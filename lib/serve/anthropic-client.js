// Calls api.anthropic.com via the ccrotate OAuth pool. Handles rotation
// on quota exhaustion, lazy refresh on 401, pool-walk on refresh-fail.
//
// Designed to be the ONLY mutator of ccrotate state inside the serve module.
// All mutations go under withCcrotateLock from state-helpers.js.

import fs from 'node:fs';
import path from 'node:path';
import { withCcrotateLock, markAccountExhausted, clearAccountExhausted } from '../state-helpers.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const REFRESH_URL = 'https://api.anthropic.com/api/oauth/token/refresh';
// NOTE: actual endpoint may be 'https://console.anthropic.com/v1/oauth/token' —
// confirm during operational probe and adjust if needed.

const HEADERS_TEMPLATE = {
  'Content-Type': 'application/json',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'oauth-2025-04-20',
};

const ONE_M_CONTEXT_BETA = 'context-1m-2025-08-07';

function prepareAnthropicRequest(payload) {
  const { context_management: _contextManagement, ...upstreamPayload } = payload || {};
  if (upstreamPayload.stream === false) delete upstreamPayload.stream;
  if (upstreamPayload?.model !== 'claude-opus-4-7[1m]') {
    return { payload: upstreamPayload, headers: HEADERS_TEMPLATE };
  }
  return {
    payload: { ...upstreamPayload, model: 'claude-opus-4-7' },
    headers: {
      ...HEADERS_TEMPLATE,
      'anthropic-beta': `${HEADERS_TEMPLATE['anthropic-beta']},${ONE_M_CONTEXT_BETA}`,
    },
  };
}

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
  const upstream = prepareAnthropicRequest(payload);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { ...upstream.headers, 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify(upstream.payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function classifyQuotaError(body, responseHeaders) {
  // Returns { structural: bool, reset5h: number|null, reset7d: number|null }
  //
  // T1 fix (2026-05-17): A `rate_limit_error` without ANY reset signal — no
  // anthropic-ratelimit-*-reset header AND no parseable epoch in the message —
  // is a transient burst-throttle (Anthropic's per-org rate limiter slapping
  // the back of a tight burst), not real per-account exhaustion. Returning
  // structural:true in that case caused cluster ccrotate-refresh cronjobs to
  // falsely flag all 13 accounts as exhausted every 30 min, deadlocking
  // paperclip's heartbeat tier-gate. Structural exhaustion requires a reset
  // signal — otherwise treat as inconclusive and let the caller propagate the
  // 429 as transient.
  if (!body || !body.error) return { structural: false };
  if (body.error.type !== 'rate_limit_error') return { structural: false };

  // Prefer reset from headers; fall back to parsing message.
  //
  // Two header shapes:
  //   `anthropic-ratelimit-tokens-reset` — already an absolute unix epoch
  //     in seconds (per Anthropic's rate-limit headers spec).
  //   `retry-after` — HTTP-spec DURATION in seconds (delta-seconds form, not
  //     the rare HTTP-date form). Pre-fix this code stored the raw duration
  //     as `reset5h`, so e.g. retry-after:60 became reset5h=60 → tier-cache
  //     showed "resets at 1970-01-01T00:01:00.000Z" and pickNextCandidate's
  //     `reset5h * 1000 <= Date.now()` filter treated those accounts as
  //     ALWAYS expired (1970 epochs are far in the past). Fix: convert the
  //     duration to an absolute epoch by adding now.
  let reset5h = null;
  if (responseHeaders) {
    const hdr = (h) => {
      const v = responseHeaders.get?.(h) ?? responseHeaders[h];
      if (v == null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const absResetHeader = hdr('anthropic-ratelimit-tokens-reset');
    if (absResetHeader != null) {
      reset5h = absResetHeader;
    } else {
      const retryAfter = hdr('retry-after');
      if (retryAfter != null) {
        reset5h = Math.floor(Date.now() / 1000) + retryAfter;
      }
    }
  }
  if (reset5h == null) {
    const msg = body.error.message || '';
    const m = msg.match(/resets? at[^0-9]*([0-9]{10,})/i);
    reset5h = m ? Number(m[1]) : null;
  }

  // No reset signal → burst-throttle, not exhaustion.
  if (reset5h == null) {
    return { structural: false };
  }

  return { structural: true, reset5h, reset7d: null };
}

// T1 (2026-05-17): exported for unit testing the burst-429 vs structural
// classification.
export { classifyQuotaError };

function pickNextCandidate(profilesDir, alreadyTried, model = null) {
  const profiles = JSON.parse(fs.readFileSync(path.join(profilesDir, 'profiles.json'), 'utf8'));
  let tierCache = { accounts: [] };
  try { tierCache = JSON.parse(fs.readFileSync(path.join(profilesDir, 'tier-cache.json'), 'utf8')); } catch {}
  const exhaustedSet = new Set(
    (tierCache.accounts || [])
      .filter(a => {
        if (a.serviceTier !== 'exhausted') return false;
        if ((a.rateLimits?.reset5h ?? 0) * 1000 <= Date.now()) return false;
        const exhaustedModel = a.exhaustedModel ?? a.rateLimits?.exhaustedModel ?? null;
        return !exhaustedModel || exhaustedModel === model;
      })
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

function setActiveOnSuccess(profilesDir, email, response, model = null) {
  if (response.status >= 200 && response.status < 300) {
    setActiveAccount(profilesDir, email);
    // Self-heal stale-exhausted-label deadlock: a 200 from this account is
    // definitive proof it isn't currently exhausted, so clear any stale
    // `serviceTier: exhausted` label in tier-cache. Common trigger: a
    // burst-probe / transient burst-429 / claude-local writeback poisoned
    // the label, the Usage API is on cooldown so freshness-loop probes
    // return status='unknown', and the anti-clobber rule in
    // upsertTierCacheEntries pins the bad label until something clears it.
    // Real upstream success is that something.
    //
    // Model-scoped clear: per-model quotas are independent (haiku may serve
    // while opus is genuinely exhausted), so we only clear when the
    // existing entry's exhaustedModel matches the success model — or when
    // no exhaustedModel was tracked at all. clearAccountExhausted handles
    // the model gate internally.
    try {
      clearAccountExhausted(profilesDir, email, { model });
    } catch {
      // Non-fatal: caller still gets the 200 response. Stale label will
      // clear on next freshness-loop probe or successful upstream call.
    }
  }
}

export async function callMessages(payload, opts = {}) {
  const { profilesDir, timeoutMs = 60000 } = opts;
  if (!profilesDir) throw new Error('anthropic-client: profilesDir required');

  const tried = new Set();
  let cand = { ...readActiveProfile(profilesDir) }; // { email, profile, allProfiles }
  let lastResponse = null;
  let quotaResponse = null;
  let transient429Response = null;
  let attempts = 0;
  let trigger = null;

  while (cand) {
    attempts += 1;
    tried.add(cand.email);
    const oauth = cand.profile.credentials?.claudeAiOauth;
    if (!oauth?.accessToken) {
      // Treat missing token as a refresh-fail candidate.
      trigger = 'refresh-fail';
      cand = pickNextCandidate(profilesDir, tried, payload.model);
      continue;
    }

    let response = await callOnce({ url: ANTHROPIC_URL, accessToken: oauth.accessToken, payload, timeoutMs });

    if (response.status === 429) {
      let body = null;
      try { body = await response.clone().json(); } catch {}
      const cls = classifyQuotaError(body, response.headers);
      if (cls.structural) {
        markAccountExhausted(profilesDir, cand.email, {
          reset5h: cls.reset5h,
          reset7d: cls.reset7d,
          model: payload.model,
        });
        trigger = 'quota';
        lastResponse = response;
        quotaResponse = response;
        cand = pickNextCandidate(profilesDir, tried, payload.model);
        continue;
      }
      // Transient 429s do not carry a reset signal, so do not poison the
      // shared tier-cache. Still walk the pool for this request; another
      // account may not be under the same burst throttle.
      trigger = 'transient-429';
      lastResponse = response;
      transient429Response = response;
      cand = pickNextCandidate(profilesDir, tried, payload.model);
      continue;
    }

    if (response.status !== 401) {
      setActiveOnSuccess(profilesDir, cand.email, response, payload.model);
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
        setActiveOnSuccess(profilesDir, cand.email, response, payload.model);
        return { status: response.status, response, attempts, account: cand.email, trigger };
      }
      // Refreshed but immediately 401 — fall through as refresh-fail.
    }

    // refresh failed — rotate.
    trigger = 'refresh-fail';
    lastResponse = response;
    cand = pickNextCandidate(profilesDir, tried, payload.model);
  }

  // Pool exhausted
  if (quotaResponse) {
    return {
      status: 429,
      response: quotaResponse,
      attempts,
      account: null,
      trigger: 'quota',
      poolExhausted: true,
    };
  }
  if (transient429Response) {
    return {
      status: 429,
      response: transient429Response,
      attempts,
      account: null,
      trigger: 'transient-429',
      poolExhausted: true,
    };
  }
  return {
    status: 502,
    response: lastResponse,
    attempts,
    account: null,
    trigger,
    poolExhausted: true,
  };
}
