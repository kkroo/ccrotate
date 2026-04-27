import chalk from 'chalk';
import prompts from 'prompts';

export class NextCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute(options = {}) {
    if (this.ccrotate.isCodexTarget()) {
      return this.executeCodex();
    }

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

    const standardAccounts = [];
    const extraUsageAccounts = [];
    const rateLimitedAccounts = [];

    // Step 1: Check tier-cache first (zero API calls)
    const cache = this.ccrotate.loadTierCache();
    const cacheAgeMs = cache ? Date.now() - new Date(cache.updatedAt).getTime() : Infinity;
    const cacheStale = cacheAgeMs > 2 * 60 * 60 * 1000; // >2hr = stale

    if (cache && !cacheStale) {
      console.log(chalk.blue('🔍 Checking cached usage tiers...\n'));
      for (const candidate of candidates) {
        const cached = cache.accounts?.find(a => a.email === candidate.email);
        if (!cached) continue;

        const rl = cached.rateLimits || {};
        const hasPerAccountData = rl.utilization5h != null || rl.utilization7d != null;

        // Skip accounts with no per-account data — "base" tier from org-level
        // fallback is unreliable (could actually be exhausted)
        if (!hasPerAccountData) {
          console.log(chalk.gray(`  ${candidate.email}: ? no per-account data (skip)`));
          continue;
        }

        // Even with per-account data, skip if near 5h or 7d limits
        const u5h = rl.utilization5h || 0;
        const u7d = rl.utilization7d || 0;
        if (u5h >= 95 || u7d >= 95 || cached.serviceTier === 'exhausted') {
          console.log(chalk.red(`  ${candidate.email}: ❌ ${cached.serviceTier} (5h:${u5h}% 7d:${u7d}%)`));
          rateLimitedAccounts.push({ ...candidate, rateLimits: rl, resetTime: parseResetTime(cached.response || ''), response: cached.response || '' });
          continue;
        }

        if (cached.serviceTier === 'base') {
          console.log(chalk.green(`  ${candidate.email}: ✅ base (5h:${u5h}% 7d:${u7d}%)`));
          standardAccounts.push({ ...candidate, tier: 'base' });
          break;
        } else if (cached.serviceTier === 'extra') {
          console.log(chalk.yellow(`  ${candidate.email}: ⚠️  extra (5h:${u5h}% 7d:${u7d}%)`));
          extraUsageAccounts.push({ ...candidate, tier: 'extra' });
        }
      }
      console.log('');
    }

    // Step 2: If no base found in cache, do live probes (usage API + /v1/messages fallback)
    if (standardAccounts.length === 0 && (cacheStale || candidates.length > (extraUsageAccounts.length + rateLimitedAccounts.length))) {
      console.log(chalk.blue('🔍 Probing accounts...\n'));

      // Clear cooldowns so all accounts get fresh probes
      this.ccrotate.clearCooldowns();

      const originalBackup = this.ccrotate.backupCurrentCredentials();
      const untestedCandidates = candidates.filter(c =>
        !standardAccounts.some(a => a.email === c.email) &&
        !extraUsageAccounts.some(a => a.email === c.email) &&
        !rateLimitedAccounts.some(a => a.email === c.email)
      );

      // If cache was stale, re-test all candidates
      const toTest = cacheStale ? candidates : untestedCandidates;

      for (const candidate of toTest) {
        const accountData = profiles[candidate.email];
        process.stdout.write(chalk.gray(`  Testing ${candidate.email}... `));

        const token = accountData.credentials?.claudeAiOauth?.accessToken;
        this.ccrotate.writeClaudeFiles(accountData);
        const result = await this.ccrotate.testAccount(candidate.email, { token });

        if (result.status === 'unknown') {
          console.log(chalk.gray(`⏳ unavailable (keeping cached tier)`));
          continue;
        }

        if (result.status !== 'success') {
          const resetTime = parseResetTime(result.response);
          console.log(chalk.red(`❌ ${result.response.substring(0, 80)}`));
          // Don't duplicate if already in list from cache
          if (!rateLimitedAccounts.some(a => a.email === candidate.email)) {
            rateLimitedAccounts.push({ ...candidate, resetTime, rateLimits: result.rateLimits, response: result.response });
          }
          continue;
        }

        if (result.serviceTier && result.serviceTier !== 'base') {
          console.log(chalk.yellow(`⚠️  ${result.serviceTier}`));
          if (!extraUsageAccounts.some(a => a.email === candidate.email)) {
            extraUsageAccounts.push({ ...candidate, tier: result.serviceTier });
          }
          continue;
        }

        console.log(chalk.green(`✅ base`));
        // Remove from other lists if it was there from stale cache
        const rlIdx = rateLimitedAccounts.findIndex(a => a.email === candidate.email);
        if (rlIdx >= 0) rateLimitedAccounts.splice(rlIdx, 1);
        const exIdx = extraUsageAccounts.findIndex(a => a.email === candidate.email);
        if (exIdx >= 0) extraUsageAccounts.splice(exIdx, 1);
        standardAccounts.push({ ...candidate, tier: 'base' });
        break;
      }

      this.ccrotate.restoreCredentials(originalBackup);
      console.log('');
    }

