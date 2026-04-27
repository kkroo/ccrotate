import chalk from 'chalk';

export class StatusCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute(options = {}) {
    const quiet = options.quiet || false;

    let currentEmail;
    try {
      const currentAccount = this.ccrotate.getCurrentAccount();
      currentEmail = currentAccount.email;
    } catch (error) {
      throw new Error(`No active ${this.ccrotate.getTargetName()} account found. Please login first.`);
    }

    if (this.ccrotate.isCodexTarget()) {
      if (!quiet) {
        console.log(chalk.blue(`🔍 Checking Codex usage for ${currentEmail}...\n`));
      }

      const profiles = this.ccrotate.loadProfiles();
      const currentProfile = profiles[currentEmail] || this.ccrotate.createProfileFromCurrentAccount(this.ccrotate.getCurrentAccount());
      const result = this.ccrotate.probeCodexAccount(currentEmail, currentProfile, profiles);

      if (result.status !== 'success') {
        if (quiet) {
          console.log(JSON.stringify({ email: currentEmail, provider: 'codex', status: 'error', response: result.response }));
        } else {
          console.log(chalk.red(`❌ ${currentEmail}: ${result.response}`));
        }
        return { email: currentEmail, provider: 'codex', status: 'error' };
      }

      this.ccrotate.upsertTierCacheEntries([{ email: currentEmail, ...result }]);

      if (quiet) {
        console.log(JSON.stringify({
          email: currentEmail,
          provider: 'codex',
          status: 'ok',
          response: result.response,
          rateLimits: result.rateLimits
        }));
      } else {
        const tierColor = result.serviceTier === 'exhausted' ? 'red' : result.serviceTier === 'near_limit' ? 'yellow' : 'green';
        const prefix = result.serviceTier === 'exhausted' ? '❌' : result.serviceTier === 'near_limit' ? '⚠️ ' : '✅';
        console.log(chalk[tierColor](`${prefix} ${currentEmail}: ${result.response}`));
      }

      return { email: currentEmail, provider: 'codex', status: 'ok', rateLimits: result.rateLimits };
    }

    if (!quiet) {
      console.log(chalk.blue(`🔍 Checking usage tier for ${currentEmail}...\n`));
    }

    const result = await this.ccrotate.testAccount(currentEmail);

    if (result.status !== 'success') {
      if (quiet) {
        // Output machine-readable for hooks
        console.log(JSON.stringify({ email: currentEmail, tier: null, status: 'error', response: result.response }));
      } else {
        console.log(chalk.red(`❌ ${currentEmail}: ${result.response}`));
      }
      return { email: currentEmail, tier: null, status: 'error' };
    }

    const tier = result.serviceTier || 'unknown';

    if (quiet) {
      console.log(JSON.stringify({ email: currentEmail, tier, status: 'ok' }));
    } else if (tier === 'standard') {
      console.log(chalk.green(`✅ ${currentEmail}: standard tier (base usage)`));
    } else {
      console.log(chalk.yellow(`⚠️  ${currentEmail}: ${tier} (extra usage)`));
      console.log(chalk.gray('\n   Run `ccrotate next` to switch to a standard-tier account if available.'));
    }

    return { email: currentEmail, tier, status: 'ok' };
  }
}
