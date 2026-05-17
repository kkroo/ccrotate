import React from 'react';
import { render } from 'ink';
import RefreshView from '../components/RefreshView.js';
import { SnapCommand } from './snap.js';

// T2 fix (2026-05-17, BLO-???? active-verify tier-gate spec §0b):
// `ccrotate refresh` walks ~13 saved accounts and calls testAccount(email)
// on each. RefreshView already drives the walk sequentially in a for-loop
// (one probe at a time), but with ZERO gap between successive probes the
// 13-probe burst still hits Anthropic's per-org Usage API throttle and the
// trailing probes get 429 rate_limit_errors. Pre-T1 the classifier treated
// those as exhaustion and wrote false-flag tier-cache entries that the
// heartbeat tier-gate then trusted ("9 of 10 unknown" → deadlock).
// Spreading the walk over ~30s (13 × 2s) keeps the burst rate well under
// Anthropic's per-org limit while remaining cheap relative to the cron's
// existing cadence (every 2h).
//
// Configurable via CCROTATE_REFRESH_INTER_PROBE_DELAY_MS; tests inject a
// stub `sleep` to avoid real wall-clock waits.
export const INTER_PROBE_DELAY_MS = Number(
  process.env.CCROTATE_REFRESH_INTER_PROBE_DELAY_MS ?? 2000,
);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrap a per-account `testAccount(email)` async fn so the FIRST call passes
 * through immediately and each SUBSEQUENT call awaits a configured delay
 * before invoking the inner fn. Spacing must happen on the *driver* side
 * (RefreshView's loop), not inside testAccount itself, so we wrap the
 * onTestAccount prop rather than touching the probe implementation.
 *
 * @param {(email: string) => Promise<any>} inner per-account probe fn
 * @param {{ sleep?: (ms: number) => Promise<void>, delayMs?: number }} opts
 */
export function withInterProbeDelay(inner, opts = {}) {
  const sleep = opts.sleep ?? defaultSleep;
  const delayMs = opts.delayMs ?? INTER_PROBE_DELAY_MS;
  let firstCall = true;
  return async (email) => {
    if (firstCall) {
      firstCall = false;
    } else {
      // Delay even after a thrown/rejected previous call. The throttle
      // doesn't care whether our last request errored; only the rate at
      // which we hit the Usage API matters.
      await sleep(delayMs);
    }
    return inner(email);
  };
}

export class RefreshCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute() {
    if (this.ccrotate.isCodexTarget()) {
      return this.executeCodex();
    }

    // First, automatically save the current account (like snap --force)
    try {
      const snapCommand = new SnapCommand(this.ccrotate);
      await snapCommand.execute(true); // force = true, no user interaction
    } catch (error) {
      // If snap fails, we can still proceed with refresh for existing accounts
      console.log(`Note: Could not save current account - ${error.message}`);
    }

    const profiles = this.ccrotate.loadProfiles();
    const emails = Object.keys(profiles);
    
    if (emails.length === 0) {
      throw new Error('No saved accounts found. Please add accounts first using `ccrotate snap`.');
    }

    // Track current active account before starting tests
    let currentActiveEmail;
    try {
      const currentAccount = this.ccrotate.getCurrentAccount();
      currentActiveEmail = currentAccount.email;
    } catch (error) {
      currentActiveEmail = null;
    }

    // Clear ONLY expired cooldowns. Anthropic rate-limits the Usage API
    // per-org, so wiping active cooldowns means we instantly re-429 the whole
    // pool on the next refresh cycle and never recover ("9 of 10 unknown"
    // pattern). Honor the retry-after window the API gave us last time and
    // only let an account back into the probe loop once its cooldown has
    // genuinely expired.
    this.ccrotate.clearExpiredCooldowns();

    const originalBackup = this.ccrotate.backupCurrentCredentials();
    const accounts = emails.map(email => ({ email }));
    
    return new Promise((resolve) => {
      const testAccount = async (email) => {
        try {
          const accountData = profiles[email];
          const oauth = accountData.credentials?.claudeAiOauth;
          const expiresAt = oauth?.expiresAt || 0;
          const fiveMinFromNow = Date.now() + 5 * 60 * 1000;

          if (oauth?.refreshToken && expiresAt < fiveMinFromNow) {
            const refreshed = await this.ccrotate.refreshAccessToken(accountData.credentials);
            if (refreshed) {
              accountData.credentials = refreshed;
              profiles[email] = accountData;
              this.ccrotate.saveProfiles(profiles);
            }
          }

          const token = accountData.credentials?.claudeAiOauth?.accessToken;
          this.ccrotate.writeClaudeFiles(accountData);

          const testResult = await this.ccrotate.testAccount(email, { token });
          return testResult;
        } catch (error) {
          return {
            status: 'error',
            response: error.message.substring(0, 150)
          };
        }
      };

      const onComplete = (results) => {
        // Save tier cache for slash commands that can't spawn claude -p.
        // Use upsert (not save), so entries other writers populated —
        // notably the runtime quota writeback from claude-local with
        // serviceTier='exhausted' + reset5h — are NOT overwritten when
        // this refresh round only managed to get status='unknown' for
        // them (Usage API cooldown). saveTierCache replaces the file
        // wholesale; upsert preserves prior data when this round's
        // entry would clobber it with weaker info.
        if (results && results.length > 0) {
          this.ccrotate.upsertTierCacheEntries(results);
        }

        // Restore original credentials (file only — don't touch Keychain).
        // BUT: if the active account's tokens were rotated during this cycle
        // (its access_token expired and refreshAccessToken consumed the
        // refresh_token), the backup we took at the start now holds a
        // CONSUMED refresh_token. Restoring it leaves any in-flight claude
        // process holding a refresh_token that the server has already
        // invalidated — next refresh attempt fails and the run reports
        // "Not logged in" mid-flight (real incident: BLO-4115, 2026-05-08).
        // Detect rotation and write the rotated credentials instead.
        if (currentActiveEmail) {
          const rotated = this.ccrotate.loadProfiles()[currentActiveEmail];
          const rotatedCreds = rotated?.credentials;
          const oldCreds = (() => {
            try { return originalBackup.credentials ? JSON.parse(originalBackup.credentials) : null; }
            catch { return null; }
          })();
          const oldRt = oldCreds?.claudeAiOauth?.refreshToken;
          const newRt = rotatedCreds?.claudeAiOauth?.refreshToken;
          if (oldRt && newRt && oldRt !== newRt) {
            this.ccrotate.writeActiveAccountFiles(rotated);
            resolve();
            return;
          }
        }
        this.ccrotate.restoreCredentials(originalBackup);
        resolve();
      };

      // Spread the per-account probes ~2s apart to avoid bursting
      // Anthropic's per-org Usage API throttle (see top-of-file comment).
      const spacedTestAccount = withInterProbeDelay(testAccount);

      const app = React.createElement(RefreshView, {
        accounts,
        onTestAccount: spacedTestAccount,
        onComplete
      });

      render(app);
    });
  }

  async executeCodex() {
    try {
      const snapCommand = new SnapCommand(this.ccrotate);
      await snapCommand.execute(true);
    } catch (error) {
      console.log(`Note: Could not save current account - ${error.message}`);
    }

    const profiles = this.ccrotate.loadProfiles();
    const emails = Object.keys(profiles);

    if (emails.length === 0) {
      throw new Error('No saved accounts found. Please add accounts first using `ccrotate snap`.');
    }

    const accounts = emails.map(email => ({ email }));

    return new Promise((resolve) => {
      const testAccount = async (email) => {
        try {
          const accountData = profiles[email];
          return this.ccrotate.probeCodexAccount(email, accountData, profiles);
        } catch (error) {
          return {
            status: 'error',
            response: error.message.substring(0, 150)
          };
        }
      };

      const onComplete = (results) => {
        if (results && results.length > 0) {
          this.ccrotate.upsertTierCacheEntries(results);
        }
        resolve();
      };

      // Same per-org throttle dynamics apply to OpenAI's usage endpoint
      // via probeCodexAccount; spread codex probes too.
      const spacedTestAccount = withInterProbeDelay(testAccount);

      const app = React.createElement(RefreshView, {
        accounts,
        onTestAccount: spacedTestAccount,
        onComplete,
        title: 'Refreshing Codex account usage...'
      });

      render(app);
    });
  }
}
