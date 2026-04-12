import chalk from 'chalk';
import prompts from 'prompts';

export class NextCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute(options = {}) {
    const config = this.ccrotate.loadConfig();
    // CLI flag > config > default
    // Non-interactive (hooks): deny extra usage unless config says allow
    // Interactive (manual): prompt unless config overrides
    const isNonInteractive = !process.stdin.isTTY;
    const extraPolicy = options.yes ? 'allow'
      : options.deny ? 'deny'
      : config.extraUsage === 'allow' ? 'allow'
      : isNonInteractive ? 'deny'
      : config.extraUsage || 'prompt';
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

    const standardAccounts = [];
    const extraUsageAccounts = [];
    const rateLimitedAccounts = [];

    for (const candidate of candidates) {
      const accountData = profiles[candidate.email];
      process.stdout.write(chalk.gray(`  Testing ${candidate.email}... `));

      this.ccrotate.writeClaudeFiles(accountData);
      const result = await this.ccrotate.testAccount(candidate.email);

      if (result.status !== 'success') {
        const resetTime = parseResetTime(result.response);
        console.log(chalk.red(`❌ ${result.response.substring(0, 80)}`));
        rateLimitedAccounts.push({ ...candidate, resetTime, response: result.response });
        continue;
      }

      if (result.serviceTier && result.serviceTier !== 'base') {
        console.log(chalk.yellow(`⚠️  ${result.serviceTier}`));
        extraUsageAccounts.push({ ...candidate, tier: result.serviceTier });
        continue;
      }

      console.log(chalk.green(`✅ base`));
      standardAccounts.push({ ...candidate, tier: 'base' });
      // Found a standard account — no need to test more
      break;
    }

    console.log('');

    // Save tier cache from what we tested
    const allTested = [
      ...standardAccounts.map(a => ({ email: a.email, status: 'success', serviceTier: 'base', result: '' })),
      ...extraUsageAccounts.map(a => ({ email: a.email, status: 'success', serviceTier: a.tier, result: '' })),
      ...rateLimitedAccounts.map(a => ({ email: a.email, status: 'error', serviceTier: null, result: a.response || '' })),
    ];
    if (allTested.length > 0) {
      this.ccrotate.saveTierCache(allTested);
    }

    // Case 1: Standard tier available — switch immediately
    if (standardAccounts.length > 0) {
      const target = standardAccounts[0];
      this.switchTo(target.email, profiles);
      console.log(chalk.green(`✓ Switched to account: ${target.email} (standard tier)`));
      printNextSteps();
      return;
    }

    // Case 2: Only extra usage available — check policy
    if (extraUsageAccounts.length > 0) {
      const target = extraUsageAccounts[0];

      console.log(chalk.yellow('⚠️  No accounts on standard (base) usage tier.'));
      console.log(chalk.yellow(`   ${extraUsageAccounts.length} account(s) on extra usage, ${rateLimitedAccounts.length} rate-limited.\n`));

      let useExtra = false;

      if (extraPolicy === 'allow') {
        useExtra = true;
      } else if (extraPolicy === 'deny') {
        console.log(chalk.gray('   Extra usage denied by config (extraUsage: "deny").'));
        useExtra = false;
      } else {
        // prompt
        const answer = await prompts({
          type: 'confirm',
          name: 'useExtra',
          message: `Use extra usage on ${target.email} (${target.tier})?`,
          initial: false
        });
        useExtra = answer.useExtra;
      }

      if (useExtra) {
        this.switchTo(target.email, profiles);
        console.log(chalk.green(`✓ Switched to account: ${target.email} (${target.tier})`));
        printNextSteps();
        return;
      }

      // User declined extra usage — fall through to rate-limited handling
    }

    // Case 3: All rate-limited (or user declined extra usage)
    this.ccrotate.restoreCredentials(originalBackup);

    if (rateLimitedAccounts.length === 0 && extraUsageAccounts.length > 0) {
      console.log(chalk.yellow('Declined extra usage. Staying on current account.'));
      return;
    }

    console.log(chalk.red('❌ All accounts are rate-limited.\n'));

    // Show reset times
    const resets = [...rateLimitedAccounts]
      .filter(a => a.resetTime)
      .sort((a, b) => a.resetTime.getTime() - b.resetTime.getTime());

