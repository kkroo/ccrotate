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
      billingType: 'subscription_included', model: 'claude-opus-4-8', costCents: 0,
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
    expect(opus).toMatchObject({ inputTokens: 10, cachedInputTokens: 1000, outputTokens: 50, costCents: 0, billingType: 'subscription_included', biller: 'ccrotate' });
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
    expect(r.pending().get('claude-opus-4-7')).toEqual({ inputTokens: 5, cachedInputTokens: 0, outputTokens: 8 });
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
