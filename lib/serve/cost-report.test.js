import { describe, it, expect, vi } from 'vitest';
import {
  costReportConfig,
  shouldReport,
  normalizeModel,
  mapUsage,
  extractUsageFromJson,
  createSseUsageAccumulator,
  buildCostEvents,
  createCostReporter,
  mapResponsesUsage,
  extractUsageFromResponsesJson,
  createResponsesSseAccumulator,
  modelRateUsd,
  priceCents,
} from './cost-report.js';

const FULL_ENV = {
  CCROTATE_PAPERCLIP_COST_URL: 'https://paperclip.example/api/',
  CCROTATE_PAPERCLIP_COST_TOKEN: 'pcp_test',
  CCROTATE_PAPERCLIP_COST_COMPANY: 'co-1',
  CCROTATE_PAPERCLIP_COST_AGENT_ID: 'agent-1',
};

describe('costReportConfig', () => {
  it('is enabled only when all four required vars are present; trims trailing slash', () => {
    const cfg = costReportConfig(FULL_ENV);
    expect(cfg.enabled).toBe(true);
    expect(cfg.url).toBe('https://paperclip.example/api');
    expect(cfg.flushMs).toBe(60000);
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.biller).toBe('ccrotate');
  });
  it('is disabled when any required var is missing', () => {
    for (const k of Object.keys(FULL_ENV)) {
      const env = { ...FULL_ENV }; delete env[k];
      expect(costReportConfig(env).enabled).toBe(false);
    }
    expect(costReportConfig({}).enabled).toBe(false);
  });
});

describe('costReportConfig — metered toggle', () => {
  it('defaults metered to true', () => {
    expect(costReportConfig(FULL_ENV).metered).toBe(true);
  });
  it('disables metered when CCROTATE_PAPERCLIP_COST_METERED=0', () => {
    expect(costReportConfig({ ...FULL_ENV, CCROTATE_PAPERCLIP_COST_METERED: '0' }).metered).toBe(false);
  });
});

describe('modelRateUsd / priceCents', () => {
  it('prices Anthropic models by family; input excludes cache reads', () => {
    // opus: $5 in / $0.50 cache-read / $25 out per 1M.
    // 1M uncached input + 0.5M cache-read + 1M output = 5 + 0.25 + 25 = $30.25 = 3025¢
    expect(priceCents('anthropic', 'claude-opus-4-8', {
      inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 1_000_000,
    })).toBe(3025);
    // opus-4-7 priced same as 4-8
    expect(priceCents('anthropic', 'claude-opus-4-7', { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })).toBe(500);
    // sonnet: $3 / $0.30 / $15
    expect(priceCents('anthropic', 'claude-sonnet-4-6', { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 })).toBe(1800);
    // sonnet-4-5 dated id folds to sonnet family
    expect(priceCents('anthropic', 'claude-sonnet-4-5-20250929', { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })).toBe(300);
    // haiku: $1 / $0.10 / $5
    expect(priceCents('anthropic', 'claude-haiku-4-5', { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 })).toBe(600);
  });
  it('prices OpenAI gpt-5.5; input INCLUDES cache so cached subset is subtracted', () => {
    // gpt-5.5: $5 in / $0.50 cache-read / $30 out. inputTokens=1M total incl 200k cached.
    // uncached 800k*$5 + 200k*$0.50 + 1M*$30 = 4.0 + 0.10 + 30.0 = $34.10 = 3410¢
    expect(priceCents('openai', 'gpt-5.5', {
      inputTokens: 1_000_000, cachedInputTokens: 200_000, outputTokens: 1_000_000,
    })).toBe(3410);
  });
  it('returns null for unknown models (caller falls back to subscription/0)', () => {
    expect(modelRateUsd('anthropic', 'mystery-model-9')).toBeNull();
    expect(priceCents('anthropic', 'mystery-model-9', { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })).toBeNull();
  });
});

