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
    const cache = this.ccrotate.loadTierCache();
    if (!cache?.accounts) {
      console.log(chalk.yellow('No tier-cache data. Run `ccrotate refresh` first.'));
      return;
    }

    const profiles = this.ccrotate.loadProfiles();
    let currentEmail;
    try { currentEmail = this.ccrotate.getCurrentAccount().email; } catch {}

    const now = Date.now();
    const cacheAge = Math.round((now - new Date(cache.updatedAt).getTime()) / 60000);
    console.log(chalk.gray(`Cache: ${cacheAge}min old`));
    console.log();

    // Sort accounts: usable now first, then by earliest reset
    const rows = cache.accounts.map(a => {
      const rl = a.rateLimits || {};
      const u5h = rl.utilization5h;
      const u7d = rl.utilization7d;
      const resetAt = rl.resetAt ? new Date(rl.resetAt).getTime() : null;
      const reset5h = rl.reset5h ? rl.reset5h * 1000 : null;
      const reset7d = rl.reset7d ? rl.reset7d * 1000 : null;

      const tier = a.serviceTier || '?';
      const hasPerAccountData = u5h != null || u7d != null;
      const isOrgLevel = (a.response || '').includes('[org]');
      // Usable now ONLY if we have real per-account data showing headroom
      // Org-level data is unreliable — different accounts can be at different usage
      const isUsableNow =
        hasPerAccountData &&
        tier !== 'exhausted' &&
        u5h < 95 &&
        u7d < 95;

      // What's blocking this account? Pick the relevant reset:
      // - If 5h is the tighter constraint (5h util >= 95%), use 5h reset
      // - If 7d is tight (>= 95%), use 7d reset
      // - Otherwise earliest future reset
      let nextReset = null;
      if (u5h != null && u5h >= 95 && reset5h && reset5h > now) {
        nextReset = reset5h;
      } else if (u7d != null && u7d >= 95 && (reset7d || resetAt)) {
        nextReset = reset7d || resetAt;
        if (nextReset <= now) nextReset = null;
      } else {
        // Account not tightly constrained — pick earliest future reset
        const futureResets = [reset5h, reset7d, resetAt]
          .filter(r => r && r > now)
          .sort((x, y) => x - y);
        nextReset = futureResets[0];
      }

      const hasToken = !!profiles[a.email]?.credentials?.claudeAiOauth?.accessToken;
      const isStale = !!profiles[a.email]?.stale;

      return { email: a.email, tier, u5h, u7d, nextReset, isUsableNow: isUsableNow && !isStale, hasToken, hasPerAccountData, isStale };
    });

    rows.sort((a, b) => {
      if (a.isUsableNow !== b.isUsableNow) return a.isUsableNow ? -1 : 1;
      if (a.nextReset && b.nextReset) return a.nextReset - b.nextReset;
      return 0;
    });

    for (const r of rows) {
      const mark = r.email === currentEmail ? '★' : ' ';
      const tokenMark = r.hasToken ? '✓' : '✗';
      const tierColor = r.tier === 'base' ? chalk.green : r.tier === 'extra' ? chalk.yellow : chalk.red;
      const util = [
        r.u5h != null ? `5h:${Math.round(r.u5h)}%` : '',
        r.u7d != null ? `7d:${Math.round(r.u7d)}%` : '',
      ].filter(Boolean).join(' ');

      let when = '';
      if (r.isStale) {
        when = chalk.red('stale (needs /login + snap)');
      } else if (r.isUsableNow) {
        when = chalk.green('usable now');
      } else if (!r.hasPerAccountData) {
        when = chalk.gray('no data (needs refresh)');
      } else if (r.nextReset) {
        const mins = Math.round((r.nextReset - now) / 60000);
        const hrs = Math.floor(mins / 60);
        const rem = mins % 60;
        const str = hrs > 0 ? `${hrs}h${rem}m` : `${mins}m`;
        when = chalk.gray(`in ${str}`);
      } else {
        when = chalk.gray('unknown');
      }

      console.log(`${mark} ${tokenMark} ${r.email.padEnd(30)} ${tierColor(r.tier.padEnd(10))} ${util.padEnd(18)} ${when}`);
    }
  }
}
