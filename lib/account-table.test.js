import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAccountTable } from './account-table.js';

function makeCcrotate({ profiles, cache = null, currentEmail = null, isCodex = false }) {
  return {
    isCodexTarget: () => isCodex,
    isClaudeTarget: () => !isCodex,
    getTargetName: () => isCodex ? 'Codex' : 'Claude Code',
    loadProfiles: () => profiles,
    loadTierCache: () => cache,
    getCurrentAccount: () => {
      if (!currentEmail) throw new Error('no active');
      return { email: currentEmail };
    },
  };
}

let logSpy;
beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function captured() {
  // Strip ANSI for easier matching.
  return logSpy.mock.calls
    .map(args => args.map(a => String(a).replace(/\x1b\[[0-9;]*m/g, '')).join(' '))
    .join('\n');
}

describe('renderAccountTable — Claude', () => {
  it('renders all profiles even when tier-cache only has a subset (the missing-account bug)', () => {
    // Real bug observed 2026-05-08: `ccrotate when` showed 10 accounts
    // while `list` showed 11 because `when` iterated cache.accounts
    // and the 11th hadn't been probed yet.
    const profiles = {
      'a@example.com': { credentials: { claudeAiOauth: { accessToken: 'ata', refreshToken: 'rta', expiresAt: Date.now() + 3600_000 } } },
      'b@example.com': { credentials: { claudeAiOauth: { accessToken: 'atb', refreshToken: 'rtb', expiresAt: Date.now() + 3600_000 } } },
      'fresh@example.com': { credentials: { claudeAiOauth: { accessToken: 'atc', refreshToken: 'rtc', expiresAt: Date.now() + 3600_000 } } },
    };
    const cache = {
      updatedAt: new Date().toISOString(),
      accounts: [
        { email: 'a@example.com', serviceTier: 'base', rateLimits: { utilization5h: 10, utilization7d: 20 } },
        { email: 'b@example.com', serviceTier: 'base', rateLimits: { utilization5h: 30, utilization7d: 40 } },
        // 'fresh@example.com' deliberately not in cache — simulates a brand-new snap.
      ],
    };
    const ccrotate = makeCcrotate({ profiles, cache, currentEmail: 'a@example.com' });
    renderAccountTable(ccrotate, { mode: 'rich' });
    const out = captured();
    expect(out).toContain('a@example.com');
    expect(out).toContain('b@example.com');
    expect(out).toContain('fresh@example.com');
    // The fresh row should still show "no data" rather than being absent.
    expect(out).toMatch(/fresh@example\.com.*no data/);
  });

  it('preserves stable index order across runs (insertion order in profiles.json)', () => {
    const profiles = {
      'first@x.com':  { credentials: { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1000 } } },
      'second@x.com': { credentials: { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1000 } } },
      'third@x.com':  { credentials: { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1000 } } },
    };
    const ccrotate = makeCcrotate({ profiles });
    renderAccountTable(ccrotate, { mode: 'rich' });
    const out = captured();
    const lines = out.split('\n').filter(l => l.includes('@x.com'));
    expect(lines[0]).toContain('first@x.com');
    expect(lines[1]).toContain('second@x.com');
    expect(lines[2]).toContain('third@x.com');
    expect(lines[0]).toMatch(/^\s*1/);
    expect(lines[1]).toMatch(/^\s*2/);
    expect(lines[2]).toMatch(/^\s*3/);
  });

  it('marks the active account with ★', () => {
    const profiles = {
      'active@x.com': { credentials: { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1000 } } },
      'idle@x.com':   { credentials: { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1000 } } },
    };
    const ccrotate = makeCcrotate({ profiles, currentEmail: 'active@x.com' });
    renderAccountTable(ccrotate, { mode: 'rich' });
    const lines = captured().split('\n');
    expect(lines.find(l => l.includes('active@x.com'))).toContain('★');
    expect(lines.find(l => l.includes('idle@x.com'))).not.toContain('★');
  });

  it('renders tier-cache exhausted entry (with reset epoch but no utilization%) as "in Xh"', () => {
    // The kkroo.10 writeback path can produce entries with serviceTier='exhausted'
    // and reset5h but no utilization%. They must NOT render as "no data".
    const futureReset = Math.floor((Date.now() + 90 * 60_000) / 1000);
    const profiles = {
      'burned@x.com': { credentials: { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1000 } } },
    };
    const cache = {
      updatedAt: new Date().toISOString(),
      accounts: [{
        email: 'burned@x.com',
        serviceTier: 'exhausted',
        response: 'quota exhausted (writeback)',
        rateLimits: { reset5h: futureReset, snapshotCapturedAt: new Date().toISOString() },
      }],
    };
    const ccrotate = makeCcrotate({ profiles, cache });
    renderAccountTable(ccrotate, { mode: 'rich' });
    const out = captured();
    expect(out).toMatch(/burned@x\.com.*exhausted.*in 1h30m/);
    expect(out).not.toMatch(/burned@x\.com.*no data/);
  });

  it('marks stale accounts in red and skips usable-now even when cache is fresh', () => {
    const profiles = {
      'stale@x.com': {
        stale: true,
        credentials: { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 } },
      },
    };
    const cache = {
      updatedAt: new Date().toISOString(),
      accounts: [{ email: 'stale@x.com', serviceTier: 'base', rateLimits: { utilization5h: 10, utilization7d: 20 } }],
    };
    const ccrotate = makeCcrotate({ profiles, cache });
    renderAccountTable(ccrotate, { mode: 'rich' });
    expect(captured()).toContain('stale (needs /login + snap)');
  });

  it('prints empty-pool guidance when profiles.json is empty', () => {
    const ccrotate = makeCcrotate({ profiles: {} });
    renderAccountTable(ccrotate, { mode: 'rich' });
    expect(captured()).toMatch(/No accounts saved/);
  });
});

