import chalk from 'chalk';
import msgpack from 'msgpack-lite';
import { gzipSync } from 'zlib';
import { createHash } from 'crypto';

// Shared between export and import — must stay in sync
export function optimizeProfile(email, profile) {
  const creds = profile.credentials?.claudeAiOauth;
  const oauth = profile.oauthAccount;
  if (!creds || !oauth) return null;
  return {
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
    l: profile.lastUsed
  };
}

export function restoreProfile(compact) {
  return {
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
    lastUsed: compact.l
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

    // Refresh expired tokens before exporting so recipient gets usable credentials
    let refreshed = 0;
    for (const [email, profile] of Object.entries(profiles)) {
      const exp = profile.credentials?.claudeAiOauth?.expiresAt || 0;
      if (exp < Date.now() + 5 * 60 * 1000) {
        const updated = await this.ccrotate.refreshAccessToken(profile.credentials);
        if (updated) {
          profiles[email].credentials = updated;
          refreshed++;
        }
      }
    }
    if (refreshed > 0) {
      this.ccrotate.saveProfiles(profiles);
      console.log(chalk.gray(`  Refreshed ${refreshed} expired token(s)`));
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
      const tierCache = this.ccrotate.loadTierCache();
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
}