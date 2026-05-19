import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { formatExpiresAt } from './utils/formatExpiresAt/index.js';

/**
 * Shared rendering for `ccrotate list` and `ccrotate when`.
 *
 * Single source of truth: iterates profiles.json (always the full
 * set — including freshly snapped accounts that haven't been probed
 * yet) and overlays whatever tier-cache data is available. The old
 * `when` command iterated cache.accounts directly and silently
 * dropped any account not yet in the cache, which is exactly when
 * you most want to see a row for it.
 *
 * Modes:
 *   'rich'   — full table: # ★ token avail email tier 5h:% 7d:% status expires
 *              (default for `ccrotate list`)
 *   'when'   — drops # and expires (back-compat shape for `ccrotate when`).
 *              Same rows; `when` is now a thin alias.
 *
 * No probing here. Probing belongs to `refresh` / `refresh-one`.
 */

function getTierColor(tier) {
  if (tier === 'base' || tier === 'available') return chalk.green;
  if (tier === 'extra' || tier === 'near_limit') return chalk.yellow;
  if (tier === 'exhausted') return chalk.red;
  return chalk.white;
}

function resetToMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return value > 1e12 ? value : value * 1000;
  }
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return parsed > 1e12 ? parsed : parsed * 1000;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function buildClaudeRow(email, profile, cachedAccount, now) {
  const rateLimits = cachedAccount?.rateLimits || {};
  const utilization5h = rateLimits.utilization5h;
  const utilization7d = rateLimits.utilization7d;
  const resetAt = resetToMs(rateLimits.resetAt);
  const reset5h = resetToMs(rateLimits.reset5h);
  const reset7d = resetToMs(rateLimits.reset7d);

  const tier = cachedAccount?.serviceTier || '?';
  const hasPerAccountData = utilization5h != null || utilization7d != null;
  const isStale = !!profile?.stale;
  const isUsableNow =
    hasPerAccountData &&
    tier !== 'exhausted' &&
    utilization5h < 95 &&
    utilization7d < 95 &&
    !isStale;

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
    nextReset = futureResets[0] || null;
  }

  // tier-cache.exhausted entries can carry only a reset epoch (no
  // utilization%). When that's the case treat the row as having
  // meaningful data so it doesn't render as "no data".
  const hasResetEpoch = reset5h != null || reset7d != null || resetAt != null;
  const cacheKnowsExhausted = tier === 'exhausted';

  return {
    email,
    tier,
    usage5h: utilization5h != null ? Math.round(utilization5h) : null,
    usage7d: utilization7d != null ? Math.round(utilization7d) : null,
    nextReset,
    isUsableNow,
    hasSavedAuth: !!profile?.credentials?.claudeAiOauth?.accessToken,
    hasPerAccountData: hasPerAccountData || cacheKnowsExhausted || hasResetEpoch,
    noDataMessage: cachedAccount?.response || 'no data (needs refresh)',
    isStale,
    expiresAt: profile?.credentials?.claudeAiOauth?.expiresAt || null,
  };
}

function buildCodexRow(email, profile, cachedAccount, now) {
  const rateLimits = cachedAccount?.rateLimits || {};
  const remaining5h = rateLimits.remaining5h;
  const remaining7d = rateLimits.remaining7d;
  const resetAt = resetToMs(rateLimits.resetAt);
  const reset5h = resetToMs(rateLimits.reset5h);
  const reset7d = resetToMs(rateLimits.reset7d);
  const tier = cachedAccount?.serviceTier || '?';
  const hasPerAccountData = remaining5h != null || remaining7d != null;
  const isStale = !!profile?.stale;
  const isUsableNow =
    hasPerAccountData &&
    tier === 'available' &&
    (remaining5h == null || remaining5h > 0) &&
    (remaining7d == null || remaining7d > 0) &&
    !isStale;

  let nextReset = null;
  if (remaining5h != null && remaining5h <= 0 && reset5h && reset5h > now) {
    nextReset = reset5h;
  } else if (remaining7d != null && remaining7d <= 0 && reset7d && reset7d > now) {
    nextReset = reset7d;
  } else {
    const futureResets = [reset5h, reset7d, resetAt]
      .filter(reset => reset && reset > now)
      .sort((left, right) => left - right);
    nextReset = futureResets[0] || null;
  }

  const hasResetEpoch = reset5h != null || reset7d != null || resetAt != null;
  const cacheKnowsExhausted = tier === 'exhausted';

  return {
    email,
    tier,
    usage5h: remaining5h != null ? Math.round(remaining5h) : null,
    usage7d: remaining7d != null ? Math.round(remaining7d) : null,
    nextReset,
    isUsableNow,
    hasSavedAuth: !!profile?.auth,
    hasPerAccountData: hasPerAccountData || cacheKnowsExhausted || hasResetEpoch,
    noDataMessage: cachedAccount?.response || (cachedAccount?.status ? 'no per-account data' : 'no data (needs refresh)'),
    isStale,
    expiresAt: profile?.tokenClaims?.exp ? profile.tokenClaims.exp * 1000 : null,
  };
}

