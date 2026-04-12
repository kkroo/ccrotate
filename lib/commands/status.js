import chalk from 'chalk';

export class StatusCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute() {
    let currentEmail;
    try {
      const currentAccount = this.ccrotate.getCurrentAccount();
      currentEmail = currentAccount.email;
    } catch (error) {
      throw new Error('No active Claude account found. Please login with claude-code first.');
    }

    console.log(chalk.blue(`🔍 Checking usage tier for ${currentEmail}...\n`));

    const result = await this.ccrotate.testAccount(currentEmail);

    if (result.status !== 'success') {
      console.log(chalk.red(`❌ ${currentEmail}: ${result.response}`));
      return;
    }

    const tier = result.serviceTier || 'unknown';
    if (tier === 'standard') {
      console.log(chalk.green(`✅ ${currentEmail}: standard tier (base usage)`));
    } else {
      console.log(chalk.yellow(`⚠️  ${currentEmail}: ${tier} (extra usage)`));
    }
  }
}
