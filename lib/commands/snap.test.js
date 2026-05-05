import { describe, expect, it, vi } from 'vitest';
import { SnapCommand } from './snap.js';

describe('SnapCommand', () => {
  function makeCcrotate({ profiles, currentEmail = 'active@example.com' }) {
    return {
      getCurrentAccount: () => ({
        email: currentEmail,
        credentials: { claudeAiOauth: { accessToken: 'AT', refreshToken: 'RT' } },
        userId: 'user-1',
        oauthAccount: { emailAddress: currentEmail },
      }),
      loadProfiles: () => profiles,
      saveProfiles: vi.fn(),
      // Pass-through stub for the cross-process lock — the real
      // implementation in ccrotate.js is exercised by ccrotate.test.js;
      // here we just need the read+saveProfiles to run inside it. A
      // separate test below asserts snap routes through this wrapper.
      withActiveFilesLock: (fn) => fn(),
      createProfileFromCurrentAccount: (acct) => ({
        provider: 'claude',
        credentials: acct.credentials,
        userId: acct.userId,
        oauthAccount: acct.oauthAccount,
        lastUsed: '2026-05-05T00:00:00.000Z',
      }),
    };
  }

  it('saves under getCurrentAccount().email when no override is given', async () => {
    const profiles = {};
    const ccrotate = makeCcrotate({ profiles });
    const cmd = new SnapCommand(ccrotate);

    await cmd.execute(true);

    expect(ccrotate.saveProfiles).toHaveBeenCalledWith(
      expect.objectContaining({
        'active@example.com': expect.objectContaining({ provider: 'claude' }),
      }),
    );
  });

  it('saves under emailOverride when provided, NOT the active email', async () => {
    // The bug case: active oauthAccount.emailAddress drifted between login
    // and snap, so without --email we'd corrupt the active entry with
    // someone else's tokens. With --email, the snap targets the passed
    // address and the active entry is left alone.
    const profiles = {
      'active@example.com': { provider: 'claude', existing: true },
      'override@example.com': {
        provider: 'claude',
        stale: true,
        staleAt: '2026-05-04T00:00:00.000Z',
      },
    };
    const ccrotate = makeCcrotate({ profiles });
    const cmd = new SnapCommand(ccrotate);

    await cmd.execute(true, 'override@example.com');

    const saved = ccrotate.saveProfiles.mock.calls[0][0];
    expect(saved['active@example.com']).toEqual({ provider: 'claude', existing: true });
    expect(saved['override@example.com']).toMatchObject({ provider: 'claude' });
    // Critical: replacing the entry must drop the stale flag.
    expect(saved['override@example.com'].stale).toBeUndefined();
    expect(saved['override@example.com'].staleAt).toBeUndefined();
  });

  it('passes emailOverride into createProfileFromCurrentAccount as the email', async () => {
    const profiles = {};
    const ccrotate = makeCcrotate({ profiles, currentEmail: 'active@example.com' });
    const createSpy = vi.spyOn(ccrotate, 'createProfileFromCurrentAccount');
    const cmd = new SnapCommand(ccrotate);

    await cmd.execute(true, 'override@example.com');

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'override@example.com' }),
    );
  });

  it('holds the active-files lock around getCurrentAccount so the email/credentials pair is consistent', async () => {
    // The on-limit hook race we're closing: paperclip-0's claude-hook
    // calls `ccrotate snap --force` (no --email) while another agent's
    // hook calls `ccrotate switch <Y>`. Without the lock, snap's
    // .claude.json read returns email X (pre-switch) and the
    // .credentials.json read returns Y's tokens (post-switch), and snap
    // saves profiles[X] = Y's credentials. Verified empirically
    // 2026-05-05: pool accumulated dupes (org members sharing one rt).
    //
    // We can't drive the actual race in a unit test (it's filesystem +
    // multi-process), so we assert the structural fix: snap routes its
    // read through withActiveFilesLock, exposing the lock hold-window
    // to whichever locking implementation is configured.
    const profiles = {};
    const ccrotate = makeCcrotate({ profiles });
    let lockHeldDuringGetCurrent = false;
    let inLock = false;
    ccrotate.withActiveFilesLock = (fn) => { inLock = true; try { return fn(); } finally { inLock = false; } };
    const origGet = ccrotate.getCurrentAccount;
    ccrotate.getCurrentAccount = () => { lockHeldDuringGetCurrent = inLock; return origGet(); };
    const cmd = new SnapCommand(ccrotate);

    await cmd.execute(true);

    expect(lockHeldDuringGetCurrent).toBe(true);
  });
});
