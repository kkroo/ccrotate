import { describe, expect, it, vi } from 'vitest';
import { NextCommand } from './next.js';

describe('Claude next rotation', () => {
  it('refreshes stale Claude tokens before switching', async () => {
    const originalCredentials = {
      claudeAiOauth: {
        accessToken: 'old-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000
      }
    };

    const profiles = {
      'stale@example.com': {
        credentials: originalCredentials,
        stale: true,
        staleAt: '2026-01-01T00:00:00Z'
      }
    };

    const refreshedCredentials = {
      claudeAiOauth: {
        accessToken: 'new-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 2 * 60 * 60 * 1000
      }
    };

    const ccrotate = {
      isCodexTarget: () => false,
      refreshAccessToken: vi.fn().mockResolvedValue(refreshedCredentials),
      writeActiveAccountFiles: vi.fn(),
      writeCredentialsToKeychain: vi.fn(),
      saveProfiles: vi.fn(),
    };

    const command = new NextCommand(ccrotate);

    const ok = await command.switchTo('stale@example.com', profiles);

    expect(ok).toBe(true);
    expect(ccrotate.refreshAccessToken).toHaveBeenCalledWith(originalCredentials);
    expect(profiles['stale@example.com'].credentials).toEqual(refreshedCredentials);
    expect(profiles['stale@example.com'].stale).toBeUndefined();
    expect(profiles['stale@example.com'].staleAt).toBeUndefined();
    expect(ccrotate.writeActiveAccountFiles).toHaveBeenCalledTimes(1);
    expect(ccrotate.writeCredentialsToKeychain).toHaveBeenCalledWith(refreshedCredentials);
    expect(ccrotate.saveProfiles).toHaveBeenCalledTimes(1);
  });

  // Real incident 2026-05-08: pool degraded to 6 stale + 2 exhausted.
  // ccrotate next ran in retry storm, picked stale `ramadan@blockcast.net`
  // as its rotation target. switchTo() refused (refresh failed), but the
  // probe loop had already written stale creds to ~/.claude/.credentials.json
  // before the restore-original step. Heartbeat runs picked up the stale
  // disk state and reported "Not logged in · Please run /login" mid-flight.
  // Stale accounts must NEVER be rotation candidates — only re-auth
  // (snap or relogin bot) brings them back.
  it('excludes stale accounts from rotation candidates', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const profiles = {
      'active@example.com': {
        credentials: { claudeAiOauth: { accessToken: 'a', refreshToken: 'ra', expiresAt: Date.now() + 60*60*1000 } },
      },
      'stale@example.com': {
        stale: true,
        staleAt: '2026-05-08T00:00:00Z',
        credentials: { claudeAiOauth: { accessToken: 'expired', refreshToken: 'rs', expiresAt: Date.now() - 1000 } },
      },
      'good@example.com': {
        credentials: { claudeAiOauth: { accessToken: 'g', refreshToken: 'rg', expiresAt: Date.now() + 60*60*1000 } },
      },
    };

    const ccrotate = {
      isCodexTarget: () => false,
      isClaudeTarget: () => true,
      // Stubbed so the snap identity check (next auto-snaps) stays hermetic
      // — null skips the check rather than shelling out to `claude`.
      readLiveClaudeAuthEmail: vi.fn(async () => null),
      loadProfiles: () => profiles,
      loadConfig: () => ({}),
      loadTierCache: () => ({
        updatedAt: new Date().toISOString(),
        accounts: [
          { email: 'good@example.com', serviceTier: 'base', rateLimits: { utilization5h: 10, utilization7d: 20 }, response: 'ok' },
        ],
      }),
      saveTierCache: vi.fn(),
      saveProfiles: vi.fn(),
      writeActiveAccountFiles: vi.fn(),
      writeCredentialsToKeychain: vi.fn(),
      writeClaudeFiles: vi.fn(),
      getCurrentAccount: () => ({ email: 'active@example.com' }),
      getPostSwitchMessage: () => 'ok',
      relaunchCurrentSession: vi.fn(),
      testAccount: vi.fn().mockResolvedValue({ status: 'success', serviceTier: 'base', rateLimits: { utilization5h: 10 }, response: 'ok' }),
      backupCurrentCredentials: () => ({ credentials: null, config: null }),
      restoreCredentials: vi.fn(),
      clearCooldowns: vi.fn(),
    };

    const command = new NextCommand(ccrotate);
    await command.execute({ yes: true });

    // The probe must never touch stale@example.com — not in cache lookup,
    // not in live probe.
    const writeClaudeFilesCalls = ccrotate.writeClaudeFiles.mock.calls;
    for (const call of writeClaudeFilesCalls) {
      const writtenAccount = call[0];
      // writeClaudeFiles receives accountData; identify which email by
      // matching credentials.
      const matching = Object.entries(profiles).find(([_, p]) => p.credentials === writtenAccount.credentials);
      expect(matching?.[0]).not.toBe('stale@example.com');
    }
    // testAccount must never be called for stale accounts either.
    const testAccountEmails = ccrotate.testAccount.mock.calls.map(c => c[0]);
    expect(testAccountEmails).not.toContain('stale@example.com');
    // Eventual switch must be to good@example.com (the only non-stale, non-active candidate).
    expect(ccrotate.writeActiveAccountFiles).toHaveBeenCalledTimes(1);
    expect(ccrotate.writeActiveAccountFiles.mock.calls[0][0].credentials.claudeAiOauth.accessToken).toBe('g');
  });
});
