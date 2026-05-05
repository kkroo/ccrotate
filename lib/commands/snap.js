import chalk from 'chalk';
import prompts from 'prompts';

export class SnapCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute(force = false, emailOverride = null) {
    // Read the active account's email + credentials atomically — without the
    // lock, a concurrent `ccrotate switch` from another agent's claude-hook
    // can land a writeClaudeFiles rewrite between getCurrentAccount's
    // .claude.json read (email) and .credentials.json read (tokens), and
    // snap captures a desynced pair (right email, wrong tokens — or the
    // reverse). Holding withActiveFilesLock for the read window forces
    // any concurrent writeClaudeFiles to wait, so the email/credentials
    // pair is consistent. Verified empirically 2026-05-05: paperclip-0's
    // claude-hooks/ccrotate-on-limit.sh calls `ccrotate snap --force`
    // (no --email) under live agent-run churn — without this lock, pool
    // accumulated dupes like (omar.ramadan@blockcast.net,
    // omar.ramadan@berkeley.edu) sharing a single refresh token.
    //
    // --email skips the email read race specifically (bot-driven relogin
    // needs this because between `claude auth login --email <x>` and the
    // snap a switch can rewrite .claude.json), but credentials are still
    // read from disk — so the lock is needed regardless of --email.
    const { targetEmail, accountForProfile } = this.ccrotate.withActiveFilesLock(() => {
      const currentAccount = this.ccrotate.getCurrentAccount();
      const email = emailOverride || currentAccount.email;
      const account = emailOverride
        ? { ...currentAccount, email: emailOverride }
        : currentAccount;
      return { targetEmail: email, accountForProfile: account };
    });
    const profiles = this.ccrotate.loadProfiles();

    if (profiles[targetEmail] && !force) {
      const response = await prompts({
        type: 'confirm',
        name: 'overwrite',
        message: `Account ${targetEmail} already exists. Overwrite?`,
        initial: false
      });

      if (!response.overwrite) {
        console.log(chalk.yellow('Operation cancelled.'));
        return;
      }
    }

    profiles[targetEmail] = this.ccrotate.createProfileFromCurrentAccount(accountForProfile);

    this.ccrotate.saveProfiles(profiles);
    console.log(chalk.green(`✓ Account ${targetEmail} saved successfully.`));
  }
}
