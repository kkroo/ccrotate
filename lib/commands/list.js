import React from 'react';
import { render } from 'ink';
import AccountsList from '../components/AccountsList.js';
import { formatExpiresAt } from '../utils/formatExpiresAt/index.js';

function formatCodexListSummary(ccrotate, cachedAccount) {
  const rateLimits = cachedAccount?.rateLimits || null;
  if (!rateLimits) {
    return cachedAccount?.response || 'Run `ccrotate status` or `ccrotate refresh`';
  }

  const parts = [];
  if (rateLimits.remaining5h != null) {
    parts.push(`5h ${rateLimits.remaining5h}% -> ${ccrotate.formatCodexReset(rateLimits.reset5h, 300)}`);
  }
  if (rateLimits.remaining7d != null) {
    parts.push(`7d ${rateLimits.remaining7d}% -> ${ccrotate.formatCodexReset(rateLimits.reset7d, 10080)}`);
  }

  return parts.join(' | ') || cachedAccount?.response || 'Run `ccrotate status` or `ccrotate refresh`';
}

export class ListCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute() {
    const profiles = this.ccrotate.loadProfiles();
    const tierCache = this.ccrotate.loadTierCache();
    const cachedAccounts = new Map(
      Array.isArray(tierCache?.accounts)
        ? tierCache.accounts.map(account => [account.email, account])
        : []
    );
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

      let details = 'Unknown';
      try {
        const expiry = this.ccrotate.getProfileExpiry(profile);
        if (this.ccrotate.isClaudeTarget()) {
          if (expiry) {
            details = formatExpiresAt(expiry);
          }
        } else {
          details = formatCodexListSummary(this.ccrotate, cachedAccounts.get(email));
        }
      } catch (error) {
        details = 'Invalid';
      }

      return {
        email,
        lastUsed,
        details,
        stale: !!profile.stale
      };
    });

    const app = React.createElement(AccountsList, {
      accounts,
      currentEmail,
      title: `Saved Accounts (${this.ccrotate.getTargetName()})`,
      emptyHint: `Please login with ${this.ccrotate.getTargetName()} and run \`ccrotate snap\` to add your first account.`,
      detailLabel: this.ccrotate.isClaudeTarget() ? 'Expires At (KST)' : 'Usage / Resets'
    });

    render(app);
  }
}
