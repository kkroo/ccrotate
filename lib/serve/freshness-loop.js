// Background single-account probe rotation for ccrotate serve.
//
// Why this exists: `ccrotate refresh` probes every account in a burst —
// great for an operator running it ad-hoc, but bad as the only source of
// tier-cache truth. A burst of 13 probes can stack Usage API retry-after
// cooldowns and used to produce false `exhausted` labels on accounts
// that are actually usable. Worse, once a `serviceTier: exhausted` label
// is written, it persists until the NEXT refresh round overwrites it —
// typically 15-30min later — during which paperclip-plugin-ccrotate
// trusts the cache and defers dispatch.
//
// This loop replaces the "trust the last burst" pattern with a low-rate
// trickle: every ~90s we probe ONE stale-exhausted account, refreshing
// its tier-cache entry. Across 13 accounts that's a full sweep every
// ~19.5min — well inside the Usage API's 1hr per-token cooldown — and
// avoids the cross-account 429 cascade that burst-probing triggers.
//
// What this is NOT:
//   - Not a replacement for `ccrotate refresh` (operators still need an
//     "all accounts now" path).
//   - Not a token refresher (that's `ccrotate-auth-bot` option-A
//     autoRefreshExpiredClaudeProfiles).
//   - Not the per-request verify-before-defer hook (a separate gap;
//     this loop reduces the surface area of stale labels but doesn't
//     guarantee freshness at any specific request moment).

import { createStateStore } from './state-store.js';
import { readExhaustion } from '../state-helpers.js';

const DEFAULT_PROBE_INTERVAL_MS = 90_000;
const DEFAULT_STALE_MIN_AGE_MS = 300_000;

