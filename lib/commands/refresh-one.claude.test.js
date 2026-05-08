import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { RefreshOneCommand } from './refresh-one.js';

function withProfilesDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccrotate-rfoc-'));
}

function expiredOauth(email) {
  return {
    accessToken: `at-old-${email}`,
    refreshToken: `rt-old-${email}`,
    expiresAt: Date.now() - 60_000, // already expired → triggers refresh
  };
}

function freshOauth(email) {
  return {
    accessToken: `at-fresh-${email}`,
    refreshToken: `rt-fresh-${email}`,
    expiresAt: Date.now() + 60 * 60 * 1000,
  };
}

describe('Claude refresh-one — active-account rotation must mirror to disk', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // Real incident 2026-05-08 (BLO-4115): refresh-one rotated the active
  // account's refresh_token, persisted the new pair to profiles.json, but
  // never wrote it to ~/.claude/.credentials.json. The live claude run
  // held the OLD pair in memory; when it tried to refresh, it used a
  // refresh_token the server had already invalidated and reported
  // "Not logged in · Please run /login" mid-flight. After 20 turns / 4min /
  // $1.87. The fix: when refresh-one rotates the ACTIVE account's tokens,
  // mirror the rotation to ~/.claude/.credentials.json so any in-flight
  // claude process (or its next refresh attempt) sees the new pair.
  it('writes rotated active-account credentials to disk', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const profiles = {
      'active@example.com': {
        credentials: { claudeAiOauth: expiredOauth('active@example.com') },
      },
      'other@example.com': {
        credentials: { claudeAiOauth: freshOauth('other@example.com') },
      },
    };

    const newCreds = { claudeAiOauth: { ...freshOauth('active@example.com'), refreshToken: 'rt-rotated' } };

    const ccrotate = {
      isCodexTarget: () => false,
      profilesDir: withProfilesDir(),
      loadProfiles: () => profiles,
      loadTierCache: () => ({ accounts: [] }),
      getCurrentAccount: () => ({ email: 'active@example.com' }),
      saveProfiles: vi.fn((p) => { Object.assign(profiles, p); }),
      saveTierCache: vi.fn(),
      refreshAccessToken: vi.fn().mockResolvedValue(newCreds),
      testAccount: vi.fn().mockResolvedValue({
        status: 'success', serviceTier: 'base', response: 'ok',
        rateLimits: { utilization5h: 10 },
      }),
      writeActiveAccountFiles: vi.fn(),
    };

    await new RefreshOneCommand(ccrotate).executeClaude();

    expect(ccrotate.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(ccrotate.writeActiveAccountFiles).toHaveBeenCalledTimes(1);
    expect(ccrotate.writeActiveAccountFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: expect.objectContaining({
          claudeAiOauth: expect.objectContaining({ refreshToken: 'rt-rotated' }),
        }),
      })
    );
  });

  it('does NOT write to disk when refreshing a non-active account', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const profiles = {
      'active@example.com': {
        credentials: { claudeAiOauth: freshOauth('active@example.com') },
      },
      'other@example.com': {
        credentials: { claudeAiOauth: expiredOauth('other@example.com') },
      },
    };
    const profilesDir = withProfilesDir();
    // Force the active account onto API cooldown so refresh-one skips it
    // and picks 'other@example.com' as the target.
    const activeTokenKey = createHash('sha256')
      .update(profiles['active@example.com'].credentials.claudeAiOauth.accessToken)
      .digest('hex')
      .slice(0, 16);
    fs.writeFileSync(
      path.join(profilesDir, 'usage-api-cooldowns.json'),
      JSON.stringify({ [activeTokenKey]: Date.now() + 60_000 }),
    );

    const ccrotate = {
      isCodexTarget: () => false,
      profilesDir,
      loadProfiles: () => profiles,
      loadTierCache: () => ({ accounts: [] }),
      getCurrentAccount: () => ({ email: 'active@example.com' }),
      saveProfiles: vi.fn(),
      saveTierCache: vi.fn(),
      refreshAccessToken: vi.fn().mockResolvedValue({
        claudeAiOauth: { ...freshOauth('other@example.com'), refreshToken: 'rt-rotated' },
      }),
      testAccount: vi.fn().mockResolvedValue({
        status: 'success', serviceTier: 'base', response: 'ok',
        rateLimits: { utilization5h: 10 },
      }),
      writeActiveAccountFiles: vi.fn(),
    };

    await new RefreshOneCommand(ccrotate).executeClaude();

    // Refresh ran for the non-active account but should NOT touch the
    // active credentials file — writing 'other@example.com''s creds to
    // ~/.claude would hijack the active session.
    expect(ccrotate.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(ccrotate.writeActiveAccountFiles).not.toHaveBeenCalled();
  });
});
