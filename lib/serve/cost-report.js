// Operator-usage cost reporting for ccrotate serve.
//
// ccrotate serve proxies Claude traffic from two kinds of caller:
//   1. paperclip cluster agents — they send `x-paperclip-agent-id` and their
//      usage is ALREADY billed by paperclip-server's heartbeat ledger.
//   2. human/operator CLI sessions (devbox + MacBook Claude Code / Codex) —
//      no `x-paperclip-agent-id`; this usage is otherwise invisible to
//      paperclip billing.
//
// This module reports (2) ONLY — gated on the ABSENCE of a paperclip agent id
// in the request attribution — as paperclip `cost-events` against a dedicated
// "Operator (devbox)" attribution agent. Reporting cluster-agent traffic here
// would double-count it, so we never do.
//
// Subscription (Claude Max via the ccrotate pool) usage carries token counts
// but zero dollar cost (paperclip convention: subscription_included => 0¢).
// Token field mapping mirrors the paperclip claude adapter exactly:
//   inputTokens       = usage.input_tokens
//   cachedInputTokens = usage.cache_read_input_tokens
//   outputTokens      = usage.output_tokens
// (cache_creation is intentionally dropped — the claude adapter ignores it.)
//
// Everything here is best-effort and env-gated: when the env is not fully
// configured the reporter is a no-op, so serve behaves exactly as before.

// paperclip cost_events token columns are int4 (max 2,147,483,647). A single
// flush per model could exceed that, so we split a model's accumulated totals
// into multiple cost-events, each field <= CAP.
const INT4_CAP = 2_000_000_000;

// Per-1M-token list prices (USD), keyed by model family. Cache-read is billed at
// 0.1x base input (Anthropic + OpenAI both). cache_creation/write tokens are not
// tracked by this module (see header), so they are not priced — backfilled and
// live cost is therefore a slight UNDER-estimate for cache-heavy traffic.
//
// `cachedIncludedInInput` captures a provider difference in how `inputTokens` is
// reported (see mapUsage vs mapResponsesUsage):
//   - Anthropic /v1/messages: input_tokens EXCLUDES cache reads -> false
//   - OpenAI  /v1/responses : input_tokens INCLUDES the cached subset -> true
// When true, the cached subset is subtracted from input before pricing so it is
// not billed twice.
export function modelRateUsd(provider, model) {
  const m = normalizeModel(model);
  const isOpenAi = provider === 'openai' || /^(gpt|o[0-9]|chatgpt)/i.test(m);
  if (isOpenAi) {
    if (/gpt-5\.5/i.test(m)) return { in: 5, cacheRead: 0.5, out: 30, cachedIncludedInInput: true };
    return null;
  }
  // Anthropic families. cacheRead = 0.1x base input.
  if (/opus/i.test(m)) return { in: 5, cacheRead: 0.5, out: 25, cachedIncludedInInput: false };
  if (/sonnet/i.test(m)) return { in: 3, cacheRead: 0.3, out: 15, cachedIncludedInInput: false };
  if (/haiku/i.test(m)) return { in: 1, cacheRead: 0.1, out: 5, cachedIncludedInInput: false };
  return null;
}

// API-equivalent cost in integer cents for a token total, or null if the model
// has no known rate (caller then leaves it as subscription_included/0¢).
export function priceCents(provider, model, totals) {
  const rate = modelRateUsd(provider, model);
  if (!rate) return null;
  const cachedIn = toInt(totals && totals.cachedInputTokens);
  const rawIn = toInt(totals && totals.inputTokens);
  const out = toInt(totals && totals.outputTokens);
  const uncachedIn = rate.cachedIncludedInInput ? Math.max(0, rawIn - cachedIn) : rawIn;
  const usd = (uncachedIn * rate.in + cachedIn * rate.cacheRead + out * rate.out) / 1_000_000;
  return Math.max(0, Math.round(usd * 100));
}

