import React from 'react';
import { render } from 'ink';
import AccountsList from '../components/AccountsList.js';
import { formatExpiresAt } from '../utils/formatExpiresAt/index.js';

export class ListCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute() {
    const profiles = this.ccrotate.loadProfiles();
    const emails = Object.keys(profiles);
    
    let currentEmail;
    try {
      const currentAccount = this.ccrotate.getCurrentAccount();
      currentEmail = currentAccount.email;
    } catch (error) {
      currentEmail = null;
    }

    const accounts = emails.map(email => {
      const profile = profiles[email];
      const lastUsed = new Date(profile.lastUsed).toLocaleDateString();
      
      let expiresAt = 'Unknown';
      try {
        const expiry = this.ccrotate.getProfileExpiry(profile);
        if (expiry) {
          expiresAt = this.ccrotate.isClaudeTarget()
            ? formatExpiresAt(expiry)
            : new Date(expiry).toLocaleString();
        }
      } catch (error) {
        expiresAt = 'Invalid';
      }
      
      return {
        email,
        lastUsed,
        expiresAt,
        stale: !!profile.stale
      };
    });

    const app = React.createElement(AccountsList, {
      accounts,
      currentEmail,
      title: `Saved Accounts (${this.ccrotate.getTargetName()})`,
      emptyHint: `Please login with ${this.ccrotate.getTargetName()} and run \`ccrotate snap\` to add your first account.`,
      expiryLabel: this.ccrotate.isClaudeTarget() ? 'Expires At (KST)' : 'Token Expires'
    });

    render(app);
  }
}