function parseTimestampMs(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Per-target token extraction. The two pool shapes diverge: claude profiles
// store under `credentials.claudeAiOauth.{accessToken,expiresAt}`, codex
// profiles store under `auth.tokens.{access_token,...}` with no
// per-entry `expiresAt` (codex id_tokens are short-lived but the auth-bot's
// stale-poller handles refresh separately). Returning null means "skip this
// account in the freshness loop"; returning { hasToken: true } means
// "probe-eligible". expiresAtMs is optional — undefined disables the expiry
// gate (correct for codex).
function readProbeToken(target, profile) {
  if (target === 'codex') {
    const at = profile?.auth?.tokens?.access_token;
    if (!at) return null;
    return { hasToken: true, expiresAtMs: undefined };
  }
  // claude (default)
  const oauth = profile?.credentials?.claudeAiOauth;
  if (!oauth?.accessToken) return null;
  return { hasToken: true, expiresAtMs: oauth.expiresAt || 0 };
}

function pickStaleEntry(cache, profiles, { staleMinAgeMs, rotationIndex, target = 'claude' }) {
  const accounts = Array.isArray(cache?.accounts) ? cache.accounts : [];
  if (accounts.length === 0) return null;
  const nowMs = Date.now();

  const candidates = [];
  for (const entry of accounts) {
    const email = entry?.email;
    if (!email) continue;

    // Only re-probe entries the cache currently says are unusable. Healthy
    // entries don't need a freshness check — let the burst refresh handle
    // those during its scheduled run. "Unusable" = carries any exhaustion
    // record (model-scoped `exhausted` map or legacy serviceTier:'exhausted')
    // or a non-success status.
    const status = entry?.status;
    const isUnusable =
      Object.keys(readExhaustion(entry)).length > 0 ||
      status === 'error' || status === 'unknown';
    if (!isUnusable) continue;

    // Honor staleness floor — don't probe entries that were just written.
    const capturedAt = parseTimestampMs(entry?.rateLimits?.snapshotCapturedAt);
    if (capturedAt > 0 && nowMs - capturedAt < staleMinAgeMs) continue;

    // Skip accounts whose token has expired — probing burns the cached
    // accessToken without yielding usable info. The auth-bot's option-A
    // loop handles those separately. Per-target lookup: claude profiles
    // store under credentials.claudeAiOauth, codex under auth.tokens.
    // Pre-fix, this was hardcoded to credentials.claudeAiOauth.accessToken,
    // which silently dropped every codex stale entry from the candidate
    // list — codex tier-cache could rot indefinitely (observed 2026-05-21:
    // ally@ tier-cache stuck on a serde 'missing field id_token' error for
    // 18+ min after a successful /relogin landed fresh tokens).
    const token = readProbeToken(target, profiles?.[email]);
    if (!token) continue;
    if (token.expiresAtMs && token.expiresAtMs > 0 && token.expiresAtMs < nowMs) continue;

    candidates.push({ email, capturedAt });
  }

  if (candidates.length === 0) return null;

  // Round-robin so we don't hot-probe the oldest entry forever. Sort by
  // capturedAt asc (oldest first) then offset by rotationIndex.
  candidates.sort((a, b) => a.capturedAt - b.capturedAt);
  return candidates[rotationIndex % candidates.length];
}

/**
 * Single-account probe primitive — shared by the freshness-loop tick body
 * and the POST /v1/internal/probe-one HTTP route. Dispatches on `target`:
 *
 *   - target='claude': loads the email's Claude OAuth token from
 *     profiles.json (via store.getProfiles) and calls
 *     ccrotate.testAccount, which hits api.anthropic.com/api/oauth/usage.
 *     A usable probe clears the stale `exhausted` label via
 *     store.clearExhausted; a confirmed-exhausted probe refreshes the
 *     reset epoch via store.markExhausted; inconclusive (error/unknown)
 *     probes leave the label alone. Writeback through the StateStore so
 *     this works whether serve reads state files directly
 *     (FileStateStore) or talks to the HTTP state-server (HttpStateStore
 *     — onprem-k8s#227, PV-less serve).
 *
 *   - target='codex': loads the codex profile from profiles.codex.json
 *     (via store.getCodexProfiles) and calls
 *     ccrotate.probeCodexAccountAsync, the Promise-returning sibling
 *     of probeCodexAccount. Same underlying probe primitive (single-
 *     turn codex call → rate-limit snapshot) but doesn't block the
 *     serve replica's event loop while the probe runs — important
 *     because the typical probe is 3-10s and the worst case is the
 *     60s timeout. probeCodexAccount (sync) stays for the CLI callers
 *     (refresh/refresh-one/status/next) that don't share an event
 *     loop with live traffic. The result is persisted via
 *     ccrotate.upsertTierCacheEntries (codex has no per-profile
 *     `exhausted` map — the tier-cache IS the source of truth, so the
 *     clearExhausted/markExhausted path doesn't apply). A rejected
 *     Promise synthesizes an error result but skips the upsert (tool-
 *     level failures aren't valid tier-cache datapoints).
 *
 * Return shape always includes `email`, `status`, `serviceTier`, plus
 * whatever testAccount or probeCodexAccountAsync produced.
 */
export async function probeOne(
  target,
  email,
  ccrotate,
  store = createStateStore({ profilesDir: ccrotate.profilesDir }),
) {
  let profiles;
  try {
    // Per-target STORE path: claude accounts live in profiles.json,
    // codex accounts in profiles.codex.json. The state-server exposes
    // these as `/state/profiles` and `/state/profiles?target=codex`
    // respectively; HttpStateStore.getCodexProfiles() routes to the
    // latter. PR #65 fixed the per-target *token path* (auth.tokens.
    // access_token vs credentials.claudeAiOauth.accessToken) but left
    // the per-target *store path* hardcoded to getProfiles() (claude
    // only) — so for any email that only exists in profiles.codex.json
    // (every dedicated codex account: omar.ramadan@, princeomz2004@,
    // …), the lookup at line below returned undefined and probeOne
    // still bailed with "no profile or token for email". Same symptom
    // PR #65 was meant to fix; same workaround (manual re-relogin to
    // force a tier-cache write) the user has been running for days.
    profiles =
      target === 'codex'
        ? await store.getCodexProfiles()
        : await store.getProfiles();
  } catch (e) {
    return {
      email,
      status: 'error',
      serviceTier: null,
      response: String(e?.message ?? e).slice(0, 150),
    };
  }
  const profile = profiles?.[email];

  // Per-target probe primitive: claude uses testAccount (which hits
  // api.anthropic.com/api/oauth/usage); codex uses
  // probeCodexAccountAsync (which spawns `codex exec` non-blockingly
  // and reads back rate-limit headers from the session JSONL). PRs
  // #65 and #67 fixed the per-target token and store paths, but left
  // the probe primitive hardcoded to testAccount — a Claude-only
  // endpoint. With a codex bearer that call returns 401, testAccount
  // falls through to `{ status: 'unknown', serviceTier: null }`, and
  // every codex freshness tick logged `tier=? status=unknown`. Codex
  // tier-cache rot was masked because auth-bot's snap-back loop
  // refreshes it on a parallel schedule. Wire the codex probe
  // primitive here so the freshness-loop becomes a real safety net
  // for codex too, matching its role for claude.
  if (target === 'codex') {
    if (!profile?.auth) {
      return {
        email,
        status: 'error',
        serviceTier: null,
        response: 'no profile or codex auth for email',
      };
    }
    // Distinguish "probeCodexAccountAsync resolved with an error
    // result" (e.g., expired id_token — a real account-level signal
    // worth persisting) from "probeCodexAccountAsync rejected" (a
    // tool-level failure like spawn ENOENT — not a signal about the
    // account). refresh-one --target codex doesn't catch; it lets
    // throws crash the whole refresh. We catch here so a single bad
    // probe doesn't kill the freshness loop, and skip the upsert
    // because a synthesized error from a rejected Promise isn't a
    // valid tier-cache datapoint.
    let probe;
    let probeThrew = false;
    try {
      probe = await ccrotate.probeCodexAccountAsync(email, profile, profiles);
    } catch (e) {
      probeThrew = true;
      probe = {
        status: 'error',
        response: String(e?.message ?? e).slice(0, 150),
        serviceTier: null,
      };
    }
    const entry = { email, ...probe };
    if (!probeThrew) {
      // Persist into tier-cache.codex.json. Mirrors refresh-one
      // --target codex: writes both success and probe-returned-error
      // entries unconditionally so a future routing decision sees
      // the latest signal, not a stale healthy snapshot. Codex has
      // no per-profile `exhausted` map — the tier-cache IS the
      // source of truth — so we don't call clearExhausted /
      // markExhausted here. upsertTierCacheEntries serializes via
      // withCcrotateLock so concurrent writers (auth-bot snap-back,
      // refresh-one, multiple serve replicas) don't race.
      try {
        ccrotate.upsertTierCacheEntries([entry]);
      } catch {
        // Non-fatal: caller still gets the probe result.
      }
      if (probe?.status === 'success' && probe?.stale !== true) {
        try {
          await store.clearCodexStale?.(email, { lastApiSyncAt: probe.lastApiSyncAt ?? null });
        } catch {
          // Non-fatal: tier-cache remains the freshness signal; the next
          // auth-bot or freshness pass can repair the profile flag.
        }
      }
    }
    return entry;
  }

  // Claude probe path: per-target token under credentials.claudeAiOauth.
  const token = profile?.credentials?.claudeAiOauth?.accessToken;
  if (!token) {
    return {
      email,
      status: 'error',
      serviceTier: null,
      response: 'no profile or token for email',
    };
  }

  let result;
  try {
    result = await ccrotate.testAccount(email, { token, usageApiOnly: false });
  } catch (e) {
    result = {
      status: 'error',
      response: String(e?.message ?? e).slice(0, 150),
      serviceTier: null,
    };
  }

  const entry = { email, ...result };

  // Writeback through the StateStore. A usable probe clears the stale
  // `exhausted` label (the self-heal); an exhausted probe refreshes the
  // reset epoch; an error/unknown probe leaves the label untouched.
  //
  // 2026-05-20 stale-LKG fix (companion to PR #51): testAccount returns
  // `stale: true` when its Usage API call served from the LKG cache
  // instead of a fresh probe (Usage API on cooldown or dedup'd to an
  // in-flight call). Pre-fix, an exhausted serviceTier derived from
  // stale LKG would still get written to tier-cache here, baking the
  // very multi-day false-exhausted flag the callMessages fix already
  // prevented. Symmetric rule: stale LKG never confirms exhaustion.
  // The CLEAR path stays unconditional — a usable serviceTier is
  // positive evidence regardless of staleness (false-clears self-heal
  // on the next 429 anyway, far less costly than false-marks).
  try {
    if (result?.serviceTier && result.serviceTier !== 'exhausted') {
      await store.clearExhausted(email, {});
    } else if (result?.serviceTier === 'exhausted' && result?.stale !== true) {
      await store.markExhausted(email, {
        reset5h: result.rateLimits?.reset5h ?? null,
        reset7d: result.rateLimits?.reset7d ?? null,
      });
    }
  } catch {
    // Non-fatal: caller still gets the probe result.
  }
  return entry;
}

export function startFreshnessLoop(ccrotate, opts = {}) {
  const probeIntervalMs = Number(
    opts.probeIntervalMs ??
      process.env.CCROTATE_FRESHNESS_PROBE_MS ??
      DEFAULT_PROBE_INTERVAL_MS,
  );
  const staleMinAgeMs = Number(
    opts.staleMinAgeMs ??
      process.env.CCROTATE_FRESHNESS_STALE_MIN_AGE_MS ??
      DEFAULT_STALE_MIN_AGE_MS,
  );
  const log = opts.log ?? console;
  const onTick = opts.onTick; // test hook

  if (!Number.isFinite(probeIntervalMs) || probeIntervalMs <= 0) {
    log.log?.(
      '[freshness-loop] disabled (CCROTATE_FRESHNESS_PROBE_MS<=0)',
    );
    return { stop: () => {}, _disabled: true };
  }

  // Rotation offset — lets multiple serve replicas start at different points
  // in the candidate list so they don't probe the same account on tick 0.
  // Explicit override via opts.rotationOffset or CCROTATE_FRESHNESS_PROBE_OFFSET.
  // If neither is set, default to a random init so independent processes
  // naturally diverge (matters for ccrotate-serve at 2+ replicas behind a
  // Service; not load-bearing for single-replica deploys).
  const rotationOffset = (() => {
    const raw = opts.rotationOffset ?? process.env.CCROTATE_FRESHNESS_PROBE_OFFSET;
    if (raw === undefined || raw === '') {
      return Math.floor(Math.random() * 0xffffffff);
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n >>> 0 : 0;
  })();
  let rotationIndex = rotationOffset;
  let inFlight = false;
  let stopped = false;

  // StateStore for tier-cache / profiles reads + probe writeback. HTTP mode
  // (CCROTATE_STATE_URL set) → HttpStateStore, else FileStateStore. Created
  // after the disabled-check so a disabled loop never needs a profilesDir.
  const store = opts.store ?? createStateStore({ profilesDir: ccrotate.profilesDir });

  async function tick() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      // Per-target STORE: a codex-target loop reads profiles.codex.json,
      // a claude-target loop reads profiles.json. Without this, a codex
      // tick fed claude-shaped profiles into pickStaleEntry, the token
      // path didn't match any of them, and no codex stale entries were
      // ever selected — equivalent to running with the loop disabled.
      // Same reasoning as probeOne above.
      const loopTarget = ccrotate.target ?? 'claude';
      let cache, profiles;
      try {
        cache =
          loopTarget === 'codex'
            ? await store.getCodexTierCache()
            : await store.getTierCache();
        profiles =
          loopTarget === 'codex'
            ? await store.getCodexProfiles()
            : await store.getProfiles();
      } catch (e) {
        log.warn?.(`[freshness-loop] state read failed: ${e?.message ?? e}`);
        return;
      }

      const target = pickStaleEntry(cache, profiles, {
        staleMinAgeMs,
        rotationIndex,
        target: loopTarget,
      });
      if (!target) {
        // Quiet on idle ticks — pool is healthy or all entries are recent.
        return;
      }
      // Round-robin across the candidate set: increment unconditionally,
      // pickStaleEntry takes modulo of candidates.length itself.
      rotationIndex = (rotationIndex + 1) >>> 0;

      // The `target` arg below is advisory — the freshness-loop is target-aware
      // via the ccrotate instance, not a per-call parameter. We pass
      // `ccrotate.target` when available (string "claude"/"codex"); otherwise
      // "claude" matches the historical default. probeOne uses it only for
      // shape; the actual token comes from profiles[email].
      const probeTarget = ccrotate.target ?? 'claude';
      const startedAt = Date.now();
      // probeOne handles testAccount throws (returns an error-shaped result)
      // and best-effort writes the result back through the StateStore
      // (clear/mark exhausted). Errors there are swallowed inside probeOne.
      const result = await probeOne(probeTarget, target.email, ccrotate, store);
      const durationMs = Date.now() - startedAt;

      const flipped =
        target && result?.serviceTier && result.serviceTier !== 'exhausted';
      log.log?.(
        `[freshness-loop] probe ${target.email} -> ` +
          `tier=${result?.serviceTier ?? '?'} status=${result?.status ?? '?'} ` +
          `(${durationMs}ms)` +
          (flipped ? ' [stale-exhausted cleared]' : ''),
      );

      if (onTick) onTick({ target, result, durationMs });
    } finally {
      inFlight = false;
    }
  }

  // Stagger the first tick so concurrent serve restarts don't all probe
  // at once. Up to probeIntervalMs/2 of jitter.
  const initialDelay = Math.floor(Math.random() * (probeIntervalMs / 2));
  const initialTimer = setTimeout(() => {
    tick().catch((e) =>
      log.warn?.(`[freshness-loop] tick error: ${e?.message ?? e}`),
    );
    const interval = setInterval(() => {
      tick().catch((e) =>
        log.warn?.(`[freshness-loop] tick error: ${e?.message ?? e}`),
      );
    }, probeIntervalMs);
    interval.unref?.();
    // Replace the initialTimer ref in the closure for stop()
    initialTimer._followup = interval;
  }, initialDelay);
  initialTimer.unref?.();

  log.log?.(
    `[freshness-loop] enabled — first probe in ~${Math.round(initialDelay / 1000)}s ` +
      `(jittered), then every ${probeIntervalMs / 1000}s; stale floor ${staleMinAgeMs / 1000}s; ` +
      `rotation offset ${rotationOffset}`,
  );

  return {
    stop() {
      stopped = true;
      clearTimeout(initialTimer);
      if (initialTimer._followup) clearInterval(initialTimer._followup);
    },
    _tick: tick, // test hook — call tick() synchronously
  };
}

// Exported for unit tests only.
export { pickStaleEntry };
