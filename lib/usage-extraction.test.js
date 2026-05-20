import { describe, expect, it, vi } from 'vitest';
import CCRotate, { toPercent } from './ccrotate.js';
import { parseClaudeCliUsageText } from './claude-cli-usage.js';
import { SnapCommand } from './commands/snap.js';

describe('toPercent', () => {
  it('passes through a 0-100 percentage', () => {
    expect(toPercent(100)).toBe(100);
    expect(toPercent(62)).toBe(62);
  });
  it('scales a 0-1 fraction to a percent', () => {
    expect(toPercent(0.29)).toBe(29);
    expect(toPercent(0.5)).toBe(50);
  });
  it('clamps above 100 and returns null for null/undefined', () => {
    expect(toPercent(140)).toBe(100);
    expect(toPercent(null)).toBeNull();
    expect(toPercent(undefined)).toBeNull();
  });
});

describe('parseUsageResult — __stale surfacing', () => {
  it('marks a last-known-good (cached) response stale in the response + result', () => {
    const ccrotate = new CCRotate();
    const usageData = {
      five_hour: { utilization: 100, resets_at: '2026-05-19T10:00:00Z' },
      seven_day: { utilization: 62, resets_at: '2026-05-25T09:00:00Z' },
      extra_usage: { is_enabled: false },
      __stale: true,
    };
    const result = ccrotate.parseUsageResult(usageData);
    expect(result.stale).toBe(true);
    expect(result.response).toContain('(cached)');
    expect(result.rateLimits.utilization5h).toBe(100);
  });
  it('does not mark a fresh response stale', () => {
    const ccrotate = new CCRotate();
    const result = ccrotate.parseUsageResult({
      five_hour: { utilization: 0.29 },
      seven_day: { utilization: 0.58 },
      extra_usage: { is_enabled: false },
    });
    expect(result.stale).toBeUndefined();
    expect(result.response).not.toContain('(cached)');
    // toPercent applied — fraction scaled.
    expect(result.rateLimits.utilization5h).toBe(29);
  });
});

describe('parseClaudeCliUsageText', () => {
  const panel = [
    'Settings: Status Config Usage',
    'Current session',
    '30% used',
    'Resets 8:50am (UTC)',
    'Current week (all models)',
    '58% used',
    'Resets May 23, 12pm (UTC)',
  ].join('\n');

  it('parses the session + week windows from a /usage panel', () => {
    const windows = parseClaudeCliUsageText(panel);
    const session = windows.find((w) => w.label === 'Current session');
    const week = windows.find((w) => w.label === 'Current week (all models)');
    expect(session.usedPercent).toBe(30);
    expect(week.usedPercent).toBe(58);
  });
  it('throws a useful error on a token-expired panel', () => {
    expect(() => parseClaudeCliUsageText('Settings: Usage\nCurrent session\ntoken_expired'))
      .toThrow(/token expired/i);
  });
  it('throws when no usage panel is present', () => {
    expect(() => parseClaudeCliUsageText('nothing useful here')).toThrow();
  });
});

describe('SnapCommand — identity guard', () => {
  function fakeCcrotate(overrides = {}) {
    return {
      isClaudeTarget: () => true,
      getCurrentAccount: () => ({ email: 'a@x.com' }),
      readLiveClaudeAuthEmail: vi.fn(async () => 'a@x.com'),
      loadProfiles: () => ({}),
      createProfileFromCurrentAccount: () => ({ provider: 'claude' }),
      saveProfiles: vi.fn(),
      ...overrides,
    };
  }

  it('saves when the live auth email matches the account', async () => {
    const ccrotate = fakeCcrotate();
    await new SnapCommand(ccrotate).execute(true);
    expect(ccrotate.saveProfiles).toHaveBeenCalled();
  });

  it('aborts when claude auth status reports a different account', async () => {
    const ccrotate = fakeCcrotate({ readLiveClaudeAuthEmail: vi.fn(async () => 'other@x.com') });
    await expect(new SnapCommand(ccrotate).execute(true)).rejects.toThrow(/snap aborted/);
    expect(ccrotate.saveProfiles).not.toHaveBeenCalled();
  });

  it('proceeds (skips the check) when auth status is unavailable', async () => {
    const ccrotate = fakeCcrotate({ readLiveClaudeAuthEmail: vi.fn(async () => null) });
    await new SnapCommand(ccrotate).execute(true);
    expect(ccrotate.saveProfiles).toHaveBeenCalled();
  });
});

describe('readLiveClaudeAuthEmail — /api/oauth/profile probe', () => {
  // Production incident 2026-05-19: the previous implementation called
  // `claude auth status --json` which returns `email: null` in claude CLI
  // ≥2.x. That made the snap identity guard silently always-skip and let
  // 9 of 15 profiles in the paperclip pool end up cross-wired (the same
  // OAuth token written under 9 different email keys). The fix probes
  // /api/oauth/profile directly with the live access token — that
  // endpoint authoritatively returns the bearer's owning identity.
  it('returns the email from /api/oauth/profile on 200', async () => {
    const cc = new CCRotate();
    // Stub the network helper rather than monkey-patching https.request.
    cc._fetchOauthProfileEmail = vi.fn(async (tok) => {
      expect(tok).toBe('TEST_AT');
      return 'real@x.com';
    });
    // Stub credentials read by patching the method to call the probe
    // with a hardcoded access token (we don't want to write to the
    // real ~/.claude/.credentials.json).
    cc.readLiveClaudeAuthEmail = async function() {
      return await this._fetchOauthProfileEmail('TEST_AT');
    };
    expect(await cc.readLiveClaudeAuthEmail()).toBe('real@x.com');
  });

  it('returns null on probe failure (HTTP error / network / parse)', async () => {
    const cc = new CCRotate();
    cc._fetchOauthProfileEmail = vi.fn(async () => null);
    cc.readLiveClaudeAuthEmail = async function() {
      return await this._fetchOauthProfileEmail('TEST_AT');
    };
    expect(await cc.readLiveClaudeAuthEmail()).toBeNull();
  });

  it('SnapCommand aborts when /api/oauth/profile email differs from currentAccount.email', async () => {
    // Integration check: the guard wires up correctly even when the
    // mismatch comes from the new probe-based implementation.
    const cc = {
      isClaudeTarget: () => true,
      getCurrentAccount: () => ({ email: 'x@blockcast.net' }),
      // Live token belongs to a DIFFERENT identity — the cross-write
      // scenario the guard exists to catch.
      readLiveClaudeAuthEmail: vi.fn(async () => 'y@blockcast.net'),
      loadProfiles: () => ({}),
      createProfileFromCurrentAccount: () => ({ provider: 'claude' }),
      saveProfiles: vi.fn(),
    };
    await expect(new SnapCommand(cc).execute(true)).rejects.toThrow(/snap aborted/);
    expect(cc.saveProfiles).not.toHaveBeenCalled();
  });
});
