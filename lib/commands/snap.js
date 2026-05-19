import chalk from 'chalk';
import prompts from 'prompts';

export class SnapCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute(force = false) {
    const currentAccount = this.ccrotate.getCurrentAccount();

    // Identity guard (Claude only). A profile switch rewrites ~/.claude.json
    // (oauthAccount) and ~/.claude/.credentials.json (tokens) as two
    // separate files; if snap runs mid-switch it can save one account's
    // credentials under another account's email — a cross-wired profile.
    // `claude auth status` reports the live authenticated account; if it
    // disagrees with the account we're about to write, the switch hasn't
    // settled — refuse rather than commit a mismatched pair. A null result
    // (CLI absent / not logged in) skips the check rather than blocking.
    if (this.ccrotate.isClaudeTarget?.()) {
      const liveEmail = await this.ccrotate.readLiveClaudeAuthEmail();
      if (liveEmail && liveEmail !== currentAccount.email) {
        throw new Error(
          `snap aborted: claude auth status reports '${liveEmail}', but the active `
          + `config resolves to '${currentAccount.email}' — a profile switch is likely `
          + `in progress. Retry once it settles.`,
        );
      }
      if (!liveEmail) {
        console.log(chalk.dim('  (skipped claude auth status identity check — not available)'));
      }
    }

    const profiles = this.ccrotate.loadProfiles();

    if (profiles[currentAccount.email] && !force) {
      const response = await prompts({
        type: 'confirm',
        name: 'overwrite',
        message: `Account ${currentAccount.email} already exists. Overwrite?`,
        initial: false,
      });

      if (!response.overwrite) {
        console.log(chalk.yellow('Operation cancelled.'));
        return;
      }
    }

    profiles[currentAccount.email] = this.ccrotate.createProfileFromCurrentAccount(currentAccount);

    this.ccrotate.saveProfiles(profiles);
    console.log(chalk.green(`✓ Account ${currentAccount.email} saved successfully.`));
  }
}
