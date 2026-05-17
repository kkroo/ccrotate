// OpenAI upstream client. Two paths:
//
//   - Single-key path (OPENAI_API_KEY env set): direct Bearer auth, no
//     pool rotation. LiteLLM's router handles transient retries.
//
//   - Codex pool path (CCROTATE_CODEX_DIR env set, OPENAI_API_KEY unset):
//     reads profiles.codex.json + current.json from the given dir, uses
//     the active account's id_token, rotates to the next codex account
//     on 429+insufficient_quota. Once-only rotation per call.
//
//     Note: as of v1 the codex `id_token` minted by `codex login
//     --device-auth` (auth_mode=chatgpt) has audience=chatgpt.com and
//     returns HTTP 401 invalid_claims against api.openai.com. This code
//     path is shipped as v2 scaffolding — usable once codex accounts are
//     populated with Platform-API-scoped tokens (auth_mode=apikey or a
//     future codex CLI flow that mints them). See Task 13 in
//     docs/superpowers/plans/2026-05-15-ccrotate-serve.md and Gate 1
//     evidence in the design doc.

import fs from 'node:fs';
import path from 'node:path';
import { withCcrotateLock, markAccountExhausted } from '../state-helpers.js';

const CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const EMB_URL = 'https://api.openai.com/v1/embeddings';

// ---------- single-key path -------------------------------------------------

async function callOnceJson({ url, payload, timeoutMs }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('openai-client: OPENAI_API_KEY env not set');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- codex pool path -------------------------------------------------

function readCodexProfiles(dir) {
  const raw = fs.readFileSync(path.join(dir, 'profiles.codex.json'), 'utf8');
  return JSON.parse(raw);
}

function readCodexActiveEmail(dir, profiles) {
  try {
    const cur = JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8'));
    if (cur && typeof cur.email === 'string' && profiles[cur.email]) return cur.email;
  } catch { /* fall through */ }
  return Object.keys(profiles)[0] ?? null;
}

function pickNextCodex(profiles, tried) {
  for (const [email, prof] of Object.entries(profiles)) {
    if (tried.has(email)) continue;
    if (getCodexIdToken(prof)) return { email, profile: prof };
  }
  return null;
}

function getCodexIdToken(profile) {
  return profile?.credentials?.tokens?.id_token || profile?.auth?.tokens?.id_token || null;
}

function setActiveCodex(dir, email) {
  withCcrotateLock(dir, () => {
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email }));
  });
}

async function codexCallOnce({ url, idToken, payload, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function isQuotaExhausted(body) {
  const code = body?.error?.code;
  const type = body?.error?.type;
  return code === 'insufficient_quota' || type === 'insufficient_quota';
}

async function callOpenaiViaCodex(url, payload, { timeoutMs = 60000 } = {}) {
  const dir = process.env.CCROTATE_CODEX_DIR;
  if (!dir) throw new Error('openai-client: CCROTATE_CODEX_DIR env not set');
  const profiles = readCodexProfiles(dir);
  const startEmail = readCodexActiveEmail(dir, profiles);

  const tried = new Set();
  let cur = startEmail && getCodexIdToken(profiles[startEmail])
    ? { email: startEmail, profile: profiles[startEmail] }
    : pickNextCodex(profiles, tried);
  let attempts = 0;
  let last = null;

  while (cur) {
    attempts += 1;
    tried.add(cur.email);
    const idTok = getCodexIdToken(cur.profile);
    if (!idTok) {
      cur = pickNextCodex(profiles, tried);
      if (cur) setActiveCodex(dir, cur.email);
      continue;
    }

    const response = await codexCallOnce({ url, idToken: idTok, payload, timeoutMs });
    last = response;

    if (response.status === 200) {
      return { status: 200, response, attempts, account: cur.email };
    }

    if (response.status === 429) {
      let body = null;
      try { body = await response.clone().json(); } catch { /* non-JSON */ }
      if (isQuotaExhausted(body)) {
        try { markAccountExhausted(dir, cur.email, { reset5h: null, reset7d: null }); }
        catch { /* tier-cache update is best-effort */ }
        const next = pickNextCodex(profiles, tried);
        if (next) {
          setActiveCodex(dir, next.email);
          cur = next;
          continue;
        }
        // Pool exhausted — every codex account is quota-blocked.
        return {
          status: 429,
          response,
          attempts,
          account: cur.email,
          poolExhausted: true,
        };
      }
    }

    // Non-rotatable failure (non-quota 429, 401, 5xx, etc).
    return { status: response.status, response, attempts, account: cur.email };
  }

  return { status: 502, response: last, attempts, poolExhausted: true };
}

// ---------- public dispatch -------------------------------------------------

async function dispatch(url, payload, opts) {
  const { timeoutMs = 60000 } = opts;
  if (process.env.OPENAI_API_KEY) {
    const response = await callOnceJson({ url, payload, timeoutMs });
    return { status: response.status, response, attempts: 1 };
  }
  if (process.env.CCROTATE_CODEX_DIR) {
    return callOpenaiViaCodex(url, payload, { timeoutMs });
  }
  throw new Error('openai-client: neither OPENAI_API_KEY nor CCROTATE_CODEX_DIR set');
}

export async function callChat(payload, opts = {}) {
  return dispatch(CHAT_URL, payload, opts);
}

export async function callResponses(payload, opts = {}) {
  return dispatch(RESPONSES_URL, payload, opts);
}

export async function callEmbeddings(payload, opts = {}) {
  return dispatch(EMB_URL, payload, opts);
}
