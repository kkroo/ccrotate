// OpenAI upstream client. Two paths:
//
//   - Single-key path (OPENAI_API_KEY env set): direct Bearer auth, used only
//     for embeddings when an API key is configured. LiteLLM's router handles
//     transient retries.
//
//   - Codex pool path (CCROTATE_CODEX_DIR env set):
//     /v1/responses is proxied to ChatGPT's Codex Responses endpoint with the
//     selected saved Codex access_token. That preserves Codex's local tool
//     loop: upstream returns Responses events/tool calls and the caller's
//     local Codex process executes tools on the caller machine. The old
//     server-side `codex exec` bridge remains behind
//     CCROTATE_CODEX_RESPONSES_MODE=exec only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createStateStore } from './state-store.js';

const CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const CHATGPT_CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CHATGPT_CODEX_RESPONSES_COMPACT_URL = 'https://chatgpt.com/backend-api/codex/responses/compact';
const EMB_URL = 'https://api.openai.com/v1/embeddings';
// /v1/images/generations bypasses api.openai.com entirely — we bridge
// through `codex exec $imagegen` (see callImagesViaCodexExec). OpenAI
// rejects ChatGPT-scoped OAuth id_tokens at that endpoint with
// `401 invalid_claims`, same as /v1/responses pre-codex-exec.

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

// Codex-pool state access goes through a StateStore (state-store.js):
// FileStateStore under CCROTATE_CODEX_DIR, or HttpStateStore when
// CCROTATE_STATE_URL points at a `ccrotate state-server`. This is what lets
// ccrotate-serve run without the shared cephfs PVC (onprem-k8s#227).
function codexStore() {
  const dir = process.env.CCROTATE_CODEX_DIR;
  if (!dir && !process.env.CCROTATE_STATE_URL) {
    throw new Error('openai-client: CCROTATE_CODEX_DIR or CCROTATE_STATE_URL env required');
  }
  return createStateStore({ profilesDir: dir });
}

async function readCodexActiveEmail(store, profiles) {
  const email = await store.getActiveEmail();
  if (email && profiles[email]) return email;
  return Object.keys(profiles)[0] ?? null;
}

