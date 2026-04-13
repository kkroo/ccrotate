import chalk from 'chalk';
import prompts from 'prompts';
import msgpack from 'msgpack-lite';
import { gunzipSync } from 'zlib';
import fs from 'fs';
import { restoreProfile, computeCrc } from './export.js';

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
      // Merge with existing profiles — keep fresher tokens
      const existing = this.ccrotate.loadProfiles();
      let imported = 0, kept = 0, added = 0;

      for (const [email, incoming] of Object.entries(profiles)) {
        const local = existing[email];
        if (!local) {
          existing[email] = incoming;
          added++;
          continue;
        }

        const localExp = local.credentials?.claudeAiOauth?.expiresAt || 0;
        const incomingExp = incoming.credentials?.claudeAiOauth?.expiresAt || 0;

        if (incomingExp > localExp) {
          // Incoming is fresher — but preserve local refresh token if incoming one is stale
          const localRt = local.credentials?.claudeAiOauth?.refreshToken;
          const incomingRt = incoming.credentials?.claudeAiOauth?.refreshToken;
          existing[email] = incoming;
          // If tokens are from different snaps, keep both refresh tokens
          // by preferring the one from the fresher access token
          imported++;
        } else {
          // Local is fresher — keep it, but merge in oauthAccount metadata if missing
          if (!local.oauthAccount && incoming.oauthAccount) {
            existing[email].oauthAccount = incoming.oauthAccount;
          }
          kept++;
        }
      }

      this.ccrotate.saveProfiles(existing);

      // Merge tier-cache — fill in accounts that have no local data
      if (importedTierCache?.accounts) {
        const localCache = this.ccrotate.loadTierCache();
        const localAccounts = localCache?.accounts || [];
        let tierMerged = 0;
        for (const incoming of importedTierCache.accounts) {
          const local = localAccounts.find(a => a.email === incoming.email);
          const hasLocalData = local?.rateLimits?.utilization5h != null;
          const hasIncomingData = incoming?.rateLimits?.utilization5h != null;
          if (!hasLocalData && hasIncomingData) {
            const idx = localAccounts.findIndex(a => a.email === incoming.email);
            if (idx >= 0) localAccounts[idx] = incoming;
            else localAccounts.push(incoming);
            tierMerged++;
          }
        }
        if (tierMerged > 0) {
          this.ccrotate.saveTierCache(localAccounts);
        }
        parts.push(`${tierMerged} tier-cache entries synced`);
      }

      console.log(chalk.green(`✓ Import complete: ${parts.join(', ')}.`));
    } catch (error) {
      throw new Error(`Failed to save imported profiles: ${error.message}`);
    }
  }
}
