import fs from 'fs';
import path from 'path';
import { decodeImportPayload } from './commands/export.js';

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

/**
 * Reset windows below this value are a relative seconds-until-reset
 * duration, not an absolute Unix epoch. 1e9 ≈ 2001-09-09; any real reset
 * epoch is ~1.7e9+, and the longest reset window (7d) is only ~604800s.
 */
const RESET_EPOCH_FLOOR = 1_000_000_000;

/**
 * markAccountExhausted expects reset5h/reset7d as absolute Unix epochs
 * (seconds). Some callers pass a relative duration instead — an older
 * classifyQuotaError that stored a raw `retry-after`, or an auth-bot probe
 * running a different pinned ccrotate SHA. Stored verbatim, a duration
 * like 1760 renders as "resets at 1970-01-01T00:29:20Z" and makes
 * pickNextCandidate's `reset5h * 1000 <= Date.now()` filter treat the
 * account as permanently past-reset. Rebase any sub-floor value onto now.
 */
function normalizeResetWindow(value) {
  if (value != null && value > 0 && value < RESET_EPOCH_FLOOR) {
    return Math.floor(Date.now() / 1000) + value;
  }
  return value;
}

export function markAccountExhausted(profilesDir, email, { reset5h = null, reset7d = null, response = null, model = null } = {}) {
  reset5h = normalizeResetWindow(reset5h);
  reset7d = normalizeResetWindow(reset7d);
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

/**
 * Symmetric to markAccountExhausted: clear a stale `serviceTier: exhausted`
 * label when authoritative evidence proves the account is currently usable.
 *
 * Background — the stale-exhausted deadlock:
 *   1. A burst-probe, transient burst-429, claude-local writeback, or
 *      probe-during-cooldown flips an account to `serviceTier: exhausted`.
 *   2. The Usage API for that account enters its 1hr per-token cooldown.
 *   3. testAccount with usageApiOnly:false then returns status='unknown'
 *      because the /v1/messages fallback is gated to extra-mode accounts.
 *   4. upsertTierCacheEntries' anti-clobber rule (preserve-exhausted-on-
 *      empty-probe) keeps the stale label indefinitely.
 *   5. Meanwhile, real upstream traffic against the SAME account through
 *      callMessages may be returning 200 — definitive proof the account
 *      isn't exhausted. This helper turns that proof into a cache clear.
 *
 * Model-scoping: if `model` is provided AND the entry tracks an
 * `exhaustedModel` AND the two differ, the label is preserved — per-model
 * quotas are independent (haiku succeeding doesn't prove opus has recovered).
 * Pass no `model` (or pass the matching one) to clear unconditionally; pass
 * a different one to skip with reason='exhaustedModel mismatch'.
 *
 * Preserves rolling-window utilization data (the next probe and
 * pickNextCandidate still want it) — only the `serviceTier`,
 * `exhaustedModel`, and `rateLimits.exhaustedModel` are dropped.
 *
 * Returns:
 *   { changed: true, email, clearedExhaustedModel }    — label cleared
 *   { changed: false, reason: 'no cache file' | 'no accounts array'
 *                            | 'no entry for email' | 'not exhausted'
 *                            | 'exhaustedModel mismatch', ... }  — no-op
 */
export function clearAccountExhausted(profilesDir, email, { model = null } = {}) {
  return withCcrotateLock(profilesDir, () => {
    const tierCachePath = path.join(profilesDir, 'tier-cache.json');
    let cache;
    try {
      cache = JSON.parse(fs.readFileSync(tierCachePath, 'utf8'));
    } catch {
      return { changed: false, reason: 'no cache file', email };
    }
    if (!Array.isArray(cache?.accounts)) {
      return { changed: false, reason: 'no accounts array', email };
    }

    const idx = cache.accounts.findIndex(a => a && a.email === email);
    if (idx === -1) {
      return { changed: false, reason: 'no entry for email', email };
    }

    const entry = cache.accounts[idx];
    if (entry.serviceTier !== 'exhausted') {
      return { changed: false, reason: 'not exhausted', email };
    }

    const entryModel = entry.exhaustedModel ?? entry.rateLimits?.exhaustedModel ?? null;
    if (model && entryModel && entryModel !== model) {
      return {
        changed: false,
        reason: 'exhaustedModel mismatch',
        email,
        entryModel,
        successModel: model,
      };
    }

    // Build the cleared entry. Preserve utilization + reset fields — only
    // drop the per-model exhaustion marker. The serviceTier goes to null
    // (not 'base' or 'extra' — we don't know the true tier yet; the next
    // freshness-loop probe or successful upstream call will fill it in).
    const { exhaustedModel: _droppedTop, ...restEntry } = entry;
    const { exhaustedModel: _droppedNested, ...restRateLimits } = entry.rateLimits || {};

    cache.accounts[idx] = {
      ...restEntry,
      serviceTier: null,
      status: 'success',
      response: 'cleared by successful upstream response',
      rateLimits: restRateLimits,
    };
    cache.updatedAt = new Date().toISOString();

    const tmp = tierCachePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, tierCachePath);
    return { changed: true, email, clearedExhaustedModel: entryModel };
  });
}

