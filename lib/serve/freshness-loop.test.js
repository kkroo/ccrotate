import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startFreshnessLoop, pickStaleEntry, probeOne } from './freshness-loop.js';

const NOW = Date.parse('2026-05-17T08:00:00Z');

function entry(email, overrides = {}) {
  return {
    email,
    status: 'success',
    serviceTier: 'exhausted',
    rateLimits: {
      snapshotCapturedAt: new Date(NOW - 10 * 60 * 1000).toISOString(), // 10min old
    },
    ...overrides,
  };
}

function profile(email, expiresAt = NOW + 3600_000) {
  return {
    credentials: {
      claudeAiOauth: { accessToken: 'tok', expiresAt },
    },
  };
}

describe('pickStaleEntry', () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(NOW));
  afterEach(() => vi.useRealTimers());

  it('picks an exhausted entry whose snapshot is older than staleMinAgeMs', () => {
    const cache = { accounts: [entry('a@x.com')] };
    const profiles = { 'a@x.com': profile('a@x.com') };
    const got = pickStaleEntry(cache, profiles, { staleMinAgeMs: 5 * 60_000, rotationIndex: 0 });
    expect(got).toMatchObject({ email: 'a@x.com' });
  });

  it('skips entries whose snapshot is too recent', () => {
    const fresh = entry('a@x.com', {
      rateLimits: { snapshotCapturedAt: new Date(NOW - 30_000).toISOString() }, // 30s old
    });
    const cache = { accounts: [fresh] };
    const profiles = { 'a@x.com': profile('a@x.com') };
    const got = pickStaleEntry(cache, profiles, { staleMinAgeMs: 5 * 60_000, rotationIndex: 0 });
    expect(got).toBeNull();
  });

  it('skips entries whose token is expired', () => {
    const cache = { accounts: [entry('a@x.com')] };
    const profiles = { 'a@x.com': profile('a@x.com', NOW - 1000) }; // expired
    const got = pickStaleEntry(cache, profiles, { staleMinAgeMs: 5 * 60_000, rotationIndex: 0 });
    expect(got).toBeNull();
  });

  it('skips healthy entries (serviceTier=base, status=success)', () => {
    const healthy = entry('a@x.com', { serviceTier: 'base' });
    const cache = { accounts: [healthy] };
    const profiles = { 'a@x.com': profile('a@x.com') };
    const got = pickStaleEntry(cache, profiles, { staleMinAgeMs: 5 * 60_000, rotationIndex: 0 });
    expect(got).toBeNull();
  });

  it('treats status="error" as eligible (cache may be wrong)', () => {
    const errored = entry('a@x.com', { serviceTier: null, status: 'error' });
    const cache = { accounts: [errored] };
    const profiles = { 'a@x.com': profile('a@x.com') };
    const got = pickStaleEntry(cache, profiles, { staleMinAgeMs: 5 * 60_000, rotationIndex: 0 });
    expect(got).toMatchObject({ email: 'a@x.com' });
  });

  it('round-robins across multiple candidates as rotationIndex grows', () => {
    const cache = {
      accounts: [
        entry('a@x.com', {
          rateLimits: { snapshotCapturedAt: new Date(NOW - 30 * 60_000).toISOString() },
        }),
        entry('b@x.com', {
          rateLimits: { snapshotCapturedAt: new Date(NOW - 20 * 60_000).toISOString() },
        }),
        entry('c@x.com', {
          rateLimits: { snapshotCapturedAt: new Date(NOW - 10 * 60_000).toISOString() },
        }),
      ],
    };
    const profiles = {
      'a@x.com': profile('a@x.com'),
      'b@x.com': profile('b@x.com'),
      'c@x.com': profile('c@x.com'),
    };
    // Sorted by capturedAt asc: a (oldest), b, c.
    expect(pickStaleEntry(cache, profiles, { staleMinAgeMs: 60_000, rotationIndex: 0 }).email).toBe(
      'a@x.com',
    );
    expect(pickStaleEntry(cache, profiles, { staleMinAgeMs: 60_000, rotationIndex: 1 }).email).toBe(
      'b@x.com',
    );
    expect(pickStaleEntry(cache, profiles, { staleMinAgeMs: 60_000, rotationIndex: 2 }).email).toBe(
      'c@x.com',
    );
    // Wraps.
    expect(pickStaleEntry(cache, profiles, { staleMinAgeMs: 60_000, rotationIndex: 3 }).email).toBe(
      'a@x.com',
    );
  });

  it('returns null when accounts is empty or malformed', () => {
    expect(pickStaleEntry(null, {}, { staleMinAgeMs: 1000, rotationIndex: 0 })).toBeNull();
    expect(pickStaleEntry({}, {}, { staleMinAgeMs: 1000, rotationIndex: 0 })).toBeNull();
    expect(
      pickStaleEntry({ accounts: [] }, {}, { staleMinAgeMs: 1000, rotationIndex: 0 }),
    ).toBeNull();
  });
});

