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

function profile(_email, expiresAt = NOW + 3600_000) {
  return {
    credentials: {
      claudeAiOauth: { accessToken: 'tok', expiresAt },
    },
  };
}

// Minimal in-memory StateStore — the same async surface FileStateStore /
// HttpStateStore expose. Records clear/mark calls so tests can assert the
// freshness-loop's writeback without touching files or a real state-server.
function fakeStore({ cache = { accounts: [] }, profiles = {} } = {}) {
  const calls = [];
  return {
    calls,
    async getTierCache() { return cache; },
    async getProfiles() { return profiles; },
    async clearExhausted(email, opts) { calls.push(['clearExhausted', email, opts]); return { changed: true }; },
    async markExhausted(email, opts) { calls.push(['markExhausted', email, opts]); return { skipped: false }; },
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
    expect(pickStaleEntry(cache, profiles, { staleMinAgeMs: 60_000, rotationIndex: 0 }).email).toBe(
      'a@x.com',
    );
    expect(pickStaleEntry(cache, profiles, { staleMinAgeMs: 60_000, rotationIndex: 1 }).email).toBe(
      'b@x.com',
    );
    expect(pickStaleEntry(cache, profiles, { staleMinAgeMs: 60_000, rotationIndex: 2 }).email).toBe(
      'c@x.com',
    );
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

  // Codex pool coverage (2026-05-21). Pre-fix, pickStaleEntry hardcoded the
  // claude profile path (`credentials.claudeAiOauth.accessToken`), so every
  // codex profile silently failed the token check and got dropped from the
  // candidate list. Result: codex tier-cache could rot indefinitely. Live
  // symptom 2026-05-21: ally@blockcast.net stayed stuck on a serde
  // 'missing field id_token' error for 18+ min after a successful /relogin
  // already landed fresh tokens. With target:'codex', the loop now reads
  // tokens from auth.tokens.access_token and picks codex stale entries.
  function codexProfile() {
    return {
      provider: 'codex',
      auth: {
        auth_mode: 'chatgpt',
        tokens: { id_token: 'id', access_token: 'at', refresh_token: 'rt', account_id: 'acc' },
        last_refresh: new Date(NOW).toISOString(),
      },
    };
  }

  it("picks a codex stale entry when target='codex' is passed", () => {
    const cache = { accounts: [entry('ally@x.com', { serviceTier: null, status: 'error' })] };
    const profiles = { 'ally@x.com': codexProfile() };
    const got = pickStaleEntry(cache, profiles, {
      staleMinAgeMs: 5 * 60_000, rotationIndex: 0, target: 'codex',
    });
    expect(got).toMatchObject({ email: 'ally@x.com' });
  });

  it("default target='claude' still skips codex-shaped profiles", () => {
    // Regression guard: a codex profile must NOT be picked when the loop
    // runs as the claude freshness loop (its claudeAiOauth.accessToken is
    // absent — the codex token lives elsewhere). Without this guard, a
    // mistargeted probe would burn the wrong API.
    const cache = { accounts: [entry('ally@x.com', { serviceTier: null, status: 'error' })] };
    const profiles = { 'ally@x.com': codexProfile() };
    const got = pickStaleEntry(cache, profiles, {
      staleMinAgeMs: 5 * 60_000, rotationIndex: 0, /* target defaults to 'claude' */
    });
    expect(got).toBeNull();
  });

  it("codex profile with no auth.tokens.access_token is skipped", () => {
    const cache = { accounts: [entry('ally@x.com', { serviceTier: null, status: 'error' })] };
    const profiles = { 'ally@x.com': { provider: 'codex', auth: { tokens: {} } } };
    const got = pickStaleEntry(cache, profiles, {
      staleMinAgeMs: 5 * 60_000, rotationIndex: 0, target: 'codex',
    });
    expect(got).toBeNull();
  });
});

