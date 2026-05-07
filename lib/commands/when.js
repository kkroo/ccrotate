import chalk from 'chalk';

/**
 * Show when each account will be available (based on reset times in cache).
 * Purely reads tier-cache — no API calls.
 */
export class WhenCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute() {
    let cache = this.ccrotate.loadTierCache();
    if (!cache?.accounts) {
      console.log(chalk.yellow(this.ccrotate.isCodexTarget()
        ? 'No tier-cache data. Run `ccrotate status`, `ccrotate refresh`, or `ccrotate next` first.'
        : 'No tier-cache data. Run `ccrotate refresh` first.'));
      return;
    }

    if (this.isCacheStale(cache)) {
      console.log(chalk.blue('Cache is stale; refreshing before showing availability...\n'));
      try {
        await this.ccrotate.refresh();
      } catch (error) {
        console.log(chalk.yellow(`Refresh failed: ${error.message}`));
      }
      cache = this.ccrotate.loadTierCache() || cache;
    }

    const profiles = this.ccrotate.loadProfiles();
    let currentEmail;
    try { currentEmail = this.ccrotate.getCurrentAccount().email; } catch {}

    const now = Date.now();
    const cacheAge = Math.round((now - new Date(cache.updatedAt).getTime()) / 60000);
    console.log(chalk.gray(`Cache: ${cacheAge}min old`));
    console.log();

    const rows = this.ccrotate.isCodexTarget()
      ? cache.accounts.map(account => this.buildCodexRow(account, profiles, now))
      : cache.accounts.map(account => this.buildClaudeRow(account, profiles, now));

    rows.sort((a, b) => {
      if (a.isUsableNow !== b.isUsableNow) return a.isUsableNow ? -1 : 1;
      if (a.nextReset && b.nextReset) return a.nextReset - b.nextReset;
      return 0;
    });

