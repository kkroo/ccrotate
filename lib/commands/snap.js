import chalk from 'chalk';
import prompts from 'prompts';

export class SnapCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute(force = false) {
    const currentAccount = this.ccrotate.getCurrentAccount();
    const profiles = this.ccrotate.loadProfiles();
    
    if (profiles[currentAccount.email] && !force) {
      const response = await prompts({
        type: 'confirm',
        name: 'overwrite',
        message: `Account ${currentAccount.email} already exists. Overwrite?`,
        initial: false
      });
      
      if (!response.overwrite) {
        console.log(chalk.yellow('Operation cancelled.'));
        return;
      }
    }

    // Capture mcpOAuth from keychain so MCP server tokens survive rotation
    const keychainData = this.ccrotate.readKeychainRaw();
    const mcpOAuth = keychainData?.mcpOAuth || null;

    profiles[currentAccount.email] = {
      credentials: currentAccount.credentials,
      userId: currentAccount.userId,
      oauthAccount: currentAccount.oauthAccount,
      mcpOAuth,
      lastUsed: new Date().toISOString()
    };

    this.ccrotate.saveProfiles(profiles);
    console.log(chalk.green(`✓ Account ${currentAccount.email} saved successfully.`));
  }
}