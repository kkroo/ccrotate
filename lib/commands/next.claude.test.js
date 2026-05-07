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

  it('marks the profile stale when refresh fails so the auth-bot poller can recover it', async () => {
    // Symmetric with switch.js:53-56. Without this, a profile whose OAuth
    // refresh_token is dead (revoked / expired / superseded by an
    // out-of-band login on another machine) gets re-selected by every
    // future `next` run, hits the same refresh failure each time, and
    // the auth-bot stale-poller never learns to relogin via the persisted
    // claude.ai sessionKey — so 401s leak through to the agent run.
    const expiredCredentials = {
      claudeAiOauth: {
        accessToken: 'old-token',
        refreshToken: 'dead-refresh-token',
        expiresAt: Date.now() - 60 * 1000, // already expired → triggers refresh path
      },
    };

    const profiles = {
      'dead@example.com': {
        credentials: expiredCredentials,
      },
    };

    const ccrotate = {
      isCodexTarget: () => false,
      refreshAccessToken: vi.fn().mockResolvedValue(null), // refresh fails
      writeActiveAccountFiles: vi.fn(),
      writeCredentialsToKeychain: vi.fn(),
      saveProfiles: vi.fn(),
    };

    const command = new NextCommand(ccrotate);

    const ok = await command.switchTo('dead@example.com', profiles);

    expect(ok).toBe(false);
    // The crucial side effect: stale flag is written so the auth-bot
    // stale-poller will reloginViaSession on its next 15-min tick.
    expect(profiles['dead@example.com'].stale).toBe(true);
    expect(typeof profiles['dead@example.com'].staleAt).toBe('string');
    expect(ccrotate.saveProfiles).toHaveBeenCalledTimes(1);
    expect(ccrotate.saveProfiles).toHaveBeenCalledWith(profiles);
    // We did NOT actually switch the active account.
    expect(ccrotate.writeActiveAccountFiles).not.toHaveBeenCalled();
    expect(ccrotate.writeCredentialsToKeychain).not.toHaveBeenCalled();
  });
});
