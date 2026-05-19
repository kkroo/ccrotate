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
    const result = ccrotate.parseUsageResult(usageData, 'a@x.com');
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
    }, 'a@x.com');
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
