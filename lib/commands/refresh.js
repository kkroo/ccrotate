import React from 'react';
import { render } from 'ink';
import RefreshView from '../components/RefreshView.js';
import { SnapCommand } from './snap.js';

export class RefreshCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute() {
    if (this.ccrotate.isCodexTarget()) {
      return this.executeCodex();
    }

    // First, automatically save the current account (like snap --force)
    try {
      const snapCommand = new SnapCommand(this.ccrotate);
      await snapCommand.execute(true); // force = true, no user interaction
    } catch (error) {
      // If snap fails, we can still proceed with refresh for existing accounts
      console.log(`Note: Could not save current account - ${error.message}`);
    }

    const profiles = this.ccrotate.loadProfiles();
    const emails = Object.keys(profiles);
    
    if (emails.length === 0) {
      throw new Error('No saved accounts found. Please add accounts first using `ccrotate snap`.');
    }

    // Track current active account before starting tests
    let currentActiveEmail;
    try {
      const currentAccount = this.ccrotate.getCurrentAccount();
      currentActiveEmail = currentAccount.email;
    } catch (error) {
      currentActiveEmail = null;
    }

    // Clear ONLY expired cooldowns. Anthropic rate-limits the Usage API
    // per-org, so wiping active cooldowns means we instantly re-429 the whole
    // pool on the next refresh cycle and never recover ("9 of 10 unknown"
    // pattern). Honor the retry-after window the API gave us last time and
    // only let an account back into the probe loop once its cooldown has
    // genuinely expired.
    this.ccrotate.clearExpiredCooldowns();

    const originalBackup = this.ccrotate.backupCurrentCredentials();
    const accounts = emails.map(email => ({ email }));
    
    return new Promise((resolve) => {
      const testAccount = async (email) => {
        try {
          const accountData = profiles[email];
          const oauth = accountData.credentials?.claudeAiOauth;
          const expiresAt = oauth?.expiresAt || 0;
          const fiveMinFromNow = Date.now() + 5 * 60 * 1000;

          if (oauth?.refreshToken && expiresAt < fiveMinFromNow) {
            const refreshed = await this.ccrotate.refreshAccessToken(accountData.credentials);
            if (refreshed) {
              accountData.credentials = refreshed;
              profiles[email] = accountData;
              this.ccrotate.saveProfiles(profiles);
            }
          }

          const token = accountData.credentials?.claudeAiOauth?.accessToken;
          this.ccrotate.writeClaudeFiles(accountData);

          const testResult = await this.ccrotate.testAccount(email, { token });
          return testResult;
        } catch (error) {
          return {
            status: 'error',
            response: error.message.substring(0, 150)
          };
        }
      };

      const onComplete = (results) => {
        // Save tier cache for slash commands that can't spawn claude -p
        if (results && results.length > 0) {
          this.ccrotate.saveTierCache(results);
        }

        // Restore original credentials (file only — don't touch Keychain)
        this.ccrotate.restoreCredentials(originalBackup);
        resolve();
      };

      const app = React.createElement(RefreshView, {
        accounts,
        onTestAccount: testAccount,
        onComplete
      });

      render(app);
    });
  }

  async executeCodex() {
    try {
      const snapCommand = new SnapCommand(this.ccrotate);
      await snapCommand.execute(true);
    } catch (error) {
      console.log(`Note: Could not save current account - ${error.message}`);
    }

    const profiles = this.ccrotate.loadProfiles();
    const emails = Object.keys(profiles);

    if (emails.length === 0) {
      throw new Error('No saved accounts found. Please add accounts first using `ccrotate snap`.');
    }

    const accounts = emails.map(email => ({ email }));

    return new Promise((resolve) => {
      const testAccount = async (email) => {
        try {
          const accountData = profiles[email];
          return this.ccrotate.probeCodexAccount(email, accountData, profiles);
        } catch (error) {
          return {
            status: 'error',
            response: error.message.substring(0, 150)
          };
        }
      };

      const onComplete = (results) => {
        if (results && results.length > 0) {
          this.ccrotate.upsertTierCacheEntries(results);
        }
        resolve();
      };

      const app = React.createElement(RefreshView, {
        accounts,
        onTestAccount: testAccount,
        onComplete,
        title: 'Refreshing Codex account usage...'
      });

      render(app);
    });
  }
}
