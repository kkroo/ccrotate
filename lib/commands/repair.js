import chalk from 'chalk';

/**
 * Repair stale profiles — scan all accounts and try refresh.
 * Mark dead ones as stale, clear stale flag on recovered ones.
 * Guides the user through /login + snap for permanently broken accounts.
 */
export class RepairCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute() {
    const profiles = this.ccrotate.loadProfiles();
    const emails = Object.keys(profiles);

    if (emails.length === 0) {
      console.log(chalk.yellow('No accounts to repair.'));
      return;
    }

    console.log(chalk.blue('Scanning accounts for stale refresh tokens...\n'));

    let healthy = 0;
    let stale = 0;
    let recovered = 0;
    const staleAccounts = [];

    for (const email of emails) {
      const profile = profiles[email];
      process.stdout.write(chalk.gray(`  ${email}... `));

      const refreshed = await this.ccrotate.refreshAccessToken(profile.credentials);
      if (refreshed) {
        const wasStale = !!profile.stale;
        profiles[email].credentials = refreshed;
        delete profiles[email].stale;
        delete profiles[email].staleAt;
        console.log(chalk.green(wasStale ? '✓ recovered' : '✓ healthy'));
        if (wasStale) recovered++;
        else healthy++;
      } else {
        profiles[email].stale = true;
        profiles[email].staleAt = new Date().toISOString();
        staleAccounts.push(email);
        console.log(chalk.red('✗ stale (refresh token dead)'));
        stale++;
      }
    }

    this.ccrotate.saveProfiles(profiles);

    console.log();
    console.log(chalk.white(`Scan complete: ${healthy} healthy, ${recovered} recovered, ${stale} stale`));

    if (staleAccounts.length > 0) {
      console.log(chalk.yellow('\nStale accounts need /login + snap:'));
      for (const email of staleAccounts) {
        console.log(chalk.gray(`  1. Run claude /login, pick ${email}`));
        console.log(chalk.gray(`  2. Run \`ccrotate snap --force\``));
      }
    }
  }
}
