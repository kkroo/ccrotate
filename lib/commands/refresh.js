import React from 'react';
import { render } from 'ink';
import RefreshView from '../components/RefreshView.js';
import { SnapCommand } from './snap.js';

export class RefreshCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute() {
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

    // Clear stale cooldowns so all accounts get fresh per-account API probes
    this.ccrotate.clearCooldowns();

    const originalBackup = this.ccrotate.backupCurrentCredentials();
    const accounts = emails.map(email => ({ email }));
    
    return new Promise((resolve) => {
      const testAccount = async (email) => {
        try {
          const accountData = profiles[email];
          const token = accountData.credentials?.claudeAiOauth?.accessToken;
          this.ccrotate.writeClaudeFiles(accountData);

          // Try per-account /api/oauth/usage for each (per-token 1hr cooldown)
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
}