export function pickNextCodex(profiles, tried) {
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

function getCodexAccessToken(profile) {
  return profile?.credentials?.tokens?.access_token || profile?.auth?.tokens?.access_token || null;
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

function responsesSseFromBody(response) {
  const lines = [];
  const push = (type, data) => lines.push(sseData({ type, ...data }));
  push('response.created', { response: { ...response, status: 'in_progress', output: [] } });
  for (const [outputIndex, item] of response.output.entries()) {
    if (item.type === 'message') {
      push('response.output_item.added', {
        response_id: response.id,
        output_index: outputIndex,
        item: { ...item, status: 'in_progress', content: [] },
      });
      for (const [contentIndex, part] of item.content.entries()) {
        push('response.content_part.added', {
          response_id: response.id,
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          part: { ...part, text: '' },
        });
        if (part.type === 'output_text' && part.text) {
          push('response.output_text.delta', {
            response_id: response.id,
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            delta: part.text,
          });
          push('response.output_text.done', {
            response_id: response.id,
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            text: part.text,
          });
        }
        push('response.content_part.done', {
          response_id: response.id,
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          part,
        });
      }
    } else {
      push('response.output_item.added', { response_id: response.id, output_index: outputIndex, item });
    }
    push('response.output_item.done', { response_id: response.id, output_index: outputIndex, item });
  }
  push('response.completed', { response });
  lines.push('data: [DONE]\n\n');
  return lines.join('');
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

function sseData(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function failedResponse(base, code, message, type = 'server_error') {
  return {
    ...base,
    status: 'failed',
    error: { type, code, message },
  };
}

function makeResponseSkeleton(payload) {
  const id = `resp_codex_${Date.now().toString(36)}`;
  const msgId = `msg_${id}`;
  return {
    response: {
      id,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'in_progress',
      model: payload.model,
      output: [],
      output_text: '',
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
    msgId,
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

function codexResponsesMode() {
  return String(process.env.CCROTATE_CODEX_RESPONSES_MODE || 'proxy').trim().toLowerCase();
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
      '--dangerously-bypass-approvals-and-sandbox',
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

function runCodexExecAsync({ auth, payload, timeoutMs }) {
  const tempHome = createTempCodexHome(auth);
  const prompt = responsesInputToPrompt(payload);
  return new Promise((resolve) => {
    const child = spawn('codex', [
      'exec',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '-m',
      payload.model,
      '-C',
      os.tmpdir(),
      '--dangerously-bypass-approvals-and-sandbox',
      '--json',
      '-',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: codexExecEnv(tempHome),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref?.();
      finish({ status: 502, errorMessage: `codex exec timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => finish({ status: 502, errorMessage: error.message }));
    child.on('close', code => {
      const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
      const parsed = parseCodexJsonOutput(combined);
      if (code === 0) {
        finish({ status: 200, text: parsed.text, usage: parsed.usage });
        return;
      }
      const message = parsed.errorMessage || combined || `codex exec exited with code ${code}`;
      finish({
        status: isCodexUsageLimitMessage(message) ? 429 : 502,
        errorMessage: message,
      });
    });
    child.stdin.end(prompt);
  });
}

async function callResponsesViaCodexExec(payload, { timeoutMs = 120000 } = {}) {
  const store = codexStore();
  const profiles = await store.getCodexProfiles();
  const startEmail = await readCodexActiveEmail(store, profiles);

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
      if (cur) await store.setActiveEmail(cur.email);
      continue;
    }

    const result = runCodexExec({ auth, payload, timeoutMs });
    last = result.response;
    if (result.status === 200 || result.status === 400) {
      return { status: result.status, response: result.response, attempts, account: cur.email };
    }

    if (result.status === 429 && isCodexUsageLimitMessage(result.errorMessage)) {
      try {
        await store.markCodexExhausted(cur.email, result.errorMessage);
      } catch { /* cache update is best-effort */ }
      const next = pickNextCodex(profiles, tried);
      if (next) {
        await store.setActiveEmail(next.email);
        cur = next;
        continue;
      }
      return { status: 429, response: result.response, attempts, account: cur.email, poolExhausted: true };
    }

    if (isRevokedCodexAuthMessage(result.errorMessage)) {
      try { await store.markCodexStale(cur.email); } catch { /* best-effort */ }
      const next = pickNextCodex(profiles, tried);
      if (next) {
        await store.setActiveEmail(next.email);
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

async function callResponsesViaCodexExecStream(payload, { timeoutMs = 15 * 60_000 } = {}) {
  const store = codexStore();
  const profiles = await store.getCodexProfiles();
  const startEmail = await readCodexActiveEmail(store, profiles);
  const tried = new Set();

  async function* stream() {
    let cur = startEmail && !profiles[startEmail]?.stale && getCodexAuth(profiles[startEmail])
      ? { email: startEmail, profile: profiles[startEmail] }
      : pickNextCodex(profiles, tried);
    let attempts = 0;
    let lastMessage = 'No Codex accounts with usable auth.';

    while (cur) {
      attempts += 1;
      tried.add(cur.email);
      yield `: ccrotate-serve trying ${cur.email}\n\n`;

      const promise = runCodexExecAsync({ auth: getCodexAuth(cur.profile), payload, timeoutMs });
      let result = null;
      while (!result) {
        result = await Promise.race([
          promise,
          new Promise(resolve => setTimeout(() => resolve(null), 10_000)),
        ]);
        if (!result) yield ': ccrotate-serve keepalive\n\n';
      }

      if (result.status === 200) {
        await store.setActiveEmail(cur.email);
        yield responsesSseFromBody(makeResponsesBody(payload, result.text, result.usage));
        return;
      }

      lastMessage = result.errorMessage || lastMessage;
      if (result.status === 429 && isCodexUsageLimitMessage(lastMessage)) {
        try { await store.markCodexExhausted(cur.email, lastMessage); } catch {}
        const next = pickNextCodex(profiles, tried);
        if (next) {
          await store.setActiveEmail(next.email);
          yield `: ccrotate-serve rotated ${cur.email} -> ${next.email}\n\n`;
          cur = next;
          continue;
        }
      }
      if (isRevokedCodexAuthMessage(lastMessage)) {
        try { await store.markCodexStale(cur.email); } catch {}
        const next = pickNextCodex(profiles, tried);
        if (next) {
          await store.setActiveEmail(next.email);
          yield `: ccrotate-serve rotated ${cur.email} -> ${next.email}\n\n`;
          cur = next;
          continue;
        }
      }
      break;
    }

    const id = `resp_codex_${Date.now().toString(36)}`;
    const response = failedResponse({
      id,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: payload.model,
      output: [],
      output_text: '',
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    }, isCodexUsageLimitMessage(lastMessage) ? 'insufficient_quota' : 'codex_exec_failed', lastMessage,
       isCodexUsageLimitMessage(lastMessage) ? 'insufficient_quota' : 'server_error');
    yield sseData({ type: 'response.failed', response });
    yield 'data: [DONE]\n\n';
  }

  return {
    status: 200,
    stream: stream(),
    response: new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    attempts: 1,
  };
}

function codexTierMap(cache) {
  const out = new Map();
  for (const entry of Array.isArray(cache?.accounts) ? cache.accounts : []) {
    if (entry?.email) out.set(entry.email, entry);
  }
  return out;
}

function isCodexTierUsable(email, tierMap) {
  const entry = tierMap?.get?.(email);
  if (!entry) return true;
  if (entry.serviceTier === 'exhausted') return false;
  if (entry.status === 'error' || entry.status === 'unknown') return false;
  return true;
}

function pickNextCodexAccess(profiles, tried, tierMap = new Map(), { allowExhausted = false } = {}) {
  for (const [email, prof] of Object.entries(profiles)) {
    if (tried.has(email)) continue;
    if (prof?.stale) continue;
    if (!allowExhausted && !isCodexTierUsable(email, tierMap)) continue;
    if (getCodexAccessToken(prof)) return { email, profile: prof };
  }
  return null;
}

function forwardableCodexRequestHeaders(headers = {}) {
  const out = {
    'content-type': 'application/json',
  };
  const allow = new Set([
    'accept',
    'accept-language',
    'openai-beta',
    'openai-organization',
    'openai-project',
    'user-agent',
    'x-codex-turn-state',
    'x-openai-client-user-agent',
    'x-stainless-arch',
    'x-stainless-lang',
    'x-stainless-os',
    'x-stainless-package-version',
    'x-stainless-runtime',
    'x-stainless-runtime-version',
    'x-stainless-retry-count',
    'x-stainless-timeout',
    'traceparent',
    'tracestate',
  ]);
  for (const [rawKey, value] of Object.entries(headers || {})) {
    const key = rawKey.toLowerCase();
    if (!allow.has(key) || value == null) continue;
    if (Array.isArray(value)) out[rawKey] = value.join(', ');
    else out[rawKey] = String(value);
  }
  return out;
}

function passthroughHeaders(response) {
  const out = {};
  const allow = [
    'content-type',
    'cache-control',
    'retry-after',
    'x-codex-turn-state',
    'x-request-id',
    'request-id',
    'openai-processing-ms',
    'openai-version',
  ];
  for (const key of allow) {
    const value = response.headers.get(key);
    if (value != null) out[key] = value;
  }
  return out;
}

async function codexResponsesProxyOnce({ url, accessToken, payload, timeoutMs, headers }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        ...forwardableCodexRequestHeaders(headers),
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function classifyCodexProxyFailure(response) {
  let body = null;
  let text = '';
  try {
    text = await response.clone().text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const message = String(body?.error?.message || body?.detail || text || '');
  return {
    body,
    message,
    quota: response.status === 429 && (isQuotaExhausted(body) || isCodexUsageLimitMessage(message)),
    tokenRejected: (response.status === 401 || response.status === 403) && isCodexTokenRejected(body),
  };
}

async function callResponsesViaChatGptCodexProxy(payload, {
  timeoutMs = 15 * 60_000,
  headers = {},
  compact = false,
  stream = false,
} = {}) {
  const store = codexStore();
  const profiles = await store.getCodexProfiles();
  const tierCache = await store.getCodexTierCache().catch(() => null);
  const tierMap = codexTierMap(tierCache);
  const startEmail = await readCodexActiveEmail(store, profiles);
  const url = compact ? CHATGPT_CODEX_RESPONSES_COMPACT_URL : CHATGPT_CODEX_RESPONSES_URL;

  const tried = new Set();
  let cur = startEmail
    && !profiles[startEmail]?.stale
    && isCodexTierUsable(startEmail, tierMap)
    && getCodexAccessToken(profiles[startEmail])
    ? { email: startEmail, profile: profiles[startEmail] }
    : pickNextCodexAccess(profiles, tried, tierMap);
  if (!cur) cur = pickNextCodexAccess(profiles, tried, tierMap, { allowExhausted: true });
  let attempts = 0;
  let last = null;

  while (cur) {
    attempts += 1;
    tried.add(cur.email);
    const accessToken = getCodexAccessToken(cur.profile);
    if (!accessToken) {
      cur = pickNextCodexAccess(profiles, tried, tierMap);
      if (!cur) cur = pickNextCodexAccess(profiles, tried, tierMap, { allowExhausted: true });
      if (cur) await store.setActiveEmail(cur.email);
      continue;
    }

    const response = await codexResponsesProxyOnce({ url, accessToken, payload, timeoutMs, headers });
    last = response;
    const responseHeaders = passthroughHeaders(response);

    if (response.status >= 200 && response.status < 300) {
      try { await store.setActiveEmail(cur.email); } catch { /* non-fatal */ }
      return {
        status: response.status,
        response,
        stream: stream && response.body ? response.body : undefined,
        headers: responseHeaders,
        attempts,
        account: cur.email,
      };
    }

    if (response.status === 429 || response.status === 401 || response.status === 403) {
      const failure = await classifyCodexProxyFailure(response);
      if (failure.quota) {
        try { await store.markCodexExhausted(cur.email, failure.message || 'Codex usage limit'); } catch {}
        tierMap.set(cur.email, { ...(tierMap.get(cur.email) || {}), serviceTier: 'exhausted', status: 'success' });
        const next = pickNextCodexAccess(profiles, tried, tierMap);
        if (next) {
          await store.setActiveEmail(next.email);
          cur = next;
          continue;
        }
        return {
          status: response.status,
          response,
          headers: responseHeaders,
          attempts,
          account: cur.email,
          poolExhausted: true,
        };
      }
      if (failure.tokenRejected) {
        try { await store.markCodexStale(cur.email); } catch {}
        const next = pickNextCodexAccess(profiles, tried, tierMap);
        if (next) {
          await store.setActiveEmail(next.email);
          cur = next;
          continue;
        }
        return {
          status: response.status,
          response,
          headers: responseHeaders,
          attempts,
          account: cur.email,
          poolExhausted: true,
        };
      }
    }

    return { status: response.status, response, headers: responseHeaders, attempts, account: cur.email };
  }

  return {
    status: 502,
    response: last || errorFetchResponse(502, 'pool_exhausted', 'No Codex accounts with usable access_token.'),
    headers: last ? passthroughHeaders(last) : {},
    attempts,
    poolExhausted: true,
  };
}

async function callOpenaiViaCodex(url, payload, { timeoutMs = 60000 } = {}) {
  const store = codexStore();
  const profiles = await store.getCodexProfiles();
  const startEmail = await readCodexActiveEmail(store, profiles);

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
      if (cur) await store.setActiveEmail(cur.email);
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
        try { await store.markCodexExhausted(cur.email, 'OpenAI quota exhausted'); }
        catch { /* tier-cache update is best-effort */ }
        const next = pickNextCodex(profiles, tried);
        if (next) {
          await store.setActiveEmail(next.email);
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
        try { await store.markCodexStale(cur.email); } catch { /* best-effort */ }
        const next = pickNextCodex(profiles, tried);
        if (next) {
          await store.setActiveEmail(next.email);
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
    if (codexResponsesMode() === 'exec') {
      if (opts.stream === true) return callResponsesViaCodexExecStream(payload, opts);
      return callResponsesViaCodexExec(payload, opts);
    }
    return callResponsesViaChatGptCodexProxy(payload, opts);
  }
  return dispatch(RESPONSES_URL, payload, opts);
}

export async function callEmbeddings(payload, opts = {}) {
  const { timeoutMs = 60000 } = opts;
  if (process.env.OPENAI_API_KEY) {
    const response = await callOnceJson({ url: EMB_URL, payload, timeoutMs });
    return { status: response.status, response, attempts: 1 };
  }
  return dispatch(EMB_URL, payload, opts);
}

// ---------- image generation via `codex exec $imagegen` ---------------------
//
// /v1/images/generations cannot pass the ChatGPT-audience OAuth id_token to
// api.openai.com — that path returns `401 invalid_claims` (same shape as
// /v1/responses pre-codex-exec). Instead we bridge through `codex exec` with
// the `$imagegen` keyword, harvest the PNG that the imagegen tool writes
// into `${CODEX_HOME}/generated_images/<thread_id>/`, and return it as
// base64 in OpenAI's /v1/images/generations response shape.
//
// Real bug 2026-05-19: PR #37's callImages routed via callOpenaiViaCodex
// (direct OAuth Bearer to api.openai.com), and every call returned
// `401 invalid_claims`. This handler swaps in the codex-exec bridge.

/**
 * Translate /v1/images/generations payload → a one-shot prompt for
 * `codex exec`. We pin the prompt tight so the agent doesn't go on a
 * tool-running spree (the empirical baseline burned 119k input tokens
 * doing find/identify/ffmpeg post-processing). Imagegen alone is what
 * we need; the actual file is auto-saved by the skill.
 */
function imagesPayloadToCodexPrompt(payload) {
  const userPrompt = (typeof payload?.prompt === 'string' && payload.prompt.trim())
    ? payload.prompt.trim()
    : 'a small placeholder image';
  const lines = [
    `$imagegen ${userPrompt}`,
    '',
    'Important: generate exactly ONE image and stop. Do NOT run shell',
    'commands, do NOT copy or resize the file, do NOT use ffmpeg or',
    'imagemagick. Reply with a single short sentence like "done" — the',
    'file written by the imagegen skill is what the caller wants.',
  ];
  if (payload?.size) lines.push(`Requested size hint: ${payload.size}.`);
  if (payload?.style) lines.push(`Style hint: ${payload.style}.`);
  if (payload?.quality) lines.push(`Quality hint: ${payload.quality}.`);
  return lines.join('\n');
}

/**
 * Scan `${tempHome}/generated_images/<thread_id>/*` (the imagegen skill's
 * write target when CODEX_HOME=tempHome) and return all image files,
 * newest first. Falls back to recursive globbing in case the imagegen
 * skill ever changes its layout.
 */
function findGeneratedImagesIn(tempHome) {
  const root = path.join(tempHome, 'generated_images');
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const name = entry.name.toLowerCase();
      if (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.webp')) {
        out.push(full);
      }
    }
  };
  walk(root);
  out.sort((a, b) => {
    try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; }
    catch { return 0; }
  });
  return out;
}

function imageMimeForPath(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

/**
 * Spawn `codex exec --json` with the $imagegen prompt, then read the PNG
 * the imagegen skill wrote into `${CODEX_HOME}/generated_images/...`.
 * Returns { status, response, errorMessage? } following the same contract
 * as runCodexExec / runCodexExecAsync.
 */
function runCodexExecImages({ auth, payload, timeoutMs }) {
  const tempHome = createTempCodexHome(auth);
  const prompt = imagesPayloadToCodexPrompt(payload);
  try {
    const result = spawnSync('codex', [
      'exec',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '-C',
      os.tmpdir(),
      '--dangerously-bypass-approvals-and-sandbox',
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
      const status = isCodexUsageLimitMessage(message) ? 429 : 502;
      return {
        status,
        response: errorFetchResponse(
          status,
          status === 429 ? 'insufficient_quota' : 'codex_exec_failed',
          message,
        ),
        errorMessage: message,
      };
    }

    const images = findGeneratedImagesIn(tempHome);
    if (images.length === 0) {
      const detail = parsed.text ? ` agent: ${parsed.text.slice(0, 200)}` : '';
      const message = `codex exec completed but no image file appeared under ${tempHome}/generated_images.${detail}`;
      return {
        status: 502,
        response: errorFetchResponse(502, 'no_image_generated', message),
        errorMessage: message,
      };
    }

    // n>1: codex exec generates one image per invocation; callers asking for
    // more than one would need separate calls. Cap at the count we have.
    const requested = Number.isInteger(payload?.n) && payload.n > 0 ? payload.n : 1;
    const responseFormat = payload?.response_format === 'url' ? 'url' : 'b64_json';
    const data = images.slice(0, requested).map(file => {
      const buf = fs.readFileSync(file);
      if (responseFormat === 'url') {
        return { url: `data:${imageMimeForPath(file)};base64,${buf.toString('base64')}` };
      }
      return { b64_json: buf.toString('base64') };
    });

    const body = {
      created: Math.floor(Date.now() / 1000),
      data,
    };
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

async function callImagesViaCodexExec(payload, { timeoutMs = 180000 } = {}) {
  const store = codexStore();
  const profiles = await store.getCodexProfiles();
  const startEmail = await readCodexActiveEmail(store, profiles);

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
      if (cur) await store.setActiveEmail(cur.email);
      continue;
    }

    const result = runCodexExecImages({ auth, payload, timeoutMs });
    last = result.response;
    if (result.status === 200) {
      try { await store.setActiveEmail(cur.email); } catch { /* non-fatal */ }
      return { status: 200, response: result.response, attempts, account: cur.email };
    }

    if (result.status === 429 && isCodexUsageLimitMessage(result.errorMessage)) {
      try { await store.markCodexExhausted(cur.email, result.errorMessage); }
      catch { /* cache update is best-effort */ }
      const next = pickNextCodex(profiles, tried);
      if (next) {
        await store.setActiveEmail(next.email);
        cur = next;
        continue;
      }
      return { status: 429, response: result.response, attempts, account: cur.email, poolExhausted: true };
    }

    if (isRevokedCodexAuthMessage(result.errorMessage)) {
      try { await store.markCodexStale(cur.email); } catch { /* best-effort */ }
      const next = pickNextCodex(profiles, tried);
      if (next) {
        await store.setActiveEmail(next.email);
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

// Exported for unit tests.
export { imagesPayloadToCodexPrompt, findGeneratedImagesIn };

// /v1/images/generations — bridged through `codex exec $imagegen`. We
// CANNOT call api.openai.com/v1/images/generations directly with a
// ChatGPT-scoped OAuth id_token; OpenAI rejects those tokens with
// `401 invalid_claims` (same shape as /v1/responses pre-codex-exec).
// Codex CLI handles the auth bridge internally.
export async function callImages(payload, opts = {}) {
  const { timeoutMs = 180000 } = opts;
  if (!process.env.CCROTATE_CODEX_DIR) {
    throw new Error('openai-client: callImages requires CCROTATE_CODEX_DIR (image generation is Codex-pool-only)');
  }
  return callImagesViaCodexExec(payload, { timeoutMs });
}
