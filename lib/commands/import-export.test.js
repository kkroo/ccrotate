import { describe, expect, it, vi } from 'vitest';
import msgpack from 'msgpack-lite';
import { gzipSync } from 'zlib';
import { optimizeProfile, restoreProfile, computeCrc } from './export.js';
import { ImportCommand } from './import.js';

vi.mock('prompts', () => ({
  default: vi.fn()
}));

function encodeImportPayload(profiles, tierCache = null) {
  const optimized = {};
  for (const [email, profile] of Object.entries(profiles)) {
    optimized[email] = optimizeProfile(email, profile);
  }
  if (tierCache) {
    optimized.__tier_cache__ = tierCache;
  }

  const crc = computeCrc(optimized);
  const encoded = gzipSync(msgpack.encode(optimized)).toString('base64');
  return `mp-gz-b64:${crc}:${encoded}`;
}

function makeCcrotate(existingProfiles, existingTierCache) {
  const state = {
    profiles: JSON.parse(JSON.stringify(existingProfiles)),
    tierCache: JSON.parse(JSON.stringify(existingTierCache))
  };

  return {
    profilesFile: '/tmp/ccrotate-import-test-profiles.json',
    loadProfiles: () => state.profiles,
    saveProfiles: (profiles) => {
      state.profiles = JSON.parse(JSON.stringify(profiles));
    },
    loadTierCache: () => state.tierCache,
    saveTierCache: (accounts) => {
      state.tierCache = {
        updatedAt: '2026-04-28T06:00:00.000Z',
        accounts: JSON.parse(JSON.stringify(accounts))
      };
    },
    tierCacheEntryHasRateLimitData: (entry) => Boolean(
      entry?.rateLimits?.utilization5h != null ||
      entry?.rateLimits?.utilization7d != null ||
      entry?.rateLimits?.remaining5h != null ||
      entry?.rateLimits?.remaining7d != null
    ),
    _state: state
  };
}

