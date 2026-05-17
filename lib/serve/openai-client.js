// OpenAI upstream client. Two paths:
//
//   - Single-key path (OPENAI_API_KEY env set, CCROTATE_CODEX_DIR unset):
//     direct Bearer auth, no pool rotation. LiteLLM's router handles transient
//     retries.
//
//   - Codex pool path (CCROTATE_CODEX_DIR env set):
//     /v1/responses is bridged through `codex exec` with the selected saved
//     Codex auth. Public OpenAI API endpoints reject ChatGPT-scoped Codex
//     OAuth tokens with invalid_claims, so direct bearer passthrough is only
//     used for endpoints that cannot be served by Codex CLI, such as
//     embeddings when a future API-scoped token is available.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withCcrotateLock } from '../state-helpers.js';

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
    if (prof?.stale) continue;
    if (getCodexAuth(prof)) return { email, profile: prof };
  }
  return null;
}

function getCodexAuth(profile) {
  if (profile?.auth) return profile.auth;
  if (profile?.credentials?.tokens) return { tokens: profile.credentials.tokens };
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

function isCodexTokenRejected(body) {
  const code = String(body?.error?.code || '').toLowerCase();
  const type = String(body?.error?.type || '').toLowerCase();
  const message = String(body?.error?.message || '').toLowerCase();
  return code === 'token_expired'
    || code === 'invalid_claims'
    || type === 'authentication_error'
    || message.includes('authentication token has expired')
    || isRevokedCodexAuthMessage(message);
}

function isCodexUsageLimitMessage(message = '') {
  const text = String(message || '').toLowerCase();
  return text.includes('hit your usage limit')
    || text.includes('out of usage')
    || (text.includes('usage limit') && text.includes('try again'))
    || (text.includes('rate limit') && text.includes('try again'));
}

function isRevokedCodexAuthMessage(message = '') {
  const text = String(message || '').toLowerCase();
  return text.includes('refresh token was already used')
    || text.includes('refresh token has already been used')
    || text.includes('refresh_token_reused')
    || text.includes('token_invalidated')
    || text.includes('token_revoked')
    || text.includes('authentication token has been invalidated')
    || text.includes('your authentication token has been invalidated')
    || text.includes('invalidated oauth token');
}

function markCodexProfileStale(dir, email) {
  withCcrotateLock(dir, () => {
    const file = path.join(dir, 'profiles.codex.json');
    const profiles = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (profiles[email]) {
      profiles[email].stale = true;
      profiles[email].staleAt = new Date().toISOString();
      fs.writeFileSync(file, JSON.stringify(profiles, null, 2));
    }
  });
}

function markCodexAccountExhausted(dir, email, response) {
  withCcrotateLock(dir, () => {
    const file = path.join(dir, 'tier-cache.codex.json');
    let cache = { updatedAt: null, accounts: [] };
    try {
      cache = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(cache.accounts)) cache.accounts = [];
    } catch { /* fresh cache */ }

    const existing = cache.accounts.find(a => a.email === email);
    cache.accounts = cache.accounts.filter(a => a.email !== email);
    cache.accounts.push({
      ...(existing || {}),
      email,
      status: 'success',
      serviceTier: 'exhausted',
      response: response || existing?.response || 'Codex usage limit reached',
      rateLimits: {
        ...(existing?.rateLimits || {}),
        utilization5h: 100,
        snapshotCapturedAt: new Date().toISOString(),
      },
    });
    cache.updatedAt = new Date().toISOString();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  });
}

