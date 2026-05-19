import chalk from 'chalk';
import msgpack from 'msgpack-lite';
import { gzipSync, gunzipSync } from 'zlib';
import { createHash } from 'crypto';

// Shared between export and import — must stay in sync
export function optimizeProfile(email, profile) {
  if (profile?.provider === 'codex' || profile?.auth) {
    if (!profile?.auth) return null;
    return {
      p: 'codex',
      a: profile.auth,
      i: profile.accountId || null,
      n: profile.name || null,
      t: profile.tokenClaims || null,
      l: profile.lastUsed || null,
      s: profile.lastApiSyncAt || null
    };
  }

  const creds = profile.credentials?.claudeAiOauth;
  const oauth = profile.oauthAccount;
  if (!creds || !oauth) return null;
  return {
    p: 'claude',
    c: {
      a: creds.accessToken,
      r: creds.refreshToken,
      e: creds.expiresAt,
      s: creds.scopes,
      t: creds.subscriptionType
    },
    o: {
      u: oauth.accountUuid,
      e: oauth.emailAddress,
      g: oauth.organizationUuid,
      r: oauth.organizationRole,
      w: oauth.workspaceRole,
      n: oauth.organizationName
    },
    l: profile.lastUsed || null,
    s: profile.lastApiSyncAt || null,
    st: profile.stale || null,
    sa: profile.staleAt || null
  };
}

export function restoreProfile(compact) {
  if (compact?.p === 'codex' || compact?.a) {
    return {
      provider: 'codex',
      auth: compact.a,
      accountId: compact.i || null,
      name: compact.n || null,
      tokenClaims: compact.t || null,
      lastUsed: compact.l || null,
      lastApiSyncAt: compact.s || null
    };
  }

  return {
    provider: 'claude',
    credentials: {
      claudeAiOauth: {
        accessToken: compact.c.a,
        refreshToken: compact.c.r,
        expiresAt: compact.c.e,
        scopes: compact.c.s,
        subscriptionType: compact.c.t
      }
    },
    oauthAccount: {
      accountUuid: compact.o.u,
      emailAddress: compact.o.e,
      organizationUuid: compact.o.g,
      organizationRole: compact.o.r,
      workspaceRole: compact.o.w,
      organizationName: compact.o.n
    },
    lastUsed: compact.l || null,
    lastApiSyncAt: compact.s || null,
    stale: compact.st || null,
    staleAt: compact.sa || null
  };
}

// CRC is computed on the round-tripped (optimize→restore) data so export and import always match
export function computeCrc(optimized) {
  const restored = {};
  for (const [email, compact] of Object.entries(optimized)) {
    if (email.startsWith('__')) continue; // skip metadata keys
    restored[email] = restoreProfile(compact);
  }
  const sorted = Object.keys(restored).sort().reduce((a, k) => (a[k] = restored[k], a), {});
  return createHash('md5').update(JSON.stringify(sorted)).digest('hex').slice(0, 8);
}

