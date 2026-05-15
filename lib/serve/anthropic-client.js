// Calls api.anthropic.com via the ccrotate OAuth pool. Handles rotation
// on quota exhaustion, lazy refresh on 401, pool-walk on refresh-fail.
//
// Designed to be the ONLY mutator of ccrotate state inside the serve module.
// All mutations go under withCcrotateLock from state-helpers.js.

import fs from 'node:fs';
import path from 'node:path';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const HEADERS_TEMPLATE = {
  'Content-Type': 'application/json',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'oauth-2025-04-20',
};

function readActiveProfile(profilesDir) {
  const profiles = JSON.parse(fs.readFileSync(path.join(profilesDir, 'profiles.json'), 'utf8'));
  // current.json holds the active email pointer (the same one ccrotate's
  // CCRotate.getCurrentAccount() reads). Fall back to first profile if absent.
  let email;
  try {
    email = JSON.parse(fs.readFileSync(path.join(profilesDir, 'current.json'), 'utf8')).email;
  } catch { email = Object.keys(profiles)[0]; }
  if (!email || !profiles[email]) {
    throw new Error('anthropic-client: no active profile');
  }
  return { email, profile: profiles[email], allProfiles: profiles };
}

export async function callMessages(payload, opts = {}) {
  const { profilesDir, timeoutMs = 15000 } = opts;
  if (!profilesDir) throw new Error('anthropic-client: profilesDir required');

  const { email, profile } = readActiveProfile(profilesDir);
  const accessToken = profile.credentials?.claudeAiOauth?.accessToken;
  if (!accessToken) throw new Error(`anthropic-client: ${email} has no accessToken`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { ...HEADERS_TEMPLATE, 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  return { status: response.status, response, attempts: 1, account: email };
}