describe('startFreshnessLoop', () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(NOW));
  afterEach(() => vi.useRealTimers());

  it('returns a disabled handle when probeIntervalMs <= 0', () => {
    const handle = startFreshnessLoop({}, {
      probeIntervalMs: 0,
      store: fakeStore(),
      log: { log: () => {}, warn: () => {} },
    });
    expect(handle._disabled).toBe(true);
  });

  it('probes one stale-exhausted account and clears it when the probe is usable', async () => {
    const store = fakeStore({
      cache: { accounts: [entry('a@x.com')] },
      profiles: { 'a@x.com': profile('a@x.com') },
    });
    const ccrotate = {
      target: 'claude',
      testAccount: vi.fn(async () => ({
        status: 'success',
        serviceTier: 'base',
        response: 'fresh probe',
        rateLimits: { utilization5h: 39, utilization7d: 86 },
      })),
    };
    const handle = startFreshnessLoop(ccrotate, {
      probeIntervalMs: 60_000,
      staleMinAgeMs: 60_000,
      store,
      log: { log: () => {}, warn: () => {} },
    });
    await handle._tick();
    // Routes through probeOne with the profile's own access token.
    expect(ccrotate.testAccount).toHaveBeenCalledWith(
      'a@x.com',
      expect.objectContaining({ token: 'tok', usageApiOnly: false }),
    );
    // A usable probe clears the stale exhausted label via the store.
    expect(store.calls).toContainEqual(['clearExhausted', 'a@x.com', {}]);
    handle.stop();
  });

  it('does nothing when there are no stale candidates', async () => {
    const store = fakeStore({
      cache: { accounts: [entry('a@x.com', { serviceTier: 'base' })] },
      profiles: { 'a@x.com': profile('a@x.com') },
    });
    const ccrotate = { target: 'claude', testAccount: vi.fn() };
    const handle = startFreshnessLoop(ccrotate, {
      probeIntervalMs: 60_000,
      staleMinAgeMs: 60_000,
      store,
      log: { log: () => {}, warn: () => {} },
    });
    await handle._tick();
    expect(ccrotate.testAccount).not.toHaveBeenCalled();
    expect(store.calls).toHaveLength(0);
    handle.stop();
  });

  it('respects opts.rotationOffset so independent loops start at different candidates', async () => {
    const accounts = [
      entry('a@x.com', { rateLimits: { snapshotCapturedAt: new Date(NOW - 30 * 60_000).toISOString() } }),
      entry('b@x.com', { rateLimits: { snapshotCapturedAt: new Date(NOW - 20 * 60_000).toISOString() } }),
      entry('c@x.com', { rateLimits: { snapshotCapturedAt: new Date(NOW - 10 * 60_000).toISOString() } }),
    ];
    const profiles = {
      'a@x.com': profile('a@x.com'),
      'b@x.com': profile('b@x.com'),
      'c@x.com': profile('c@x.com'),
    };
    const probed = [];
    const mkCcrotate = () => ({
      target: 'claude',
      testAccount: vi.fn(async (email) => {
        probed.push(email);
        return { status: 'success', serviceTier: 'base', response: 'p' };
      }),
    });

    const handleA = startFreshnessLoop(mkCcrotate(), {
      probeIntervalMs: 60_000,
      staleMinAgeMs: 60_000,
      rotationOffset: 0,
      store: fakeStore({ cache: { accounts }, profiles }),
      log: { log: () => {}, warn: () => {} },
    });
    const handleB = startFreshnessLoop(mkCcrotate(), {
      probeIntervalMs: 60_000,
      staleMinAgeMs: 60_000,
      rotationOffset: 1,
      store: fakeStore({ cache: { accounts }, profiles }),
      log: { log: () => {}, warn: () => {} },
    });
    await handleA._tick();
    await handleB._tick();
    expect(probed).toEqual(['a@x.com', 'b@x.com']);
    handleA.stop();
    handleB.stop();
  });

  it('reads CCROTATE_FRESHNESS_PROBE_OFFSET from env when opts.rotationOffset is absent', async () => {
    const accounts = [
      entry('a@x.com', { rateLimits: { snapshotCapturedAt: new Date(NOW - 30 * 60_000).toISOString() } }),
      entry('b@x.com', { rateLimits: { snapshotCapturedAt: new Date(NOW - 20 * 60_000).toISOString() } }),
    ];
    const profiles = {
      'a@x.com': profile('a@x.com'),
      'b@x.com': profile('b@x.com'),
    };
    const probed = [];
    const ccrotate = {
      target: 'claude',
      testAccount: vi.fn(async (email) => {
        probed.push(email);
        return { status: 'success', serviceTier: 'base', response: 'p' };
      }),
    };
    const prev = process.env.CCROTATE_FRESHNESS_PROBE_OFFSET;
    process.env.CCROTATE_FRESHNESS_PROBE_OFFSET = '1';
    try {
      const handle = startFreshnessLoop(ccrotate, {
        probeIntervalMs: 60_000,
        staleMinAgeMs: 60_000,
        store: fakeStore({ cache: { accounts }, profiles }),
        log: { log: () => {}, warn: () => {} },
      });
      await handle._tick();
      expect(probed).toEqual(['b@x.com']);
      handle.stop();
    } finally {
      if (prev === undefined) delete process.env.CCROTATE_FRESHNESS_PROBE_OFFSET;
      else process.env.CCROTATE_FRESHNESS_PROBE_OFFSET = prev;
    }
  });

  it('handles testAccount throwing without crashing and writes no label', async () => {
    const store = fakeStore({
      cache: { accounts: [entry('a@x.com')] },
      profiles: { 'a@x.com': profile('a@x.com') },
    });
    let tickResult;
    const ccrotate = {
      target: 'claude',
      testAccount: async () => { throw new Error('network down'); },
    };
    const handle = startFreshnessLoop(ccrotate, {
      probeIntervalMs: 60_000,
      staleMinAgeMs: 60_000,
      store,
      onTick: ({ result }) => { tickResult = result; },
      log: { log: () => {}, warn: () => {} },
    });
    await handle._tick();
    expect(tickResult.status).toBe('error');
    expect(tickResult.response).toContain('network down');
    // An error probe is inconclusive — neither clear nor mark.
    expect(store.calls).toHaveLength(0);
    handle.stop();
  });
});

