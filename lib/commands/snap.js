import chalk from 'chalk';
import prompts from 'prompts';

export class SnapCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute(force = false, emailOverride = null) {
    const currentAccount = this.ccrotate.getCurrentAccount();
    // When the caller passes --email, save the active credentials under THAT
    // email rather than whatever ~/.claude.json's oauthAccount.emailAddress
    // happens to say. This is what bot-driven relogin needs: between the
    // bot's `claude auth login --email <x>` and `ccrotate snap`, another
    // process (e.g. paperclip-0's `ccrotate switch`) can land an
    // `.claude.json` rewrite — without --email, snap captures the right
    // credentials but writes them under the wrong key, corrupting both
    // accounts' entries (verified empirically 2026-05-05: pool ended up
    // with two distinct emails sharing one refresh-token suffix).
    const targetEmail = emailOverride || currentAccount.email;
    const accountForProfile = emailOverride
      ? { ...currentAccount, email: emailOverride }
      : currentAccount;
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