describe('startFreshnessLoop', () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(NOW));
  afterEach(() => vi.useRealTimers());

  it('returns a disabled handle when probeIntervalMs <= 0', () => {
    const ccrotate = {
      loadTierCache: () => null,
      loadProfiles: () => ({}),
      testAccount: () => Promise.resolve({}),
      upsertTierCacheEntries: () => {},
    };
    const handle = startFreshnessLoop(ccrotate, {
      probeIntervalMs: 0,
      log: { log: () => {}, warn: () => {} },
    });
    expect(handle._disabled).toBe(true);
  });

  it('probes one stale-exhausted account and upserts the result', async () => {
    const cache = { accounts: [entry('a@x.com')] };
    const profiles = { 'a@x.com': profile('a@x.com') };
    const upserts = [];
    const ccrotate = {
      loadTierCache: () => cache,
      loadProfiles: () => profiles,
      testAccount: vi.fn(async (email) => ({
        status: 'success',
        serviceTier: 'base',
        response: 'fresh probe',
        rateLimits: { utilization5h: 39, utilization7d: 86 },
      })),
      upsertTierCacheEntries: (entries) => upserts.push(...entries),
    };
    const handle = startFreshnessLoop(ccrotate, {
      probeIntervalMs: 60_000,
      staleMinAgeMs: 60_000,
      log: { log: () => {}, warn: () => {} },
    });
    await handle._tick();
    // The tick body now routes through probeOne, which passes the profile's
    // own access token + usageApiOnly:false so the active credentials are
    // never consulted (read-only contract — see freshness-loop.js header).
    expect(ccrotate.testAccount).toHaveBeenCalledWith(
      'a@x.com',
      expect.objectContaining({ token: 'tok', usageApiOnly: false }),
    );
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ email: 'a@x.com', serviceTier: 'base' });
    handle.stop();
  });

  it('does nothing when there are no stale candidates', async () => {
    const fresh = entry('a@x.com', { serviceTier: 'base' });
    const ccrotate = {
      loadTierCache: () => ({ accounts: [fresh] }),
      loadProfiles: () => ({ 'a@x.com': profile('a@x.com') }),
      testAccount: vi.fn(),
      upsertTierCacheEntries: vi.fn(),
    };
    const handle = startFreshnessLoop(ccrotate, {
      probeIntervalMs: 60_000,
      staleMinAgeMs: 60_000,
      log: { log: () => {}, warn: () => {} },
    });
    await handle._tick();
    expect(ccrotate.testAccount).not.toHaveBeenCalled();
    expect(ccrotate.upsertTierCacheEntries).not.toHaveBeenCalled();
    handle.stop();
  });

  it('handles testAccount throwing by recording an error result', async () => {
    const cache = { accounts: [entry('a@x.com')] };
    const upserts = [];
    const ccrotate = {
      loadTierCache: () => cache,
      loadProfiles: () => ({ 'a@x.com': profile('a@x.com') }),
      testAccount: async () => {
        throw new Error('network down');
      },
      upsertTierCacheEntries: (entries) => upserts.push(...entries),
    };
    const handle = startFreshnessLoop(ccrotate, {
      probeIntervalMs: 60_000,
      staleMinAgeMs: 60_000,
      log: { log: () => {}, warn: () => {} },
    });
    await handle._tick();
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ status: 'error' });
    expect(upserts[0].response).toContain('network down');
    handle.stop();
  });
});

