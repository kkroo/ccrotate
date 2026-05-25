import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { RefreshOneCommand } from './refresh-one.js';

// Per-test isolated profiles dir keeps the round-robin marker file from
// leaking between cases.
function withProfilesDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrotate-rfo-'));
  return dir;
}

function makeCcrotate({ profiles, cache, currentEmail, probeResults }) {
  return {
    isCodexTarget: () => true,
    profilesDir: withProfilesDir(),
    loadProfiles: () => profiles,
    loadTierCache: () => (cache ? { accounts: cache } : null),
    getCurrentAccount: () => ({ email: currentEmail }),
    probeCodexAccount: vi.fn((email) => probeResults[email] ?? {
      status: 'error',
      response: 'no probe configured',
    }),
    upsertTierCacheEntries: vi.fn(),
  };
}

describe('Codex refresh-one', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('probes the active account first', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const cc = makeCcrotate({
      profiles: {
        'active@example.com': { auth: { tokens: {} } },
        'other@example.com': { auth: { tokens: {} } },
      },
      cache: [
        { email: 'active@example.com', serviceTier: 'base' },
        { email: 'other@example.com', serviceTier: 'base' },
      ],
      currentEmail: 'active@example.com',
      probeResults: {
        'active@example.com': {
          status: 'success',
          serviceTier: 'base',
          response: '5h 50% left',
          rateLimits: { utilization5h: 50 },
        },
      },
    });

    await new RefreshOneCommand(cc).execute();

    expect(cc.probeCodexAccount).toHaveBeenCalledWith('active@example.com', expect.any(Object), expect.any(Object));
    expect(cc.upsertTierCacheEntries).toHaveBeenCalledWith([
      expect.objectContaining({ email: 'active@example.com', serviceTier: 'base' }),
    ]);
  });

  it('skips exhausted accounts with a known future reset', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const futureReset = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const cc = makeCcrotate({
      profiles: {
        'exhausted@example.com': { auth: { tokens: {} } },
        'fresh@example.com': { auth: { tokens: {} } },
      },
      cache: [
        {
          email: 'exhausted@example.com',
          serviceTier: 'exhausted',
          rateLimits: { resetAt: futureReset },
        },
      ],
      currentEmail: 'someone-else@example.com',
      probeResults: {
        'fresh@example.com': {
          status: 'success',
          serviceTier: 'base',
          response: 'ok',
          rateLimits: { utilization5h: 10 },
        },
      },
    });

    await new RefreshOneCommand(cc).execute();

    // Only the fresh (uncached) account should be probed; exhausted skipped
    expect(cc.probeCodexAccount).toHaveBeenCalledTimes(1);
    expect(cc.probeCodexAccount.mock.calls[0][0]).toBe('fresh@example.com');
  });

  it('returns silently when no accounts have usable auth', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const cc = makeCcrotate({
      profiles: {
        'noauth@example.com': {}, // missing .auth
      },
      cache: null,
      currentEmail: 'noauth@example.com',
      probeResults: {},
    });

    await new RefreshOneCommand(cc).execute();

    expect(cc.probeCodexAccount).not.toHaveBeenCalled();
    expect(cc.upsertTierCacheEntries).not.toHaveBeenCalled();
  });

  it('skips upsert when probe returns unknown', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const cc = makeCcrotate({
      profiles: {
        'unknown@example.com': { auth: { tokens: {} } },
      },
      cache: null,
      currentEmail: 'unknown@example.com',
      probeResults: {
        'unknown@example.com': { status: 'unknown', response: 'cooldown' },
      },
    });

    await new RefreshOneCommand(cc).execute();

    expect(cc.probeCodexAccount).toHaveBeenCalledTimes(1);
    expect(cc.upsertTierCacheEntries).not.toHaveBeenCalled();
  });

  it('probes the requested account instead of the active account', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const cc = makeCcrotate({
      profiles: {
        'active@example.com': { auth: { tokens: {} } },
        'other@example.com': { auth: { tokens: {} } },
      },
      cache: [
        { email: 'active@example.com', serviceTier: 'base' },
        { email: 'other@example.com', serviceTier: 'base' },
      ],
      currentEmail: 'active@example.com',
      probeResults: {
        'other@example.com': {
          status: 'success',
          serviceTier: 'base',
          response: '5h 80% left',
          rateLimits: { utilization5h: 20 },
        },
      },
    });

    await new RefreshOneCommand(cc).execute(' OTHER@example.com ');

    expect(cc.probeCodexAccount).toHaveBeenCalledWith('other@example.com', expect.any(Object), expect.any(Object));
    expect(cc.upsertTierCacheEntries).toHaveBeenCalledWith([
      expect.objectContaining({ email: 'other@example.com', serviceTier: 'base' }),
    ]);
  });

  it('probes a requested account even when the cache has a future exhausted reset', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const futureReset = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const cc = makeCcrotate({
      profiles: {
        'exhausted@example.com': { auth: { tokens: {} } },
        'fresh@example.com': { auth: { tokens: {} } },
      },
      cache: [
        {
          email: 'exhausted@example.com',
          serviceTier: 'exhausted',
          rateLimits: { resetAt: futureReset },
        },
      ],
      currentEmail: 'fresh@example.com',
      probeResults: {
        'exhausted@example.com': {
          status: 'success',
          serviceTier: 'base',
          response: 'ok',
          rateLimits: { utilization5h: 10 },
        },
      },
    });

    await new RefreshOneCommand(cc).executeCodex('exhausted@example.com');

    expect(cc.probeCodexAccount).toHaveBeenCalledTimes(1);
    expect(cc.probeCodexAccount.mock.calls[0][0]).toBe('exhausted@example.com');
    expect(cc.upsertTierCacheEntries).toHaveBeenCalledWith([
      expect.objectContaining({ email: 'exhausted@example.com', serviceTier: 'base' }),
    ]);
  });

  it('fails when a requested codex account has no usable auth', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const cc = makeCcrotate({
      profiles: {
        'noauth@example.com': {},
        'available@example.com': { auth: { tokens: {} } },
      },
      cache: null,
      currentEmail: 'noauth@example.com',
      probeResults: {},
    });

    await expect(new RefreshOneCommand(cc).execute('noauth@example.com'))
      .rejects.toThrow('No usable codex auth for noauth@example.com');

    expect(cc.probeCodexAccount).not.toHaveBeenCalled();
    expect(cc.upsertTierCacheEntries).not.toHaveBeenCalled();
  });

  it('fails when a requested codex account has no saved profile', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const cc = makeCcrotate({
      profiles: {},
      cache: null,
      currentEmail: 'missing@example.com',
      probeResults: {},
    });

    await expect(new RefreshOneCommand(cc).execute('missing@example.com'))
      .rejects.toThrow('No saved profile for missing@example.com');
  });
});
