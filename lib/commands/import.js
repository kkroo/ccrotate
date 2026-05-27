import chalk from 'chalk';
import prompts from 'prompts';
import msgpack from 'msgpack-lite';
import { gunzipSync } from 'zlib';
import fs from 'fs';
import { restoreProfile, computeCrc } from './export.js';

function parseTimestamp(value) {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function getProfileSyncTime(profile) {
  return parseTimestamp(profile?.lastApiSyncAt || profile?.lastUsed || null);
}

function getTierCacheSyncTime(entry, fallbackUpdatedAt = null) {
  return parseTimestamp(entry?.syncedAt || entry?.rateLimits?.snapshotCapturedAt || fallbackUpdatedAt || null);
}

export class ImportCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute(compressedData, options = {}) {
    if (!compressedData) {
      throw new Error('No compressed data provided. Usage: ccrotate import <compressed-data>');
    }

    let importedTierCache = null;
    let cleanData = compressedData.trim();
    if ((cleanData.startsWith('"') && cleanData.endsWith('"')) ||
        (cleanData.startsWith("'") && cleanData.endsWith("'"))) {
      cleanData = cleanData.slice(1, -1);
    }

    if (!cleanData.startsWith('mp-gz-b64:')) {
      throw new Error('Invalid data format. Expected mp-gz-b64: prefix.');
    }

    const dataWithCrc = cleanData.slice('mp-gz-b64:'.length);
    const colonIndex = dataWithCrc.indexOf(':');
    if (colonIndex === -1) {
      throw new Error('Invalid data format. Missing CRC hash.');
    }

    const expectedCrc = dataWithCrc.slice(0, colonIndex);
    const encodedData = dataWithCrc.slice(colonIndex + 1);

    if (expectedCrc.length !== 8) {
      throw new Error('Invalid CRC hash format. Expected 8 characters.');
    }

    let profiles;
    try {
      const decoded = Buffer.from(encodedData, 'base64');
      const decompressed = gunzipSync(decoded);
      const optimized = msgpack.decode(decompressed);

      // CRC on the optimized data (same computation as export)
      const actualCrc = computeCrc(optimized);
      if (actualCrc !== expectedCrc) {
        throw new Error(`CRC verification failed. Expected: ${expectedCrc}, Got: ${actualCrc}. Data may be corrupted.`);
      }
      console.log(chalk.green(`✓ CRC verification passed: ${actualCrc}`));

      // Extract tier-cache if present
      if (optimized['__tier_cache__']) {
        importedTierCache = optimized['__tier_cache__'];
        delete optimized['__tier_cache__'];
      }

      // Restore to full profile structure
      profiles = {};
      for (const [email, compact] of Object.entries(optimized)) {
        profiles[email] = restoreProfile(compact);
      }

    } catch (error) {
      throw new Error(`Failed to parse imported data: ${error.message}`);
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

    const accountCount = Object.keys(profiles).length;
    const accountList = Object.keys(profiles).join(', ');

    console.log(chalk.blue(`Found ${accountCount} accounts to import:`));
    console.log(chalk.dim(accountList));
    console.log();

    if (!options.force) {
      if (fs.existsSync(this.ccrotate.profilesFile)) {
        console.log(chalk.yellow(`Warning: This will merge with existing profile data (keeps fresher tokens).`));
      }

      const response = await prompts({
        type: 'confirm',
        name: 'proceed',
        message: 'Do you want to proceed with the import?',
        initial: false
      });

      if (!response.proceed) {
        console.log(chalk.yellow('Import cancelled.'));
        return;
      }
    }

    try {
      // Group incoming profiles by their bank target. Codex-shaped profiles
      // (provider === 'codex' or carrying an `auth` block) belong in
      // profiles.codex.json; everything else lives in profiles.json. Without
      // this split a `ccrotate export | ccrotate import` round-trip writes
      // every entry to whichever single bank matches the CLI's current
      // --target, silently stranding cross-bank profiles in the wrong file
      // where the other pool view can't see them (observed during
      // omar@blockcast.net codex recovery on 2026-05-27).
      const byTarget = { claude: {}, codex: {} };
      for (const [email, p] of Object.entries(profiles)) {
        const target = (p?.provider === 'codex' || p?.auth) ? 'codex' : 'claude';
        byTarget[target][email] = p;
      }

      const origTarget = this.ccrotate.target;
      const canSplitTargets = typeof this.ccrotate.setTarget === 'function';
      // With setTarget available, walk both banks separately so each
      // profile lands in the right file. Test fixtures often mock
      // ccrotate without setTarget — fall back to single-bank for those.
      const targetsToWalk = canSplitTargets ? ['claude', 'codex'] : [null];
      let imported = 0, kept = 0, added = 0;

      try {
        for (const target of targetsToWalk) {
          const incomingForTarget = target === null
            ? { ...byTarget.claude, ...byTarget.codex }
            : byTarget[target];
          if (Object.keys(incomingForTarget).length === 0) continue;

          if (target !== null) this.ccrotate.setTarget(target);
          const existing = this.ccrotate.loadProfiles();

          for (const [email, incoming] of Object.entries(incomingForTarget)) {
            const local = existing[email];
            if (!local) {
              existing[email] = incoming;
              added++;
              continue;
            }

            const localSync = getProfileSyncTime(local);
            const incomingSync = getProfileSyncTime(incoming);

            if (incomingSync > localSync) {
              existing[email] = incoming;
              imported++;
            } else {
              // Local is fresher — keep it, but merge in oauthAccount
              // metadata if missing.
              if (!local.oauthAccount && incoming.oauthAccount) {
                existing[email].oauthAccount = incoming.oauthAccount;
              }
              if (!local.auth && incoming.auth) {
                existing[email].auth = incoming.auth;
              }
              kept++;
            }
          }

          this.ccrotate.saveProfiles(existing);
        }
      } finally {
        if (canSplitTargets) this.ccrotate.setTarget(origTarget);
      }

      const parts = [];
      if (added) parts.push(`${added} new`);
      if (imported) parts.push(`${imported} updated`);
      if (kept) parts.push(`${kept} kept (local fresher)`);

      // Merge tier-cache — fill in accounts that have no local data
      if (importedTierCache?.accounts) {
        const localCache = this.ccrotate.loadTierCache();
        const localAccounts = localCache?.accounts || [];
        const localCacheUpdatedAt = localCache?.updatedAt || null;
        const importedCacheUpdatedAt = importedTierCache?.updatedAt || null;
        let tierMerged = 0;
        for (const incoming of importedTierCache.accounts) {
          const idx = localAccounts.findIndex(a => a.email === incoming.email);
          const local = idx >= 0 ? localAccounts[idx] : null;
          const localSync = getTierCacheSyncTime(local, localCacheUpdatedAt);
          const incomingSync = getTierCacheSyncTime(incoming, importedCacheUpdatedAt);
          if (!local || incomingSync > localSync) {
            if (idx >= 0) localAccounts[idx] = incoming;
            else localAccounts.push(incoming);
            tierMerged++;
          }
        }
        if (tierMerged > 0) {
          this.ccrotate.saveTierCache(localAccounts);
        }
        if (tierMerged) parts.push(`${tierMerged} tier-cache synced`);
      }

      console.log(chalk.green(`✓ Import complete: ${parts.join(', ')}.`));
    } catch (error) {
      throw new Error(`Failed to save imported profiles: ${error.message}`);
    }
  }
}
