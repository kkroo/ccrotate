import chalk from 'chalk';

export class NextCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute() {
    const profiles = this.ccrotate.loadProfiles();
    const emails = Object.keys(profiles);

    if (emails.length === 0) {
      throw new Error('No saved accounts found. Please add accounts first using `ccrotate snap`.');
    }

    if (emails.length === 1) {
      console.log(chalk.yellow('Only one account available. Nothing to switch to.'));
      return;
    }

    let currentEmail;
    try {
      const currentAccount = this.ccrotate.getCurrentAccount();
      currentEmail = currentAccount.email;
    } catch (error) {
      currentEmail = null;
    }

    // Smart rotation: test candidates to find one on standard tier
    const currentIndex = currentEmail ? emails.indexOf(currentEmail) : -1;
    const candidates = emails
      .map((email, i) => ({ email, index: i }))
      .filter(c => c.email !== currentEmail);

    // Sort candidates: start from the one after current index
    candidates.sort((a, b) => {
      const aIdx = (a.index - currentIndex - 1 + emails.length) % emails.length;
      const bIdx = (b.index - currentIndex - 1 + emails.length) % emails.length;
      return aIdx - bIdx;
    });

    console.log(chalk.blue('🔍 Finding best account (checking usage tier)...\n'));

    const originalBackup = this.ccrotate.backupCurrentCredentials();
    let bestCandidate = null;

    for (const candidate of candidates) {
      const accountData = profiles[candidate.email];
      process.stdout.write(chalk.gray(`  Testing ${candidate.email}... `));

      // Temporarily switch to test
      this.ccrotate.writeClaudeFiles(accountData);
      const result = await this.ccrotate.testAccount(candidate.email);

      if (result.status !== 'success') {
        console.log(chalk.red(`❌ ${result.response.substring(0, 80)}`));
        continue;
      }

      if (result.serviceTier && result.serviceTier !== 'standard') {
        console.log(chalk.yellow(`⚠️  extra usage (${result.serviceTier})`));
        // Track as fallback but keep looking
        if (!bestCandidate) {
          bestCandidate = { ...candidate, tier: result.serviceTier, fallback: true };
        }
        continue;
      }

      console.log(chalk.green(`✅ standard`));
      bestCandidate = { ...candidate, tier: 'standard', fallback: false };
      break;
    }

    if (!bestCandidate) {
      // Restore original and bail
      this.ccrotate.restoreCredentials(originalBackup);
      console.log(chalk.red('\n❌ No available accounts found. All are rate-limited.'));
      return;
    }

    // Switch to the best candidate
    const targetEmail = bestCandidate.email;
    const accountData = profiles[targetEmail];
    this.ccrotate.writeClaudeFiles(accountData);

    profiles[targetEmail].lastUsed = new Date().toISOString();
    this.ccrotate.saveProfiles(profiles);

    console.log('');
    if (bestCandidate.fallback) {
      console.log(chalk.yellow(`⚠️  Switched to ${targetEmail} (${bestCandidate.tier} — no standard-tier accounts available)`));
    } else {
      console.log(chalk.green(`✓ Switched to account: ${targetEmail} (standard tier)`));
    }
    console.log(chalk.blue('\n💡 Next steps:'));
    console.log(chalk.gray('  • Restart claude-code to apply account changes'));
    console.log(chalk.gray('  • To resume previous conversation: Use') + chalk.cyan(' /resume') + chalk.gray(' command'));
  }
}