function responsesInputToPrompt(payload) {
  const parts = [];
  if (typeof payload.instructions === 'string' && payload.instructions.trim()) {
    parts.push(payload.instructions.trim());
  }

  const appendContent = (content, role = 'user') => {
    if (typeof content === 'string') {
      parts.push(`${role}: ${content}`);
      return;
    }
    if (!Array.isArray(content)) {
      if (content != null) parts.push(`${role}: ${JSON.stringify(content)}`);
      return;
    }
    const text = content.map(part => {
      if (typeof part === 'string') return part;
      if (part?.type === 'input_text' || part?.type === 'output_text') return part.text || '';
      if (part?.text) return part.text;
      return '';
    }).filter(Boolean).join('\n');
    if (text) parts.push(`${role}: ${text}`);
  };

  const input = payload.input;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (item?.type === 'message') {
        appendContent(item.content, item.role || 'user');
      } else if (item?.type === 'function_call_output') {
        appendContent(item.output, 'tool');
      } else if (typeof item === 'string') {
        appendContent(item, 'user');
      }
    }
  } else {
    appendContent(input ?? '', 'user');
  }

  return parts.filter(Boolean).join('\n\n') || 'Respond briefly.';
}

function createTempCodexHome(auth) {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrotate-codex-home-'));
  fs.mkdirSync(path.join(tempHome, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(tempHome, 'auth.json'), JSON.stringify(auth, null, 2), 'utf8');
  return tempHome;
}

function parseCodexJsonOutput(output) {
  const messages = [];
  let usage = null;
  let errorMessage = '';
  for (const raw of String(output || '').split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type === 'item.completed' && entry.item?.type === 'agent_message') {
        messages.push(entry.item.text || '');
      } else if (entry?.type === 'turn.completed') {
        usage = entry.usage || usage;
      } else if (entry?.type === 'error' && typeof entry.message === 'string') {
        errorMessage = entry.message;
      } else if (entry?.type === 'turn.failed' && typeof entry.error?.message === 'string') {
        errorMessage = entry.error.message;
      }
    } catch {
      // Ignore non-JSON lines emitted by wrappers or warnings.
    }
  }
  return { text: messages.join('\n'), usage, errorMessage };
}

function codexUsageToResponsesUsage(usage = {}) {
  const u = usage || {};
  const inputTokens = u.input_tokens ?? 0;
  const outputTokens = u.output_tokens ?? 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };
}

function makeResponsesBody(payload, text, usage) {
  const id = `resp_codex_${Date.now().toString(36)}`;
  const msgId = `msg_${id}`;
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: payload.model,
    output: [{
      id: msgId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    }],
    output_text: text,
    usage: codexUsageToResponsesUsage(usage),
  };
}

function codexExecEnv(tempHome) {
  const keep = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'TERM',
    'TMPDIR',
    'http_proxy',
    'https_proxy',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
  ];
  const env = {};
  for (const key of keep) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.CODEX_HOME = tempHome;
  return env;
}

