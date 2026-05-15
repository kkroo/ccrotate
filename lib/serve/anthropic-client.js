// Calls api.anthropic.com via the ccrotate OAuth pool. Handles rotation
// on quota exhaustion, lazy refresh on 401, pool-walk on refresh-fail.
//
// Designed to be the ONLY mutator of ccrotate state inside the serve module.
// All mutations go under withCcrotateLock from state-helpers.js.

import fs from 'node:fs';
import path from 'node:path';
import { withCcrotateLock, markAccountExhausted } from '../state-helpers.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const REFRESH_URL = 'https://api.anthropic.com/api/oauth/token/refresh';
// NOTE: actual endpoint may be 'https://console.anthropic.com/v1/oauth/token' —
// confirm during operational probe and adjust if needed.

const HEADERS_TEMPLATE = {
  'Content-Type': 'application/json',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'oauth-2025-04-20',
};

function readActiveProfile(profilesDir) {
  const profiles = JSON.parse(fs.readFileSync(path.join(profilesDir, 'profiles.json'), 'utf8'));
  let email;
  try {
    email = JSON.parse(fs.readFileSync(path.join(profilesDir, 'current.json'), 'utf8')).email;
  } catch { email = Object.keys(profiles)[0]; }
  if (!email || !profiles[email]) {
    throw new Error('anthropic-client: no active profile');
  }
  return { email, profile: profiles[email], allProfiles: profiles };
}

async function refreshAccessToken(refreshToken, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = new Error(`refresh failed: ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
  } finally {
    clearTimeout(timer);
  }
}

function writeProfileAccessToken(profilesDir, email, oauth) {
  withCcrotateLock(profilesDir, () => {
    const file = path.join(profilesDir, 'profiles.json');
    const profiles = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (profiles[email]?.credentials?.claudeAiOauth) {
      profiles[email].credentials.claudeAiOauth = {
        ...profiles[email].credentials.claudeAiOauth,
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt: oauth.expiresAt,
      };
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(profiles, null, 2));
      fs.renameSync(tmp, file);
    }
  });
}

async function callOnce({ url, accessToken, payload, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { ...HEADERS_TEMPLATE, 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function classifyQuotaError(body) {
  // Returns { structural: bool, reset5h: number|null, reset7d: number|null }
  if (!body || !body.error) return { structural: false };
  const msg = (body.error.message || '').toLowerCase();
  if (body.error.type === 'rate_limit_error' &&
      /(usage limit|extra usage exhausted|exceeded your.*quota)/i.test(msg)) {
    // Try to parse a reset timestamp ("Resets at unix N")
    const m = msg.match(/resets? at[^0-9]*([0-9]{10,})/);
    const reset = m ? Number(m[1]) : null;
    return { structural: true, reset5h: reset, reset7d: null };
  }
  return { structural: false };
}

function pickNextCandidate(profilesDir, alreadyTried) {
  const profiles = JSON.parse(fs.readFileSync(path.join(profilesDir, 'profiles.json'), 'utf8'));
  let tierCache = { accounts: [] };
  try { tierCache = JSON.parse(fs.readFileSync(path.join(profilesDir, 'tier-cache.json'), 'utf8')); } catch {}
  const exhaustedSet = new Set(
    (tierCache.accounts || [])
      .filter(a => a.serviceTier === 'exhausted' && (a.rateLimits?.reset5h ?? 0) * 1000 > Date.now())
      .map(a => a.email)
  );
  for (const [email, prof] of Object.entries(profiles)) {
    if (alreadyTried.has(email)) continue;
    if (exhaustedSet.has(email)) continue;
    if (!prof.credentials?.claudeAiOauth?.accessToken) continue;
    return { email, profile: prof };
  }
  return null;
}

function setActiveAccount(profilesDir, email) {
  withCcrotateLock(profilesDir, () => {
    fs.writeFileSync(path.join(profilesDir, 'current.json'), JSON.stringify({ email }));
  });
}

export async function callMessages(payload, opts = {}) {
  const { profilesDir, timeoutMs = 15000 } = opts;
  if (!profilesDir) throw new Error('anthropic-client: profilesDir required');

  const tried = new Set();
  let cand = { ...readActiveProfile(profilesDir) }; // { email, profile, allProfiles }
  let lastResponse = null;
  let attempts = 0;
  let trigger = null;

  while (cand) {
    attempts += 1;
    tried.add(cand.email);
    const oauth = cand.profile.credentials?.claudeAiOauth;
    if (!oauth?.accessToken) {
      // Treat missing token as a refresh-fail candidate.
      trigger = 'refresh-fail';
      cand = pickNextCandidate(profilesDir, tried);
      if (cand) setActiveAccount(profilesDir, cand.email);
      continue;
    }

    let response = await callOnce({ url: ANTHROPIC_URL, accessToken: oauth.accessToken, payload, timeoutMs });

    if (response.status === 429) {
      let body = null;
      try { body = await response.clone().json(); } catch {}
      const cls = classifyQuotaError(body);
      if (cls.structural) {
        markAccountExhausted(profilesDir, cand.email, { reset5h: cls.reset5h, reset7d: cls.reset7d });
        // Replay-once: try ONE alternate. If that fails (any reason), propagate.
        if (attempts < 2) {
          const next = pickNextCandidate(profilesDir, tried);
          if (next) {
            tried.add(next.email);
            setActiveAccount(profilesDir, next.email);
            attempts += 1;
            const nextOauth = next.profile.credentials?.claudeAiOauth;
            const replay = await callOnce({
              url: ANTHROPIC_URL, accessToken: nextOauth.accessToken, payload, timeoutMs,
            });
            return { status: replay.status, response: replay, attempts, account: next.email, trigger: 'quota' };
          }
        }
        return { status: response.status, response, attempts, account: cand.email, trigger: 'quota' };
      }
      // Transient 429 — propagate.
      return { status: 429, response, attempts, account: cand.email, trigger: 'transient-429' };
    }

    if (response.status !== 401) {
      return { status: response.status, response, attempts, account: cand.email, trigger };
    }

    // 401 → try refresh
    let newOauth;
    try {
      newOauth = await refreshAccessToken(oauth.refreshToken, timeoutMs);
    } catch {
      newOauth = null;
    }
    if (newOauth) {
      writeProfileAccessToken(profilesDir, cand.email, newOauth);
      // Replay once on the same account.
      attempts += 1;
      response = await callOnce({ url: ANTHROPIC_URL, accessToken: newOauth.accessToken, payload, timeoutMs });
      if (response.status !== 401) {
        return { status: response.status, response, attempts, account: cand.email, trigger };
      }
      // Refreshed but immediately 401 — fall through as refresh-fail.
    }

    // refresh failed — rotate.
    trigger = 'refresh-fail';
    lastResponse = response;
    cand = pickNextCandidate(profilesDir, tried);
    if (cand) setActiveAccount(profilesDir, cand.email);
  }

  // Pool exhausted
  return {
    status: 502,
    response: lastResponse,
    attempts,
    account: null,
    trigger,
    poolExhausted: true,
  };
}
