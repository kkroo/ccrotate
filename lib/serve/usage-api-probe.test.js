import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeUsageApi, toPercent } from './usage-api-probe.js';

// The shared describe-level reset wipes the module-level cooldown/LKG/inFlight
// maps between tests. Without it the in-flight dedup or cooldown TTL would
// leak across cases (the maps live for the lifetime of the imported module).
beforeEach(async () => {
  delete process.env.CCROTATE_USAGE_PROBE_DISABLED;
  await probeUsageApi('', { _reset: true });
});
afterEach(() => { vi.restoreAllMocks(); });

function fakeUsageResponse({ five = 0.14, seven = 0.03 } = {}) {
  return {
    statusCode: 200,
    headers: {},
    body: JSON.stringify({
      five_hour: { utilization: five, resets_at: '2026-05-20T01:09:59Z' },
      seven_day: { utilization: seven, resets_at: '2026-05-26T13:00:00Z' },
    }),
  };
}

describe('toPercent', () => {
  it('passes through 0-100 integer percents', () => {
    expect(toPercent(75)).toBe(75);
    expect(toPercent(100)).toBe(100);
    expect(toPercent(0)).toBe(0);
  });
  it('scales 0-1 fractions to 0-100 percents', () => {
    expect(toPercent(0.14)).toBe(14);
    expect(toPercent(0.95)).toBe(95);
  });
  it('returns null for null/undefined', () => {
    expect(toPercent(null)).toBe(null);
    expect(toPercent(undefined)).toBe(null);
  });
});

describe('probeUsageApi', () => {
  it('parses 200 OK into normalized percentages', async () => {
    const fetcher = vi.fn(async () => fakeUsageResponse({ five: 0.14, seven: 0.03 }));
    const r = await probeUsageApi('TOK', { _fetch: fetcher });
    expect(r).toEqual({ utilization5h: 14, utilization7d: 3, stale: false });
  });

  it('treats both legacy fraction (0-1) and modern percent (0-100) shapes identically', async () => {
    const fetcher = vi.fn(async () => ({
      statusCode: 200, headers: {},
      body: JSON.stringify({ five_hour: { utilization: 95 }, seven_day: { utilization: 0.95 } }),
    }));
    const r = await probeUsageApi('TOK', { _fetch: fetcher });
    expect(r).toEqual({ utilization5h: 95, utilization7d: 95, stale: false });
  });

  it('returns null on non-200 non-429 status (eg 401)', async () => {
    const fetcher = vi.fn(async () => ({ statusCode: 401, headers: {}, body: 'unauthorized' }));
    expect(await probeUsageApi('TOK', { _fetch: fetcher })).toBe(null);
  });

  it('returns null on fetch error', async () => {
    const fetcher = vi.fn(async () => null);
    expect(await probeUsageApi('TOK', { _fetch: fetcher })).toBe(null);
  });

  it('caches successful results as LKG and serves them stale during 429 cooldown', async () => {
    const successFetcher = vi.fn(async () => fakeUsageResponse({ five: 0.14, seven: 0.03 }));
    const first = await probeUsageApi('TOK', { _fetch: successFetcher });
    expect(first.stale).toBe(false);

    // Token is now LKG-populated. Force a 429 — we should get the LKG back
    // tagged stale, and the cooldown should persist.
    const limitFetcher = vi.fn(async () => ({
      statusCode: 429, headers: { 'retry-after': '60' }, body: 'too many',
    }));
    const second = await probeUsageApi('TOK', { _fetch: limitFetcher });
    expect(second).toEqual({ utilization5h: 14, utilization7d: 3, stale: true });

    // A subsequent probe should hit cooldown — no upstream call.
    const noCallFetcher = vi.fn(async () => { throw new Error('should not be called'); });
    const third = await probeUsageApi('TOK', { _fetch: noCallFetcher });
    expect(third).toEqual({ utilization5h: 14, utilization7d: 3, stale: true });
    expect(noCallFetcher).not.toHaveBeenCalled();
  });

  it('respects retry-after via the injected _now clock to expire cooldowns', async () => {
    // Seed an LKG so the cooldown branch has something to return.
    await probeUsageApi('TOK', { _fetch: vi.fn(async () => fakeUsageResponse()) });
    // 429 with retry-after:30 captures 30s cooldown.
    const t0 = 1_000_000_000_000; // arbitrary epoch ms
    const tries = [];
    const fetcher = vi.fn(async () => {
      tries.push('called');
      return { statusCode: 429, headers: { 'retry-after': '30' }, body: '' };
    });
    await probeUsageApi('TOK', { _fetch: fetcher, _now: () => t0 });
    expect(tries.length).toBe(1);

    // Within the 30s window — cooldown, no upstream call.
    await probeUsageApi('TOK', { _fetch: fetcher, _now: () => t0 + 10_000 });
    expect(tries.length).toBe(1);

    // After the 30s window — upstream call happens again.
    fetcher.mockImplementationOnce(async () => { tries.push('again'); return fakeUsageResponse(); });
    await probeUsageApi('TOK', { _fetch: fetcher, _now: () => t0 + 31_000 });
    expect(tries.length).toBe(2);
  });

  it('dedups concurrent probes for the same token', async () => {
    let resolveFetch;
    const fetcher = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const p1 = probeUsageApi('TOK', { _fetch: fetcher });
    const p2 = probeUsageApi('TOK', { _fetch: fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolveFetch(fakeUsageResponse());
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
  });

  it('returns null and does not fetch when CCROTATE_USAGE_PROBE_DISABLED=1', async () => {
    process.env.CCROTATE_USAGE_PROBE_DISABLED = '1';
    const fetcher = vi.fn(async () => fakeUsageResponse());
    const r = await probeUsageApi('TOK', { _fetch: fetcher });
    expect(r).toBe(null);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
