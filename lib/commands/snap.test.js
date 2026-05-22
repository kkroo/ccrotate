import { describe, expect, it, vi } from 'vitest';
import { SnapCommand } from './snap.js';

function buildClaudeCcrotate(opts = {}) {
  const {
    ambientEmail = 'ambient@example.com',
    liveEmail = 'ambient@example.com',
    profiles = {},
  } = opts;
  return {
    isClaudeTarget: () => true,
    isCodexTarget: () => false,
    getCurrentAccount: () => ({
      email: ambientEmail,
      credentials: { claudeAiOauth: { accessToken: 'live-tok', refreshToken: 'live-rt' } },
      userId: 'uid-' + ambientEmail,
      oauthAccount: { emailAddress: ambientEmail, organizationName: 'Test Org' },
    }),
    readLiveClaudeAuthEmail: async () => liveEmail,
    loadProfiles: () => ({ ...profiles }),
    saveProfiles: vi.fn(),
    createProfileFromCurrentAccount: (acc) => ({
      provider: 'claude',
      credentials: acc.credentials,
      userId: acc.userId,
      oauthAccount: acc.oauthAccount,
      lastUsed: '2026-05-22T00:00:00Z',
      lastApiSyncAt: '2026-05-22T00:00:00Z',
      stale: false,
    }),
  };
}

function buildCodexCcrotate(opts = {}) {
  const {
    ambientEmail = 'codex@example.com',
    profiles = {},
  } = opts;
  return {
    isClaudeTarget: () => false,
    isCodexTarget: () => true,
    getCurrentAccount: () => ({
      email: ambientEmail,
      auth: { tokens: { id_token: 'jwt-fake', access_token: 'codex-at' } },
      accountId: 'acct-' + ambientEmail,
    }),
    readLiveClaudeAuthEmail: async () => null,
    loadProfiles: () => ({ ...profiles }),
    saveProfiles: vi.fn(),
    createProfileFromCurrentAccount: (acc) => ({
      provider: 'codex',
      auth: acc.auth,
      accountId: acc.accountId,
      lastUsed: '2026-05-22T00:00:00Z',
    }),
  };
}

describe('SnapCommand', () => {
  describe('default behavior (no --email)', () => {
    it('saves under ambient email when live identity agrees', async () => {
      const ccrotate = buildClaudeCcrotate({ ambientEmail: 'a@example.com', liveEmail: 'a@example.com' });
      const cmd = new SnapCommand(ccrotate);

      await cmd.execute(true);

      expect(ccrotate.saveProfiles).toHaveBeenCalledOnce();
      const saved = ccrotate.saveProfiles.mock.calls[0][0];
      expect(Object.keys(saved)).toEqual(['a@example.com']);
      expect(saved['a@example.com'].oauthAccount.emailAddress).toBe('a@example.com');
    });

    it('aborts when live identity disagrees with ambient (the cross-wire signal)', async () => {
      const ccrotate = buildClaudeCcrotate({ ambientEmail: 'a@example.com', liveEmail: 'b@example.com' });
      const cmd = new SnapCommand(ccrotate);

      await expect(cmd.execute(true)).rejects.toThrow(
        /snap aborted: claude auth status reports 'b@example.com'/,
      );
      expect(ccrotate.saveProfiles).not.toHaveBeenCalled();
    });

    it('skips the identity check (with note) when live email is null', async () => {
      const ccrotate = buildClaudeCcrotate({ ambientEmail: 'a@example.com', liveEmail: null });
      const cmd = new SnapCommand(ccrotate);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await cmd.execute(true);

      expect(ccrotate.saveProfiles).toHaveBeenCalledOnce();
      logSpy.mockRestore();
    });
  });

  describe('--email pin (claude)', () => {
    it('saves under pinned email when live identity matches the pin', async () => {
      // Ambient state is "stale" (still showing the previous account) but the
      // live token actually belongs to the pinned account — exactly the race
      // /reloginViaSession hits after a sibling profile switch mutates
      // ~/.claude.json before snap runs.
      const ccrotate = buildClaudeCcrotate({
        ambientEmail: 'stale@example.com',
        liveEmail: 'pinned@example.com',
      });
      const cmd = new SnapCommand(ccrotate);

      await cmd.execute(true, { email: 'pinned@example.com' });

      expect(ccrotate.saveProfiles).toHaveBeenCalledOnce();
      const saved = ccrotate.saveProfiles.mock.calls[0][0];
      // The slot key is the pinned email — NOT the ambient one.
      expect(Object.keys(saved)).toEqual(['pinned@example.com']);
      // The saved profile's oauthAccount.emailAddress is rewritten to match
      // the slot, so the profile is internally consistent on read-back.
      expect(saved['pinned@example.com'].oauthAccount.emailAddress).toBe('pinned@example.com');
      // The actual token payload is preserved as-is — the credentials came
      // from the live ~/.claude/.credentials.json regardless of slot.
      expect(saved['pinned@example.com'].credentials.claudeAiOauth.accessToken).toBe('live-tok');
    });

    it('refuses to cross-write when pinned email does not match live identity', async () => {
      // The CLI is actually logged in as 'real@example.com' but caller is
      // asking to slot those tokens under 'wrong@example.com'. Pre-flag the
      // mismatch loudly — never write the wrong tokens under any slot.
      const ccrotate = buildClaudeCcrotate({
        ambientEmail: 'real@example.com',
        liveEmail: 'real@example.com',
      });
      const cmd = new SnapCommand(ccrotate);

      await expect(cmd.execute(true, { email: 'wrong@example.com' })).rejects.toThrow(
        /snap aborted: --email pinned to 'wrong@example.com', but live token belongs to 'real@example.com'/,
      );
      expect(ccrotate.saveProfiles).not.toHaveBeenCalled();
    });

    it('rejects non-string --email values', async () => {
      const ccrotate = buildClaudeCcrotate();
      const cmd = new SnapCommand(ccrotate);

      await expect(cmd.execute(true, { email: 42 })).rejects.toThrow(/snap --email must be a string/);
      expect(ccrotate.saveProfiles).not.toHaveBeenCalled();
    });
  });

  describe('--email pin (codex)', () => {
    it('saves under the codex account when --email matches the JWT-derived identity', async () => {
      const ccrotate = buildCodexCcrotate({ ambientEmail: 'codex@example.com' });
      const cmd = new SnapCommand(ccrotate);

      await cmd.execute(true, { email: 'codex@example.com' });

      expect(ccrotate.saveProfiles).toHaveBeenCalledOnce();
      const saved = ccrotate.saveProfiles.mock.calls[0][0];
      expect(Object.keys(saved)).toEqual(['codex@example.com']);
    });

    it('refuses when codex --email disagrees with the JWT-derived identity', async () => {
      // Sanity check — id_token is signed by OpenAI so it is authoritative.
      // Don't let callers override it; surface the mismatch.
      const ccrotate = buildCodexCcrotate({ ambientEmail: 'codex@example.com' });
      const cmd = new SnapCommand(ccrotate);

      await expect(cmd.execute(true, { email: 'other@example.com' })).rejects.toThrow(
        /snap aborted: --email pinned to 'other@example.com', but codex auth.json id_token decodes to 'codex@example.com'/,
      );
      expect(ccrotate.saveProfiles).not.toHaveBeenCalled();
    });

    it('default codex snap (no --email) works as before', async () => {
      const ccrotate = buildCodexCcrotate({ ambientEmail: 'codex@example.com' });
      const cmd = new SnapCommand(ccrotate);

      await cmd.execute(true);

      expect(ccrotate.saveProfiles).toHaveBeenCalledOnce();
    });
  });
});
