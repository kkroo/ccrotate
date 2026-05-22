const RATE_LIMIT_STATE_VERSION = 1;

export function emptyRateLimitState() {
  return {
    version: RATE_LIMIT_STATE_VERSION,
    updatedAt: null,
    anthropic: { accounts: {} },
  };
}

export function normalizeAnthropicModelGroup(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('haiku')) return 'claude-haiku';
  if (m.includes('opus')) return 'claude-opus';
  if (m.includes('sonnet')) return 'claude-sonnet';
  if (m.startsWith('claude-')) return 'claude-other';
  return 'unknown';
}

function headerValue(headers, name) {
  if (!headers) return null;
  return headers.get?.(name) ?? headers[name] ?? headers[name.toLowerCase()] ?? null;
}

function parseNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseReset(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    if (numeric > 1e12) return new Date(numeric).toISOString();
    if (numeric > 1e9) return new Date(numeric * 1000).toISOString();
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function parseRetryAfter(headers) {
  const raw = headerValue(headers, 'retry-after');
  if (raw == null || raw === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return new Date(Date.now() + seconds * 1000).toISOString();
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function bucketFromHeaders(headers, prefix, nowIso) {
  const limit = parseNumber(headerValue(headers, `anthropic-ratelimit-${prefix}-limit`));
  const remaining = parseNumber(headerValue(headers, `anthropic-ratelimit-${prefix}-remaining`));
  const resetAt = parseReset(headerValue(headers, `anthropic-ratelimit-${prefix}-reset`));
  if (limit == null && remaining == null && resetAt == null) return null;
  return {
    limit,
    remaining,
    resetAt,
    updatedAt: nowIso,
    source: 'header',
  };
}

function infer429Reason(next) {
  const buckets = [
    ['requests', next.requests],
    ['input_tokens', next.inputTokens],
    ['output_tokens', next.outputTokens],
  ];
  const empty = buckets.find(([, bucket]) => bucket?.remaining != null && bucket.remaining <= 0);
  return empty?.[0] ?? 'unknown';
}

export function applyAnthropicRateLimitHeaders(state, {
  email,
  model,
  status,
  headers,
  now = new Date(),
} = {}) {
  if (!email) return state ?? emptyRateLimitState();
  const nextState = state && typeof state === 'object' ? state : emptyRateLimitState();
  if (!nextState.anthropic) nextState.anthropic = { accounts: {} };
  if (!nextState.anthropic.accounts) nextState.anthropic.accounts = {};

  const nowIso = now.toISOString();
  const modelGroup = normalizeAnthropicModelGroup(model);
  const account = nextState.anthropic.accounts[email] ?? {
    plan: 'unknown',
    modelGroups: {},
  };
  const existing = account.modelGroups?.[modelGroup] ?? { modelGroup };
  const next = {
    ...existing,
    modelGroup,
    requests: bucketFromHeaders(headers, 'requests', nowIso) ?? existing.requests,
    inputTokens: bucketFromHeaders(headers, 'input-tokens', nowIso) ?? existing.inputTokens,
    outputTokens: bucketFromHeaders(headers, 'output-tokens', nowIso) ?? existing.outputTokens,
    learnedFromHeadersAt: nowIso,
  };

  if (status === 429) {
    next.cooldownUntil = parseRetryAfter(headers)
      ?? next.requests?.resetAt
      ?? next.inputTokens?.resetAt
      ?? next.outputTokens?.resetAt
      ?? new Date(Date.now() + 60_000).toISOString();
    next.last429At = nowIso;
    next.last429Reason = infer429Reason(next);
  } else if (next.cooldownUntil && Date.parse(next.cooldownUntil) <= now.getTime()) {
    next.cooldownUntil = null;
  }

  account.modelGroups = { ...(account.modelGroups || {}), [modelGroup]: next };
  nextState.anthropic.accounts[email] = account;
  nextState.updatedAt = nowIso;
  nextState.version = RATE_LIMIT_STATE_VERSION;
  return nextState;
}

export function getAnthropicRateLimitBlock(state, email, model, now = new Date()) {
  const modelGroup = normalizeAnthropicModelGroup(model);
  const entry = state?.anthropic?.accounts?.[email]?.modelGroups?.[modelGroup];
  if (!entry) return { blocked: false, modelGroup, status: 'unknown' };
  const cooldownMs = entry.cooldownUntil ? Date.parse(entry.cooldownUntil) : NaN;
  if (Number.isFinite(cooldownMs) && cooldownMs > now.getTime()) {
    return {
      blocked: true,
      modelGroup,
      status: 'cooldown',
      until: entry.cooldownUntil,
      reason: entry.last429Reason ?? 'unknown',
    };
  }
  return { blocked: false, modelGroup, status: 'ok' };
}

function compactBucket(bucket, unit = '') {
  if (!bucket) return null;
  const limit = bucket.limit;
  const remaining = bucket.remaining;
  if (limit == null && remaining == null) return null;
  const suffix = unit ? unit : '';
  if (remaining != null && limit != null) return `${remaining}${suffix}/${limit}${suffix}`;
  if (remaining != null) return `${remaining}${suffix} left`;
  return `${limit}${suffix} limit`;
}

export function summarizeAnthropicRateLimit(entry, now = new Date()) {
  if (!entry) return 'api unknown';
  const cooldownMs = entry.cooldownUntil ? Date.parse(entry.cooldownUntil) : NaN;
  if (Number.isFinite(cooldownMs) && cooldownMs > now.getTime()) {
    const seconds = Math.max(1, Math.ceil((cooldownMs - now.getTime()) / 1000));
    const mins = Math.floor(seconds / 60);
    const rem = seconds % 60;
    const text = mins > 0 ? `${mins}m${rem ? `${rem}s` : ''}` : `${seconds}s`;
    return `cooldown ${text}${entry.last429Reason ? ` · 429 ${entry.last429Reason}` : ''}`;
  }
  const req = compactBucket(entry.requests);
  if (req) return `req ${req}`;
  const input = compactBucket(entry.inputTokens, 't');
  const output = compactBucket(entry.outputTokens, 't');
  if (input || output) return [input ? `in ${input}` : null, output ? `out ${output}` : null].filter(Boolean).join(' ');
  return 'api ok';
}