export function costReportConfig(env = process.env) {
  const url = (env.CCROTATE_PAPERCLIP_COST_URL || '').replace(/\/+$/, '');
  const token = env.CCROTATE_PAPERCLIP_COST_TOKEN || '';
  const company = env.CCROTATE_PAPERCLIP_COST_COMPANY || '';
  const agentId = env.CCROTATE_PAPERCLIP_COST_AGENT_ID || '';
  const flushMs = Number.parseInt(env.CCROTATE_PAPERCLIP_COST_FLUSH_MS || '60000', 10);
  return {
    enabled: Boolean(url && token && company && agentId),
    url,
    token,
    company,
    agentId,
    flushMs: Number.isFinite(flushMs) && flushMs > 0 ? flushMs : 60000,
    provider: env.CCROTATE_PAPERCLIP_COST_PROVIDER || 'anthropic',
    biller: env.CCROTATE_PAPERCLIP_COST_BILLER || 'ccrotate',
    // Bill pool usage at API-equivalent rates (metered_api + computed cost)
    // instead of subscription_included/0¢. Default on; set to '0' to revert to
    // the old subscription behavior without a redeploy.
    metered: (env.CCROTATE_PAPERCLIP_COST_METERED || '1') !== '0',
  };
}

// Report only operator/devbox traffic: enabled AND no paperclip agent id.
export function shouldReport(attribution, cfg) {
  if (!cfg || !cfg.enabled) return false;
  const meta = attribution && attribution.metadata ? attribution.metadata : attribution;
  const agentId = meta && (meta.paperclipAgentId ?? meta.paperclip_agent_id);
  return !agentId;
}

// Normalize model ids so live reporting matches the backfill rollup.
export function normalizeModel(model) {
  if (!model || typeof model !== 'string') return 'unknown';
  let m = model.replace(/\[1m\]$/, '');
  if (m === 'sonnet') return 'claude-sonnet-4-6';
  if (m === 'haiku' || m === 'claude-haiku-4-5-20251001') return 'claude-haiku-4-5';
  return m;
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Map a raw Anthropic `usage` object to the three billed token fields.
export function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const out = {
    inputTokens: toInt(usage.input_tokens),
    cachedInputTokens: toInt(usage.cache_read_input_tokens),
    outputTokens: toInt(usage.output_tokens),
  };
  if (out.inputTokens === 0 && out.cachedInputTokens === 0 && out.outputTokens === 0) {
    return null;
  }
  return out;
}

// Parse a non-stream /v1/messages JSON response body for {model, usage}.
export function extractUsageFromJson(json) {
  if (!json || typeof json !== 'object') return null;
  const mapped = mapUsage(json.usage);
  if (!mapped) return null;
  return { model: json.model, usage: mapped };
}

// Map an OpenAI Responses-API usage object to the three billed token fields.
// In the Responses API `input_tokens` is the TOTAL input (includes cached) and
// the cached subset lives under `input_tokens_details.cached_tokens`. We mirror
// the paperclip codex adapter (codex-local parse.ts): inputTokens=input_tokens
// (NOT subtracting cached), cachedInputTokens=cached — so operator Codex usage
// is booked the same way cluster codex agents are.
export function mapResponsesUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const details = usage.input_tokens_details || usage.prompt_tokens_details || {};
  const out = {
    inputTokens: toInt(usage.input_tokens ?? usage.prompt_tokens),
    cachedInputTokens: toInt(details.cached_tokens ?? usage.cached_input_tokens ?? usage.cache_read_input_tokens),
    outputTokens: toInt(usage.output_tokens ?? usage.completion_tokens),
  };
  if (out.inputTokens === 0 && out.cachedInputTokens === 0 && out.outputTokens === 0) {
    return null;
  }
  return out;
}

// Parse a non-stream /v1/responses JSON body for {model, usage}. The body may be
// the response object itself or wrapped as { response: {...} }.
export function extractUsageFromResponsesJson(json) {
  if (!json || typeof json !== 'object') return null;
  const resp = json.response && typeof json.response === 'object' ? json.response : json;
  const mapped = mapResponsesUsage(resp.usage);
  if (!mapped) return null;
  return { model: resp.model, usage: mapped };
}