    if (resets.length > 0) {
      console.log(chalk.white('Reset schedule:'));
      for (const account of resets) {
        const timeStr = formatResetTime(account.resetTime);
        console.log(chalk.gray(`  ${account.email}: resets ${timeStr}`));
      }

      const earliest = resets[0];
      const waitMs = earliest.resetTime.getTime() - Date.now();

      if (waitMs > 0 && waitMs < 24 * 60 * 60 * 1000) {
        const waitMin = Math.ceil(waitMs / 60000);
        console.log('');

        if (extraPolicy === 'allow') {
          // Non-interactive — just report, don't block
          console.log(chalk.blue(`⏰ Earliest reset: ${earliest.email} in ${formatDuration(waitMs)}`));
          return;
        }

        const { waitForReset } = await prompts({
          type: 'confirm',
          name: 'waitForReset',
          message: `Wait ${formatDuration(waitMs)} and auto-switch to ${earliest.email} when it resets?`,
          initial: true
        });

        if (waitForReset) {
          console.log(chalk.blue(`\n⏳ Waiting ${formatDuration(waitMs)} for ${earliest.email} to reset...`));
          console.log(chalk.gray('   (Press Ctrl+C to cancel)\n'));

          await sleep(waitMs + 60000); // wait + 1 min buffer

          // Switch to the reset account
          const accountData = profiles[earliest.email];
          this.ccrotate.writeClaudeFiles(accountData);
          profiles[earliest.email].lastUsed = new Date().toISOString();
          this.ccrotate.saveProfiles(profiles);

          console.log(chalk.green(`\n✓ Switched to account: ${earliest.email}`));
          printNextSteps();
          return;
        }
      }
    }

    console.log(chalk.gray('\nTip: Check back later or add more accounts with `ccrotate snap`.'));
  }

  switchTo(email, profiles) {
    const accountData = profiles[email];
    this.ccrotate.writeClaudeFiles(accountData);
    profiles[email].lastUsed = new Date().toISOString();
    this.ccrotate.saveProfiles(profiles);
  }
}

function printNextSteps() {
  console.log(chalk.blue('\n💡 Next steps:'));
  console.log(chalk.gray('  • Restart claude-code to apply account changes'));
  console.log(chalk.gray('  • To resume previous conversation: Use') + chalk.cyan(' /resume') + chalk.gray(' command'));
}

/**
 * Parse reset time from error messages like:
 *   "You've hit your limit · resets 3am (America/Los_Angeles)"
 *   "You've hit your limit · resets 5pm (America/Los_Angeles)"
 */
function parseResetTime(message) {
  const match = message.match(/resets?\s+(\d{1,2})(am|pm)\s*\(([^)]+)\)/i);
  if (!match) return null;

  let hour = parseInt(match[1], 10);
  const ampm = match[2].toLowerCase();
  const tz = match[3];

  if (ampm === 'pm' && hour !== 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  // Build a date string for today/tomorrow at the reset hour in the given timezone
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
  const resetDate = new Date(`${todayStr}T${String(hour).padStart(2, '0')}:00:00`);

  // Adjust for timezone offset
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
    // Get current time in the target timezone
    const parts = formatter.formatToParts(now);
    const tzNow = new Date(
      `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}T${parts.find(p => p.type === 'hour').value}:${parts.find(p => p.type === 'minute').value}:00`
    );
    const tzReset = new Date(tzNow);
    tzReset.setHours(hour, 0, 0, 0);

    // If reset time already passed today, it's tomorrow
    if (tzReset <= tzNow) {
      tzReset.setDate(tzReset.getDate() + 1);
    }

    // Convert back to local time
    const diffMs = tzReset.getTime() - tzNow.getTime();
    return new Date(now.getTime() + diffMs);
  } catch {
    // Fallback: assume local timezone
    if (resetDate <= now) {
      resetDate.setDate(resetDate.getDate() + 1);
    }
    return resetDate;
  }
}

function formatResetTime(date) {
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  if (diffMs <= 0) return 'now';
  return `in ${formatDuration(diffMs)} (${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })})`;
}

function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return remainMin > 0 ? `${hours}h ${remainMin}m` : `${hours}h`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
