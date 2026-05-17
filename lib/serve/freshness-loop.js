// Background single-account probe rotation for ccrotate serve.
//
// Why this exists: `ccrotate refresh` probes every account in a burst —
// great for an operator running it ad-hoc, but bad as the only source of
// tier-cache truth. Anthropic's per-org Usage API throttling means a burst
// of 13 probes routinely produces false `exhausted` labels on accounts
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

const DEFAULT_PROBE_INTERVAL_MS = 90_000;
const DEFAULT_STALE_MIN_AGE_MS = 300_000;

function parseTimestampMs(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pickStaleEntry(cache, profiles, { staleMinAgeMs, rotationIndex }) {
  const accounts = Array.isArray(cache?.accounts) ? cache.accounts : [];
  if (accounts.length === 0) return null;
  const nowMs = Date.now();

  const candidates = [];
  for (const entry of accounts) {
    const email = entry?.email;
    if (!email) continue;

    // Only re-probe entries the cache currently says are unusable. Healthy
    // entries don't need a freshness check — let the burst refresh handle
    // those during its scheduled run.
    const tier = entry?.serviceTier;
    const status = entry?.status;
    const isUnusable =
      tier === 'exhausted' || status === 'error' || status === 'unknown';
    if (!isUnusable) continue;

    // Honor staleness floor — don't probe entries that were just written.
    const capturedAt = parseTimestampMs(entry?.rateLimits?.snapshotCapturedAt);
    if (capturedAt > 0 && nowMs - capturedAt < staleMinAgeMs) continue;

    // Skip accounts whose token has expired — probing burns the cached
    // accessToken without yielding usable info. The auth-bot's option-A
    // loop handles those separately.
    const oauth = profiles?.[email]?.credentials?.claudeAiOauth;
    if (!oauth?.accessToken) continue;
    const expiresAt = oauth.expiresAt || 0;
    if (expiresAt > 0 && expiresAt < nowMs) continue;

    candidates.push({ email, capturedAt });
  }

  if (candidates.length === 0) return null;

  // Round-robin so we don't hot-probe the oldest entry forever. Sort by
  // capturedAt asc (oldest first) then offset by rotationIndex.
  candidates.sort((a, b) => a.capturedAt - b.capturedAt);
  return candidates[rotationIndex % candidates.length];
}

/**
 * Single-account probe primitive shared between the freshness-loop tick
 * body and the POST /v1/internal/probe-one HTTP route (active-verify
 * tier-gate, T4). Read-only with respect to active credentials: we load
 * the target email's bearer from profiles.json and pass it to
 * testAccount via the explicit `token` option, so the active session's
 * ~/.claude/.credentials.json is never touched. `usageApiOnly: false`
 * leaves the /v1/messages fallback path enabled — testAccount internally
 * gates that fallback to extra/overage accounts only, which is the
 * behavior we want here too.
 *
 * The `target` arg is "claude" or "codex" — currently advisory (used for
 * logging / future routing). The freshness-loop's per-instance ccrotate
 * already knows its own target via construction; the probe-one HTTP route
 * passes it in.
 *
 * Return shape always includes `email`, `status`, `serviceTier`, plus
 * whatever testAccount produced. Upsert errors are swallowed — caller
 * still receives the probe result.
 */
export async function probeOne(target, email, ccrotate) {
  let profiles;
  try {
    profiles = ccrotate.loadProfiles();
  } catch (e) {
    return {
      email,
      status: 'error',
      serviceTier: null,
      response: String(e?.message ?? e).slice(0, 150),
    };
  }
  const oauth = profiles?.[email]?.credentials?.claudeAiOauth;
  const token = oauth?.accessToken;
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
  try {
    ccrotate.upsertTierCacheEntries([entry]);
  } catch {
    // Non-fatal: caller still gets the probe result. The freshness-loop
    // tick body logs its own warning; HTTP callers can decide whether
    // the cache-write failure matters for their flow.
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

  let rotationIndex = 0;
  let inFlight = false;
  let stopped = false;

  async function tick() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      // clearExpiredCooldowns belongs to the refresh path, not here —
      // calling it would write profiles.json and race with the writer
      // path. Cooldown checks live inside testAccount via the Usage API
      // response itself.
      let cache, profiles;
      try {
        cache = ccrotate.loadTierCache();
        profiles = ccrotate.loadProfiles();
      } catch (e) {
        log.warn?.(`[freshness-loop] state read failed: ${e?.message ?? e}`);
        return;
      }

      const target = pickStaleEntry(cache, profiles, {
        staleMinAgeMs,
        rotationIndex,
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
      // and best-effort upserts the result into tier-cache. The upsert error
      // is swallowed inside probeOne; we re-detect by checking whether the
      // entry round-trips back when we read post-tick — but for the log line
      // we just rely on probeOne's contract.
      const result = await probeOne(probeTarget, target.email, ccrotate);
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
      `(jittered), then every ${probeIntervalMs / 1000}s; stale floor ${staleMinAgeMs / 1000}s`,
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
