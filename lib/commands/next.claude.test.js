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
});
