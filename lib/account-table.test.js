import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderAccountTable } from './account-table.js';

function makeCcrotate({ profiles, cache = null, currentEmail = null, isCodex = false, profilesDir = null }) {
  return {
    profilesDir,
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

  it('shows active API cooldowns with a distinct marker and model group', () => {
    const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-table-'));
    const profiles = {
      'limited@x.com': { credentials: { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1000 } } },
    };
    const cache = {
      updatedAt: new Date().toISOString(),
      accounts: [{
        email: 'limited@x.com',
        serviceTier: 'base',
        rateLimits: { utilization5h: 10, utilization7d: 20 },
      }],
    };
    fs.writeFileSync(path.join(profilesDir, 'rate-limit-state.json'), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      anthropic: {
        accounts: {
          'limited@x.com': {
            modelGroups: {
              'claude-opus': {
                modelGroup: 'claude-opus',
                cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
                last429Reason: 'requests',
              },
            },
          },
        },
      },
    }));
    const ccrotate = makeCcrotate({ profiles, cache, profilesDir });
    renderAccountTable(ccrotate, { mode: 'when' });
    const out = captured();
    expect(out).toContain('🤌');
    expect(out).toMatch(/limited@x\.com.*opus cooldown.*429 requests/);
    expect(out).not.toMatch(/limited@x\.com.*api: api unknown/);
  });

  it('displays the LATER reset when both 5h and 7d windows are blocked (no false "in 23m" when 7d is also exhausted)', () => {
    // Real incident 2026-05-21: bot1@blockcast.net rendered "in 23m" while
    // Anthropic's UI said weekly resets Sat 7am. Both 5h and 7d were 100%
    // utilized; the picker used the SOONER reset (5h) which becomes
    // misleading because the 7d cap still blocks every request after the
    // 5h window resets. Fix: when both are over the cap, pick the LATER
    // reset so display matches the actual recovery time.
    const profiles = {
      'both-blocked@x.com': { credentials: { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 } } },
    };
    // 5h resets in 23 minutes; 7d resets in 2 days (the long horizon).
    const reset5h = Math.floor((Date.now() + 23 * 60_000) / 1000);
    const reset7d = Math.floor((Date.now() + 2 * 24 * 3600_000) / 1000);
    const cache = {
      updatedAt: new Date().toISOString(),
      accounts: [{
        email: 'both-blocked@x.com',
        serviceTier: 'base',
        rateLimits: {
          utilization5h: 100,
          utilization7d: 100,
          reset5h,
          reset7d,
        },
      }],
    };
    const ccrotate = makeCcrotate({ profiles, cache });
    renderAccountTable(ccrotate, { mode: 'rich' });
    const out = captured();
    // Should NOT display 'in 23m' — that misleads the operator.
    expect(out).not.toMatch(/both-blocked@x\.com.*in 23m/);
    // Should display the 7d reset (~48h out). formatExpiresAt renders 2d
    // as hours ("in 48h"), not days — match that.
    expect(out).toMatch(/both-blocked@x\.com.*in 4[78]h/);
  });

  it('still picks 5h reset when only the 5h window is blocked', () => {
    // Regression guard: the new both-blocked branch must not steal cases
    // where 7d still has headroom (utilization7d < 95).
    const profiles = {
      'fivehonly@x.com': { credentials: { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 } } },
    };
    const reset5h = Math.floor((Date.now() + 30 * 60_000) / 1000);
    const reset7d = Math.floor((Date.now() + 2 * 24 * 3600_000) / 1000);
    const cache = {
      updatedAt: new Date().toISOString(),
      accounts: [{
        email: 'fivehonly@x.com',
        serviceTier: 'base',
        rateLimits: {
          utilization5h: 100,
          utilization7d: 40,
          reset5h,
          reset7d,
        },
      }],
    };
    const ccrotate = makeCcrotate({ profiles, cache });
    renderAccountTable(ccrotate, { mode: 'rich' });
    expect(captured()).toMatch(/fivehonly@x\.com.*in 30m/);
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

  it('flags cached (usageStale) percentages with a ~ prefix so a frozen 5h:100% does not read as live', () => {
    // Live confusion 2026-05-30: bot13@blockcast.net showed 5h:100% 7d:79%
    // while Anthropic's UI read 32% session / 4% weekly. The %s were a
    // last-known-good snapshot served while the token's /api/oauth/usage was
    // on 429 cooldown; the column gave no hint it was stale.
    const profiles = {
      'frozen@x.com': { credentials: { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 } } },
    };
    const cache = {
      updatedAt: new Date().toISOString(),
      accounts: [{
        email: 'frozen@x.com',
        serviceTier: 'base',
        usageStale: true,
        rateLimits: { utilization5h: 100, utilization7d: 79 },
      }],
    };
    const ccrotate = makeCcrotate({ profiles, cache });
    renderAccountTable(ccrotate, { mode: 'rich' });
    const out = captured();
    expect(out).toMatch(/frozen@x\.com.*~5h:100%.*~7d:79%/);
  });

  it('does NOT add the ~ prefix for a live (non-stale) usage snapshot', () => {
    const profiles = {
      'live@x.com': { credentials: { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 } } },
    };
    const cache = {
      updatedAt: new Date().toISOString(),
      accounts: [{ email: 'live@x.com', serviceTier: 'base', rateLimits: { utilization5h: 32, utilization7d: 4 } }],
    };
    const ccrotate = makeCcrotate({ profiles, cache });
    renderAccountTable(ccrotate, { mode: 'rich' });
    const out = captured();
    const line = out.split('\n').find(l => l.includes('live@x.com'));
    expect(line).toContain('5h:32%');
    expect(line).not.toContain('~5h:');
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

  it('does NOT show usable-now when an exhausted map is set, even if serviceTier is stale "available"', () => {
    // Live bug 2026-05-27: PR #80's markCodexExhausted writes an
    // `exhausted` map to the canonical tier-cache via the state-server,
    // but local serve-pod caches can lag with serviceTier still
    // 'available'. The Claude row uses isAccountExhausted() to overlay
    // the model-scoped exhaustion onto the display tier; the codex row
    // previously only looked at serviceTier and mislabeled the row as
    // 🟢 / "usable now" when callers were guaranteed to get a 429.
    const profiles = {
      'stale-available@x.com': { auth: { tokens: {} }, tokenClaims: { exp: Math.floor(Date.now() / 1000) + 3600 } },
    };
    const futureReset = Math.floor((Date.now() + 3 * 60 * 60_000) / 1000);
    const cache = {
      updatedAt: new Date().toISOString(),
      accounts: [{
        email: 'stale-available@x.com',
        serviceTier: 'available',
        // Pre-PR-#80 fields still say "tons of headroom":
        rateLimits: { remaining5h: 100, remaining7d: 50 },
        // ...but markCodexExhausted has flagged the account already:
        exhausted: {
          '*': {
            reset5h: futureReset,
            reset7d: futureReset,
            response: 'quota exhausted; resets at ...',
            since: new Date().toISOString(),
          },
        },
      }],
    };
    const ccrotate = makeCcrotate({ profiles, cache, isCodex: true });
    renderAccountTable(ccrotate, { mode: 'rich' });
    const out = captured();
    expect(out).toContain('stale-available@x.com');
    expect(out).not.toMatch(/stale-available@x\.com.*usable now/);
    expect(out).toMatch(/stale-available@x\.com.*exhausted/);
  });

  it('honors codex response-only exhaustion shape (no exhausted map, just response + resets)', () => {
    // Some cache writes preserve `response: "quota exhausted; resets at ..."`
    // and the rateLimits reset epochs but drop the `exhausted` map. The
    // recovery fallback in readExhaustion() reconstructs the '*' record;
    // the codex row must respect it.
    const profiles = {
      'response-only-exhausted@x.com': { auth: { tokens: {} }, tokenClaims: { exp: Math.floor(Date.now() / 1000) + 3600 } },
    };
    const futureReset = Math.floor((Date.now() + 90 * 60_000) / 1000);
    const cache = {
      updatedAt: new Date().toISOString(),
      accounts: [{
        email: 'response-only-exhausted@x.com',
        serviceTier: 'available',
        response: 'quota exhausted; resets at 2026-05-30T14:00:00.000Z',
        rateLimits: {
          reset5h: futureReset,
          reset7d: futureReset,
          // intentionally no remaining* / utilization* — mimic the
          // bot1@blockcast.net cache shape observed live 2026-05-27.
        },
      }],
    };
    const ccrotate = makeCcrotate({ profiles, cache, isCodex: true });
    renderAccountTable(ccrotate, { mode: 'rich' });
    const out = captured();
    expect(out).not.toMatch(/response-only-exhausted@x\.com.*usable now/);
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

describe('renderAccountTable — model-scoped exhaustion', () => {
  it('names the capped model on an exhausted row so it does not read as fully dead', () => {
    const profiles = {
      'a@x.com': { credentials: { claudeAiOauth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 } } },
    };
    const cache = {
      updatedAt: new Date().toISOString(),
      accounts: [
        {
          email: 'a@x.com',
          serviceTier: 'exhausted',
          exhaustedModel: 'claude-haiku-4-5-20251001',
          response: 'quota exhausted',
          rateLimits: { reset5h: Math.floor(Date.now() / 1000) + 3600 },
        },
      ],
    };
    const ccrotate = makeCcrotate({ profiles, cache });
    renderAccountTable(ccrotate, { mode: 'when' });
    const out = captured();
    const line = out.split('\n').find(l => l.includes('a@x.com'));
    expect(line).toBeDefined();
    // The capped model is surfaced — operator sees it is a haiku-only cap.
    expect(line).toContain('(haiku)');
  });
});
