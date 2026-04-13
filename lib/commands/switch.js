import chalk from 'chalk';

export class SwitchCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute(email) {
    const profiles = this.ccrotate.loadProfiles();

    if (!profiles[email]) {
      throw new Error(`Account ${email} not found. Run 'ccrotate list' to see available accounts.`);
    }

    const result = await this.trySwitch(email, profiles);
    if (result) return;

    // Refresh failed — tell user
    console.log(chalk.red(`  Token refresh failed for ${email}. Run /login as that account then \`ccrotate snap --force\`.`));
  }

  async trySwitch(email, profiles) {
    let accountData = profiles[email];
    let credentials = accountData.credentials;

    // Auto-refresh if access token is expired (or expires within 5 min)
    const expiresAt = credentials?.claudeAiOauth?.expiresAt || 0;
    if (expiresAt < Date.now() + 5 * 60 * 1000) {
      process.stdout.write(chalk.gray('  Refreshing token... '));
      const refreshed = await this.ccrotate.refreshAccessToken(credentials);
      if (refreshed) {
        credentials = refreshed;
        accountData = { ...accountData, credentials };
        profiles[email].credentials = credentials;
        console.log(chalk.green('✓'));
      } else {
        console.log(chalk.red('✗'));
        return false;
      }
    }

    this.ccrotate.writeClaudeFiles(accountData);
    this.ccrotate.writeCredentialsToKeychain(credentials);

    profiles[email].lastUsed = new Date().toISOString();
    this.ccrotate.saveProfiles(profiles);

    console.log(chalk.green(`✓ Switched to account: ${email}`));
    console.log(chalk.gray('  Active session will pick up new credentials automatically.'));
    return true;
  }
}