/** Format a duration in ms to a compact "Xh Ym" / "Ym" string. */
function fmtDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h${rem}m` : `${hrs}h`;
}

function renderRow(row, opts) {
  const { mark, mode } = opts;
  const tokenMark = row.hasSavedAuth ? '✓' : '✗';
  const tierColor = getTierColor(row.tier);

  let availMark;
  let when;
  if (row.isStale) {
    availMark = '🔴';
    when = chalk.red('stale (needs /login + snap)');
  } else if (row.isUsableNow) {
    availMark = row.tier === 'near_limit' ? '🟡' : '🟢';
    when = chalk.green('usable now');
  } else if (!row.hasPerAccountData) {
    const msg = String(row.noDataMessage ?? '');
    availMark = /Usage API on cooldown|429/i.test(msg) ? '🔵' : '❔';
    when = chalk.gray(msg.length > 35 ? msg.slice(0, 35) + '…' : msg);
  } else if (row.tier === 'exhausted') {
    availMark = '⏳';
    when = row.nextReset
      ? chalk.gray(`in ${fmtDuration(row.nextReset - Date.now())}`)
      : chalk.gray('exhausted');
  } else if (row.nextReset) {
    availMark = '🟡';
    when = chalk.gray(`in ${fmtDuration(row.nextReset - Date.now())}`);
  } else {
    availMark = '❔';
    when = chalk.gray('unknown');
  }

  const usage5h = row.usage5h != null ? `5h:${row.usage5h}%` : '';
  const usage7d = row.usage7d != null ? `7d:${row.usage7d}%` : '';
  const usage = [usage5h, usage7d].filter(Boolean).join(' ').padEnd(14);
  const tier = tierColor(String(row.tier).padEnd(10));
  const email = row.email.padEnd(32);

  if (mode === 'rich') {
    const indexCol = String(opts.index).padStart(2);
    const expiry = row.expiresAt ? formatExpiresAt(row.expiresAt) : '—';
    return `${indexCol} ${mark} ${tokenMark} ${availMark} ${email} ${tier} ${usage} ${when}  ${chalk.gray(expiry)}`;
  }
  // 'when' mode: keep the back-compat shape (no #, no expires)
  return `${mark} ${tokenMark} ${availMark} ${email} ${tier} ${usage} ${when}`;
}

/**
 * Render the full account table to stdout. `mode` is 'rich' (used by
 * `ccrotate list`) or 'when' (used by `ccrotate when` for back-compat).
 */
export function renderAccountTable(ccrotate, { mode = 'rich' } = {}) {
  const profiles = ccrotate.loadProfiles();
  const cache = ccrotate.loadTierCache();
  const cachedAccounts = new Map(
    Array.isArray(cache?.accounts)
      ? cache.accounts.map(account => [account.email, account])
      : []
  );

  const emails = Object.keys(profiles);
  if (emails.length === 0) {
    console.log(chalk.yellow(
      `No accounts saved. Run \`ccrotate snap\` to add one (target: ${ccrotate.getTargetName()}).`
    ));
    return;
  }

  // Active-account marker (★). getCurrentAccount() reads the local
  // interactive ~/.claude.json — absent on a PV-less ccrotate-serve pod.
  // Fall back to current.json, the pool's active-account pointer (the
  // last account to serve a 200), so `when` still marks the selected row.
  let currentEmail = null;
  try { currentEmail = ccrotate.getCurrentAccount().email; } catch { /* no local claude session */ }
  if (!currentEmail) {
    try {
      const cur = JSON.parse(fs.readFileSync(path.join(ccrotate.profilesDir, 'current.json'), 'utf8'));
      currentEmail = cur?.email ?? null;
    } catch { /* no current.json */ }
  }

  const now = Date.now();
  const rows = emails.map(email =>
    ccrotate.isCodexTarget()
      ? buildCodexRow(email, profiles[email], cachedAccounts.get(email), now)
      : buildClaudeRow(email, profiles[email], cachedAccounts.get(email), now)
  );

  // Header.
  if (cache?.updatedAt) {
    const cacheAge = Math.max(0, Math.round((now - new Date(cache.updatedAt).getTime()) / 60000));
    console.log(chalk.gray(`📋 ccrotate pool (${ccrotate.getTargetName()}) — tier-cache ${cacheAge}m old, ${rows.length} accounts`));
  } else {
    console.log(chalk.gray(`📋 ccrotate pool (${ccrotate.getTargetName()}) — no tier-cache yet, ${rows.length} accounts`));
  }
  console.log();

  // Stable sort: by profile order (insertion order in profiles.json) so
  // numeric indexes stay stable across runs. Don't reshuffle by status.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const mark = row.email === currentEmail ? '★' : ' ';
    console.log(renderRow(row, { mark, mode, index: i + 1 }));
  }
}
