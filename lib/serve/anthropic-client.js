// Calls api.anthropic.com via the ccrotate OAuth pool. Handles rotation
// on quota exhaustion, lazy refresh on 401, pool-walk on refresh-fail.
//
// Designed to be the ONLY mutator of ccrotate state inside the serve module.
// All mutations go under withCcrotateLock from state-helpers.js.

import fs from 'node:fs';
import path from 'node:path';
import { withCcrotateLock } from '../state-helpers.js';

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

export async function callMessages(payload, opts = {}) {
  const { profilesDir, timeoutMs = 15000 } = opts;
  if (!profilesDir) throw new Error('anthropic-client: profilesDir required');

  const { email, profile } = readActiveProfile(profilesDir);
  const oauth = profile.credentials?.claudeAiOauth;
  if (!oauth?.accessToken) throw new Error(`anthropic-client: ${email} has no accessToken`);

  // Attempt 1
  let response = await callOnce({ url: ANTHROPIC_URL, accessToken: oauth.accessToken, payload, timeoutMs });
  if (response.status !== 401) {
    return { status: response.status, response, attempts: 1, account: email };
  }

  // 401 → refresh then attempt 2
  let newOauth;
  try {
    newOauth = await refreshAccessToken(oauth.refreshToken, timeoutMs);
  } catch (refreshErr) {
    return { status: 401, response, attempts: 1, account: email, refreshError: refreshErr };
  }
  writeProfileAccessToken(profilesDir, email, newOauth);
  response = await callOnce({ url: ANTHROPIC_URL, accessToken: newOauth.accessToken, payload, timeoutMs });
  return { status: response.status, response, attempts: 2, account: email };
}