    for (const r of rows) {
      const mark = r.email === currentEmail ? '★' : ' ';
      // tokenMark: do we have saved auth credentials parseable on disk?
      // This is *separate* from whether the account is usable right now —
      // an exhausted account still has good auth, so it gets ✓.
      const tokenMark = r.hasSavedAuth ? '✓' : '✗';
      const tierColor = this.getTierColor(r.tier);
      const util = r.usageSummary;

      // availMark: at-a-glance availability glyph, distinct from tokenMark
      // so callers can scan a column for "what's actually usable" without
      // misreading ✓ as "good to use".
      //   🟢 usable now           🔴 stale auth (needs /login)
      //   🟡 near_limit            🔵 usage-api rate limited
      //   ⏳ exhausted (will reset) ❔ needs refresh / no per-account data
      let availMark;
      let when;
      if (r.isStale) {
        availMark = '🔴';
        when = chalk.red('stale (needs /login + snap)');
      } else if (r.isUsableNow) {
        availMark = r.tier === 'near_limit' ? '🟡' : '🟢';
        when = chalk.green('usable now');
      } else if (!r.hasPerAccountData) {
        const msg = String(r.noDataMessage ?? '');
        availMark = /Usage API on cooldown|429/i.test(msg) ? '🔵' : '❔';
        when = chalk.gray(msg);
      } else if (r.tier === 'exhausted') {
        availMark = '⏳';
        if (r.nextReset) {
          const mins = Math.round((r.nextReset - now) / 60000);
          const hrs = Math.floor(mins / 60);
          const rem = mins % 60;
          const str = hrs > 0 ? `${hrs}h${rem}m` : `${mins}m`;
          when = chalk.gray(`in ${str}`);
        } else {
          when = chalk.gray('exhausted');
        }
      } else if (r.nextReset) {
        // Not usable now, not exhausted, not stale — throttled with a
        // future reset. Treat as near-limit (caution) rather than green.
        availMark = '🟡';
        const mins = Math.round((r.nextReset - now) / 60000);
        const hrs = Math.floor(mins / 60);
        const rem = mins % 60;
        const str = hrs > 0 ? `${hrs}h${rem}m` : `${mins}m`;
        when = chalk.gray(`in ${str}`);
      } else {
        availMark = '❔';
        when = chalk.gray('unknown');
      }

      console.log(`${mark} ${tokenMark} ${availMark} ${r.email.padEnd(30)} ${tierColor(r.tier.padEnd(10))} ${util.padEnd(36)} ${when}`);
    }
  }

  buildClaudeRow(account, profiles, now) {
    const rateLimits = account.rateLimits || {};
    const utilization5h = rateLimits.utilization5h;
    const utilization7d = rateLimits.utilization7d;
    const utilization7dSonnet = rateLimits.utilization7dSonnet;
    const utilization7dOpus = rateLimits.utilization7dOpus;
    const resetAt = rateLimits.resetAt ? new Date(rateLimits.resetAt).getTime() : null;
    const reset5h = rateLimits.reset5h ? rateLimits.reset5h * 1000 : null;
    const reset7d = rateLimits.reset7d ? rateLimits.reset7d * 1000 : null;

    const tier = account.serviceTier || '?';
    const hasPerAccountData = utilization5h != null || utilization7d != null;
    const isUsableNow =
      hasPerAccountData &&
      tier !== 'exhausted' &&
      utilization5h < 95 &&
      utilization7d < 95;

    let nextReset = null;
    if (utilization5h != null && utilization5h >= 95 && reset5h && reset5h > now) {
      nextReset = reset5h;
    } else if (utilization7d != null && utilization7d >= 95 && (reset7d || resetAt)) {
      nextReset = reset7d || resetAt;
      if (nextReset <= now) nextReset = null;
    } else {
      const futureResets = [reset5h, reset7d, resetAt]
        .filter(reset => reset && reset > now)
        .sort((left, right) => left - right);
      nextReset = futureResets[0];
    }

    return {
      email: account.email,
      tier,
      usageSummary: [
        utilization5h != null ? `5h:${Math.round(utilization5h)}%` : '',
        utilization7d != null ? `7d:${Math.round(utilization7d)}%` : '',
        utilization7dSonnet != null ? `s7d:${Math.round(utilization7dSonnet)}%` : '',
        utilization7dOpus != null ? `o7d:${Math.round(utilization7dOpus)}%` : '',
      ].filter(Boolean).join(' '),
      nextReset,
      isUsableNow: isUsableNow && !profiles[account.email]?.stale,
      hasSavedAuth: !!profiles[account.email]?.credentials?.claudeAiOauth?.accessToken,
      hasPerAccountData,
      noDataMessage: 'no data (needs refresh)',
      isStale: !!profiles[account.email]?.stale
    };
  }

  buildCodexRow(account, profiles, now) {
    const rateLimits = account.rateLimits || {};
    const remaining5h = rateLimits.remaining5h;
    const remaining7d = rateLimits.remaining7d;
    const reset5h = rateLimits.reset5h ? rateLimits.reset5h * 1000 : null;
    const reset7d = rateLimits.reset7d ? rateLimits.reset7d * 1000 : null;
    const tier = account.serviceTier || '?';
    const hasPerAccountData = remaining5h != null || remaining7d != null;
    const isStale = !!profiles[account.email]?.stale;
    const isUsableNow =
      hasPerAccountData &&
      tier === 'available' &&
      (remaining5h == null || remaining5h > 0) &&
      (remaining7d == null || remaining7d > 0);

    let nextReset = null;
    if (remaining5h != null && remaining5h <= 0 && reset5h && reset5h > now) {
      nextReset = reset5h;
    } else if (remaining7d != null && remaining7d <= 0 && reset7d && reset7d > now) {
      nextReset = reset7d;
    } else {
      const futureResets = [reset5h, reset7d]
        .filter(reset => reset && reset > now)
        .sort((left, right) => left - right);
      nextReset = futureResets[0];
    }

    return {
      email: account.email,
      tier,
      usageSummary: [
        remaining5h != null ? `5h:${Math.round(remaining5h)}%` : '',
        remaining7d != null ? `7d:${Math.round(remaining7d)}%` : '',
      ].filter(Boolean).join(' '),
      nextReset,
      isUsableNow: isUsableNow && !isStale,
      hasSavedAuth: !!profiles[account.email]?.auth,
      hasPerAccountData,
      noDataMessage: account.status ? 'no per-account data' : 'no data (needs refresh)',
      isStale
    };
  }

  getTierColor(tier) {
    if (tier === 'base' || tier === 'available') return chalk.green;
    if (tier === 'extra' || tier === 'near_limit') return chalk.yellow;
    if (tier === 'exhausted') return chalk.red;
    return chalk.white;
  }

  isCacheStale(cache) {
    const updatedAt = cache?.updatedAt ? new Date(cache.updatedAt).getTime() : 0;
    if (!updatedAt) return true;
    return Date.now() - updatedAt > 2 * 60 * 60 * 1000;
  }
}