function errorFetchResponse(status, code, message, type = 'invalid_request_error') {
  return new Response(JSON.stringify({ error: { type, code, message }, status }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function runCodexExec({ auth, payload, timeoutMs }) {
  const tempHome = createTempCodexHome(auth);
  const prompt = responsesInputToPrompt(payload);
  try {
    const result = spawnSync('codex', [
      'exec',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '-m',
      payload.model,
      '-C',
      os.tmpdir(),
      '--sandbox',
      'read-only',
      '--json',
      '-',
    ], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      input: prompt,
      timeout: timeoutMs,
      env: codexExecEnv(tempHome),
    });

    const combined = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    const parsed = parseCodexJsonOutput(combined);

    if (result.error) {
      return {
        status: 502,
        response: errorFetchResponse(502, 'codex_exec_failed', result.error.message),
        errorMessage: result.error.message,
      };
    }

    if (result.status !== 0) {
      const message = parsed.errorMessage || combined || `codex exec exited with code ${result.status}`;
      return {
        status: isCodexUsageLimitMessage(message) ? 429 : 502,
        response: errorFetchResponse(
          isCodexUsageLimitMessage(message) ? 429 : 502,
          isCodexUsageLimitMessage(message) ? 'insufficient_quota' : 'codex_exec_failed',
          message,
        ),
        errorMessage: message,
      };
    }

    const body = makeResponsesBody(payload, parsed.text, parsed.usage);
    return {
      status: 200,
      response: new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    };
  } finally {
    try { fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
}

async function callResponsesViaCodexExec(payload, { timeoutMs = 120000 } = {}) {
  const dir = process.env.CCROTATE_CODEX_DIR;
  if (!dir) throw new Error('openai-client: CCROTATE_CODEX_DIR env not set');
  const profiles = readCodexProfiles(dir);
  const startEmail = readCodexActiveEmail(dir, profiles);

  const tried = new Set();
  let cur = startEmail && !profiles[startEmail]?.stale && getCodexAuth(profiles[startEmail])
    ? { email: startEmail, profile: profiles[startEmail] }
    : pickNextCodex(profiles, tried);
  let attempts = 0;
  let last = null;

  while (cur) {
    attempts += 1;
    tried.add(cur.email);
    const auth = getCodexAuth(cur.profile);
    if (!auth) {
      cur = pickNextCodex(profiles, tried);
      if (cur) setActiveCodex(dir, cur.email);
      continue;
    }

    const result = runCodexExec({ auth, payload, timeoutMs });
    last = result.response;
    if (result.status === 200 || result.status === 400) {
      return { status: result.status, response: result.response, attempts, account: cur.email };
    }

    if (result.status === 429 && isCodexUsageLimitMessage(result.errorMessage)) {
      try {
        markCodexAccountExhausted(dir, cur.email, result.errorMessage);
      } catch { /* cache update is best-effort */ }
      const next = pickNextCodex(profiles, tried);
      if (next) {
        setActiveCodex(dir, next.email);
        cur = next;
        continue;
      }
      return { status: 429, response: result.response, attempts, account: cur.email, poolExhausted: true };
    }

    if (isRevokedCodexAuthMessage(result.errorMessage)) {
      try { markCodexProfileStale(dir, cur.email); } catch { /* best-effort */ }
      const next = pickNextCodex(profiles, tried);
      if (next) {
        setActiveCodex(dir, next.email);
        cur = next;
        continue;
      }
      return { status: result.status, response: result.response, attempts, account: cur.email, poolExhausted: true };
    }

    return { status: result.status, response: result.response, attempts, account: cur.email };
  }

  return {
    status: 502,
    response: last || errorFetchResponse(502, 'pool_exhausted', 'No Codex accounts with usable auth.'),
    attempts,
    poolExhausted: true,
  };
}

async function callOpenaiViaCodex(url, payload, { timeoutMs = 60000 } = {}) {
  const dir = process.env.CCROTATE_CODEX_DIR;
  if (!dir) throw new Error('openai-client: CCROTATE_CODEX_DIR env not set');
  const profiles = readCodexProfiles(dir);
  const startEmail = readCodexActiveEmail(dir, profiles);

  const tried = new Set();
  let cur = startEmail && !profiles[startEmail]?.stale && getCodexIdToken(profiles[startEmail])
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
        try { markCodexAccountExhausted(dir, cur.email, 'OpenAI quota exhausted'); }
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

    if (response.status === 401) {
      let body = null;
      try { body = await response.clone().json(); } catch { /* non-JSON */ }
      if (isCodexTokenRejected(body)) {
        try { markCodexProfileStale(dir, cur.email); } catch { /* best-effort */ }
        const next = pickNextCodex(profiles, tried);
        if (next) {
          setActiveCodex(dir, next.email);
          cur = next;
          continue;
        }
        return {
          status: 401,
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
  if (process.env.CCROTATE_CODEX_DIR) {
    return callOpenaiViaCodex(url, payload, { timeoutMs });
  }
  if (process.env.OPENAI_API_KEY) {
    const response = await callOnceJson({ url, payload, timeoutMs });
    return { status: response.status, response, attempts: 1 };
  }
  throw new Error('openai-client: neither OPENAI_API_KEY nor CCROTATE_CODEX_DIR set');
}

export async function callChat(payload, opts = {}) {
  return dispatch(CHAT_URL, payload, opts);
}

export async function callResponses(payload, opts = {}) {
  if (process.env.CCROTATE_CODEX_DIR) {
    return callResponsesViaCodexExec(payload, opts);
  }
  return dispatch(RESPONSES_URL, payload, opts);
}

export async function callEmbeddings(payload, opts = {}) {
  return dispatch(EMB_URL, payload, opts);
}
