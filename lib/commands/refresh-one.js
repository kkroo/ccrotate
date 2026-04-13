import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

/**
 * Refresh a single account's usage data via the per-account API.
 * Picks the account with the stalest data (or org-level fallback) and
 * updates just that one entry in tier-cache. Designed for cron use:
 * one call per tick avoids org-level 429.
 *
 * Respects API cooldowns — skips tokens that were recently 429'd.
 */
export class RefreshOneCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute() {
    const profiles = this.ccrotate.loadProfiles();
    const emails = Object.keys(profiles);

    if (emails.length === 0) {
      console.log(chalk.yellow('No accounts to refresh.'));
      return;
    }

    const cache = this.ccrotate.loadTierCache();
    const cachedAccounts = cache?.accounts || [];

    // Load cooldowns to skip tokens that are still rate-limited
    const cooldownFile = path.join(this.ccrotate.profilesDir, 'usage-api-cooldowns.json');
    let cooldowns = {};
    try { cooldowns = JSON.parse(fs.readFileSync(cooldownFile, 'utf8')); } catch {}
    const now = Date.now();

    // Get current active account — always refresh it first (need fresh data for preemptive switch)
    let currentEmail;
    try { currentEmail = this.ccrotate.getCurrentAccount().email; } catch {}

    // Score candidates: lower = more stale = higher priority
    // Current account always gets priority 0 (highest)
    const scored = emails.map(email => {
      const cached = cachedAccounts.find(a => a.email === email);
      const token = profiles[email]?.credentials?.claudeAiOauth?.accessToken;
      const tokenKey = token ? createHash('sha256').update(token).digest('hex').slice(0, 16) : null;
      const onCooldown = tokenKey && cooldowns[tokenKey] && now < cooldowns[tokenKey];

      if (email === currentEmail) return { email, score: -1, reason: 'active account', onCooldown };
      if (!cached) return { email, score: 0, reason: 'not cached', onCooldown };
      if ((cached.response || '').includes('[org]')) return { email, score: 1, reason: 'org-level', onCooldown };
      return { email, score: 2, reason: 'per-account', onCooldown };
    });

    // Sort by score (most stale first), then filter out cooldown accounts
    scored.sort((a, b) => a.score - b.score || a.email.localeCompare(b.email));
    const available = scored.filter(s => !s.onCooldown);

    if (available.length === 0) {
      // Find earliest cooldown expiry
      const earliest = Object.values(cooldowns).filter(v => v > now).sort((a, b) => a - b)[0];
      const waitMin = earliest ? Math.ceil((earliest - now) / 60000) : '?';
      console.log(chalk.yellow(`All accounts on API cooldown. Retry in ~${waitMin}min.`));
      return;
    }

    // Round-robin among top-scored available candidates
    const markerFile = path.join(this.ccrotate.profilesDir, 'refresh-one-last.txt');
    let lastEmail = '';
    try { lastEmail = fs.readFileSync(markerFile, 'utf8').trim(); } catch {}

    const topScore = available[0].score;
    const topCandidates = available.filter(s => s.score === topScore);
    let target;
    if (topCandidates.length > 1) {
      const lastIdx = topCandidates.findIndex(c => c.email === lastEmail);
      target = topCandidates[(lastIdx + 1) % topCandidates.length];
    } else {
      target = topCandidates[0];
    }

    const token = profiles[target.email]?.credentials?.claudeAiOauth?.accessToken;
    if (!token) {
      console.log(chalk.red(`No token for ${target.email}`));
      return;
    }

    console.log(chalk.blue(`Refreshing ${target.email} (${target.reason})...`));

    const result = await this.ccrotate.testAccount(target.email, { token, usageApiOnly: true });

    if (result.status === 'unknown') {
      console.log(chalk.yellow(`  Usage API unavailable — skipping`));
      return;
    }

    // Update just this account in tier-cache
    const updatedAccounts = cachedAccounts.filter(a => a.email !== target.email);
    updatedAccounts.push({
      email: target.email,
      status: result.status,
      serviceTier: result.serviceTier || null,
      response: result.response || '',
      rateLimits: result.rateLimits || null,
    });

    updatedAccounts.sort((a, b) => emails.indexOf(a.email) - emails.indexOf(b.email));

    this.ccrotate.saveTierCache(updatedAccounts.map(a => ({
      email: a.email,
      status: a.status,
      serviceTier: a.serviceTier,
      result: a.response,
      response: a.response,
      rateLimits: a.rateLimits,
    })));

    try { fs.writeFileSync(markerFile, target.email); } catch {}

    // After updating cache, check if CURRENT account needs preemptive switch
    this.checkPreemptiveSwitch(emails, profiles);

    const tier = result.serviceTier || 'unknown';
    const color = tier === 'base' ? 'green' : tier === 'extra' ? 'yellow' : 'red';
    console.log(chalk[color](`  ${tier}: ${result.response}`));
  }

  /**
   * Check if the currently active account is near exhaustion.
   * If so, find a base account and write a preemptive-switch marker.
   * The UserPromptSubmit hook reads this marker and switches before
   * the next API call, avoiding the "out of extra usage" dead end.
   */
  checkPreemptiveSwitch(emails, profiles) {
    const switchFile = path.join(this.ccrotate.profilesDir, 'preemptive-switch.json');
    const cache = this.ccrotate.loadTierCache();
    if (!cache?.accounts) return;

    // Get current account
    let currentEmail;
    try {
      currentEmail = this.ccrotate.getCurrentAccount().email;
    } catch { return; }

    const currentData = cache.accounts.find(a => a.email === currentEmail);
    if (!currentData) return;

    const rl = currentData.rateLimits || {};
    const u5h = rl.utilization5h;
    const u7d = rl.utilization7d;
    const tier = currentData.serviceTier;

    // Trigger preemptive switch only when truly about to hit the wall
    const nearLimit = (u5h != null && u5h >= 98) ||
                      (u7d != null && u7d >= 99) ||
                      tier === 'exhausted';

    if (!nearLimit) {
      // Clear any stale marker
      try { fs.unlinkSync(switchFile); } catch {}
      return;
    }

    // Find best base account to switch to
    const bestBase = cache.accounts.find(a =>
      a.email !== currentEmail &&
      a.serviceTier === 'base' &&
      profiles[a.email] // has stored credentials
    );

    if (!bestBase) {
      // No base accounts — check for lowest-usage account
      return;
    }

    // Write marker for UserPromptSubmit hook
    const marker = {
      target: bestBase.email,
      reason: `${currentEmail} at ${u5h != null ? `5h:${u5h}%` : ''} ${u7d != null ? `7d:${u7d}%` : ''} ${tier}`.trim(),
      createdAt: new Date().toISOString()
    };

    try {
      fs.writeFileSync(switchFile, JSON.stringify(marker, null, 2));
      console.log(chalk.yellow(`  ⚠ Preemptive switch queued → ${bestBase.email} (${marker.reason})`));
    } catch {}
  }
}
