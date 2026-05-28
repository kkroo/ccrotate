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
function fakeStore({ cache = { accounts: [] }, profiles = {}, codexProfiles = {} } = {}) {
  const calls = [];
  return {
    calls,
    async getTierCache() { return cache; },
    async getCodexTierCache() { return cache; },
    async getProfiles() { return profiles; },
    async getCodexProfiles() { return codexProfiles; },
    async clearExhausted(email, opts) { calls.push(['clearExhausted', email, opts]); return { changed: true }; },
    async markExhausted(email, opts) { calls.push(['markExhausted', email, opts]); return { skipped: false }; },
    async markCodexStale(email) { calls.push(['markCodexStale', email]); return { updated: true }; },
    async clearCodexStale(email, opts) { calls.push(['clearCodexStale', email, opts]); return { updated: true }; },
    async markCodexExhausted(email, response) { calls.push(['markCodexExhausted', email, response]); return { email, serviceTier: 'exhausted' }; },
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

  it('uses the codex tier-cache and clears codex stale after a successful probe', async () => {
    const store = {
      calls: [],
      async getTierCache() {
        throw new Error('claude tier-cache should not be read for codex');
      },
      async getCodexTierCache() {
        return { accounts: [entry('codex@x.com')] };
      },
      async getProfiles() {
        throw new Error('claude profiles should not be read for codex');
      },
      async getCodexProfiles() {
        return {
          'codex@x.com': {
            provider: 'codex',
            auth: { tokens: { access_token: 'CODEX_AT' } },
          },
        };
      },
      async clearCodexStale(email, opts) {
        this.calls.push(['clearCodexStale', email, opts]);
        return { updated: true };
      },
    };
    const ccrotate = {
      target: 'codex',
      probeCodexAccountAsync: vi.fn(async () => ({
        status: 'success',
        serviceTier: 'available',
        lastApiSyncAt: 'sync',
        rateLimits: { remaining5h: 88 },
      })),
      upsertTierCacheEntries: vi.fn(),
    };
    const handle = startFreshnessLoop(ccrotate, {
      probeIntervalMs: 60_000,
      staleMinAgeMs: 60_000,
      store,
      log: { log: () => {}, warn: () => {} },
    });

    await handle._tick();

    expect(ccrotate.probeCodexAccountAsync).toHaveBeenCalledWith(
      'codex@x.com',
      expect.objectContaining({ provider: 'codex' }),
      null,
      { creditCheck: false },
    );
    expect(store.calls).toContainEqual(['clearCodexStale', 'codex@x.com', { lastApiSyncAt: 'sync' }]);
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

  // Regression coverage for the codex probe-primitive wiring. PR #65
  // fixed the per-target *token* path inside a profile; PR #67 fixed
  // the per-target *store* path. Both left probeOne hardcoded to call
  // ccrotate.testAccount — a Claude-only primitive that hits
  // api.anthropic.com/api/oauth/usage. With a codex bearer the endpoint
  // returns 401, testAccount falls through to `{ status: 'unknown',
  // serviceTier: null }`, and the codex freshness-loop logs
  // `tier=? status=unknown` on every tick. Codex tier-cache rot was
  // masked because auth-bot's snap-back loop refreshes the cache on a
  // parallel schedule — but the freshness-loop was contributing zero
  // signal for codex. This block pins the codex probe to
  // probeCodexAccountAsync (a Promise-returning async surface that
  // wraps the same probe primitive `refresh-one --target codex` uses)
  // and persists via upsertTierCacheEntries. The async variant lets
  // serve-codex keep its event loop free during the probe — important
  // because the underlying `codex exec` subprocess can block up to 60s.
  describe('codex probe wiring (probeOne uses probeCodexAccountAsync for target=codex)', () => {
    it("calls probeCodexAccountAsync, NOT testAccount or the sync probeCodexAccount", async () => {
      const store = fakeStore({
        profiles: { /* deliberately empty — codex emails are NOT here */ },
        codexProfiles: {
          'codex-only@x.com': {
            provider: 'codex',
            auth: { tokens: { access_token: 'CODEX_AT', id_token: 'jwt', refresh_token: 'rt' } },
          },
        },
      });
      const probeReturn = {
        status: 'success',
        serviceTier: 'available',
        response: '5h 88% left (resets 09:49)',
        rateLimits: { remaining5h: 88, planType: 'pro' },
      };
      const ccrotate = {
        testAccount: vi.fn(),
        probeCodexAccount: vi.fn(),
        probeCodexAccountAsync: vi.fn(async () => probeReturn),
        upsertTierCacheEntries: vi.fn(),
      };

      const result = await probeOne('codex', 'codex-only@x.com', ccrotate, store);

      expect(ccrotate.testAccount).not.toHaveBeenCalled();
      expect(ccrotate.probeCodexAccount).not.toHaveBeenCalled();
      expect(ccrotate.probeCodexAccountAsync).toHaveBeenCalledWith(
        'codex-only@x.com',
        expect.objectContaining({
          auth: expect.objectContaining({
            tokens: expect.objectContaining({ access_token: 'CODEX_AT' }),
          }),
        }),
        null,
        { creditCheck: false },
      );
      expect(result.email).toBe('codex-only@x.com');
      expect(result.serviceTier).toBe('available');
    });

    it('routes an exhausted codex probe result to the canonical store (markCodexExhausted)', async () => {
      // In HTTP/serve mode the local upsert is invisible to the canonical
      // state-server / badge — exhaustion MUST be routed through the store
      // (live 2026-05-28: credit-check detected omar.ramadan93 exhausted but
      // the badge stayed 'available' because the codex path only wrote local).
      const store = fakeStore({
        codexProfiles: { 'broke@x.com': { provider: 'codex', auth: { tokens: { access_token: 'AT', id_token: 'jwt' } } } },
      });
      const ccrotate = {
        testAccount: vi.fn(), probeCodexAccount: vi.fn(), upsertTierCacheEntries: vi.fn(),
        probeCodexAccountAsync: vi.fn(async () => ({
          status: 'success', serviceTier: 'exhausted', exhaustedReason: 'out_of_credits',
          response: 'Your workspace is out of credits.',
          rateLimits: { utilization5h: 100, remaining5h: 0 },
        })),
      };
      await probeOne('codex', 'broke@x.com', ccrotate, store);
      expect(store.calls).toContainEqual(['markCodexExhausted', 'broke@x.com', 'Your workspace is out of credits.']);
    });

    it('does NOT route a usable codex probe result to markCodexExhausted', async () => {
      const store = fakeStore({
        codexProfiles: { 'ok@x.com': { provider: 'codex', auth: { tokens: { access_token: 'AT', id_token: 'jwt' } } } },
      });
      const ccrotate = {
        testAccount: vi.fn(), probeCodexAccount: vi.fn(), upsertTierCacheEntries: vi.fn(),
        probeCodexAccountAsync: vi.fn(async () => ({ status: 'success', serviceTier: 'available', response: 'ok', rateLimits: { remaining5h: 88 } })),
      };
      await probeOne('codex', 'ok@x.com', ccrotate, store);
      expect(store.calls.find(c => c[0] === 'markCodexExhausted')).toBeUndefined();
    });

    it("awaits a Promise return from probeCodexAccountAsync (not a sync return)", async () => {
      // Regression guard: if probeOne forgot to await, the entry
      // spread would inline the Promise object and produce nonsense.
      // Use a deliberately-delayed Promise to prove the await happens.
      const store = fakeStore({
        codexProfiles: {
          'a@x.com': { provider: 'codex', auth: { tokens: { access_token: 'T' } } },
        },
      });
      let resolved = false;
      const ccrotate = {
        probeCodexAccountAsync: vi.fn(() =>
          new Promise((resolve) => {
            setImmediate(() => {
              resolved = true;
              resolve({ status: 'success', serviceTier: 'available', rateLimits: {} });
            });
          }),
        ),
        upsertTierCacheEntries: vi.fn(),
      };

      const result = await probeOne('codex', 'a@x.com', ccrotate, store);

      expect(resolved).toBe(true); // proves probeOne awaited
      expect(result.serviceTier).toBe('available');
      expect(result.email).toBe('a@x.com');
    });

    it("persists the codex probe via upsertTierCacheEntries", async () => {
      // freshness-loop's writeback path for claude mutates
      // profiles[].exhausted via clearExhausted/markExhausted. Codex
      // has no per-profile exhausted map — the tier-cache itself IS the
      // authoritative status. Mirror refresh-one --target codex: pipe
      // the probe result through upsertTierCacheEntries so the codex
      // freshness-loop becomes a real writer.
      const store = fakeStore({
        codexProfiles: {
          'codex-only@x.com': {
            provider: 'codex',
            auth: { tokens: { access_token: 'CODEX_AT' } },
          },
        },
      });
      const ccrotate = {
        probeCodexAccountAsync: vi.fn(async () => ({
          status: 'success',
          serviceTier: 'available',
          rateLimits: { remaining5h: 88 },
        })),
        upsertTierCacheEntries: vi.fn(),
      };

      await probeOne('codex', 'codex-only@x.com', ccrotate, store);

      expect(ccrotate.upsertTierCacheEntries).toHaveBeenCalledWith([
        expect.objectContaining({
          email: 'codex-only@x.com',
          status: 'success',
          serviceTier: 'available',
          rateLimits: expect.objectContaining({ remaining5h: 88 }),
        }),
      ]);
    });

    it("persists error results via upsertTierCacheEntries too (so codex pool reflects failures)", async () => {
      // probeCodexAccountAsync returns { status: 'error', stale: true }
      // for expired id_tokens (mirrors probeCodexAccount's pre-spawn
      // short-circuit). The freshness entry needs to land in
      // tier-cache so a future call routing decision sees the error,
      // not a stale healthy snapshot. Matches refresh-one --target
      // codex semantics (writes both success and error results
      // unconditionally).
      const store = fakeStore({
        codexProfiles: {
          'expired@x.com': {
            provider: 'codex',
            auth: { tokens: { access_token: 'EXPIRED_AT' } },
          },
        },
      });
      const errorReturn = {
        status: 'error',
        response: 'Codex id_token expired 12m ago — needs reauth',
        stale: true,
      };
      const ccrotate = {
        probeCodexAccountAsync: vi.fn(async () => errorReturn),
        upsertTierCacheEntries: vi.fn(),
      };

      const result = await probeOne('codex', 'expired@x.com', ccrotate, store);

      expect(result.status).toBe('error');
      expect(ccrotate.upsertTierCacheEntries).toHaveBeenCalledWith([
        expect.objectContaining({ email: 'expired@x.com', status: 'error' }),
      ]);
      expect(store.calls).toContainEqual(['markCodexStale', 'expired@x.com']);
    });

    it("does not pass a stale full-profile snapshot to the codex probe writer", async () => {
      const codexProfiles = {
        'target@x.com': {
          provider: 'codex',
          auth: { tokens: { access_token: 'TARGET_AT' } },
          stale: true,
        },
        'fresh@x.com': {
          provider: 'codex',
          auth: { tokens: { access_token: 'FRESH_AT' } },
          stale: false,
          lastApiSyncAt: 'fresh-sync',
        },
      };
      const store = fakeStore({ codexProfiles });
      const ccrotate = {
        probeCodexAccountAsync: vi.fn(async (_email, _profile, profilesArg) => {
          if (profilesArg) profilesArg['fresh@x.com'].stale = true;
          return {
            status: 'success',
            serviceTier: 'available',
            lastApiSyncAt: 'target-sync',
            rateLimits: { remaining5h: 77 },
          };
        }),
        upsertTierCacheEntries: vi.fn(),
      };

      await probeOne('codex', 'target@x.com', ccrotate, store);

      expect(ccrotate.probeCodexAccountAsync).toHaveBeenCalledWith(
        'target@x.com',
        codexProfiles['target@x.com'],
        null,
        { creditCheck: false },
      );
      expect(codexProfiles['fresh@x.com'].stale).toBe(false);
      expect(store.calls).toContainEqual(['clearCodexStale', 'target@x.com', { lastApiSyncAt: 'target-sync' }]);
    });

    it("emails present in BOTH pools use the codex profile when target='codex'", async () => {
      // ally@ and ssh-users+1@ exist in both profiles.json (claude shape)
      // and profiles.codex.json (codex shape). A codex probe must hand
      // the codex-shaped profile (auth.tokens.access_token) to
      // probeCodexAccountAsync; passing the claude shape would crash at
      // accountData.auth being undefined.
      const codexProfile = {
        provider: 'codex',
        auth: { tokens: { access_token: 'CODEX_AT' } },
      };
      const store = fakeStore({
        profiles: {
          'ally@x.com': {
            credentials: { claudeAiOauth: { accessToken: 'CLAUDE_AT', expiresAt: Date.now() + 9e9 } },
          },
        },
        codexProfiles: { 'ally@x.com': codexProfile },
      });
      const ccrotate = {
        probeCodexAccountAsync: vi.fn(async () => ({ status: 'success', serviceTier: 'available', rateLimits: {} })),
        upsertTierCacheEntries: vi.fn(),
      };

      await probeOne('codex', 'ally@x.com', ccrotate, store);

      expect(ccrotate.probeCodexAccountAsync).toHaveBeenCalledWith(
        'ally@x.com',
        codexProfile,
        null,
        { creditCheck: false },
      );
    });

    it("returns error when codex profile has no auth (no probeCodexAccountAsync call)", async () => {
      const store = fakeStore({
        codexProfiles: { 'broken@x.com': { /* no auth field */ } },
      });
      const ccrotate = {
        probeCodexAccountAsync: vi.fn(),
        upsertTierCacheEntries: vi.fn(),
      };

      const result = await probeOne('codex', 'broken@x.com', ccrotate, store);

      expect(result.status).toBe('error');
      expect(result.email).toBe('broken@x.com');
      expect(result.serviceTier).toBeNull();
      expect(ccrotate.probeCodexAccountAsync).not.toHaveBeenCalled();
      expect(ccrotate.upsertTierCacheEntries).not.toHaveBeenCalled();
    });

    it("returns an error result on probeCodexAccountAsync rejection and writes no entry", async () => {
      const store = fakeStore({
        codexProfiles: {
          'a@x.com': { provider: 'codex', auth: { tokens: { access_token: 'T' } } },
        },
      });
      const ccrotate = {
        probeCodexAccountAsync: vi.fn(async () => { throw new Error('boom'); }),
        upsertTierCacheEntries: vi.fn(),
      };

      const result = await probeOne('codex', 'a@x.com', ccrotate, store);

      expect(result.status).toBe('error');
      expect(result.response).toContain('boom');
      expect(result.serviceTier).toBeNull();
      expect(ccrotate.upsertTierCacheEntries).not.toHaveBeenCalled();
    });

    it("claude target still calls testAccount, NOT probeCodexAccount (regression guard)", async () => {
      const store = fakeStore({
        profiles: {
          'claude-only@x.com': {
            credentials: { claudeAiOauth: { accessToken: 'CLAUDE_AT', expiresAt: Date.now() + 9e9 } },
          },
        },
        codexProfiles: { /* empty */ },
      });
      const ccrotate = {
        testAccount: vi.fn(async () => ({ status: 'success', serviceTier: 'base', rateLimits: {} })),
        probeCodexAccount: vi.fn(),
        upsertTierCacheEntries: vi.fn(),
      };

      await probeOne('claude', 'claude-only@x.com', ccrotate, store);

      expect(ccrotate.testAccount).toHaveBeenCalledOnce();
      expect(ccrotate.testAccount).toHaveBeenCalledWith(
        'claude-only@x.com',
        expect.objectContaining({ token: 'CLAUDE_AT' }),
      );
      expect(ccrotate.probeCodexAccount).not.toHaveBeenCalled();
      expect(ccrotate.upsertTierCacheEntries).not.toHaveBeenCalled();
    });
  });
});

describe('pickStaleEntry — codex credit verification', () => {
  // Workspace credit balance is invisible to the headers/usage probe, so a
  // usable codex account can be silently out-of-credits (live 2026-05-27:
  // omar.ramadan93@ showed 🟢 available at 5h:100% while every call failed).
  // pickStaleEntry must schedule a real-turn credit-check for usable codex
  // accounts (TTL-gated) and for out_of_credits accounts (to detect a refill).
  const TTL = 30 * 60_000;
  const codexProfile = () => ({ auth: { tokens: { access_token: 'tok' } } });
  const usable = (email, overrides = {}) => ({
    email,
    status: 'success',
    serviceTier: 'available',
    rateLimits: { snapshotCapturedAt: new Date(Date.now() - 60_000).toISOString() },
    ...overrides,
  });
  const pickCodex = (cache, profiles) =>
    pickStaleEntry(cache, profiles, {
      staleMinAgeMs: 5 * 60_000, rotationIndex: 0, target: 'codex', creditCheckTtlMs: TTL,
    });

  it('schedules a credit-check (real turn) for a usable codex account never credit-verified', () => {
    const got = pickCodex({ accounts: [usable('a@x.net')] }, { 'a@x.net': codexProfile() });
    expect(got?.email).toBe('a@x.net');
    expect(got.creditCheck).toBe(true);
  });

  it('does NOT re-credit-check a usable account verified within the TTL', () => {
    const recent = new Date(Date.now() - 60_000).toISOString(); // 1m ago < 30m TTL
    const got = pickCodex({ accounts: [usable('a@x.net', { lastCreditCheckAt: recent })] }, { 'a@x.net': codexProfile() });
    expect(got).toBeNull();
  });

  it('credit-checks again once the TTL has elapsed', () => {
    const stale = new Date(Date.now() - 60 * 60_000).toISOString(); // 1h ago > 30m TTL
    const got = pickCodex({ accounts: [usable('a@x.net', { lastCreditCheckAt: stale })] }, { 'a@x.net': codexProfile() });
    expect(got?.email).toBe('a@x.net');
    expect(got.creditCheck).toBe(true);
  });

  it('credit-checks an out_of_credits account (to detect a refill — headers cannot)', () => {
    const ooc = {
      email: 'a@x.net', status: 'success', serviceTier: 'exhausted',
      exhaustedReason: 'out_of_credits',
      rateLimits: { snapshotCapturedAt: new Date(Date.now() - 60_000).toISOString() },
    };
    const got = pickCodex({ accounts: [ooc] }, { 'a@x.net': codexProfile() });
    expect(got?.email).toBe('a@x.net');
    expect(got.creditCheck).toBe(true);
  });

  it('does NOT credit-check usable CLAUDE accounts (codex-only behavior)', () => {
    const got = pickStaleEntry(
      { accounts: [{ email: 'c@x.net', status: 'success', serviceTier: 'available',
        rateLimits: { snapshotCapturedAt: new Date(Date.now() - 60_000).toISOString() } }] },
      { 'c@x.net': { credentials: { claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() + 3600_000 } } } },
      { staleMinAgeMs: 5 * 60_000, rotationIndex: 0, target: 'claude', creditCheckTtlMs: TTL },
    );
    expect(got).toBeNull();
  });

  it('uses a headers recover probe (not credit-check) for a rate-limit-exhausted codex account', () => {
    const rl = {
      email: 'a@x.net', status: 'error', serviceTier: null, response: 'rate limited',
      rateLimits: { snapshotCapturedAt: new Date(Date.now() - 60 * 60_000).toISOString() },
    };
    const got = pickCodex({ accounts: [rl] }, { 'a@x.net': codexProfile() });
    expect(got?.email).toBe('a@x.net');
    expect(got.creditCheck).toBe(false);
  });
});
