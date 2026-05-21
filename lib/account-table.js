import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { formatExpiresAt } from './utils/formatExpiresAt/index.js';
import { isAccountExhausted, readExhaustion } from './state-helpers.js';

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

  // Exhaustion is model-scoped: a 429 on one model (e.g. haiku, from a
  // batch-traffic flood) caps only that model — opus/sonnet on the same
  // account are still usable. `serviceTier` is account HEALTH only;
  // exhaustion comes from the model-scoped `exhausted` map (or the legacy
  // serviceTier:'exhausted' shape) via readExhaustion/isAccountExhausted.
  const isExhausted = isAccountExhausted(cachedAccount, { now });
  const healthTier =
    cachedAccount?.serviceTier && cachedAccount.serviceTier !== 'exhausted'
      ? cachedAccount.serviceTier
      : null;
  // Display tier — 'exhausted' overlays the row when any model is capped.
  const tier = isExhausted ? 'exhausted' : (healthTier || '?');
  // Account subscription suffix — distinguishes Claude Max (true 20x
  // token-bucket multiplier from Anthropic) from Claude Team seats
  // (t1=standard, t2=premium). For personal Max accounts we show the
  // rateLimitTier's numeric multiplier verbatim (`20x`); for Team seats
  // we show ONLY the seat label (`t1` / `t2`), NOT the rateLimitTier
  // number — because Team seats' `default_claude_max_5x` field is a
  // legacy naming artifact, not a real 5x throughput claim (Team
  // standard's actual per-user output bucket is closer to 1x-2x of base).
  // Misreporting it as `5x` would be operator-misleading.
  //
  // Pool today: 8 personal Max (`·20x`) + 6 Team t1 (`·t1`). `tier`
  // itself stays as the bare base ('base'/'extra'/'exhausted'/...) so
  // downstream color pickers and equality checks (line 197, 205, 211)
  // don't have to learn the suffix grammar — we expose `tierLabel`
  // separately for display.
  // Map oauthAccount.seatTier slugs to Anthropic-admin-UI labels:
  //   team_tier_1   → Premium       (·prem)
  //   team_standard → Standard      (·std)
  //   unassigned    → Unassigned    (·off)
  //   team_tier_N>1 → future tiers  (·tN)
  // For personal accounts (no team seat), the rateLimitTier multiplier
  // is the meaningful column (·20x, ·10x).
  const oauthAcct = profile?.oauthAccount || {};
  const rlTier = profile?.credentials?.claudeAiOauth?.rateLimitTier || '';
  const seatTier = oauthAcct.seatTier || '';
  let subSuffix = '';
  if (seatTier === 'team_tier_1') {
    subSuffix = '·prem';
  } else if (seatTier === 'team_standard') {
    subSuffix = '·std';
  } else if (seatTier === 'unassigned') {
    subSuffix = '·off';
  } else {
    const teamMatch = seatTier.match(/^team_tier_(\d+)$/);
    if (teamMatch) {
      subSuffix = `·t${teamMatch[1]}`;
    } else {
      const rateMultMatch = rlTier.match(/_(\d+)x$/);
      if (rateMultMatch) subSuffix = `·${rateMultMatch[1]}x`;
    }
  }
  const tierLabel = `${tier}${subSuffix}`;
  // Capped model keys for the row annotation; '*' (account-wide) contributes
  // no annotation — that row genuinely reads as fully capped.
  const exhaustedModels = Object.keys(readExhaustion(cachedAccount)).filter(m => m !== '*');
  const hasPerAccountData = utilization5h != null || utilization7d != null;
  const isStale = !!profile?.stale;
  const isUsableNow =
    hasPerAccountData &&
    tier !== 'exhausted' &&
    utilization5h < 95 &&
    utilization7d < 95 &&
    !isStale;

  // An account is usable again only when EVERY blocking window has cleared.
  // If both 5h and 7d are over the cap, picking reset5h (the sooner reset)
  // is misleading — the 7d cap still blocks every request after the 5h
  // window resets, so "in 23m" reads as "ready in 23m" when the real
  // recovery is days away (live incident 2026-05-21: bot1@blockcast.net
  // displayed "in 23m" while Anthropic's UI showed "weekly resets Sat 7am").
  // When both windows are blocked, pick the LATER reset so the displayed
  // availability matches when the account actually becomes usable.
  const fiveHBlocked = utilization5h != null && utilization5h >= 95 && reset5h && reset5h > now;
  const sevenDResetMs = reset7d || resetAt;
  const sevenDBlocked =
    utilization7d != null && utilization7d >= 95 && sevenDResetMs && sevenDResetMs > now;

  let nextReset = null;
  if (fiveHBlocked && sevenDBlocked) {
    nextReset = Math.max(reset5h, sevenDResetMs);
  } else if (fiveHBlocked) {
    nextReset = reset5h;
  } else if (sevenDBlocked) {
    nextReset = sevenDResetMs;
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
    tierLabel,
    exhaustedModels,
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

  // Same "pick the LATER reset when both windows are blocked" rule as the
  // Claude row above — codex `remaining` is the inverse of utilization, so
  // both-blocked means remaining5h<=0 AND remaining7d<=0.
  const fiveHBlocked = remaining5h != null && remaining5h <= 0 && reset5h && reset5h > now;
  const sevenDBlocked = remaining7d != null && remaining7d <= 0 && reset7d && reset7d > now;

  let nextReset = null;
  if (fiveHBlocked && sevenDBlocked) {
    nextReset = Math.max(reset5h, reset7d);
  } else if (fiveHBlocked) {
    nextReset = reset5h;
  } else if (sevenDBlocked) {
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

/** Short, readable form of a Claude model id, e.g. "claude-haiku-4-5-20251001" → "haiku". */
function shortModelName(model) {
  if (!model) return null;
  const m = String(model).match(/(haiku|sonnet|opus)/i);
  return m ? m[1].toLowerCase() : String(model);
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
    // Model-scoped: name the capped model(s) so a one-model cap doesn't read
    // as a fully dead account (other models on it are still usable).
    const models = (row.exhaustedModels || []).map(shortModelName).filter(Boolean);
    const scope = models.length ? ` (${models.join(', ')})` : '';
    when = row.nextReset
      ? chalk.gray(`in ${fmtDuration(row.nextReset - Date.now())}${scope}`)
      : chalk.gray(`exhausted${scope}`);
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
  // Display the full label (e.g. `base·20x`, `extra·t1`) — keeps the
  // color from the base row.tier so coloring stays consistent.
  const tier = tierColor(String(row.tierLabel || row.tier).padEnd(14));
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