function parseTimestamp(value) {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function profileSyncTime(profile) {
  return parseTimestamp(profile?.lastApiSyncAt || profile?.lastUsed || null);
}

function tierEntrySyncTime(entry, fallbackUpdatedAt = null) {
  return parseTimestamp(
    entry?.syncedAt || entry?.rateLimits?.snapshotCapturedAt || fallbackUpdatedAt || null,
  );
}

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Decode an `mp-gz-b64:` export blob and merge it into the state files
 * under `dir`. The write-side analog of `ImportCommand.execute`, minus the
 * ink/prompts UI — the ccrotate-serve PV-decouple (onprem-k8s#227) needs
 * `import` to land on the auth-bot's state files over HTTP, not on a
 * serve-pod emptyDir.
 *
 * Profiles are split by provider: claude → profiles.json, codex →
 * profiles.codex.json. The merge keeps whichever record has the fresher
 * `lastApiSyncAt`/`lastUsed`; a kept-local record still absorbs missing
 * `oauthAccount`/`auth` metadata from the incoming one. The export's
 * `__tier_cache__` payload merges into the tier-cache of whichever pool
 * the profiles belong to (claude when any claude profile is present).
 *
 * Serializes through withCcrotateLock — same advisory lock the file-mode
 * path and the rest of the state-server use.
 */
export function applyImport(dir, data) {
  const { profiles, tierCache } = decodeImportPayload(data);

  return withCcrotateLock(dir, () => {
    let added = 0, updated = 0, kept = 0, tierMerged = 0;

    const byTarget = { claude: {}, codex: {} };
    let hasClaude = false;
    for (const [email, profile] of Object.entries(profiles)) {
      const target = (profile.provider === 'codex' || profile.auth) ? 'codex' : 'claude';
      if (target === 'claude') hasClaude = true;
      byTarget[target][email] = profile;
    }

    for (const target of ['claude', 'codex']) {
      const incoming = byTarget[target];
      if (Object.keys(incoming).length === 0) continue;
      const file = path.join(dir, target === 'codex' ? 'profiles.codex.json' : 'profiles.json');
      let existing = {};
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && typeof parsed === 'object') existing = parsed;
      } catch { /* fresh profiles file */ }

      for (const [email, inc] of Object.entries(incoming)) {
        const local = existing[email];
        if (!local) {
          existing[email] = inc;
          added++;
          continue;
        }
        if (profileSyncTime(inc) > profileSyncTime(local)) {
          existing[email] = inc;
          updated++;
        } else {
          if (!local.oauthAccount && inc.oauthAccount) existing[email].oauthAccount = inc.oauthAccount;
          if (!local.auth && inc.auth) existing[email].auth = inc.auth;
          kept++;
        }
      }
      writeJsonAtomic(file, existing);
    }

    if (tierCache && Array.isArray(tierCache.accounts) && tierCache.accounts.length > 0) {
      const tierTarget = hasClaude ? 'claude' : 'codex';
      const file = path.join(dir, tierTarget === 'codex' ? 'tier-cache.codex.json' : 'tier-cache.json');
      let cache = { updatedAt: null, accounts: [] };
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && Array.isArray(parsed.accounts)) cache = parsed;
      } catch { /* fresh tier-cache file */ }

      const importedUpdatedAt = tierCache.updatedAt || null;
      for (const inc of tierCache.accounts) {
        const idx = cache.accounts.findIndex(a => a && a.email === inc.email);
        const local = idx >= 0 ? cache.accounts[idx] : null;
        const localSync = tierEntrySyncTime(local, cache.updatedAt);
        const incomingSync = tierEntrySyncTime(inc, importedUpdatedAt);
        if (!local || incomingSync > localSync) {
          if (idx >= 0) cache.accounts[idx] = inc;
          else cache.accounts.push(inc);
          tierMerged++;
        }
      }
      cache.updatedAt = new Date().toISOString();
      writeJsonAtomic(file, cache);
    }

    return { accounts: Object.keys(profiles).length, added, updated, kept, tierMerged };
  });
}
