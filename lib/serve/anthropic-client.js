// Calls api.anthropic.com via the ccrotate OAuth pool. Handles rotation
// on quota exhaustion, lazy refresh on 401, pool-walk on refresh-fail.
//
// All rotation-state access goes through a StateStore (state-store.js):
// FileStateStore in local/file-mode deploys, HttpStateStore when
// CCROTATE_STATE_URL points at a `ccrotate state-server`. This is what
// lets ccrotate-serve run without the shared cephfs PVC (onprem-k8s#227).

import { createStateStore } from './state-store.js';
import { isAccountExhausted } from '../state-helpers.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const REFRESH_URL = 'https://api.anthropic.com/api/oauth/token/refresh';
// NOTE: actual endpoint may be 'https://console.anthropic.com/v1/oauth/token' —
// confirm during operational probe and adjust if needed.

const HEADERS_TEMPLATE = {
  'Content-Type': 'application/json',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'oauth-2025-04-20',
};

const ONE_M_CONTEXT_BETA = 'context-1m-2025-08-07';

// A rate_limit_error counts as STRUCTURAL exhaustion only when its reset is
// at least this far out. Shorter resets are transient burst / org-level /
// token-bucket throttles, not a per-account 5h/7d cap — see classifyQuotaError.
const STRUCTURAL_MIN_RESET_HORIZON_S = 600;

function prepareAnthropicRequest(payload) {
  const { context_management: _contextManagement, ...upstreamPayload } = payload || {};
  if (upstreamPayload.stream === false) delete upstreamPayload.stream;
  if (upstreamPayload?.model !== 'claude-opus-4-7[1m]') {
    return { payload: upstreamPayload, headers: HEADERS_TEMPLATE };
  }
  return {
    payload: { ...upstreamPayload, model: 'claude-opus-4-7' },
    headers: {
      ...HEADERS_TEMPLATE,
      'anthropic-beta': `${HEADERS_TEMPLATE['anthropic-beta']},${ONE_M_CONTEXT_BETA}`,
    },
  };
}

async function readActiveProfile(store) {
  const profiles = await store.getProfiles();
  let email = await store.getActiveEmail();
  if (!email || !profiles[email]) email = Object.keys(profiles)[0];
  if (!email || !profiles[email]) {
    throw new Error('anthropic-client: no active profile');
  }
  return { email, profile: profiles[email], allProfiles: profiles };
}

