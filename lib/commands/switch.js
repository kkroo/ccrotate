import chalk from 'chalk';

export class SwitchCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute(email, options = {}) {
    const profiles = this.ccrotate.loadProfiles();

    if (!profiles[email]) {
      throw new Error(`Account ${email} not found. Run 'ccrotate list' to see available accounts.`);
    }

    if (this.ccrotate.isClaudeTarget() && profiles[email].stale) {
      console.log(chalk.red(`✗ ${email} is marked stale (token rotated elsewhere).`));
      console.log(chalk.gray(`  Fix: /login as ${email} then \`ccrotate snap --force\``));
      return;
    }

    try {
      const current = this.ccrotate.getCurrentAccount();
      if (current.email === email) {
        profiles[email] = {
          ...profiles[email],
          ...this.ccrotate.createProfileFromCurrentAccount(current)
        };
        delete profiles[email].stale;
        delete profiles[email].staleAt;
        this.ccrotate.saveProfiles(profiles);
        console.log(chalk.green(`✓ Already on ${email} (profile synced)`));
        return;
      }
    } catch {
      // No active account. Continue with saved profile.
    }

    const result = this.ccrotate.isClaudeTarget()
      ? await this.trySwitchClaude(email, profiles, options)
      : await this.trySwitchCodex(email, profiles);

    if (result === true) {
      if (options.relaunch) {
        await this.ccrotate.relaunchCurrentSession();
      }
      return;
    }

    if (result === 'rate_limited' || result === 'transient' || result === 'no_refresh_skipped') {
      // Transient or operator-deferred failures: do NOT mark stale.
      // The account's saved credentials are still considered good and
      // can be retried later. Marking stale on these would degrade pool
      // state and require manual /login + snap to recover.
      return;
    }

    profiles[email].stale = true;
    profiles[email].staleAt = new Date().toISOString();
    this.ccrotate.saveProfiles(profiles);
    console.log(chalk.red(`  Marked ${email} as stale. Run /login + \`ccrotate snap --force\` to recover.`));
  }

  async trySwitchClaude(email, profiles, options = {}) {
    let accountData = profiles[email];
    let credentials = accountData.credentials;
    const expiresAt = credentials?.claudeAiOauth?.expiresAt || 0;
    const needsRefresh = expiresAt < Date.now() + 5 * 60 * 1000;

    let status = needsRefresh ? 'invalid' : await this.ccrotate.checkTokenStatus(credentials.claudeAiOauth.accessToken);

    if (status === 'rate_limited') {
      console.log(chalk.yellow(`  ⚠ ${email} got 429 (org-level burst limit). Switching anyway.`));
    }

    if (status === 'invalid') {
      // --no-refresh: never consume the refresh_token. Useful when the
      // operator wants a true read-only pointer flip and is willing to
      // get an "expired token" error on the next request rather than
      // risk a refresh_token desync (the most fragile failure mode).
      if (options.noRefresh) {
        console.log(chalk.yellow(
          needsRefresh
            ? `  ⚠ ${email} token is expired; --no-refresh set, leaving credentials untouched.`
            : `  ⚠ ${email} token rejected; --no-refresh set, leaving credentials untouched.`
        ));
        return 'no_refresh_skipped';
      }

      process.stdout.write(chalk.gray(needsRefresh ? '  Refreshing expired token... ' : '  Token rejected, refreshing... '));
      const result = await this.ccrotate.refreshAccessTokenDetailed(credentials);
      if (!result.ok) {
        if (result.kind === 'transient') {
          console.log(chalk.yellow(`✗ transient (${result.message})`));
          console.log(chalk.gray('  Refresh failed for a transient reason (network / 5xx / 429). Not marking stale; retry later.'));
          return 'transient';
        }
        // invalid_grant or no_refresh_token — definitively dead
        console.log(chalk.red('✗ refresh failed'));
        if (result.kind === 'invalid_grant') {
          const err = result.body?.error || `HTTP ${result.statusCode}`;
          console.log(chalk.gray(`  Server says ${err} — refresh_token has been rotated elsewhere or revoked.`));
        }
        return 'invalid';
      }
      credentials = result.credentials;
      accountData = { ...accountData, credentials };
      profiles[email].credentials = credentials;
      console.log(chalk.green('✓'));

      const newStatus = await this.ccrotate.checkTokenStatus(credentials.claudeAiOauth.accessToken);
      if (newStatus === 'rate_limited') {
        console.log(chalk.yellow(`  ⚠ ${email} refreshed but got 429. Switching anyway.`));
      }
      if (newStatus === 'invalid') {
        console.log(chalk.red(`  ✗ Refreshed token still invalid.`));
        return 'invalid';
      }
    }

    this.ccrotate.writeActiveAccountFiles(accountData);
    this.ccrotate.writeCredentialsToKeychain(credentials);

    profiles[email].lastUsed = new Date().toISOString();
    delete profiles[email].stale;
    delete profiles[email].staleAt;
    this.ccrotate.saveProfiles(profiles);

    console.log(chalk.green(`✓ Switched to account: ${email}`));
    console.log(chalk.gray(this.ccrotate.getPostSwitchMessage()));
    return true;
  }

  async trySwitchCodex(email, profiles) {
    const accountData = profiles[email];
    this.ccrotate.writeActiveAccountFiles(accountData);

    profiles[email].lastUsed = new Date().toISOString();
    this.ccrotate.saveProfiles(profiles);

    console.log(chalk.green(`✓ Switched to account: ${email}`));
    console.log(chalk.gray(this.ccrotate.getPostSwitchMessage()));
    return true;
  }
}
