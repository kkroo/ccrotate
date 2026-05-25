import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { isAccountExhausted } from '../state-helpers.js';

function resetToMs(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed > 1e12 ? parsed : parsed * 1000;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeRequestedEmail(email) {
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  return normalized || null;
}

function resolveRequestedEmail(profiles, requestedEmail) {
  if (!requestedEmail) return null;
  const profileEmail = Object.keys(profiles).find(email => email.toLowerCase() === requestedEmail);
  if (!profileEmail) {
    throw new Error(`No saved profile for ${requestedEmail}`);
  }
  return profileEmail;
}

/**
 * Refresh a single account's usage data via the per-account API.
 * Picks the account with the stalest data (or org-level fallback) and
 * updates just that one entry in tier-cache. Designed for cron use:
 * one call per tick avoids stacking retry-after cooldowns across tokens.
 *
 * Respects API cooldowns — skips tokens that were recently 429'd.
 *
 * Dispatches to `executeCodex` when target=codex; the codex pool has a
 * different probe shape (no usage-api-cooldowns file, no org-level fallback,
 * different tier-cache write path) so the two flows don't share much.
 */
export class RefreshOneCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute(email) {
    const requestedEmail = normalizeRequestedEmail(email);
    if (this.ccrotate.isCodexTarget()) {
      return this.executeCodex(requestedEmail);
    }
    return this.executeClaude(requestedEmail);
  }

  async executeClaude(requestedEmail) {
    const profiles = this.ccrotate.loadProfiles();
    const emails = Object.keys(profiles);

    if (emails.length === 0 && !requestedEmail) {
      console.log(chalk.yellow('No accounts to refresh.'));
      return;
    }

    const requestedProfileEmail = resolveRequestedEmail(profiles, requestedEmail);

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
    // Accounts with known future reset time: skip until reset (data won't change)
    const scored = emails.map(email => {
      const cached = cachedAccounts.find(a => a.email === email);
      const token = profiles[email]?.credentials?.claudeAiOauth?.accessToken;
      const tokenKey = token ? createHash('sha256').update(token).digest('hex').slice(0, 16) : null;
      const onCooldown = tokenKey && cooldowns[tokenKey] && now < cooldowns[tokenKey];

      if (email === requestedProfileEmail) return { email, score: -2, reason: 'requested account', onCooldown, requested: true };

      if (email === currentEmail) return { email, score: -1, reason: 'active account', onCooldown };

      // If we know this account is exhausted with a future reset time, skip it
      if (cached) {
        const rl = cached.rateLimits || {};
        const tier = cached.serviceTier;
        const resetAt = resetToMs(rl.resetAt);
        const reset5h = resetToMs(rl.reset5h);
        const nextReset = Math.max(resetAt, reset5h);

        // Exhausted account with future reset — no point refetching, data won't change
        if (tier === 'exhausted' && nextReset > now) {
          return { email, score: 999, reason: 'exhausted (known reset)', onCooldown, skip: true };
        }
        // High utilization with recent data — skip if reset time known
        const u5h = rl.utilization5h;
        if (u5h != null && u5h >= 95 && reset5h > now) {
          return { email, score: 999, reason: `5h at ${u5h}% (reset known)`, onCooldown, skip: true };
        }
      }

      if (!cached) return { email, score: 0, reason: 'not cached', onCooldown };
      if ((cached.response || '').includes('[org]')) return { email, score: 1, reason: 'org-level', onCooldown };
      return { email, score: 2, reason: 'per-account', onCooldown };
    });

    // Sort by score (most stale first), filter cooldown AND skip-flagged accounts
    scored.sort((a, b) => a.score - b.score || a.email.localeCompare(b.email));
    const available = scored.filter(s => !s.onCooldown && (!s.skip || s.requested));

    if (requestedProfileEmail && !available.some(s => s.email === requestedProfileEmail)) {
      const target = scored.find(s => s.email === requestedProfileEmail);
      if (target?.onCooldown) {
        const token = profiles[requestedProfileEmail]?.credentials?.claudeAiOauth?.accessToken;
        const tokenKey = token ? createHash('sha256').update(token).digest('hex').slice(0, 16) : null;
        const retryAt = tokenKey ? cooldowns[tokenKey] : null;
        const waitMin = retryAt ? Math.ceil((retryAt - now) / 60000) : '?';
        throw new Error(`${requestedProfileEmail} is on Usage API cooldown; retry in ~${waitMin}min`);
      }
      throw new Error(`${requestedProfileEmail} is not refreshable`);
    }

    if (available.length === 0) {
      // Find earliest cooldown expiry
      const earliest = Object.values(cooldowns).filter(v => v > now).sort((a, b) => a - b)[0];
      const waitMin = earliest ? Math.ceil((earliest - now) / 60000) : '?';
      console.log(chalk.yellow(`All accounts on API cooldown. Retry in ~${waitMin}min.`));
      return;
    }

    const markerFile = path.join(this.ccrotate.profilesDir, 'refresh-one-last.txt');
    let target;
    if (requestedProfileEmail) {
      target = available.find(s => s.email === requestedProfileEmail);
    } else {
      // Round-robin among top-scored available candidates
      let lastEmail = '';
      try { lastEmail = fs.readFileSync(markerFile, 'utf8').trim(); } catch {}

      const topScore = available[0].score;
      const topCandidates = available.filter(s => s.score === topScore);
      if (topCandidates.length > 1) {
        const lastIdx = topCandidates.findIndex(c => c.email === lastEmail);
        target = topCandidates[(lastIdx + 1) % topCandidates.length];
      } else {
        target = topCandidates[0];
      }
    }

    const accountData = profiles[target.email];
    const oauth = accountData?.credentials?.claudeAiOauth;
    if (!oauth?.accessToken) {
      if (requestedProfileEmail) throw new Error(`No Claude access token for ${target.email}`);
      console.log(chalk.red(`No token for ${target.email}`));
      return;
    }

    const expiresAt = oauth.expiresAt || 0;
    if (oauth.refreshToken && expiresAt < Date.now() + 5 * 60 * 1000) {
      const refreshed = await this.ccrotate.refreshAccessToken(accountData.credentials);
      if (refreshed) {
        accountData.credentials = refreshed;
        profiles[target.email] = accountData;
        this.ccrotate.saveProfiles(profiles);
        // If we just rotated the ACTIVE account's tokens, the new refresh_token
        // lands in profiles.json — but ~/.claude/.credentials.json still holds
        // the OLD pair. A live claude process reading that stale file will try
        // to refresh with the consumed refresh_token and report "Not logged in"
        // mid-run. Mirror the rotation to disk so in-flight runs stay valid.
        // Real incident 2026-05-08: BLO-4115 ran 20 turns / 4min / $1.87 and
        // failed at the end with "Not logged in" because refresh-one had
        // rotated bot2's tokens while the run held the old pair in memory.
        if (target.email === currentEmail) {
          this.ccrotate.writeActiveAccountFiles(accountData);
        }
      }
    }

    const token = accountData.credentials.claudeAiOauth.accessToken;
    console.log(chalk.blue(`Refreshing ${target.email} (${target.reason})...`));

    const result = await this.ccrotate.testAccount(target.email, { token, usageApiOnly: true });

    if (result.status === 'unknown') {
      console.log(chalk.yellow(`  Usage API unavailable — skipping`));
      return;
    }

    // Update just this account in tier-cache via the locked upsert path.
    //
    // The previous `saveTierCache(updatedAccounts)` call was a read-modify-
    // write OUTSIDE the advisory lock:
    //   1. `cachedAccounts` was the disk view at the start of refresh-one
    //      (loaded above at `loadTierCache()`).
    //   2. Any concurrent writer (a `ccrotate refresh` round, a freshness-
    //      loop probe writeback via markAccountExhausted, the runtime
    //      writeback in claude-local) that landed BETWEEN that read and
    //      this write was silently clobbered — the saveTierCache here
    //      replaced the whole file with our stale view, dropping the
    //      concurrent writer's update.
    //   3. The `.map(...)` shape also dropped per-entry `syncedAt`, so
    //      every entry in the resulting file shared the saveTierCache call's
    //      fallback `updatedAt` — masking the loss in mtime forensics.
    //
    // upsertTierCacheEntries holds the same withCcrotateLock the markExhausted
    // /clearExhausted writebacks take (state-helpers.js), reads the cache
    // fresh inside the lock, and merges by-email — concurrent writers'
    // entries survive. Matches the codex variant at executeCodex below.
    this.ccrotate.upsertTierCacheEntries([{ email: target.email, ...result }]);

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
  // `emails` is accepted for API symmetry with the caller; the function
  // currently derives the eligible candidates from `profiles` + the
  // tier-cache, so the list of all emails isn't needed in-band. Kept
  // in the signature to avoid churning callers if a future check needs
  // it back.
  checkPreemptiveSwitch(_emails, profiles) {
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

    // Find best candidate accounts, treating `resets_at` as source of truth.
    // An account is CURRENTLY USABLE if:
    //   - tier is base (has headroom), OR
    //   - its 5h reset has passed since cache was written (counters reset)
    const cacheTime = new Date(cache.updatedAt || 0).getTime();
    const nowMs = Date.now();

    const candidates = cache.accounts
      .filter(a => a.email !== currentEmail && profiles[a.email])
      .map(a => {
        const arl = a.rateLimits || {};
        const a5h = arl.utilization5h;
        const a7d = arl.utilization7d;
        const reset5h = resetToMs(arl.reset5h);

        // 5h reset already passed → account effectively reset
        const reset5hPassed = reset5h && reset5h < nowMs;
        // Estimate: if data is > 5hrs old, assume the 5h window has rolled.
        // (arl.resetAt is the 7d reset — not useful for the 5h check, so
        // we don't read it here.)
        const dataAgeMs = nowMs - cacheTime;
        const estimated5hReset = dataAgeMs > 5 * 3600 * 1000;

        // Score: lower = better
        const hasRealData = a5h != null || a7d != null;
        let score = 100;
        if (!hasRealData) score = 80; // no per-account data — unreliable, avoid
        // Exhaustion is model-scoped now (the `exhausted` map / legacy
        // serviceTier:'exhausted'); check it before the health tier.
        else if (isAccountExhausted(a, { now: nowMs })) score = 50;
        else if (a.serviceTier === 'base') score = 0;
        else if (a.serviceTier === 'extra') score = 20;

        // Bonus: reset passed → probably usable
        if (reset5hPassed || estimated5hReset) score -= 10;
        // Penalty: high utilization
        if (a5h != null && a5h >= 95) score += 30;
        if (a7d != null && a7d >= 95) score += 40;

        return { email: a.email, score, tier: a.serviceTier, u5h: a5h, u7d: a7d };
      })
      .sort((a, b) => a.score - b.score);

    if (candidates.length === 0) return;
    const bestBase = candidates[0];

    // Don't switch to an account that's in worse shape than current
    if (bestBase.u5h != null && u5h != null && bestBase.u5h >= u5h) return;

    // Write marker for UserPromptSubmit hook
    const marker = {
      target: bestBase.email,
      reason: `${currentEmail} at ${u5h != null ? `5h:${u5h}%` : ''} ${u7d != null ? `7d:${u7d}%` : ''} ${tier}`.trim(),
      targetTier: bestBase.tier,
      targetU5h: bestBase.u5h,
      createdAt: new Date().toISOString()
    };

    try {
      fs.writeFileSync(switchFile, JSON.stringify(marker, null, 2));
      console.log(chalk.yellow(`  ⚠ Preemptive switch queued → ${bestBase.email} (${marker.reason})`));
    } catch {}
  }

  /**
   * Codex variant: probe a single codex account's usage and update its
   * tier-cache entry. Mirrors the Claude path's "pick stalest, round-robin
   * among ties" scoring but uses `probeCodexAccount` (no per-token cooldown
   * file — codex usage probe is a CLI invocation against the account's
   * saved auth, not an HTTP token call). Writes via `upsertTierCacheEntries`
   * which preserves rate-limit data on existing entries when the new probe
   * comes back without it.
   *
   * Skips:
   *   - Accounts marked exhausted with a known future reset (data won't change)
   *   - When no accounts have usable auth (returns no-op like the Claude path
   *     when all are on cooldown)
   */
  async executeCodex(requestedEmail) {
    const profiles = this.ccrotate.loadProfiles();
    const emails = Object.keys(profiles);

    if (emails.length === 0 && !requestedEmail) {
      console.log(chalk.yellow('No accounts to refresh.'));
      return;
    }

    const requestedProfileEmail = resolveRequestedEmail(profiles, requestedEmail);

    const cache = this.ccrotate.loadTierCache();
    const cachedAccounts = cache?.accounts || [];

    let currentEmail;
    try { currentEmail = this.ccrotate.getCurrentAccount().email; } catch {}

    const now = Date.now();
    const scored = emails.map(email => {
      const cached = cachedAccounts.find(a => a.email === email);
      const accountData = profiles[email];
      const hasAuth = !!accountData?.auth;

      if (email === requestedProfileEmail) return { email, score: -2, reason: 'requested account', hasAuth, requested: true };

      if (email === currentEmail) return { email, score: -1, reason: 'active account', hasAuth };

      // Exhausted with known future reset — data won't change, skip
      if (cached) {
        const rl = cached.rateLimits || {};
        const resetAt = resetToMs(rl.resetAt);
        const reset5h = resetToMs(rl.reset5h);
        const nextReset = Math.max(resetAt, reset5h);
        if (cached.serviceTier === 'exhausted' && nextReset > now) {
          return { email, score: 999, reason: 'exhausted (known reset)', hasAuth, skip: true };
        }
        const u5h = rl.utilization5h;
        if (u5h != null && u5h >= 95 && reset5h > now) {
          return { email, score: 999, reason: `5h at ${u5h}% (reset known)`, hasAuth, skip: true };
        }
      }

      if (!cached) return { email, score: 0, reason: 'not cached', hasAuth };
      return { email, score: 1, reason: 'cached', hasAuth };
    });

    scored.sort((a, b) => a.score - b.score || a.email.localeCompare(b.email));
    const available = scored.filter(s => (!s.skip || s.requested) && s.hasAuth);

    if (requestedProfileEmail && !available.some(s => s.email === requestedProfileEmail)) {
      throw new Error(`No usable codex auth for ${requestedProfileEmail}`);
    }

    if (available.length === 0) {
      console.log(chalk.yellow('No codex accounts with usable auth to refresh.'));
      return;
    }

    const markerFile = path.join(this.ccrotate.profilesDir, 'refresh-one-codex-last.txt');
    let target;
    if (requestedProfileEmail) {
      target = available.find(s => s.email === requestedProfileEmail);
    } else {
      // Round-robin within top score. Separate marker file from claude path
      // so the two pools don't trample each other's round-robin pointers.
      let lastEmail = '';
      try { lastEmail = fs.readFileSync(markerFile, 'utf8').trim(); } catch {}

      const topScore = available[0].score;
      const topCandidates = available.filter(s => s.score === topScore);
      if (topCandidates.length > 1) {
        const lastIdx = topCandidates.findIndex(c => c.email === lastEmail);
        target = topCandidates[(lastIdx + 1) % topCandidates.length];
      } else {
        target = topCandidates[0];
      }
    }

    console.log(chalk.blue(`Refreshing ${target.email} (${target.reason})...`));

    const result = this.ccrotate.probeCodexAccount(target.email, profiles[target.email], profiles);

    if (result.status === 'unknown' || result.status === 'error') {
      console.log(chalk.yellow(`  ${result.status}: ${(result.response || '').substring(0, 100)}`));
      if (requestedProfileEmail) {
        throw new Error(`${target.email} probe returned ${result.status}: ${result.response || '(no response)'}`);
      }
      return;
    }

    this.ccrotate.upsertTierCacheEntries([{ email: target.email, ...result }]);

    try { fs.writeFileSync(markerFile, target.email); } catch {}

    const tier = result.serviceTier || 'unknown';
    const color = tier === 'base' ? 'green' : tier === 'extra' ? 'yellow' : 'red';
    console.log(chalk[color](`  ${tier}: ${result.response || '(no response)'}`));
  }
}