async function refreshAccessToken(refreshToken, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = new Error(`refresh failed: ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callOnce({ url, accessToken, payload, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const upstream = prepareAnthropicRequest(payload);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { ...upstream.headers, 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify(upstream.payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function classifyQuotaError(body, responseHeaders) {
  // Returns { structural: bool, reset5h: number|null, reset7d: number|null }
  //
  // T1 fix (2026-05-17): A `rate_limit_error` without ANY reset signal — no
  // anthropic-ratelimit-*-reset header AND no parseable epoch in the message —
  // is a transient burst-throttle (Anthropic's per-org rate limiter slapping
  // the back of a tight burst), not real per-account exhaustion. Returning
  // structural:true in that case caused cluster ccrotate-refresh cronjobs to
  // falsely flag all 13 accounts as exhausted every 30 min, deadlocking
  // paperclip's heartbeat tier-gate. Structural exhaustion requires a reset
  // signal — otherwise treat as inconclusive and let the caller propagate the
  // 429 as transient.
  if (!body || !body.error) return { structural: false };
  if (body.error.type !== 'rate_limit_error') return { structural: false };

  // Prefer reset from headers; fall back to parsing message.
  //
  // Two header shapes:
  //   `anthropic-ratelimit-tokens-reset` — already an absolute unix epoch
  //     in seconds (per Anthropic's rate-limit headers spec).
  //   `retry-after` — HTTP-spec DURATION in seconds (delta-seconds form, not
  //     the rare HTTP-date form). Pre-fix this code stored the raw duration
  //     as `reset5h`, so e.g. retry-after:60 became reset5h=60 → tier-cache
  //     showed "resets at 1970-01-01T00:01:00.000Z" and pickNextCandidate's
  //     `reset5h * 1000 <= Date.now()` filter treated those accounts as
  //     ALWAYS expired (1970 epochs are far in the past). Fix: convert the
  //     duration to an absolute epoch by adding now.
  let reset5h = null;
  if (responseHeaders) {
    const hdr = (h) => {
      const v = responseHeaders.get?.(h) ?? responseHeaders[h];
      if (v == null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const absResetHeader = hdr('anthropic-ratelimit-tokens-reset');
    if (absResetHeader != null) {
      reset5h = absResetHeader;
    } else {
      const retryAfter = hdr('retry-after');
      if (retryAfter != null) {
        reset5h = Math.floor(Date.now() / 1000) + retryAfter;
      }
    }
  }
  if (reset5h == null) {
    const msg = body.error.message || '';
    const m = msg.match(/resets? at[^0-9]*([0-9]{10,})/i);
    reset5h = m ? Number(m[1]) : null;
  }

  // No reset signal → burst-throttle, not exhaustion.
  if (reset5h == null) {
    return { structural: false };
  }

  // Horizon gate (2026-05-19 incident fix). A reset signal alone is too
  // weak: Anthropic's transient burst / org-level / token-bucket 429s ALSO
  // carry retry-after and *-reset headers, but those reset in seconds-to-
  // minutes. A genuine per-account 5h/7d quota cap resets many minutes-to-
  // hours out. Classifying a short-horizon 429 as structural marked usable
  // accounts `exhausted` on every transient burst — the all-`exhausted`
  // pool deadlock. Only a long horizon is real exhaustion.
  const horizonS = reset5h - Math.floor(Date.now() / 1000);
  if (horizonS < STRUCTURAL_MIN_RESET_HORIZON_S) {
    return { structural: false };
  }

  return { structural: true, reset5h, reset7d: null };
}

// T1 (2026-05-17): exported for unit testing the burst-429 vs structural
// classification.
export { classifyQuotaError };

export async function pickNextCandidate(store, alreadyTried, model = null) {
  const profiles = await store.getProfiles();
  const tierCache = await store.getTierCache();
  // Skip an account only when it is exhausted FOR THIS MODEL. Exhaustion is
  // per-model (isAccountExhausted reads the model-scoped `exhausted` map and
  // the legacy serviceTier:'exhausted' shape) — a haiku cap must not bounce
  // an opus request off an otherwise-healthy account.
  const now = Date.now();
  const exhaustedSet = new Set(
    (tierCache.accounts || [])
      .filter(a => isAccountExhausted(a, { model, now }))
      .map(a => a.email)
  );
  for (const [email, prof] of Object.entries(profiles)) {
    if (alreadyTried.has(email)) continue;
    if (exhaustedSet.has(email)) continue;
    if (!prof.credentials?.claudeAiOauth?.accessToken) continue;
    return { email, profile: prof };
  }
  return null;
}

async function setActiveOnSuccess(store, email, response, model = null) {
  if (response.status >= 200 && response.status < 300) {
    // Best-effort: the 200 response stands even if recording the
    // active-account pointer fails (e.g. a transient state-server blip).
    try {
      await store.setActiveEmail(email);
    } catch {
      /* non-fatal */
    }
    // Self-heal stale-exhausted-label deadlock: a 200 from this account is
    // definitive proof it isn't currently exhausted, so clear any stale
    // `serviceTier: exhausted` label in tier-cache. Common trigger: a
    // burst-probe / transient burst-429 / claude-local writeback poisoned
    // the label, the Usage API is on cooldown so freshness-loop probes
    // return status='unknown', and the anti-clobber rule in
    // upsertTierCacheEntries pins the bad label until something clears it.
    // Real upstream success is that something.
    //
    // Model-scoped clear: per-model quotas are independent (haiku may serve
    // while opus is genuinely exhausted), so we only clear when the
    // existing entry's exhaustedModel matches the success model — or when
    // no exhaustedModel was tracked at all. clearExhausted handles the
    // model gate internally.
    try {
      await store.clearExhausted(email, { model });
    } catch {
      // Non-fatal: caller still gets the 200 response. Stale label will
      // clear on next freshness-loop probe or successful upstream call.
    }
  }
}

export async function callMessages(payload, opts = {}) {
  const { profilesDir, timeoutMs = 60000 } = opts;
  if (!opts.store && !profilesDir && !process.env.CCROTATE_STATE_URL) {
    throw new Error('anthropic-client: profilesDir or CCROTATE_STATE_URL required');
  }
  const store = opts.store ?? createStateStore({ profilesDir });

  // Spacing applied after a transient (burst/org) 429 before rotating to the
  // next account — see the transient-429 branch below. Tunable via env;
  // tests inject `opts.transient429BackoffMs` / `opts.sleep`. An unset,
  // empty, or non-numeric env value falls back to the 400ms default rather
  // than `Number('')→0` silently disabling the backoff pool-wide; an
  // explicit `'0'` is honored as the documented disable knob.
  const transient429BackoffMs = (() => {
    if (opts.transient429BackoffMs != null) return opts.transient429BackoffMs;
    const raw = process.env.CCROTATE_TRANSIENT_429_BACKOFF_MS;
    const n = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 400;
  })();
  const doSleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const tried = new Set();
  let cand = { ...(await readActiveProfile(store)) }; // { email, profile, allProfiles }
  let lastResponse = null;
  let quotaResponse = null;
  let transient429Response = null;
  let attempts = 0;
  let trigger = null;

  while (cand) {
    attempts += 1;
    tried.add(cand.email);
    const oauth = cand.profile.credentials?.claudeAiOauth;
    if (!oauth?.accessToken) {
      // Treat missing token as a refresh-fail candidate.
      trigger = 'refresh-fail';
      cand = await pickNextCandidate(store, tried, payload.model);
      continue;
    }

    let response = await callOnce({ url: ANTHROPIC_URL, accessToken: oauth.accessToken, payload, timeoutMs });

    // Classify a 429 up front so the per-attempt log records WHY it failed —
    // a structural 5h/7d cap (real exhaustion) vs a transient burst/org
    // throttle (accounts still have quota; serve is just being rate-limited).
    let quotaCls = null;
    if (response.status === 429) {
      let body = null;
      try { body = await response.clone().json(); } catch {}
      quotaCls = classifyQuotaError(body, response.headers);
    }
    // Per-request rotation visibility: one line per account attempt so the
    // serve log shows which account served (or rotated off) each request.
    // The serve log otherwise only prints freshness-loop probes.
    console.log(
      `[callMessages] account=${cand.email} attempt=${attempts} status=${response.status}` +
        (quotaCls ? ` quota=${quotaCls.structural ? 'structural' : 'transient'}` : ''),
    );

    if (response.status === 429) {
      const cls = quotaCls;
      if (cls.structural) {
        await store.markExhausted(cand.email, {
          reset5h: cls.reset5h,
          reset7d: cls.reset7d,
          model: payload.model,
        });
        trigger = 'quota';
        lastResponse = response;
        quotaResponse = response;
        cand = await pickNextCandidate(store, tried, payload.model);
        continue;
      }
      // Transient 429s do not carry a reset signal, so do not poison the
      // shared tier-cache. Still walk the pool for this request; another
      // account may not be under the same burst throttle.
      trigger = 'transient-429';
      lastResponse = response;
      transient429Response = response;
      cand = await pickNextCandidate(store, tried, payload.model);
      // Back off before the next attempt. Rotating instantly fires at the
      // next account inside the SAME org-wide burst window, so a single
      // request hammers the whole pool into transient-429 in milliseconds.
      // A short gap lets the token bucket recover so a later attempt can
      // land a 200. Structural 429s skip this — that account is genuinely
      // capped. Uniform jitter in [0.75x, 1.25x] decorrelates concurrent
      // requests so they don't re-sync into a fresh burst. A failing
      // backoff (only possible via an injected opts.sleep) must not abort
      // the request — degrade to immediate rotation.
      if (cand && transient429BackoffMs > 0) {
        try {
          await doSleep(transient429BackoffMs * (0.75 + Math.random() * 0.5));
        } catch (err) {
          console.log(`[callMessages] transient-429 backoff failed, rotating immediately: ${err?.message ?? err}`);
        }
      }
      continue;
    }

    if (response.status !== 401) {
      await setActiveOnSuccess(store, cand.email, response, payload.model);
      return { status: response.status, response, attempts, account: cand.email, trigger };
    }

    // 401 → try refresh
    let newOauth;
    try {
      newOauth = await refreshAccessToken(oauth.refreshToken, timeoutMs);
    } catch {
      newOauth = null;
    }
    if (newOauth) {
      await store.writeProfileToken(cand.email, newOauth);
      // Replay once on the same account.
      attempts += 1;
      response = await callOnce({ url: ANTHROPIC_URL, accessToken: newOauth.accessToken, payload, timeoutMs });
      if (response.status !== 401) {
        await setActiveOnSuccess(store, cand.email, response, payload.model);
        return { status: response.status, response, attempts, account: cand.email, trigger };
      }
      // Refreshed but immediately 401 — fall through as refresh-fail.
    }

    // refresh failed — rotate.
    trigger = 'refresh-fail';
    lastResponse = response;
    cand = await pickNextCandidate(store, tried, payload.model);
  }

  // Pool exhausted
  if (quotaResponse) {
    return {
      status: 429,
      response: quotaResponse,
      attempts,
      account: null,
      trigger: 'quota',
      poolExhausted: true,
    };
  }
  if (transient429Response) {
    return {
      status: 429,
      response: transient429Response,
      attempts,
      account: null,
      trigger: 'transient-429',
      poolExhausted: true,
    };
  }
  return {
    status: 502,
    response: lastResponse,
    attempts,
    account: null,
    trigger,
    poolExhausted: true,
  };
}