// Decode an `mp-gz-b64:` export payload back into profiles + tier-cache.
// Pure (no fs, no prompts) — the same decode `ImportCommand.execute` runs,
// extracted so the state-server's /state/import endpoint can decode a blob
// server-side without an ink/prompts UI. Throws on a malformed prefix,
// missing/short CRC, decompression failure, CRC mismatch, or an invalid
// profile shape. Returns { profiles, tierCache } where tierCache is the
// `__tier_cache__` payload (or null if the export carried none).
export function decodeImportPayload(data) {
  if (!data || typeof data !== 'string') {
    throw new Error('No compressed data provided.');
  }
  let clean = data.trim();
  if ((clean.startsWith('"') && clean.endsWith('"')) ||
      (clean.startsWith("'") && clean.endsWith("'"))) {
    clean = clean.slice(1, -1);
  }
  if (!clean.startsWith('mp-gz-b64:')) {
    throw new Error('Invalid data format. Expected mp-gz-b64: prefix.');
  }
  const dataWithCrc = clean.slice('mp-gz-b64:'.length);
  const colonIndex = dataWithCrc.indexOf(':');
  if (colonIndex === -1) {
    throw new Error('Invalid data format. Missing CRC hash.');
  }
  const expectedCrc = dataWithCrc.slice(0, colonIndex);
  const encodedData = dataWithCrc.slice(colonIndex + 1);
  if (expectedCrc.length !== 8) {
    throw new Error('Invalid CRC hash format. Expected 8 characters.');
  }

  let optimized;
  try {
    const decompressed = gunzipSync(Buffer.from(encodedData, 'base64'));
    optimized = msgpack.decode(decompressed);
  } catch (error) {
    throw new Error(`Failed to parse imported data: ${error.message}`);
  }

  const actualCrc = computeCrc(optimized);
  if (actualCrc !== expectedCrc) {
    throw new Error(
      `CRC verification failed. Expected: ${expectedCrc}, Got: ${actualCrc}. Data may be corrupted.`,
    );
  }

  let tierCache = null;
  if (optimized['__tier_cache__']) {
    tierCache = optimized['__tier_cache__'];
    delete optimized['__tier_cache__'];
  }

  const profiles = {};
  for (const [email, compact] of Object.entries(optimized)) {
    profiles[email] = restoreProfile(compact);
  }

  for (const [email, profile] of Object.entries(profiles)) {
    if (profile.provider === 'codex' || profile.auth) {
      if (!profile.auth) {
        throw new Error(`Invalid Codex profile structure for ${email}. Missing auth fields.`);
      }
      continue;
    }
    if (!profile.credentials?.claudeAiOauth || !profile.oauthAccount) {
      throw new Error(`Invalid profile structure for ${email}. Missing required fields.`);
    }
  }

  return { profiles, tierCache };
}

export class ExportCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute() {
    const profiles = this.ccrotate.loadProfiles();

    if (Object.keys(profiles).length === 0) {
      console.log(chalk.yellow('No profiles found to export.'));
      return;
    }

    const refreshed = await this.refreshExpiringProfiles(profiles);
    if (refreshed > 0) {
      this.ccrotate.saveProfiles(profiles);
      console.log(chalk.gray(`  Refreshed ${refreshed} expiring token(s)`));
    }

    try {
      const originalJson = JSON.stringify(profiles);

      // Optimize
      const optimized = {};
      for (const [email, profile] of Object.entries(profiles)) {
        const compact = optimizeProfile(email, profile);
        if (compact) optimized[email] = compact;
      }

      // CRC on profile data only (before adding tier-cache)
      const crc = computeCrc(optimized);

      // Add tier-cache after CRC — not included in CRC
      const tierCache = this.prepareTierCacheForExport(this.ccrotate.loadTierCache());
      if (tierCache) {
        optimized['__tier_cache__'] = tierCache;
      }

      // Pack + compress (includes tier-cache in payload)
      const packed = msgpack.encode(optimized);
      const gzipped = gzipSync(packed);
      const encoded = gzipped.toString('base64');

      const finalOutput = `${crc}:${encoded}`;

      console.log(chalk.green('✓ Profiles exported (Shell-Safe compression + CRC verification):'));
      console.log(chalk.dim(`${Object.keys(profiles).length} accounts: ${originalJson.length} → ${finalOutput.length} chars (-${Math.round((1 - finalOutput.length / originalJson.length) * 100)}%)`));
      console.log(chalk.dim(`CRC: ${crc} (data integrity guaranteed)`));
      console.log();
      console.log('"mp-gz-b64:' + finalOutput + '"');

    } catch (error) {
      throw new Error(`Failed to export profiles: ${error.message}`);
    }
  }

  async refreshExpiringProfiles(profiles) {
    let refreshed = 0;

    for (const [email, profile] of Object.entries(profiles)) {
      if (profile?.provider === 'codex' || profile?.auth) {
        continue;
      }

      const exp = profile.credentials?.claudeAiOauth?.expiresAt || 0;
      if (exp < Date.now() + 5 * 60 * 1000) {
        const updated = await this.ccrotate.refreshAccessToken(profile.credentials);
        if (updated) {
          profiles[email].credentials = updated;
          refreshed++;
        }
      }
    }

    return refreshed;
  }

  prepareTierCacheForExport(tierCache) {
    if (!tierCache?.accounts) return tierCache;

    return {
      ...tierCache,
      accounts: tierCache.accounts.map(account => ({
        ...account,
        syncedAt: account.syncedAt || account.rateLimits?.snapshotCapturedAt || tierCache.updatedAt || null
      }))
    };
  }
}