    // Don't overwrite tier-cache from next — it only has classification, not full data.
    // Let refresh / refresh-one be the sole writers of tier-cache.

    // Case 1: Standard tier available — switch immediately (try each until one works)
    for (const target of standardAccounts) {
      const ok = await this.switchTo(target.email, profiles);
      if (ok) {
        console.log(chalk.green(`✓ Switched to account: ${target.email} (standard tier)`));
        printNextSteps(this.ccrotate);
        return;
      }
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
        await this.switchTo(target.email, profiles);
        console.log(chalk.green(`✓ Switched to account: ${target.email} (${target.tier})`));
        printNextSteps(this.ccrotate);
        return;
      }

      // User declined extra usage — fall through to rate-limited handling
    }

    // Case 3: All rate-limited (or user declined extra usage)

    if (rateLimitedAccounts.length === 0 && extraUsageAccounts.length > 0) {
      console.log(chalk.yellow('Declined extra usage. Staying on current account.'));
      return;
    }

    // Build reset schedule from epoch data (preferred) or parsed text
    const resets = [...rateLimitedAccounts]
      .map(a => {
        // Prefer 5h reset epoch from API headers (unix seconds)
        const epoch5h = a.rateLimits?.reset5h;
        const resetDate = epoch5h ? new Date(epoch5h * 1000) : a.resetTime;
        return { ...a, resetDate, resetEpoch: epoch5h || (a.resetTime ? Math.floor(a.resetTime.getTime() / 1000) : null) };
      })
      .filter(a => a.resetDate)
      .sort((a, b) => a.resetDate.getTime() - b.resetDate.getTime());

    // --wait mode: switch to earliest-reset account NOW and output JSON for auto-resume
    if (options.wait && resets.length > 0) {
      const earliest = resets[0];
      await this.switchTo(earliest.email, profiles);
      const waitMs = earliest.resetDate.getTime() - Date.now();
      console.log(chalk.blue(`⏰ Switched to ${earliest.email} (resets in ${formatDuration(Math.max(waitMs, 0))})`));
      // Machine-readable output for Claude/hooks to schedule wakeup
      console.log(JSON.stringify({
        action: 'wait',
        email: earliest.email,
        resetEpoch: earliest.resetEpoch,
        resetIn: formatDuration(Math.max(waitMs, 0)),
        resetAt: earliest.resetDate.toISOString()
      }));
      return;
    }

    console.log(chalk.red('❌ All accounts are rate-limited.\n'));

    if (resets.length > 0) {
      console.log(chalk.white('Reset schedule:'));
      for (const account of resets) {
        const timeStr = formatResetTime(account.resetDate);
        console.log(chalk.gray(`  ${account.email}: resets ${timeStr}`));
      }

      const earliest = resets[0];
      const waitMs = earliest.resetDate.getTime() - Date.now();

      if (waitMs > 0 && waitMs < 24 * 60 * 60 * 1000) {
        console.log('');

        if (extraPolicy === 'allow') {
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

          await sleep(waitMs + 60000);

          await this.switchTo(earliest.email, profiles);
          console.log(chalk.green(`\n✓ Switched to account: ${earliest.email}`));
          printNextSteps(this.ccrotate);
          return;
        }
      }
    }

    console.log(chalk.gray('\nTip: Check back later or add more accounts with `ccrotate snap`.'));
  }

  async executeCodex() {
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
      currentEmail = this.ccrotate.getCurrentAccount().email;
    } catch {
      currentEmail = null;
    }

    const currentIndex = currentEmail ? emails.indexOf(currentEmail) : -1;
    const candidates = emails
      .map((email, index) => ({ email, index }))
      .filter(candidate => candidate.email !== currentEmail);

    candidates.sort((a, b) => {
      const aIdx = (a.index - currentIndex - 1 + emails.length) % emails.length;
      const bIdx = (b.index - currentIndex - 1 + emails.length) % emails.length;
      return aIdx - bIdx;
    });

    console.log(chalk.blue('🔍 Probing Codex accounts...\n'));

    const results = [];
    for (const candidate of candidates) {
      process.stdout.write(chalk.gray(`  Testing ${candidate.email}... `));
      const result = this.ccrotate.probeCodexAccount(candidate.email, profiles[candidate.email], profiles);
      results.push({ ...candidate, ...result });

      if (result.status !== 'success') {
        console.log(chalk.red(result.response.substring(0, 80)));
        continue;
      }

      if (result.serviceTier === 'exhausted') {
        console.log(chalk.red(`❌ ${result.response}`));
      } else if (result.serviceTier === 'near_limit') {
        console.log(chalk.yellow(`⚠️  ${result.response}`));
      } else {
        console.log(chalk.green(`✅ ${result.response}`));
      }
    }

    if (results.length > 0) {
      this.ccrotate.saveTierCache(results);
    }

    const available = results
      .filter(result => result.status === 'success' && result.serviceTier !== 'exhausted')
      .sort((a, b) => {
        const aCurrent = a.rateLimits?.remaining5h ?? a.rateLimits?.remaining7d ?? -1;
        const bCurrent = b.rateLimits?.remaining5h ?? b.rateLimits?.remaining7d ?? -1;
        if (bCurrent !== aCurrent) return bCurrent - aCurrent;

        const a7d = a.rateLimits?.remaining7d ?? -1;
        const b7d = b.rateLimits?.remaining7d ?? -1;
        if (b7d !== a7d) return b7d - a7d;

        return a.index - b.index;
      });

    if (available.length > 0) {
      const target = available[0];
      await this.switchTo(target.email, profiles);
      console.log(chalk.green(`✓ Switched to account: ${target.email}`));
      printNextSteps(this.ccrotate);
      return;
    }

    const exhausted = results
      .filter(result => result.status === 'success')
      .map(result => ({
        email: result.email,
        resetEpoch: result.rateLimits?.reset5h || result.rateLimits?.reset7d || null
      }))
      .filter(result => result.resetEpoch)
      .sort((a, b) => a.resetEpoch - b.resetEpoch);

    console.log(chalk.red('\n❌ No Codex accounts currently have available quota.\n'));
    if (exhausted.length > 0) {
      console.log(chalk.white('Reset schedule:'));
      for (const account of exhausted) {
        const resetDate = new Date(account.resetEpoch * 1000);
        console.log(chalk.gray(`  ${account.email}: resets ${formatResetTime(resetDate)}`));
      }
    }
  }

  /** Switch to an account, auto-refreshing expired tokens. Returns true on success. */
  async switchTo(email, profiles) {
    if (this.ccrotate.isCodexTarget()) {
      const accountData = profiles[email];
      this.ccrotate.writeActiveAccountFiles(accountData);
      profiles[email].lastUsed = new Date().toISOString();
      this.ccrotate.saveProfiles(profiles);
      return true;
    }

    let accountData = profiles[email];
    let credentials = accountData.credentials;

    // Auto-refresh if expired
    const expiresAt = credentials?.claudeAiOauth?.expiresAt || 0;
    if (expiresAt < Date.now() + 5 * 60 * 1000) {
      const refreshed = await this.ccrotate.refreshAccessToken(credentials);
      if (refreshed) {
        credentials = refreshed;
        accountData = { ...accountData, credentials };
        profiles[email].credentials = credentials;
      } else {
        console.log(chalk.yellow(`  ⚠ Token refresh failed for ${email} (stale refresh token)`));
        return false;
      }
    }

    this.ccrotate.writeActiveAccountFiles(accountData);
    this.ccrotate.writeCredentialsToKeychain(credentials);
    profiles[email].lastUsed = new Date().toISOString();
    this.ccrotate.saveProfiles(profiles);
    return true;
  }
}

function printNextSteps(ccrotate) {
  console.log(chalk.gray(ccrotate.getPostSwitchMessage()));
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
