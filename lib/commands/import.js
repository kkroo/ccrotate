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

  async execute(compressedData) {
    if (!compressedData) {
      throw new Error('No compressed data provided. Usage: ccrotate import <compressed-data>');
    }

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

    if (fs.existsSync(this.ccrotate.profilesFile)) {
      console.log(chalk.yellow(`Warning: This will replace existing profile data.`));
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

    try {
      this.ccrotate.saveProfiles(profiles);
      console.log(chalk.green(`✓ Successfully imported ${accountCount} accounts.`));
    } catch (error) {
      throw new Error(`Failed to save imported profiles: ${error.message}`);
    }
  }
}