// Accumulate usage from a passing /v1/messages SSE stream WITHOUT altering it.
// message_start carries model + input/cache usage; message_delta carries the
// (cumulative) output usage. We keep the latest seen values.
export function createSseUsageAccumulator() {
  let buf = '';
  let model = null;
  let input = 0;
  let cached = 0;
  let output = 0;
  let seen = false;

  function handleData(dataStr) {
    let evt;
    try { evt = JSON.parse(dataStr); } catch { return; }
    if (!evt || typeof evt !== 'object') return;
    if (evt.type === 'message_start' && evt.message) {
      seen = true;
      if (typeof evt.message.model === 'string') model = evt.message.model;
      const u = evt.message.usage || {};
      input = toInt(u.input_tokens);
      cached = toInt(u.cache_read_input_tokens);
      if (toInt(u.output_tokens) > output) output = toInt(u.output_tokens);
    } else if ((evt.type === 'message_delta' || evt.type === 'message_stop') && evt.usage) {
      seen = true;
      if (toInt(evt.usage.output_tokens) > output) output = toInt(evt.usage.output_tokens);
      if (toInt(evt.usage.input_tokens) > input) input = toInt(evt.usage.input_tokens);
      if (toInt(evt.usage.cache_read_input_tokens) > cached) cached = toInt(evt.usage.cache_read_input_tokens);
    }
  }

  return {
    push(text) {
      buf += text;
      let idx;
      // SSE events are separated by blank lines; process complete lines.
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.startsWith('data:')) handleData(line.slice(5).trim());
      }
    },
    result() {
      if (!seen) return null;
      const usage = { input_tokens: input, cache_read_input_tokens: cached, output_tokens: output };
      const mapped = mapUsage(usage);
      if (!mapped) return null;
      return { model, usage: mapped };
    },
  };
}

// Accumulate usage from a /v1/responses SSE stream WITHOUT altering it. The
// terminal `response.completed` (or `response.incomplete`) event carries the
// full `response.model` + `response.usage`.
export function createResponsesSseAccumulator() {
  let buf = '';
  let result = null;

  function handleData(dataStr) {
    if (!dataStr || dataStr === '[DONE]') return;
    let evt;
    try { evt = JSON.parse(dataStr); } catch { return; }
    if (!evt || typeof evt !== 'object') return;
    if ((evt.type === 'response.completed' || evt.type === 'response.incomplete') && evt.response) {
      const mapped = mapResponsesUsage(evt.response.usage);
      if (mapped) result = { model: evt.response.model, usage: mapped };
    }
  }

  return {
    push(text) {
      buf += text;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.startsWith('data:')) handleData(line.slice(5).trim());
      }
    },
    result() {
      return result;
    },
  };
}

// Build cost-event POST bodies for one (provider, model)'s accumulated totals,
// splitting any field that exceeds the int4 cap into multiple events. `provider`
// is per-endpoint (anthropic for /v1/messages, openai for /v1/responses) because
// a single serve pod handles both; it falls back to cfg.provider.
export function buildCostEvents(cfg, agentId, model, totals, occurredAtIso, provider) {
  const rem = {
    inputTokens: totals.inputTokens,
    cachedInputTokens: totals.cachedInputTokens,
    outputTokens: totals.outputTokens,
  };
  const nrows = Math.max(
    1,
    Math.ceil(rem.inputTokens / INT4_CAP),
    Math.ceil(rem.cachedInputTokens / INT4_CAP),
    Math.ceil(rem.outputTokens / INT4_CAP),
  );
  const eventProvider = provider || cfg.provider;
  // When metered, price each int4-split chunk from its own token slice so the
  // summed cost across chunks equals pricing the whole. Unknown models (null
  // rate) stay subscription_included/0¢ — never fabricate a metered $0.
  const cents = cfg.metered ? priceCents(eventProvider, model, totals) : null;
  const metered = cents !== null;
  const events = [];
  for (let i = 0; i < nrows; i++) {
    const chunk = {};
    for (const k of Object.keys(rem)) {
      const take = Math.min(rem[k], INT4_CAP);
      chunk[k] = take;
      rem[k] -= take;
    }
    events.push({
      agentId,
      provider: eventProvider,
      biller: cfg.biller,
      billingType: metered ? 'metered_api' : 'subscription_included',
      model: normalizeModel(model),
      inputTokens: chunk.inputTokens,
      cachedInputTokens: chunk.cachedInputTokens,
      outputTokens: chunk.outputTokens,
      costCents: metered ? priceCents(eventProvider, model, chunk) : 0,
      occurredAt: occurredAtIso,
    });
  }
  return events;
}

/**
 * Create the operator cost reporter.
 *
 * opts:
 *   cfg        — costReportConfig() result (defaults to env)
 *   fetchImpl  — fetch implementation (defaults to global fetch); test injection
 *   nowIso     — () => ISO string (test injection)
 *   log        — { info, warn } (optional)
 */