describe('probeOne helper', () => {
  it("calls testAccount with the target email's token from the store", async () => {
    const store = fakeStore({
      profiles: {
        'bot4@blockcast.net': {
          credentials: { claudeAiOauth: { accessToken: 'BOT4_TOKEN', expiresAt: Date.now() + 9e9 } },
        },
      },
    });
    const ccrotate = {
      testAccount: vi.fn(async () => ({ status: 'success', serviceTier: 'base', rateLimits: {} })),
    };
    const result = await probeOne('claude', 'bot4@blockcast.net', ccrotate, store);
    expect(ccrotate.testAccount).toHaveBeenCalledWith(
      'bot4@blockcast.net',
      expect.objectContaining({ token: 'BOT4_TOKEN', usageApiOnly: false }),
    );
    expect(result.email).toBe('bot4@blockcast.net');
    expect(result.serviceTier).toBe('base');
  });

  it('clears the exhausted label when the probe shows the account usable', async () => {
    const store = fakeStore({
      profiles: { 'a@x.com': profile('a@x.com', Date.now() + 9e9) },
    });
    const ccrotate = {
      testAccount: vi.fn(async () => ({ status: 'success', serviceTier: 'base', rateLimits: {} })),
    };
    await probeOne('claude', 'a@x.com', ccrotate, store);
    expect(store.calls).toContainEqual(['clearExhausted', 'a@x.com', {}]);
  });

  it('refreshes the reset epoch via markExhausted when the probe confirms exhaustion', async () => {
    const store = fakeStore({
      profiles: { 'a@x.com': profile('a@x.com', Date.now() + 9e9) },
    });
    const ccrotate = {
      testAccount: vi.fn(async () => ({
        status: 'success',
        serviceTier: 'exhausted',
        rateLimits: { reset5h: 1234567890, reset7d: 1234599999 },
      })),
    };
    await probeOne('claude', 'a@x.com', ccrotate, store);
    expect(store.calls).toContainEqual(
      ['markExhausted', 'a@x.com', { reset5h: 1234567890, reset7d: 1234599999 }],
    );
  });

  it('returns error when target email has no profile', async () => {
    const store = fakeStore({ profiles: {} });
    const ccrotate = { testAccount: vi.fn() };
    const result = await probeOne('claude', 'unknown@blockcast.net', ccrotate, store);
    expect(result.status).toBe('error');
    expect(result.email).toBe('unknown@blockcast.net');
    expect(result.serviceTier).toBeNull();
    expect(ccrotate.testAccount).not.toHaveBeenCalled();
    expect(store.calls).toHaveLength(0);
  });

  it('returns error when target email profile has no access token', async () => {
    const store = fakeStore({ profiles: { 'a@x.com': { credentials: { claudeAiOauth: {} } } } });
    const ccrotate = { testAccount: vi.fn() };
    const result = await probeOne('claude', 'a@x.com', ccrotate, store);
    expect(result.status).toBe('error');
    expect(ccrotate.testAccount).not.toHaveBeenCalled();
  });

  it('returns an error result on testAccount throw and writes no label', async () => {
    const store = fakeStore({
      profiles: { 'a@x.com': { credentials: { claudeAiOauth: { accessToken: 'T', expiresAt: Date.now() + 9e9 } } } },
    });
    const ccrotate = {
      testAccount: vi.fn(async () => { throw new Error('boom'); }),
    };
    const result = await probeOne('claude', 'a@x.com', ccrotate, store);
    expect(result.status).toBe('error');
    expect(result.response).toContain('boom');
    expect(result.serviceTier).toBeNull();
    expect(store.calls).toHaveLength(0);
  });
});
