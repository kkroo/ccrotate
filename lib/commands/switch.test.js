import { describe, expect, it, vi } from 'vitest';
import { SwitchCommand } from './switch.js';

describe('SwitchCommand', () => {
  it('relaunches the current session after a successful switch when requested', async () => {
    const ccrotate = {
      isClaudeTarget: () => false,
      isCodexTarget: () => true,
      loadProfiles: () => ({
        'codex@example.com': { auth: { tokens: {} } }
      }),
      getCurrentAccount: () => { throw new Error('no active account'); },
      saveProfiles: vi.fn(),
      writeActiveAccountFiles: vi.fn(),
      getPostSwitchMessage: () => 'Start a new Codex session if the current process has cached auth.',
      relaunchCurrentSession: vi.fn(),
    };

    const command = new SwitchCommand(ccrotate);
    command.trySwitchCodex = vi.fn().mockResolvedValue(true);

    await command.execute('codex@example.com', { relaunch: true });

    expect(command.trySwitchCodex).toHaveBeenCalledWith('codex@example.com', expect.any(Object));
    expect(ccrotate.relaunchCurrentSession).toHaveBeenCalledTimes(1);
  });

  describe('claude refresh failure handling — DO NOT mark stale on transient errors', () => {
    // Real incident 2026-05-08: `ccrotate switch princeomz2004@blockcast.net`
    // hit a network/5xx during refresh and ended up marking the account
    // stale, requiring manual /login + snap to recover. Refresh failure
    // should distinguish definitive auth failures (invalid_grant: the
    // refresh_token has been rotated elsewhere) from transient errors
    // (network, 5xx, 429) — only the former warrants marking stale.
    function buildCcrotate(profiles) {
      return {
        isClaudeTarget: () => true,
        isCodexTarget: () => false,
        loadProfiles: () => profiles,
        getCurrentAccount: () => { throw new Error('no active account'); },
        saveProfiles: vi.fn((p) => { Object.assign(profiles, p); }),
        writeActiveAccountFiles: vi.fn(),
        writeCredentialsToKeychain: vi.fn(),
        checkTokenStatus: vi.fn().mockResolvedValue('valid'),
        refreshAccessTokenDetailed: vi.fn(),
        refreshAccessToken: vi.fn(),
        getPostSwitchMessage: () => '',
        relaunchCurrentSession: vi.fn(),
      };
    }

    function expiredAccount(email) {
      return {
        [email]: {
          credentials: {
            claudeAiOauth: {
              accessToken: 'expired',
              refreshToken: 'rt-' + email,
              expiresAt: Date.now() - 60_000, // expired
            }
          }
        }
      };
    }

    it('does NOT mark stale when refresh fails transiently (network)', async () => {
      const profiles = expiredAccount('a@example.com');
      const ccrotate = buildCcrotate(profiles);
      ccrotate.refreshAccessTokenDetailed.mockResolvedValue({
        ok: false, kind: 'transient', message: 'network error: ECONNRESET',
      });

      const command = new SwitchCommand(ccrotate);
      await command.execute('a@example.com', {});

      expect(profiles['a@example.com'].stale).toBeUndefined();
      expect(profiles['a@example.com'].staleAt).toBeUndefined();
      expect(ccrotate.writeActiveAccountFiles).not.toHaveBeenCalled();
      // Profiles should not have been mutated to stale state
      const saveCalls = ccrotate.saveProfiles.mock.calls;
      for (const call of saveCalls) {
        expect(call[0]['a@example.com'].stale).toBeUndefined();
      }
    });

    it('does NOT mark stale on 5xx / 429 / timeout', async () => {
      const profiles = expiredAccount('b@example.com');
      const ccrotate = buildCcrotate(profiles);
      ccrotate.refreshAccessTokenDetailed.mockResolvedValue({
        ok: false, kind: 'transient', statusCode: 503, message: 'HTTP 503',
      });

      const command = new SwitchCommand(ccrotate);
      await command.execute('b@example.com', {});

      expect(profiles['b@example.com'].stale).toBeUndefined();
    });

    it('DOES mark stale when refresh fails with invalid_grant (definitive)', async () => {
      const profiles = expiredAccount('c@example.com');
      const ccrotate = buildCcrotate(profiles);
      ccrotate.refreshAccessTokenDetailed.mockResolvedValue({
        ok: false, kind: 'invalid_grant', statusCode: 400,
        body: { error: 'invalid_grant' },
      });

      const command = new SwitchCommand(ccrotate);
      await command.execute('c@example.com', {});

      expect(profiles['c@example.com'].stale).toBe(true);
      expect(profiles['c@example.com'].staleAt).toBeTruthy();
    });

    it('--no-refresh skips the refresh entirely and does not mark stale', async () => {
      const profiles = expiredAccount('d@example.com');
      const ccrotate = buildCcrotate(profiles);

      const command = new SwitchCommand(ccrotate);
      await command.execute('d@example.com', { noRefresh: true });

      expect(ccrotate.refreshAccessTokenDetailed).not.toHaveBeenCalled();
      expect(ccrotate.refreshAccessToken).not.toHaveBeenCalled();
      expect(profiles['d@example.com'].stale).toBeUndefined();
      expect(profiles['d@example.com'].staleAt).toBeUndefined();
      expect(ccrotate.writeActiveAccountFiles).not.toHaveBeenCalled();
    });
  });
});