describe('buildCostEvents — metered pricing', () => {
  const meteredCfg = { provider: 'anthropic', biller: 'ccrotate', metered: true };
  it('emits metered_api with computed costCents for a priceable model', () => {
    const ev = buildCostEvents(meteredCfg, 'agent-1', 'claude-opus-4-8',
      { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 1_000_000 }, 'NOW', 'anthropic');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ billingType: 'metered_api', costCents: 3025, model: 'claude-opus-4-8' });
  });
  it('falls back to subscription_included/0 for unknown models even when metered', () => {
    const ev = buildCostEvents(meteredCfg, 'agent-1', 'mystery-model-9',
      { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 }, 'NOW', 'anthropic');
    expect(ev[0]).toMatchObject({ billingType: 'subscription_included', costCents: 0 });
  });
  it('keeps subscription_included/0 when metered is disabled', () => {
    const subCfg = { provider: 'anthropic', biller: 'ccrotate', metered: false };
    const ev = buildCostEvents(subCfg, 'agent-1', 'claude-opus-4-8',
      { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 }, 'NOW', 'anthropic');
    expect(ev[0]).toMatchObject({ billingType: 'subscription_included', costCents: 0 });
  });
  it('prices each int4-split chunk so the summed cost matches the whole', () => {
    // 3e9 output tokens on opus ($25/1M) splits into 2 chunks; total = 3000 * $25 = $75,000 = 7,500,000¢
    const ev = buildCostEvents(meteredCfg, 'agent-1', 'claude-opus-4-8',
      { inputTokens: 0, cachedInputTokens: 0, outputTokens: 3_000_000_000 }, 'NOW', 'anthropic');
    expect(ev.length).toBe(2);
    const total = ev.reduce((s, e) => s + e.costCents, 0);
    expect(total).toBe(7_500_000);
    expect(ev.every((e) => e.billingType === 'metered_api')).toBe(true);
  });
});

describe('shouldReport — operator-only gate', () => {
  const cfg = costReportConfig(FULL_ENV);
  it('reports when enabled and no paperclip agent id', () => {
    expect(shouldReport({ metadata: {} }, cfg)).toBe(true);
    expect(shouldReport({ metadata: { paperclipAgentId: null } }, cfg)).toBe(true);
    expect(shouldReport({ paperclipAgentId: null }, cfg)).toBe(true);
  });
  it('does NOT report cluster-agent traffic (agent id present)', () => {
    expect(shouldReport({ metadata: { paperclipAgentId: 'agent-x' } }, cfg)).toBe(false);
    expect(shouldReport({ paperclipAgentId: 'agent-x' }, cfg)).toBe(false);
  });
  it('does NOT report when disabled', () => {
    expect(shouldReport({ metadata: {} }, costReportConfig({}))).toBe(false);
  });
});

describe('normalizeModel', () => {
  it('strips [1m] and folds aliases', () => {
    expect(normalizeModel('claude-opus-4-7[1m]')).toBe('claude-opus-4-7');
    expect(normalizeModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(normalizeModel('sonnet')).toBe('claude-sonnet-4-6');
    expect(normalizeModel('claude-opus-4-8')).toBe('claude-opus-4-8');
  });
});

describe('mapUsage / extractUsageFromJson', () => {
  it('maps cache_read -> cachedInputTokens and drops cache_creation', () => {
    expect(mapUsage({ input_tokens: 10, cache_creation_input_tokens: 999, cache_read_input_tokens: 50, output_tokens: 7 }))
      .toEqual({ inputTokens: 10, cachedInputTokens: 50, outputTokens: 7 });
  });
  it('returns null for all-zero / missing usage', () => {
    expect(mapUsage({})).toBeNull();
    expect(mapUsage(null)).toBeNull();
    expect(extractUsageFromJson({ model: 'x' })).toBeNull();
  });
  it('extracts model + usage from a messages JSON body', () => {
    expect(extractUsageFromJson({ model: 'claude-opus-4-7', usage: { input_tokens: 3, cache_read_input_tokens: 100, output_tokens: 9 } }))
      .toEqual({ model: 'claude-opus-4-7', usage: { inputTokens: 3, cachedInputTokens: 100, outputTokens: 9 } });
  });
});

describe('createSseUsageAccumulator', () => {
  it('accumulates input/cache from message_start and output from message_delta across chunks', () => {
    const acc = createSseUsageAccumulator();
    acc.push('event: message_start\n');
    acc.push('data: {"type":"message_start","message":{"model":"claude-opus-4-7","usage":{"input_tokens":12,"cache_read_input_tokens":3400,"output_tokens":1}}}\n\n');
    acc.push('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":256}}\n\n');
    expect(acc.result()).toEqual({
      model: 'claude-opus-4-7',
      usage: { inputTokens: 12, cachedInputTokens: 3400, outputTokens: 256 },
    });
  });
  it('returns null when no usage events seen', () => {
    const acc = createSseUsageAccumulator();
    acc.push('event: ping\ndata: {"type":"ping"}\n\n');
    expect(acc.result()).toBeNull();
  });
});

describe('buildCostEvents — int4 splitting', () => {
  const cfg = costReportConfig(FULL_ENV);
  it('emits a single event under the cap', () => {
    const ev = buildCostEvents(cfg, 'agent-1', 'claude-opus-4-8', { inputTokens: 100, cachedInputTokens: 200, outputTokens: 50 }, 'NOW');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      agentId: 'agent-1', provider: 'anthropic', biller: 'ccrotate',
      billingType: 'metered_api', model: 'claude-opus-4-8', costCents: 0,
      inputTokens: 100, cachedInputTokens: 200, outputTokens: 50, occurredAt: 'NOW',
    });
  });
  it('splits a field exceeding the int4 cap, preserving the total', () => {
    const ev = buildCostEvents(cfg, 'agent-1', 'm', { inputTokens: 0, cachedInputTokens: 5_000_000_000, outputTokens: 0 }, 'NOW');
    expect(ev).toHaveLength(3); // ceil(5e9 / 2e9)
    expect(ev.every((e) => e.cachedInputTokens <= 2_000_000_000)).toBe(true);
    expect(ev.reduce((s, e) => s + e.cachedInputTokens, 0)).toBe(5_000_000_000);
  });
});

