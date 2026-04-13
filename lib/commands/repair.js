import chalk from 'chalk';

/**
 * Repair stale profiles — scan accounts and ONLY refresh tokens that need it.
 * Does NOT rotate healthy tokens (which would invalidate copies on other machines).
 *
 * Logic:
 * - Token expires >5min from now AND not marked stale → leave alone (assume healthy)
 * - Token expired or marked stale → try refresh
 * - Refresh succeeds → recovered
 * - Refresh fails → mark stale, guide user to /login + snap
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

    console.log(chalk.blue('Checking accounts (only refreshing expired/stale)...\n'));

    let skipped = 0;
    let recovered = 0;
    let stale = 0;
    const staleAccounts = [];
    const now = Date.now();

    for (const email of emails) {
      const profile = profiles[email];
      const expiresAt = profile.credentials?.claudeAiOauth?.expiresAt || 0;
      const isExpired = expiresAt < now + 5 * 60 * 1000;
      const isMarkedStale = !!profile.stale;

      process.stdout.write(chalk.gray(`  ${email}... `));

      // Skip healthy tokens — don't rotate them unnecessarily
      if (!isExpired && !isMarkedStale) {
        const mins = Math.round((expiresAt - now) / 60000);
        console.log(chalk.green(`✓ healthy (${mins}min left — not refreshed)`));
        skipped++;
        continue;
      }

      // Need refresh — attempt it
      const refreshed = await this.ccrotate.refreshAccessToken(profile.credentials);
      if (refreshed) {
        profiles[email].credentials = refreshed;
        delete profiles[email].stale;
        delete profiles[email].staleAt;
        console.log(chalk.green(isMarkedStale ? '✓ recovered' : '✓ refreshed (was expired)'));
        recovered++;
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
    console.log(chalk.white(`Result: ${skipped} healthy (skipped), ${recovered} refreshed, ${stale} stale`));

    if (staleAccounts.length > 0) {
      console.log(chalk.yellow('\nStale accounts need /login + snap:'));
      for (const email of staleAccounts) {
        console.log(chalk.gray(`  ${email}: /login as this account, then \`ccrotate snap --force\``));
      }
    }

    if (skipped > 0) {
      console.log(chalk.gray('\nNote: healthy tokens were not refreshed to avoid invalidating'));
      console.log(chalk.gray('copies on other machines. Use --force to refresh all anyway.'));
    }
  }
}
