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

    // Refuse to switch to profiles marked stale — refresh token was rotated
    // by another machine, only /login + snap can fix
    if (profiles[email].stale) {
      console.log(chalk.red(`✗ ${email} is marked stale (token rotated elsewhere).`));
      console.log(chalk.gray(`  Fix: /login as ${email} then \`ccrotate snap --force\``));
      return;
    }

    // If already on this account, re-snap from Keychain to keep profile fresh
    try {
      const current = this.ccrotate.getCurrentAccount();
      if (current.email === email) {
        profiles[email].credentials = current.credentials;
        profiles[email].lastUsed = new Date().toISOString();
        delete profiles[email].stale;
        this.ccrotate.saveProfiles(profiles);
        console.log(chalk.green(`✓ Already on ${email} (profile synced)`));
        return;
      }
    } catch { /* no current account, proceed */ }

    const result = await this.trySwitch(email, profiles);
    if (result) return;

    // Mark stale so we don't keep trying this profile
    profiles[email].stale = true;
    profiles[email].staleAt = new Date().toISOString();
    this.ccrotate.saveProfiles(profiles);
    console.log(chalk.red(`  Marked ${email} as stale. Run /login + \`ccrotate snap --force\` to recover.`));
  }

  async trySwitch(email, profiles) {
    let accountData = profiles[email];
    let credentials = accountData.credentials;
    const expiresAt = credentials?.claudeAiOauth?.expiresAt || 0;
    const needsRefresh = expiresAt < Date.now() + 5 * 60 * 1000;

    // Check token status against /v1/messages
    let status = needsRefresh ? 'invalid' : await this.ccrotate.checkTokenStatus(credentials.claudeAiOauth.accessToken);

    if (status === 'rate_limited') {
      console.log(chalk.yellow(`  ✗ ${email} is rate-limited (would 429 immediately). Not switching.`));
      return false;
    }

    if (status === 'invalid') {
      // Try refresh as recovery
      process.stdout.write(chalk.gray(needsRefresh ? '  Refreshing expired token... ' : '  Token rejected, refreshing... '));
      const refreshed = await this.ccrotate.refreshAccessToken(credentials);
      if (!refreshed) {
        console.log(chalk.red('✗ refresh failed'));
        return false;
      }
      credentials = refreshed;
      accountData = { ...accountData, credentials };
      profiles[email].credentials = credentials;
      console.log(chalk.green('✓'));

      // Verify the refreshed token is actually usable (not just valid)
      const newStatus = await this.ccrotate.checkTokenStatus(credentials.claudeAiOauth.accessToken);
      if (newStatus === 'rate_limited') {
        console.log(chalk.yellow(`  ✗ ${email} refreshed but rate-limited. Not switching.`));
        return false;
      }
      if (newStatus === 'invalid') {
        console.log(chalk.red(`  ✗ Refreshed token still invalid.`));
        return false;
      }
    }
    // status === 'usable' or 'unknown' → proceed

    this.ccrotate.writeClaudeFiles(accountData);
    this.ccrotate.writeCredentialsToKeychain(credentials);

    profiles[email].lastUsed = new Date().toISOString();
    delete profiles[email].stale;
    delete profiles[email].staleAt;
    this.ccrotate.saveProfiles(profiles);

    console.log(chalk.green(`✓ Switched to account: ${email}`));
    console.log(chalk.gray('  Active session will pick up new credentials automatically.'));
    return true;
  }
}