export function createCostReporter(opts = {}) {
  const cfg = opts.cfg || costReportConfig();
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const nowIso = opts.nowIso || (() => new Date().toISOString());
  const log = opts.log || null;
  // keyed by `${provider}:${model}` -> {provider, model, inputTokens, cachedInputTokens, outputTokens}
  const agg = new Map();
  let timer = null;

  function record(model, usage, provider) {
    const mapped = usage && (usage.inputTokens !== undefined ? usage : mapUsage(usage));
    if (!mapped) return;
    const prov = provider || cfg.provider;
    const m = normalizeModel(model);
    const key = `${prov}:${m}`;
    const cur = agg.get(key) || { provider: prov, model: m, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    cur.inputTokens += mapped.inputTokens;
    cur.cachedInputTokens += mapped.cachedInputTokens;
    cur.outputTokens += mapped.outputTokens;
    agg.set(key, cur);
  }

  async function flush() {
    if (!cfg.enabled || agg.size === 0) return { posted: 0, failed: 0 };
    // Snapshot + clear so concurrent records during the await aren't lost on
    // success and aren't double-posted.
    const snapshot = [...agg.entries()];
    agg.clear();
    const occurredAtIso = nowIso();
    const url = `${cfg.url}/companies/${cfg.company}/cost-events`;
    let posted = 0;
    let failed = 0;
    for (const [key, totals] of snapshot) {
      const events = buildCostEvents(cfg, cfg.agentId, totals.model, totals, occurredAtIso, totals.provider);
      let modelFailed = false;
      for (const body of events) {
        try {
          const resp = await fetchImpl(url, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${cfg.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          });
          if (resp && (resp.status === 201 || resp.ok)) {
            posted++;
          } else {
            failed++;
            modelFailed = true;
          }
        } catch (e) {
          failed++;
          modelFailed = true;
          if (log) log.warn({ err: String(e?.message ?? e), provider: totals.provider, model: totals.model }, 'cost-report flush error');
          break;
        }
      }
      // Re-queue this (provider, model)'s totals if any event failed, so we
      // retry on the next flush rather than dropping usage.
      if (modelFailed) {
        const cur = agg.get(key) || { provider: totals.provider, model: totals.model, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
        cur.inputTokens += totals.inputTokens;
        cur.cachedInputTokens += totals.cachedInputTokens;
        cur.outputTokens += totals.outputTokens;
        agg.set(key, cur);
      }
    }
    if (log && (posted || failed)) log.info({ posted, failed }, 'cost-report flush');
    return { posted, failed };
  }

  return {
    cfg,
    shouldReport: (attribution) => shouldReport(attribution, cfg),
    // Record from a parsed non-stream messages JSON body (always anthropic).
    recordFromJson(json, fallbackModel) {
      const ext = extractUsageFromJson(json);
      if (ext) record(ext.model || fallbackModel, ext.usage, 'anthropic');
    },
    // Wrap a messages SSE async-generator: yields chunks unchanged, records at end.
    async *tapStream(innerGen, fallbackModel) {
      const acc = createSseUsageAccumulator();
      const decoder = new TextDecoder();
      try {
        for await (const chunk of innerGen) {
          if (typeof chunk === 'string') acc.push(chunk);
          else acc.push(decoder.decode(chunk, { stream: true }));
          yield chunk;
        }
      } finally {
        const ext = acc.result();
        if (ext) record(ext.model || fallbackModel, ext.usage, 'anthropic');
      }
    },
    // Record from a parsed non-stream /v1/responses JSON body (always openai).
    recordFromResponsesJson(json, fallbackModel) {
      const ext = extractUsageFromResponsesJson(json);
      if (ext) record(ext.model || fallbackModel, ext.usage, 'openai');
    },
    // Wrap a /v1/responses SSE async-generator: yields chunks unchanged, records at end.
    async *tapResponsesStream(innerGen, fallbackModel) {
      const acc = createResponsesSseAccumulator();
      const decoder = new TextDecoder();
      try {
        for await (const chunk of innerGen) {
          if (typeof chunk === 'string') acc.push(chunk);
          else acc.push(decoder.decode(chunk, { stream: true }));
          yield chunk;
        }
      } finally {
        const ext = acc.result();
        if (ext) record(ext.model || fallbackModel, ext.usage, 'openai');
      }
    },
    record,
    flush,
    pending: () => new Map(agg),
    start() {
      if (timer || !cfg.enabled) return;
      timer = setInterval(() => { void flush(); }, cfg.flushMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    async stop() {
      if (timer) { clearInterval(timer); timer = null; }
      await flush();
    },
  };
}
