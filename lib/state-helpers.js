import fs from 'fs';
import path from 'path';

/**
 * Cross-process advisory lock around shared-state file writes
 * (profiles.json, tier-cache.json, .credentials.json, etc.) on a shared
 * PVC. Same primitive as `CCRotate.withActiveFilesLock` but decoupled
 * from the CCRotate instance so external writers (paperclip-kkroo's
 * claude-local adapter, ccrotate-auth-bot, snap scripts) can take the
 * SAME lock and not race the in-process ccrotate CLI.
 *
 * Lock filename is intentionally identical (`.active-files.lock`) so all
 * cooperating writers serialize on one POSIX advisory lock.
 *
 * Implementation: O_CREAT | O_EXCL (atomic on cephfs) with busy-retry.
 * Stale lockfiles older than `staleMs` are reclaimed (crashed holder
 * doesn't deadlock the next caller). Synchronous; the busy-wait blocks
 * the calling subprocess only.
 */
export function withCcrotateLock(profilesDir, fn, opts = {}) {
  const lockPath = path.join(profilesDir, '.active-files.lock');
  const timeout = opts.timeout ?? 10000;
  const staleMs = opts.staleMs ?? 30000;
  const sleepMs = 50;
  const start = Date.now();
  let fd;

  try { fs.mkdirSync(profilesDir, { recursive: true }); } catch {}

  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      } catch { /* metadata best-effort */ }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    try {
      const st = fs.statSync(lockPath);
      if (Date.now() - st.mtimeMs > staleMs) {
        try { fs.unlinkSync(lockPath); } catch {}
        continue;
      }
    } catch { /* concurrent release */ }
    if (Date.now() - start > timeout) {
      throw new Error(`ccrotate: timed out waiting for ${lockPath} after ${timeout}ms`);
    }
    const sleepUntil = Date.now() + sleepMs;
    while (Date.now() < sleepUntil) { /* spin */ }
  }

  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

/**
 * Atomically upsert a tier-cache entry for one account. Used when an
 * external observer (claude-local adapter, ccrotate-auth-bot probe)
 * captures a state-changing event for an account — most importantly, a
 * runtime "out of extra usage" failure where the reset epoch is parsed
 * from the failure message.
 *
 * The shape matches what `testAccountViaMessages` produces, so
 * `next.js`'s candidate scoring (lines 92-108) treats the entry the
 * same whether ccrotate's own probe wrote it or an external observer
 * did. `serviceTier === 'exhausted'` flips the account out of rotation
 * until `rateLimits.reset5h` (or reset7d) passes.
 *
 * Atomic via tmpfile + rename, under the shared advisory lock, so a
 * concurrent `ccrotate refresh-one` can't lose this entry.
 *
 * Real incident 2026-05-08: pool depleted because runtime quota burns
 * weren't captured into tier-cache, so `next.js` kept rotating between
 * burned accounts that all looked "unknown" (no per-account data).
 */
/**
 * Refresh window for trusting existing utilization data when deciding
 * whether a runtime quota burn looks like a real cap hit. If the cache
 * was probed within this window and shows both 5h and 7d well below
 * cap, the burn is likely non-cap (overage credits out, transient
 * concurrent limit, content filter) and we should NOT flip the account
 * out of rotation.
 *
 * 30 min is short enough that a fast-burn cycle would still appear,
 * and long enough that we don't ignore probes from a normal idle
 * rotation cycle.
 */
const UTILIZATION_FRESHNESS_MS = 30 * 60 * 1000;

/**
 * Threshold below which an existing utilization% counts as "well below cap".
 * Matches the gate in account-table.js#isUsableNow.
 */
const NOT_AT_CAP_PCT = 95;

export function markAccountExhausted(profilesDir, email, { reset5h = null, reset7d = null, response = null, model = null } = {}) {
  return withCcrotateLock(profilesDir, () => {
    const tierCachePath = path.join(profilesDir, 'tier-cache.json');
    let cache = { updatedAt: null, accounts: [] };
    try {
      cache = JSON.parse(fs.readFileSync(tierCachePath, 'utf8'));
      if (!Array.isArray(cache.accounts)) cache.accounts = [];
    } catch { /* fresh cache */ }

    const existing = cache.accounts.find(a => a.email === email);

    // Guard: if the existing cache entry has FRESH utilization data
    // showing both rolling windows well below cap, this runtime burn
    // is likely NOT from a real cap. Anthropic returns 429-like
    // outcomes for several non-cap conditions:
    //   - overage credits exhausted (account still usable on base tier)
    //   - transient concurrent-request limit (recovers in seconds)
    //   - request shape / content rejection
    // Marking exhausted here would park a usable account behind a 5h
    // wait. Seen in prod 2026-05-13: ramadan@blockcast.net (5h:6%
    // 7d:1%) and omar.ramadan93@blockcast.net (5h:87% 7d:53%) both
    // flipped to 'exhausted' from runtime burns, collapsing the pool
    // to 1 viable account. Trust fresh utilization% over the bare 429.
    const existingRl = existing?.rateLimits || {};
    const u5h = existingRl.utilization5h;
    const u7d = existingRl.utilization7d;
    const snapshotAt = existingRl.snapshotCapturedAt
      ? Date.parse(existingRl.snapshotCapturedAt)
      : null;
    const dataAgeMs = snapshotAt ? Date.now() - snapshotAt : Infinity;
    const utilizationIsFreshAndLow =
      dataAgeMs <= UTILIZATION_FRESHNESS_MS &&
      u5h != null && u5h < NOT_AT_CAP_PCT &&
      u7d != null && u7d < NOT_AT_CAP_PCT;
    if (utilizationIsFreshAndLow) {
      return {
        skipped: true,
        reason: 'utilization below cap on fresh data',
        email,
        utilization5h: u5h,
        utilization7d: u7d,
        snapshotAgeMs: dataAgeMs,
      };
    }

    const others = cache.accounts.filter(a => a.email !== email);
    const resetEpoch = reset5h ?? reset7d;
    const fallbackResp = resetEpoch
      ? `quota exhausted; resets at ${new Date(resetEpoch * 1000).toISOString()}`
      : 'quota exhausted';

    const entry = {
      email,
      status: 'success',
      serviceTier: 'exhausted',
      response: response || existing?.response || fallbackResp,
      ...(model ? { exhaustedModel: model } : {}),
      rateLimits: {
        ...(existing?.rateLimits || {}),
        ...(reset5h != null ? { reset5h } : {}),
        ...(reset7d != null ? { reset7d } : {}),
        ...(model ? { exhaustedModel: model } : {}),
        snapshotCapturedAt: new Date().toISOString(),
      },
    };

    cache.accounts = others.concat(entry);
    cache.updatedAt = new Date().toISOString();

    const tmp = tierCachePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, tierCachePath);
    return { skipped: false, email };
  });
}