describe('export/import sync metadata', () => {
  it('round-trips Claude and Codex profiles with sync metadata intact', () => {
    const claude = {
      provider: 'claude',
      credentials: {
        claudeAiOauth: {
          accessToken: 'claude-access',
          refreshToken: 'claude-refresh',
          expiresAt: 1770000000000,
          scopes: ['chat'],
          subscriptionType: 'pro'
        }
      },
      oauthAccount: {
        accountUuid: 'claude-uuid',
        emailAddress: 'claude@example.com',
        organizationUuid: 'org-1',
        organizationRole: 'member',
        workspaceRole: 'member',
        organizationName: 'Org'
      },
      lastUsed: '2026-04-28T01:00:00.000Z',
      lastApiSyncAt: '2026-04-28T02:00:00.000Z',
      stale: true,
      staleAt: '2026-04-27T00:00:00.000Z'
    };

    const codex = {
      provider: 'codex',
      auth: { tokens: { account_id: 'acct-1', id_token: 'id-token' } },
      accountId: 'acct-1',
      name: 'Codex User',
      tokenClaims: { email: 'codex@example.com', name: 'Codex User', sub: 'acct-1', exp: 1770000000, iss: 'issuer' },
      lastUsed: '2026-04-28T01:30:00.000Z',
      lastApiSyncAt: '2026-04-28T02:30:00.000Z'
    };

    expect(restoreProfile(optimizeProfile('claude@example.com', claude))).toEqual(claude);
    expect(restoreProfile(optimizeProfile('codex@example.com', codex))).toEqual(codex);
  });

  it('prefers the profile and tier-cache entry with the newest successful API sync', async () => {
    const existingProfiles = {
      'claude@example.com': {
        provider: 'claude',
        credentials: {
          claudeAiOauth: {
            accessToken: 'local-claude',
            refreshToken: 'local-claude-refresh',
            expiresAt: 1770000000000,
            scopes: ['chat'],
            subscriptionType: 'pro'
          }
        },
        oauthAccount: {
          accountUuid: 'local-claude-uuid',
          emailAddress: 'claude@example.com',
          organizationUuid: 'org-1',
          organizationRole: 'member',
          workspaceRole: 'member',
          organizationName: 'Org'
        },
        lastApiSyncAt: '2026-04-01T10:00:00.000Z',
        lastUsed: '2026-04-01T11:00:00.000Z'
      },
      'codex@example.com': {
        provider: 'codex',
        auth: { tokens: { account_id: 'local-codex', id_token: 'local-id-token' } },
        accountId: 'local-codex',
        name: 'Local Codex',
        tokenClaims: { email: 'codex@example.com', name: 'Local Codex', sub: 'local-codex', exp: 1770000000, iss: 'issuer' },
        lastApiSyncAt: '2026-04-20T10:00:00.000Z',
        lastUsed: '2026-04-20T11:00:00.000Z'
      }
    };

    const existingTierCache = {
      updatedAt: '2026-04-20T10:00:00.000Z',
      accounts: [
        {
          email: 'claude@example.com',
          status: 'success',
          serviceTier: 'available',
          response: 'local claude',
          syncedAt: '2026-04-01T10:00:00.000Z',
          rateLimits: { remaining5h: 55, remaining7d: 70 }
        },
        {
          email: 'codex@example.com',
          status: 'success',
          serviceTier: 'available',
          response: 'local codex',
          syncedAt: '2026-04-20T10:00:00.000Z',
          rateLimits: { remaining5h: 80, remaining7d: 90 }
        }
      ]
    };

    const incomingProfiles = {
      'claude@example.com': {
        provider: 'claude',
        credentials: {
          claudeAiOauth: {
            accessToken: 'remote-claude',
            refreshToken: 'remote-claude-refresh',
            expiresAt: 1771000000000,
            scopes: ['chat', 'usage'],
            subscriptionType: 'max'
          }
        },
        oauthAccount: {
          accountUuid: 'remote-claude-uuid',
          emailAddress: 'claude@example.com',
          organizationUuid: 'org-2',
          organizationRole: 'admin',
          workspaceRole: 'admin',
          organizationName: 'Remote Org'
        },
        lastApiSyncAt: '2026-04-28T12:00:00.000Z',
        lastUsed: '2026-04-28T12:30:00.000Z'
      },
      'codex@example.com': {
        provider: 'codex',
        auth: { tokens: { account_id: 'remote-codex', id_token: 'remote-id-token' } },
        accountId: 'remote-codex',
        name: 'Remote Codex',
        tokenClaims: { email: 'codex@example.com', name: 'Remote Codex', sub: 'remote-codex', exp: 1770000000, iss: 'issuer' },
        lastApiSyncAt: '2026-04-10T10:00:00.000Z',
        lastUsed: '2026-04-10T11:00:00.000Z'
      }
    };

    const importedTierCache = {
      updatedAt: '2026-04-28T12:00:00.000Z',
      accounts: [
        {
          email: 'claude@example.com',
          status: 'success',
          serviceTier: 'available',
          response: 'remote claude',
          syncedAt: '2026-04-28T12:00:00.000Z',
          rateLimits: { remaining5h: 91, remaining7d: 95 }
        },
        {
          email: 'codex@example.com',
          status: 'success',
          serviceTier: 'available',
          response: 'remote codex',
          syncedAt: '2026-04-10T10:00:00.000Z',
          rateLimits: { remaining5h: 20, remaining7d: 30 }
        }
      ]
    };

    const ccrotate = makeCcrotate(existingProfiles, existingTierCache);
    const command = new ImportCommand(ccrotate);
    const payload = encodeImportPayload(incomingProfiles, importedTierCache);

    await command.execute(payload, { force: true });

    expect(ccrotate._state.profiles['claude@example.com'].credentials.claudeAiOauth.accessToken).toBe('remote-claude');
    expect(ccrotate._state.profiles['claude@example.com'].lastApiSyncAt).toBe('2026-04-28T12:00:00.000Z');
    expect(ccrotate._state.profiles['codex@example.com'].auth.tokens.account_id).toBe('local-codex');
    expect(ccrotate._state.profiles['codex@example.com'].lastApiSyncAt).toBe('2026-04-20T10:00:00.000Z');

    const tierByEmail = Object.fromEntries(ccrotate._state.tierCache.accounts.map(entry => [entry.email, entry]));
    expect(tierByEmail['claude@example.com'].response).toBe('remote claude');
    expect(tierByEmail['claude@example.com'].syncedAt).toBe('2026-04-28T12:00:00.000Z');
    expect(tierByEmail['codex@example.com'].response).toBe('local codex');
    expect(tierByEmail['codex@example.com'].syncedAt).toBe('2026-04-20T10:00:00.000Z');
  });
});