describe('renderAccountTable — Codex', () => {
  it('renders codex availability using reset windows', () => {
    const profiles = {
      'codex@x.com': { auth: { tokens: { access_token: 'a', refresh_token: 'r' } }, tokenClaims: { exp: Math.floor(Date.now() / 1000) + 3600 } },
    };
    const cache = {
      updatedAt: new Date().toISOString(),
      accounts: [{
        email: 'codex@x.com',
        serviceTier: 'available',
        rateLimits: { remaining5h: 80, remaining7d: 60 },
      }],
    };
    const ccrotate = makeCcrotate({ profiles, cache, isCodex: true });
    renderAccountTable(ccrotate, { mode: 'rich' });
    expect(captured()).toContain('codex@x.com');
    expect(captured()).toContain('usable now');
  });

  it('does not show codex accounts at the limit as usable', () => {
    const profiles = {
      'limited@x.com': { auth: { tokens: {} }, tokenClaims: { exp: Math.floor(Date.now() / 1000) + 3600 } },
    };
    const futureReset = Math.floor((Date.now() + 60 * 60_000) / 1000);
    const cache = {
      updatedAt: new Date().toISOString(),
      accounts: [{
        email: 'limited@x.com',
        serviceTier: 'available',
        rateLimits: { remaining5h: 0, reset5h: futureReset, remaining7d: 50 },
      }],
    };
    const ccrotate = makeCcrotate({ profiles, cache, isCodex: true });
    renderAccountTable(ccrotate, { mode: 'rich' });
    const out = captured();
    expect(out).toContain('limited@x.com');
    expect(out).not.toMatch(/limited@x\.com.*usable now/);
  });

  it('renders codex exhausted entries with reset epochs even without remaining percentages', () => {
    const profiles = {
      'burned-codex@x.com': { auth: { tokens: {} }, tokenClaims: { exp: Math.floor(Date.now() / 1000) + 3600 } },
    };
    const futureReset = Math.floor((Date.now() + 45 * 60_000) / 1000);
    const cache = {
      updatedAt: new Date().toISOString(),
      accounts: [{
        email: 'burned-codex@x.com',
        serviceTier: 'exhausted',
        response: '5h:0% exhausted',
        rateLimits: { reset5h: futureReset, snapshotCapturedAt: new Date().toISOString() },
      }],
    };
    const ccrotate = makeCcrotate({ profiles, cache, isCodex: true });
    renderAccountTable(ccrotate, { mode: 'rich' });
    const out = captured();
    expect(out).toMatch(/burned-codex@x\.com.*exhausted.*in 45m/);
    expect(out).not.toMatch(/burned-codex@x\.com.*5h:0% exhausted/);
  });

  it('does NOT auto-refresh when the cache is stale (consolidation removed implicit probing)', () => {
    // Pre-kkroo.11 `ccrotate when` would call ccrotate.refresh() if the
    // tier-cache was older than 2h. That made a "show me state" command
    // have side effects on the network and on shared PVC files —
    // particularly bad when called frequently from monitoring scripts.
    // The consolidation explicitly removes that behavior; refresh /
    // refresh-one own all probing.
    const profiles = {
      'a@x.com': { credentials: { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 } } },
    };
    // Cache marked old (3h ago) — would have triggered the old auto-refresh.
    const cache = {
      updatedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
      accounts: [{ email: 'a@x.com', serviceTier: 'base', rateLimits: { utilization5h: 10, utilization7d: 20 } }],
    };
    const refreshSpy = vi.fn();
    const ccrotate = {
      ...makeCcrotate({ profiles, cache }),
      refresh: refreshSpy,
    };
    renderAccountTable(ccrotate, { mode: 'rich' });
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

describe('renderAccountTable — modes', () => {
  it('rich mode includes the # column and expires-at', () => {
    const profiles = {
      'a@x.com': { credentials: { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 } } },
    };
    const ccrotate = makeCcrotate({ profiles });
    renderAccountTable(ccrotate, { mode: 'rich' });
    const out = captured();
    expect(out).toMatch(/^\s*1\s/m);
  });

  it('when mode omits the # column (back-compat shape)', () => {
    const profiles = {
      'a@x.com': { credentials: { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 } } },
    };
    const ccrotate = makeCcrotate({ profiles });
    renderAccountTable(ccrotate, { mode: 'when' });
    const out = captured();
    // Account row should NOT start with a numeric index in `when` mode.
    const accountLine = out.split('\n').find(l => l.includes('a@x.com'));
    expect(accountLine).toBeDefined();
    expect(accountLine).not.toMatch(/^\s*\d+\s/);
  });
});