describe('createCostReporter — flush + tapStream', () => {
  function okFetch() {
    return vi.fn(async () => ({ status: 201, ok: true }));
  }

  it('records and flushes one POST per model with correct payload', async () => {
    const fetchImpl = okFetch();
    const r = createCostReporter({ cfg: costReportConfig(FULL_ENV), fetchImpl, nowIso: () => 'T0' });
    r.record('claude-opus-4-7[1m]', { input_tokens: 5, cache_read_input_tokens: 1000, output_tokens: 42 });
    r.record('claude-opus-4-7', { input_tokens: 5, cache_read_input_tokens: 0, output_tokens: 8 });
    r.record('claude-sonnet-4-6', { input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3 });
    const res = await r.flush();
    expect(res).toEqual({ posted: 2, failed: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const bodies = fetchImpl.mock.calls.map((c) => JSON.parse(c[1].body));
    const opus = bodies.find((b) => b.model === 'claude-opus-4-7');
    expect(opus).toMatchObject({ inputTokens: 10, cachedInputTokens: 1000, outputTokens: 50, costCents: 0, billingType: 'metered_api', biller: 'ccrotate' });
    // url + auth
    expect(fetchImpl.mock.calls[0][0]).toBe('https://paperclip.example/api/companies/co-1/cost-events');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer pcp_test');
  });

  it('clears the buffer after a successful flush', async () => {
    const r = createCostReporter({ cfg: costReportConfig(FULL_ENV), fetchImpl: okFetch(), nowIso: () => 'T0' });
    r.record('m', { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 0 });
    await r.flush();
    expect(r.pending().size).toBe(0);
  });

  it('re-queues usage when a POST fails (no data loss)', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 500, ok: false }));
    const r = createCostReporter({ cfg: costReportConfig(FULL_ENV), fetchImpl, nowIso: () => 'T0' });
    r.record('claude-opus-4-7', { input_tokens: 5, cache_read_input_tokens: 0, output_tokens: 8 });
    const res = await r.flush();
    expect(res.failed).toBe(1);
    expect(r.pending().get('anthropic:claude-opus-4-7')).toMatchObject({ provider: 'anthropic', model: 'claude-opus-4-7', inputTokens: 5, cachedInputTokens: 0, outputTokens: 8 });
  });

  it('is a no-op flush when disabled', async () => {
    const fetchImpl = okFetch();
    const r = createCostReporter({ cfg: costReportConfig({}), fetchImpl });
    r.record('m', { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 });
    expect(await r.flush()).toEqual({ posted: 0, failed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('tapStream yields chunks unchanged and records usage at end', async () => {
    const fetchImpl = okFetch();
    const r = createCostReporter({ cfg: costReportConfig(FULL_ENV), fetchImpl, nowIso: () => 'T0' });
    const enc = new TextEncoder();
    async function* inner() {
      yield enc.encode('event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-4-8","usage":{"input_tokens":2,"cache_read_input_tokens":900,"output_tokens":0}}}\n\n');
      yield enc.encode('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":77}}\n\n');
    }
    const out = [];
    for await (const c of r.tapStream(inner(), 'claude-opus-4-8')) out.push(c);
    expect(out).toHaveLength(2); // chunks passed through unchanged
    await r.flush();
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toMatchObject({ model: 'claude-opus-4-8', inputTokens: 2, cachedInputTokens: 900, outputTokens: 77 });
  });
});

describe('Responses-API (Codex) usage', () => {
  it('mapResponsesUsage: cached from input_tokens_details.cached_tokens, input not subtracted', () => {
    expect(mapResponsesUsage({ input_tokens: 1000, output_tokens: 50, input_tokens_details: { cached_tokens: 800 } }))
      .toEqual({ inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50 });
  });
  it('mapResponsesUsage: falls back to cached_input_tokens / prompt_tokens / completion_tokens', () => {
    expect(mapResponsesUsage({ prompt_tokens: 10, completion_tokens: 3, cached_input_tokens: 4 }))
      .toEqual({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 3 });
    expect(mapResponsesUsage({})).toBeNull();
  });
  it('extractUsageFromResponsesJson handles bare body and {response:{}} wrapper', () => {
    expect(extractUsageFromResponsesJson({ model: 'gpt-5.5', usage: { input_tokens: 7, output_tokens: 2, input_tokens_details: { cached_tokens: 1 } } }))
      .toEqual({ model: 'gpt-5.5', usage: { inputTokens: 7, cachedInputTokens: 1, outputTokens: 2 } });
    expect(extractUsageFromResponsesJson({ response: { model: 'gpt-5.5', usage: { input_tokens: 7, output_tokens: 2 } } }))
      .toEqual({ model: 'gpt-5.5', usage: { inputTokens: 7, cachedInputTokens: 0, outputTokens: 2 } });
  });
  it('createResponsesSseAccumulator captures response.completed usage + model', () => {
    const acc = createResponsesSseAccumulator();
    acc.push('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n');
    acc.push('event: response.completed\n');
    acc.push('data: {"type":"response.completed","response":{"model":"gpt-5.5","usage":{"input_tokens":1200,"output_tokens":340,"input_tokens_details":{"cached_tokens":900}}}}\n\n');
    expect(acc.result()).toEqual({ model: 'gpt-5.5', usage: { inputTokens: 1200, cachedInputTokens: 900, outputTokens: 340 } });
  });
  it('createResponsesSseAccumulator returns null when no completed event', () => {
    const acc = createResponsesSseAccumulator();
    acc.push('event: response.created\ndata: {"type":"response.created","response":{}}\n\n');
    expect(acc.result()).toBeNull();
  });

  it('recordFromResponsesJson → flush posts an openai-provider event (per-endpoint, even when cfg default is anthropic)', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 201, ok: true }));
    const r = createCostReporter({ cfg: costReportConfig(FULL_ENV), fetchImpl, nowIso: () => 'T0' }); // FULL_ENV → default provider anthropic
    r.recordFromResponsesJson({ model: 'gpt-5.5', usage: { input_tokens: 1000, output_tokens: 50, input_tokens_details: { cached_tokens: 800 } } }, 'fallback');
    await r.flush();
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toMatchObject({ provider: 'openai', biller: 'ccrotate', billingType: 'metered_api', costCents: 0, model: 'gpt-5.5', inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50 });
  });

  it('messages → anthropic, responses → openai are kept as separate (provider,model) events in one reporter', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 201, ok: true }));
    const r = createCostReporter({ cfg: costReportConfig(FULL_ENV), fetchImpl, nowIso: () => 'T0' });
    r.recordFromJson({ model: 'claude-opus-4-7', usage: { input_tokens: 5, cache_read_input_tokens: 0, output_tokens: 8 } }, 'm');
    r.recordFromResponsesJson({ model: 'gpt-5.5', usage: { input_tokens: 11, output_tokens: 9 } }, 'm');
    const res = await r.flush();
    expect(res.posted).toBe(2);
    const bodies = fetchImpl.mock.calls.map((c) => JSON.parse(c[1].body));
    expect(bodies.find((b) => b.model === 'claude-opus-4-7').provider).toBe('anthropic');
    expect(bodies.find((b) => b.model === 'gpt-5.5').provider).toBe('openai');
  });

  it('tapResponsesStream yields chunks unchanged and records at end', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 201, ok: true }));
    const r = createCostReporter({ cfg: costReportConfig(FULL_ENV), fetchImpl, nowIso: () => 'T0' });
    const enc = new TextEncoder();
    async function* inner() {
      yield enc.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"x"}\n\n');
      yield enc.encode('event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-5.5","usage":{"input_tokens":11,"output_tokens":9,"input_tokens_details":{"cached_tokens":3}}}}\n\n');
    }
    const out = [];
    for await (const c of r.tapResponsesStream(inner(), 'gpt-5.5')) out.push(c);
    expect(out).toHaveLength(2);
    await r.flush();
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toMatchObject({ provider: 'openai', model: 'gpt-5.5', inputTokens: 11, cachedInputTokens: 3, outputTokens: 9 });
  });
});