describe('probeOne helper', () => {
  it("calls testAccount with the target email's token from profiles", async () => {
    const profiles = {
      'bot4@blockcast.net': {
        credentials: { claudeAiOauth: { accessToken: 'BOT4_TOKEN', expiresAt: Date.now() + 9e9 } },
      },
    };
    const ccrotate = {
      loadProfiles: () => profiles,
      testAccount: vi.fn(async () => ({ status: 'success', serviceTier: 'base', rateLimits: {} })),
      upsertTierCacheEntries: vi.fn(),
    };
    const result = await probeOne('claude', 'bot4@blockcast.net', ccrotate);
    expect(ccrotate.testAccount).toHaveBeenCalledWith(
      'bot4@blockcast.net',
      expect.objectContaining({ token: 'BOT4_TOKEN', usageApiOnly: false }),
    );
    expect(result.email).toBe('bot4@blockcast.net');
    expect(result.serviceTier).toBe('base');
    expect(ccrotate.upsertTierCacheEntries).toHaveBeenCalledWith([
      expect.objectContaining({ email: 'bot4@blockcast.net', serviceTier: 'base' }),
    ]);
  });

  it('returns error when target email has no profile', async () => {
    const ccrotate = {
      loadProfiles: () => ({}),
      testAccount: vi.fn(),
      upsertTierCacheEntries: vi.fn(),
    };
    const result = await probeOne('claude', 'unknown@blockcast.net', ccrotate);
    expect(result.status).toBe('error');
    expect(result.email).toBe('unknown@blockcast.net');
    expect(result.serviceTier).toBeNull();
    expect(ccrotate.testAccount).not.toHaveBeenCalled();
    expect(ccrotate.upsertTierCacheEntries).not.toHaveBeenCalled();
  });

  it('returns error when target email profile has no access token', async () => {
    const profiles = { 'a@x.com': { credentials: { claudeAiOauth: {} } } };
    const ccrotate = {
      loadProfiles: () => profiles,
      testAccount: vi.fn(),
      upsertTierCacheEntries: vi.fn(),
    };
    const result = await probeOne('claude', 'a@x.com', ccrotate);
    expect(result.status).toBe('error');
    expect(ccrotate.testAccount).not.toHaveBeenCalled();
  });

  it('returns error result on testAccount throw and swallows upsert errors', async () => {
    const profiles = {
      'a@x.com': { credentials: { claudeAiOauth: { accessToken: 'T', expiresAt: Date.now() + 9e9 } } },
    };
    const ccrotate = {
      loadProfiles: () => profiles,
      testAccount: vi.fn(async () => { throw new Error('boom'); }),
      upsertTierCacheEntries: vi.fn(() => { throw new Error('upsert fail'); }),
    };
    const result = await probeOne('claude', 'a@x.com', ccrotate);
    expect(result.status).toBe('error');
    expect(result.response).toContain('boom');
    expect(result.serviceTier).toBeNull();
    // upsert was still attempted even though testAccount threw
    expect(ccrotate.upsertTierCacheEntries).toHaveBeenCalled();
  });

  it('upserts the email + result fields together', async () => {
    const profiles = {
      'a@x.com': { credentials: { claudeAiOauth: { accessToken: 'T', expiresAt: Date.now() + 9e9 } } },
    };
    const upserts = [];
    const ccrotate = {
      loadProfiles: () => profiles,
      testAccount: vi.fn(async () => ({
        status: 'success',
        serviceTier: 'exhausted',
        rateLimits: { reset5h: 1234567890 },
      })),
      upsertTierCacheEntries: (entries) => upserts.push(...entries),
    };
    await probeOne('claude', 'a@x.com', ccrotate);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      email: 'a@x.com',
      status: 'success',
      serviceTier: 'exhausted',
      rateLimits: { reset5h: 1234567890 },
    });
  });
});
