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

    // Score candidates: lower = more stale = higher priority
    const scored = emails.map(email => {
      const cached = cachedAccounts.find(a => a.email === email);
      const token = profiles[email]?.credentials?.claudeAiOauth?.accessToken;
      const tokenKey = token ? createHash('sha256').update(token).digest('hex').slice(0, 16) : null;
      const onCooldown = tokenKey && cooldowns[tokenKey] && now < cooldowns[tokenKey];

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

    const tier = result.serviceTier || 'unknown';
    const color = tier === 'base' ? 'green' : tier === 'extra' ? 'yellow' : 'red';
    console.log(chalk[color](`  ${tier}: ${result.response}`));
  }
}
