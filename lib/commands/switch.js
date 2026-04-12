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

    const accountData = profiles[email];
    this.ccrotate.writeClaudeFiles(accountData);
    // Also update Keychain for user-initiated switch
    this.ccrotate.writeCredentialsToKeychain(accountData.credentials);

    profiles[email].lastUsed = new Date().toISOString();
    this.ccrotate.saveProfiles(profiles);

    console.log(chalk.green(`✓ Switched to account: ${email}`));
    console.log(chalk.blue('\n💡 Next steps:'));
    console.log(chalk.gray('  • Restart claude-code to apply account changes'));
    console.log(chalk.gray('  • To resume previous conversation: Use') + chalk.cyan(' /resume') + chalk.gray(' command'));
  }
}