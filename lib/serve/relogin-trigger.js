// Fire-and-forget relogin notifications to the ccrotate-auth-bot.
//
// Self-heal hook (paperclip incident 2026-05-19, Issue gap). When
// callMessages sees a refresh-token failure (the account's stored
// refresh_token won't mint a new access_token), the only path back to
// usable is a sessionKey-driven re-login through the auth-bot. Pre-fix,
// ccrotate-serve just rotated and left the broken profile to rot until
// an operator manually called /reloginViaSession. This module gives
// serve a one-line "notify the auth-bot for me" call so the recovery
// kicks off without operator involvement.
//
// Design:
//   - Fire-and-forget: the auth-bot's relogin takes ~30s (Camoufox +
//     claude /login + ccrotate snap). Blocking the in-flight request
//     on it would defeat the rotation that's the actual recovery for
//     THIS request. The dead profile will be healed by the time a
//     later request rotates back to it.
//   - In-process dedup: a burst of 401s from many concurrent requests
//     would otherwise fire many parallel relogin POSTs against the
//     auth-bot — the bot already has per-(email,target) serializeRelogin
//     lock that would serialize them, but we shouldn't pile that
//     queue up. Dedup by (email,target) for COOLDOWN_MS so concurrent
//     401s during a relogin-in-flight collapse to one POST.
//   - Disabled when CCROTATE_RELOGIN_TRIGGER_URL is empty (tests,
//     local dev, devbox routing — only the in-cluster serve pods set
//     this env).
//
// Wire-up: anthropic-client.js callMessages refresh-fail branch.

const COOLDOWN_MS = 60_000;
const inFlight = new Map(); // key = `${email}|${target}` → epoch_ms last_fired

function key(email, target) { return `${email}|${target}`; }

/**
 * Fire a relogin request at the auth-bot. Returns immediately; errors
 * are swallowed (logged but not thrown). Idempotent under bursts via
 * the in-process cooldown map.
 *
 * opts:
 *   url        — override CCROTATE_RELOGIN_TRIGGER_URL (test injection)
 *   timeoutMs  — default 5000
 *   _now       — clock injection (test)
 *   _fetch     — fetch injection (test)
 */
export function triggerRelogin(email, target = 'claude', opts = {}) {
  if (!email) return false;
  const url = opts.url ?? process.env.CCROTATE_RELOGIN_TRIGGER_URL ?? '';
  if (!url) return false;
  const now = (opts._now ?? Date.now)();
  const k = key(email, target);
  const last = inFlight.get(k);
  if (last && now - last < COOLDOWN_MS) {
    // Already fired recently; let the prior relogin land.
    return false;
  }
  inFlight.set(k, now);

  const doFetch = opts._fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  doFetch(url.replace(/\/$/, '') + '/reloginViaSession', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, target }),
    signal: controller.signal,
  }).then((res) => {
    // The auth-bot's relogin is async-completing on its end; a 200 here
    // means "accepted, will run". Any non-2xx surfaces in serve logs
    // so operators can correlate dead pool sweeps.
    if (!res || (res.status >= 200 && res.status < 300)) {
      console.log(`[reloginTrigger] account=${email} target=${target} accepted`);
    } else {
      console.log(`[reloginTrigger] account=${email} target=${target} status=${res.status}`);
    }
  }).catch((err) => {
    console.log(`[reloginTrigger] account=${email} target=${target} error=${err?.message ?? err}`);
  }).finally(() => {
    clearTimeout(timer);
  });
  return true;
}

/** Test-only: clear the in-process cooldown map. */
export function _resetReloginTrigger() { inFlight.clear(); }
