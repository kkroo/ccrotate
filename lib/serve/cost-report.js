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

// Build cost-event POST bodies for one model's accumulated totals, splitting
// any field that exceeds the int4 cap into multiple events.
export function buildCostEvents(cfg, agentId, model, totals, occurredAtIso) {
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
      provider: cfg.provider,
      biller: cfg.biller,
      billingType: 'subscription_included',
      model: normalizeModel(model),
      inputTokens: chunk.inputTokens,
      cachedInputTokens: chunk.cachedInputTokens,
      outputTokens: chunk.outputTokens,
      costCents: 0,
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
  const agg = new Map(); // model -> {inputTokens, cachedInputTokens, outputTokens}
  let timer = null;

  function record(model, usage) {
    const mapped = usage && (usage.inputTokens !== undefined ? usage : mapUsage(usage));
    if (!mapped) return;
    const key = normalizeModel(model);
    const cur = agg.get(key) || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
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
    for (const [model, totals] of snapshot) {
      const events = buildCostEvents(cfg, cfg.agentId, model, totals, occurredAtIso);
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
          if (log) log.warn({ err: String(e?.message ?? e), model }, 'cost-report flush error');
          break;
        }
      }
      // Re-queue the model's totals if any of its events failed, so we retry
      // on the next flush rather than dropping usage.
      if (modelFailed) {
        const cur = agg.get(model) || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
        cur.inputTokens += totals.inputTokens;
        cur.cachedInputTokens += totals.cachedInputTokens;
        cur.outputTokens += totals.outputTokens;
        agg.set(model, cur);
      }
    }
    if (log && (posted || failed)) log.info({ posted, failed }, 'cost-report flush');
    return { posted, failed };
  }

  return {
    cfg,
    shouldReport: (attribution) => shouldReport(attribution, cfg),
    // Record from a parsed non-stream messages JSON body.
    recordFromJson(json, fallbackModel) {
      const ext = extractUsageFromJson(json);
      if (ext) record(ext.model || fallbackModel, ext.usage);
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
        if (ext) record(ext.model || fallbackModel, ext.usage);
      }
    },
    // Record from a parsed non-stream /v1/responses JSON body.
    recordFromResponsesJson(json, fallbackModel) {
      const ext = extractUsageFromResponsesJson(json);
      if (ext) record(ext.model || fallbackModel, ext.usage);
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
        if (ext) record(ext.model || fallbackModel, ext.usage);
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
