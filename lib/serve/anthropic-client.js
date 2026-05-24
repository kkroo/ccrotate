// Calls api.anthropic.com via the ccrotate OAuth pool. Handles rotation
// on quota exhaustion, lazy refresh on 401, pool-walk on refresh-fail.
//
// All rotation-state access goes through a StateStore (state-store.js):
// FileStateStore in local/file-mode deploys, HttpStateStore when
// CCROTATE_STATE_URL points at a `ccrotate state-server`. This is what
// lets ccrotate-serve run without the shared cephfs PVC (onprem-k8s#227).

import { createStateStore } from './state-store.js';
import { isAccountExhausted } from '../state-helpers.js';
import { probeUsageApi as defaultProbeUsageApi, probeOauthProfile as defaultProbeOauthProfile } from './usage-api-probe.js';
import { triggerRelogin as defaultTriggerRelogin } from './relogin-trigger.js';
import { admitAnthropicAttempt } from './anthropic-admission.js';

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

function headerValue(headers, name) {
  try {
    return headers?.get?.(name) ?? null;
  } catch {
    return null;
  }
}

function anthropicResponseHeaders(response) {
  if (!response?.headers) return {};
  return {
    anthropicRequestId: headerValue(response.headers, 'request-id') ?? headerValue(response.headers, 'anthropic-request-id'),
    retryAfter: headerValue(response.headers, 'retry-after'),
    inputTokensLimit: headerValue(response.headers, 'anthropic-ratelimit-input-tokens-limit'),
    inputTokensRemaining: headerValue(response.headers, 'anthropic-ratelimit-input-tokens-remaining'),
    inputTokensReset: headerValue(response.headers, 'anthropic-ratelimit-input-tokens-reset'),
    outputTokensLimit: headerValue(response.headers, 'anthropic-ratelimit-output-tokens-limit'),
    outputTokensRemaining: headerValue(response.headers, 'anthropic-ratelimit-output-tokens-remaining'),
    outputTokensReset: headerValue(response.headers, 'anthropic-ratelimit-output-tokens-reset'),
    tokensLimit: headerValue(response.headers, 'anthropic-ratelimit-tokens-limit'),
    tokensRemaining: headerValue(response.headers, 'anthropic-ratelimit-tokens-remaining'),
    tokensReset: headerValue(response.headers, 'anthropic-ratelimit-tokens-reset'),
    requestsLimit: headerValue(response.headers, 'anthropic-ratelimit-requests-limit'),
    requestsRemaining: headerValue(response.headers, 'anthropic-ratelimit-requests-remaining'),
    requestsReset: headerValue(response.headers, 'anthropic-ratelimit-requests-reset'),
  };
}

function logAttribution(event, attribution, fields = {}) {
  if (!attribution) return;
  try {
    console.log(`[callMessages.attribution] ${JSON.stringify({
      component: 'ccrotate.callMessages',
      event,
      requestId: attribution.requestId ?? null,
      endpoint: attribution.endpoint ?? null,
      model: attribution.model ?? null,
      stream: attribution.stream === true,
      bodyBytes: attribution.bodyBytes ?? null,
      estimatedInputTokens: attribution.estimatedInputTokens ?? null,
      requestedMaxOutputTokens: attribution.requestedMaxOutputTokens ?? null,
      caller: attribution.caller ?? {},
      ...fields,
    })}`);
  } catch (err) {
    console.log(`[callMessages.attribution] log failed: ${err?.message ?? err}`);
  }
}

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

// Parse the upstream's `retry-after` header value in delta-seconds form
// (the only form Anthropic emits in practice). HTTP-date form is rare and
// ignored — returns null in that case so callers fall back to default
// behavior instead of mis-waiting on an unparseable string.
function parseRetryAfterSec(headers) {
  if (!headers) return null;
  const v = headers.get?.('retry-after') ?? headers['retry-after'];
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
export { parseRetryAfterSec };

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
  const activeEmail = await store.getActiveEmail();
  if (activeEmail && !alreadyTried.has(activeEmail)) {
    const prof = profiles[activeEmail];
    if (!exhaustedSet.has(activeEmail) && prof?.credentials?.claudeAiOauth?.accessToken) {
      return { email: activeEmail, profile: prof };
    }
  }
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
  const attribution = opts.attribution ?? null;
  const requestStartedAt = Date.now();

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
  // Wait-on-same-account ceiling (seconds). On a transient 429, if the
  // upstream's `retry-after` is below this, we hold the same account
  // and wait it out instead of rotating to the next candidate. Rotation
  // chains into refresh attempts on the next account's stale access token,
  // which can 429 the per-org /oauth/token endpoint and (pre-kkroo#63)
  // trigger relogin storms — and even after #63, rotation still burns a
  // different account's quota and increases pool churn for what is often a
  // short upstream burst. Test/disable knob via opts.waitOnTransient429MaxSec
  // (0 disables wait-on-same-account). Env: CCROTATE_WAIT_ON_TRANSIENT_429_MAX_SEC.
  const waitOnTransient429MaxSec = (() => {
    if (opts.waitOnTransient429MaxSec != null) return opts.waitOnTransient429MaxSec;
    const raw = process.env.CCROTATE_WAIT_ON_TRANSIENT_429_MAX_SEC;
    const n = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 300;
  })();
  // Same-account transient retry budget. A queued Claude message can sit
  // behind Anthropic's short-lived request/token bucket and repeatedly get
  // retry-after. Waiting only once made the caller halt even though the
  // bucket would clear a few seconds later. Bound by BOTH retry count and
  // total waited wall-clock so a genuinely wedged account still rotates.
  const transient429SameAccountMaxRetries = (() => {
    if (opts.transient429SameAccountMaxRetries != null) return opts.transient429SameAccountMaxRetries;
    const raw = process.env.CCROTATE_TRANSIENT_429_SAME_ACCOUNT_MAX_RETRIES;
    const n = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 120;
  })();
  const transient429WaitBudgetMs = (() => {
    if (opts.transient429WaitBudgetMs != null) return opts.transient429WaitBudgetMs;
    const raw = process.env.CCROTATE_TRANSIENT_429_WAIT_BUDGET_MS;
    const n = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 15 * 60_000;
  })();
  // Anthropic 529 overloaded_error is provider capacity, not account quota.
  // Returning every 529 to Claude Code burns its small client retry counter
  // and halts the conversation. Hold the HTTP request open and retry upstream
  // within a bounded wait budget so queued messages can survive short capacity
  // waves without rotating accounts or poisoning tier-cache.
  const transient529MaxRetries = (() => {
    if (opts.transient529MaxRetries != null) return opts.transient529MaxRetries;
    const raw = process.env.CCROTATE_TRANSIENT_529_MAX_RETRIES;
    const n = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 180;
  })();
  const transient529WaitBudgetMs = (() => {
    if (opts.transient529WaitBudgetMs != null) return opts.transient529WaitBudgetMs;
    const raw = process.env.CCROTATE_TRANSIENT_529_WAIT_BUDGET_MS;
    const n = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 15 * 60_000;
  })();
  const transient529BaseDelayMs = (() => {
    if (opts.transient529BaseDelayMs != null) return opts.transient529BaseDelayMs;
    const raw = process.env.CCROTATE_TRANSIENT_529_BASE_DELAY_MS;
    const n = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 2_000;
  })();
  const transient529MaxDelayMs = (() => {
    if (opts.transient529MaxDelayMs != null) return opts.transient529MaxDelayMs;
    const raw = process.env.CCROTATE_TRANSIENT_529_MAX_DELAY_MS;
    const n = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 10_000;
  })();
  const doSleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const probeUsageApi = opts.probeUsageApi ?? defaultProbeUsageApi;
  const usageApiTimeoutMs = opts.usageApiTimeoutMs ?? 5000;
  const triggerRelogin = opts.triggerRelogin ?? defaultTriggerRelogin;
  const probeOauthProfile = opts.probeOauthProfile ?? defaultProbeOauthProfile;

  // Cross-write self-heal: probe Anthropic's /api/oauth/profile to confirm
  // the access token's owning identity matches the profile key we're
  // serving from. Mismatch means profiles.json has been cross-wired
  // (the 2026-05-19 paperclip incident pattern: 9 of 15 profiles
  // accidentally held the same OAuth token under different email keys).
  // Returns true when a mismatch was detected and the relogin trigger
  // was fired; false when identities match or the probe couldn't decide.
  // Errors swallowed — never blocks the request that triggered the check.
  // The probe's own LKG cache makes the cost negligible after the first
  // call per token.
  const checkCrossWired = async (email, accessToken) => {
    if (!email || !accessToken) return false;
    try {
      const probed = await probeOauthProfile(accessToken, { timeoutMs: usageApiTimeoutMs });
      if (!probed?.email) return false;
      if (probed.email.toLowerCase() === email.toLowerCase()) return false;
      console.log(
        `[callMessages] CROSS-WRITE DETECTED: profile=${email} but token belongs to ${probed.email}${probed.stale ? ' (stale)' : ''} — quarantining tokens + firing relogin`,
      );
      // Quarantine the wrong-identity tokens BEFORE firing relogin.
      // Without this, every subsequent callMessages for `email` would
      // continue to use the same wrong tokens until the relogin lands —
      // observed live 2026-05-20: pool serving 9-10 retries per user
      // request because 5 profiles held cross-wired tokens that kept
      // 429-structural'ing. With auto-null the rotator skips straight
      // to the next candidate (the !accessToken branch routes to
      // 'refresh-fail' → pickNextCandidate). Quarantine errors are
      // swallowed — we still want to fire the relogin even if the
      // null/backup couldn't be persisted.
      //
      // RACE FIX 2026-05-20: pass the OFFENDING accessToken to
      // markCrossWritten. The HttpStateStore read cache (1s TTL) can
      // serve a stale `cand` snapshot — we probe the cached old token,
      // it correctly resolves to the wrong identity, but by the time
      // the quarantine RMW lands on the state-server the profile has
      // ALREADY been re-logged-in to a NEW correct token. Without the
      // token check the state-server would null the brand-new correct
      // token using a probe result for the long-gone old one. Live
      // failure mode observed 2026-05-20: princeomz2004 was nulled
      // moments after /ccrotate:setSession wrote its correct token.
      try {
        await store.markCrossWritten?.(email, probed.email, accessToken);
      } catch (qe) {
        console.log(`[callMessages] markCrossWritten threw: ${qe?.message ?? qe}`);
      }
      try { triggerRelogin(email, 'claude'); } catch (e) {
        console.log(`[callMessages] reloginTrigger threw post-mismatch: ${e?.message ?? e}`);
      }
      return true;
    } catch (e) {
      console.log(`[callMessages] identity probe threw: ${e?.message ?? e}`);
      return false;
    }
  };

  const tried = new Set();
  // Per-request wait accounting for transient 429s. Allows many
  // wait-then-retry cycles for a queued message, but caps total wait so
  // a genuinely wedged account eventually falls through to rotation.
  const transientWaitsByAccount = new Map();
  const transient529State = { retries: 0, waitedMs: 0 };
  let cand = await pickNextCandidate(store, tried, payload.model);
  let lastResponse = null;
  let quotaResponse = null;
  let transient429Response = null;
  let attempts = 0;
  let trigger = null;
  logAttribution('request_start', attribution, {
    activeAccount: cand.email ?? null,
  });

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

    try {
      const block = await store.getAnthropicRateLimitBlock?.(cand.email, payload.model);
      const waitState = transientWaitsByAccount.get(cand.email);
      if (block?.blocked && !waitState) {
        console.log(
          `[callMessages] account=${cand.email} skipped by proxy throttle modelGroup=${block.modelGroup} until=${block.until} reason=${block.reason}`,
        );
        logAttribution('throttle_skip', attribution, {
          account: cand.email,
          attempt: attempts,
          throttle: {
            modelGroup: block.modelGroup ?? null,
            until: block.until ?? null,
            reason: block.reason ?? null,
          },
        });
        trigger = `throttle-${block.reason ?? 'cooldown'}`;
        cand = await pickNextCandidate(store, tried, payload.model);
        continue;
      }
    } catch (err) {
      console.log(`[callMessages] rate-limit-state read failed, proceeding: ${err?.message ?? err}`);
    }

    let admission = null;
    try {
      admission = await admitAnthropicAttempt(payload, {
        attribution,
        sleep: doSleep,
        admissionConfig: opts.admissionConfig,
        log: (fields) => {
          console.log(
            `[callMessages] admission throttle modelGroup=${fields.modelGroup} wait=${fields.waitMs}ms ` +
              `reservedIn=${fields.reserved?.inputTokens ?? 'unknown'} reservedOut=${fields.reserved?.outputTokens ?? 'unknown'}`,
          );
          logAttribution('admission_wait', attribution, fields);
        },
      });
    } catch (err) {
      console.log(`[callMessages] admission throttle failed open: ${err?.message ?? err}`);
    }

    let response;
    try {
      response = await callOnce({ url: ANTHROPIC_URL, accessToken: oauth.accessToken, payload, timeoutMs });
    } finally {
      try { admission?.release?.(); } catch {}
    }
    try {
      await store.recordAnthropicRateLimit?.(cand.email, payload.model, response.clone());
    } catch (err) {
      console.log(`[callMessages] rate-limit-state write failed: ${err?.message ?? err}`);
    }

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
    logAttribution('attempt_result', attribution, {
      account: cand.email,
      attempt: attempts,
      status: response.status,
      quota: quotaCls ? (quotaCls.structural ? 'structural' : 'transient') : null,
      trigger,
      responseHeaders: anthropicResponseHeaders(response),
    });

    if (response.status === 529) {
      const retryAfterSec = parseRetryAfterSec(response.headers);
      const retryAfterMs = retryAfterSec != null && retryAfterSec > 0 ? (retryAfterSec + 1) * 1000 : null;
      const exponentialMs = Math.min(
        transient529MaxDelayMs,
        transient529BaseDelayMs * (2 ** Math.min(transient529State.retries, 3)),
      );
      const waitMs = retryAfterMs ?? exponentialMs;
      const canWait =
        transient529MaxRetries > 0 &&
        transient529WaitBudgetMs > 0 &&
        waitMs > 0 &&
        transient529State.retries < transient529MaxRetries &&
        transient529State.waitedMs + waitMs <= transient529WaitBudgetMs;
      if (canWait) {
        transient529State.retries += 1;
        transient529State.waitedMs += waitMs;
        trigger = 'transient-529';
        lastResponse = response;
        console.log(
          `[callMessages] account=${cand.email} transient 529 overloaded — waiting ${Math.round(waitMs)}ms before retrying same account (retry ${transient529State.retries}/${transient529MaxRetries})`,
        );
        logAttribution('transient_529_wait', attribution, {
          account: cand.email,
          attempt: attempts,
          status: response.status,
          waitMs: Math.round(waitMs),
          retry: transient529State.retries,
          maxRetries: transient529MaxRetries,
          waitedMs: transient529State.waitedMs,
        });
        try {
          await doSleep(waitMs);
          continue;
        } catch (err) {
          console.log(`[callMessages] transient-529 wait aborted, returning upstream 529: ${err?.message ?? err}`);
        }
      }
    }

    if (response.status === 429) {
      const cls = quotaCls;
      let structural = cls.structural;
      if (structural) {
        // Verify-on-429 (2026-05-19 incident fix). Per-account RPM /
        // concurrent-request throttles on personal Claude Max accounts ALSO
        // carry the long `anthropic-ratelimit-tokens-reset` absolute header,
        // so classifyQuotaError's horizon gate alone marked transient
        // throttles as 3+ hour exhaustion. The whole pool got poisoned on
        // every burst. Cross-check with the per-account Usage API: only
        // mark exhausted when both 5h and 7d utilization are >= 95%. Module-
        // level dedup in usage-api-probe.js collapses concurrent probes so
        // a 429 burst doesn't beat the Usage API into a long cooldown.
        //
        // 2026-05-20 stale-LKG fix (false-exhausted pool incident): the
        // Usage API probe returns a `stale: true` flag when it served from
        // the LKG cache instead of a fresh HTTP probe (Usage API on
        // cooldown, or another in-flight probe returned a cached value).
        // PRIOR to this fix, stale LKG values participated in BOTH the
        // demote branch AND the confirm-structural branch — meaning a
        // single peak-time util7d=100% probe would keep marking every
        // subsequent 429 (hours later) as structural, poisoning tier-cache
        // with a multi-day exhaustion flag long after the actual quota
        // window rolled. Observed live: omar.ramadan93@gmail.com had a
        // sticky tier-cache exhausted-until-2026-05-23 flag while the
        // user's own /status showed only 79% weekly usage.
        //
        // NEW rule: stale LKG is "no signal". Fresh probe + high util ⇒
        // structural; everything else ⇒ transient (rotate, don't poison
        // tier-cache). One late probe-cooldown rotation costs less than
        // a sticky multi-day false-exhausted flag.
        let probed = null;
        try {
          probed = await probeUsageApi(oauth.accessToken, { timeoutMs: usageApiTimeoutMs });
        } catch (err) {
          console.log(`[callMessages] account=${cand.email} usage-api probe threw, demoting to transient: ${err?.message ?? err}`);
        }
        const u5h = probed?.utilization5h;
        const u7d = probed?.utilization7d;
        const lowFiveHour = u5h != null && u5h < 95;
        const lowSevenDay = u7d == null || u7d < 95;
        const isFresh = probed && probed.stale !== true;
        if (probed && lowFiveHour && lowSevenDay) {
          structural = false;
          console.log(
            `[callMessages] account=${cand.email} 429 demoted by Usage API verify (util5h=${u5h}% util7d=${u7d ?? 'null'}%${probed.stale ? ' stale' : ''})`,
          );
        } else if (isFresh) {
          console.log(
            `[callMessages] account=${cand.email} 429 confirmed structural by Usage API (util5h=${u5h ?? 'null'}% util7d=${u7d ?? 'null'}%)`,
          );
        } else if (probed) {
          // LKG cache served the probe. Treat as no-confirmation so we
          // rotate (transient) instead of baking a multi-day exhaustion
          // flag from possibly-stale data. The original code path
          // confirmed structural here, which let one peak-time
          // util7d=100% probe keep marking 429s for hours afterward as
          // sticky exhaustion. Observed live 2026-05-20: a seat with
          // actual 79% weekly capacity got tier-cache flagged exhausted
          // until 2026-05-23 because every 429 was confirmed against
          // the same stale LKG.
          structural = false;
          console.log(
            `[callMessages] account=${cand.email} 429 demoted — usage-api returned LKG/stale, not trusting for exhaustion (util5h=${u5h ?? 'null'}% util7d=${u7d ?? 'null'}% stale)`,
          );
        } else {
          // No probe data at all (network error / cooldown / null).
          // Conservative — trust the 429 + its headers and mark
          // structural. classifyQuotaError already gates on reset
          // headers + horizon, so this path only fires when the 429
          // legitimately looks like exhaustion. Keeps existing pool-walk
          // semantics that the structural-rotation tests rely on.
          console.log(
            `[callMessages] account=${cand.email} 429 usage-api probe returned no signal, trusting 429`,
          );
        }
      }
      if (structural) {
        // Cross-write check BEFORE markExhausted. If the probe shows
        // this profile's access token actually belongs to a different
        // Anthropic identity, the "exhaustion" is on the wrong
        // identity — marking THIS profile exhausted would just freeze
        // a cross-wired profile that needs a relogin, not a wait. Fire
        // the relogin trigger, treat as transient-429, and rotate.
        const crossWired = await checkCrossWired(cand.email, oauth.accessToken);
        if (crossWired) {
          trigger = 'transient-429';
          lastResponse = response;
          transient429Response = response;
          cand = await pickNextCandidate(store, tried, payload.model);
          if (cand && transient429BackoffMs > 0) {
            try { await doSleep(transient429BackoffMs * (0.75 + Math.random() * 0.5)); } catch {}
          }
          continue;
        }
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
      // Transient 429s do not carry a reset signal (or a short one), so
      // do not poison the shared tier-cache. We prefer waiting it out on
      // the SAME account when the upstream gave us a small retry-after,
      // and only rotate when waiting isn't viable.
      //
      // Rationale (2026-05-21, kkroo#63 follow-up): rotating on transient
      // 429 chains into a refresh on the next account's stale access token.
      // That refresh can itself 429 the per-org /oauth/token endpoint, and
      // pre-#63 every such throw fired triggerRelogin → auth-bot Camoufox
      // cycle → fresh refresh_token written → original tokens overwritten.
      // Even after #63 (which suppresses relogin on transient refresh 429s),
      // a rotation burst still burns a different account's quota and
      // increases pool churn for what is typically a 1-5s burst-throttle.
      // For sub-`waitOnTransient429MaxSec` retry-afters, the wait is cheap
      // and short-circuits the whole chain.
      trigger = 'transient-429';
      lastResponse = response;
      transient429Response = response;

      const retryAfterSec = parseRetryAfterSec(response.headers);
      const waitState = transientWaitsByAccount.get(cand.email) ?? { retries: 0, waitedMs: 0 };
      const waitMs = retryAfterSec != null ? (retryAfterSec + 1) * 1000 : null;
      const canWait =
        waitOnTransient429MaxSec > 0 &&
        transient429SameAccountMaxRetries > 0 &&
        transient429WaitBudgetMs > 0 &&
        retryAfterSec != null &&
        retryAfterSec > 0 &&
        retryAfterSec < waitOnTransient429MaxSec &&
        waitMs != null &&
        waitState.retries < transient429SameAccountMaxRetries &&
        waitState.waitedMs + waitMs <= transient429WaitBudgetMs;
      if (canWait) {
        transientWaitsByAccount.set(cand.email, {
          retries: waitState.retries + 1,
          waitedMs: waitState.waitedMs + waitMs,
        });
        console.log(
          `[callMessages] account=${cand.email} transient 429 retry-after=${retryAfterSec}s — waiting on same account instead of rotating (retry ${waitState.retries + 1}/${transient429SameAccountMaxRetries})`,
        );
        logAttribution('transient_429_wait', attribution, {
          account: cand.email,
          attempt: attempts,
          status: response.status,
          retryAfterSec,
          waitMs,
          retry: waitState.retries + 1,
          maxRetries: transient429SameAccountMaxRetries,
          waitedMs: waitState.waitedMs + waitMs,
        });
        try {
          await doSleep(waitMs);
        } catch (err) {
          console.log(`[callMessages] transient-429 wait aborted, falling through to rotate: ${err?.message ?? err}`);
          // Fall through to the rotate path below.
          cand = await pickNextCandidate(store, tried, payload.model);
          if (cand && transient429BackoffMs > 0) {
            try { await doSleep(transient429BackoffMs * (0.75 + Math.random() * 0.5)); } catch {}
          }
        }
        continue;
      }

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
      logAttribution('request_complete', attribution, {
        account: cand.email,
        status: response.status,
        attempts,
        trigger,
        durationMs: Date.now() - requestStartedAt,
        poolExhausted: false,
      });
      return { status: response.status, response, attempts, account: cand.email, trigger };
    }

    // 401 → try refresh
    let newOauth;
    let refreshErr = null;
    try {
      newOauth = await refreshAccessToken(oauth.refreshToken, timeoutMs);
    } catch (e) {
      refreshErr = e;
      newOauth = null;
    }
    if (newOauth) {
      // B8 self-heal (2026-05-20): identity-probe the freshly-minted
      // access token BEFORE writing it back to disk. PR #46 + PR #50
      // added cross-write detection + quarantine on the READ side
      // (when callMessages observes a 429-structural on a token that
      // probes to a wrong identity). But the 401-refresh path is a
      // separate WRITE path: if `oauth.refreshToken` on disk was
      // already cross-wired (held bot1's RT under bot2's profile key),
      // Anthropic's /v1/oauth/token mints fresh tokens for bot1's
      // identity. Without this guard, writeProfileToken would persist
      // bot1's brand-new tokens under bot2's profile key — perpetuating
      // the cross-write across every refresh tick. Stale-poller would
      // relogin bot2 cleanly, the next refresh would re-cross-write,
      // and G1 (read-side) would catch + quarantine, looping forever.
      //
      // Mirror the read-side handling: refuse the write, quarantine the
      // stale on-disk RT (which is the seed of the bug) AND record the
      // offending freshly-minted pair for forensics, fire a relogin
      // trigger, then continue the pool walk as 'refresh-fail'.
      //
      // Errors swallowed — never block the original request that
      // triggered the refresh.
      let wrongIdentityRefresh = false;
      try {
        const probed = await probeOauthProfile(newOauth.accessToken, { timeoutMs: usageApiTimeoutMs });
        if (probed?.email && probed.email.toLowerCase() !== cand.email.toLowerCase()) {
          wrongIdentityRefresh = true;
          console.log(
            `[callMessages] WRITE-SIDE CROSS-WRITE DETECTED: profile=${cand.email} refresh minted tokens belonging to ${probed.email}${probed.stale ? ' (stale)' : ''} — refusing writeProfileToken, quarantining + firing relogin`,
          );
          try {
            await store.markCrossWritten?.(
              cand.email,
              probed.email,
              oauth.accessToken,
              {
                accessToken: newOauth.accessToken,
                refreshToken: newOauth.refreshToken,
                expiresAt: newOauth.expiresAt,
                source: 'refresh-write-refused',
              },
            );
          } catch (qe) {
            console.log(`[callMessages] markCrossWritten (write-side) threw: ${qe?.message ?? qe}`);
          }
          try { triggerRelogin(cand.email, 'claude'); } catch (e) {
            console.log(`[callMessages] reloginTrigger threw post-write-side-mismatch: ${e?.message ?? e}`);
          }
        }
      } catch (e) {
        console.log(`[callMessages] write-side identity probe threw: ${e?.message ?? e}`);
      }

      if (!wrongIdentityRefresh) {
        await store.writeProfileToken(cand.email, newOauth);
        // Replay once on the same account.
        attempts += 1;
        let replayAdmission = null;
        try {
          replayAdmission = await admitAnthropicAttempt(payload, {
            attribution,
            sleep: doSleep,
            admissionConfig: opts.admissionConfig,
            log: (fields) => {
              console.log(
                `[callMessages] admission throttle modelGroup=${fields.modelGroup} wait=${fields.waitMs}ms ` +
                  `reservedIn=${fields.reserved?.inputTokens ?? 'unknown'} reservedOut=${fields.reserved?.outputTokens ?? 'unknown'} replayAfterRefresh=true`,
              );
              logAttribution('admission_wait', attribution, { ...fields, replayAfterRefresh: true });
            },
          });
        } catch (err) {
          console.log(`[callMessages] admission throttle failed open before refresh replay: ${err?.message ?? err}`);
        }
        try {
          response = await callOnce({ url: ANTHROPIC_URL, accessToken: newOauth.accessToken, payload, timeoutMs });
        } finally {
          try { replayAdmission?.release?.(); } catch {}
        }
        logAttribution('attempt_result', attribution, {
          account: cand.email,
          attempt: attempts,
          status: response.status,
          quota: null,
          trigger,
          replayAfterRefresh: true,
          responseHeaders: anthropicResponseHeaders(response),
        });
        if (response.status !== 401) {
          await setActiveOnSuccess(store, cand.email, response, payload.model);
          logAttribution('request_complete', attribution, {
            account: cand.email,
            status: response.status,
            attempts,
            trigger,
            durationMs: Date.now() - requestStartedAt,
            poolExhausted: false,
          });
          return { status: response.status, response, attempts, account: cand.email, trigger };
        }
        // Refreshed but immediately 401 — fall through as refresh-fail.
      }
      // wrongIdentityRefresh: fall through to refresh-fail rotation.
    }

    // refresh failed — rotate AND (usually) fire an auto-relogin trigger at
    // the auth-bot for this account (paperclip incident 2026-05-19, self-heal
    // gap). The stored refresh_token can't mint a new access_token here;
    // only a sessionKey-driven re-login through the auth-bot can revive
    // the profile. Fire-and-forget (don't block this request — rotation
    // is what serves THIS caller; the relogin heals the profile for the
    // next request). Module-level cooldown dedups bursts.
    //
    // EXCEPTION: when refreshAccessToken threw with a TRANSIENT shape
    // (429 from /api/oauth/token/refresh, 5xx, or a network error), the
    // refresh_token is still valid — the refresh endpoint just declined
    // to honor THIS attempt right now. Firing triggerRelogin here would
    // pointlessly drive the auth-bot through a full Camoufox-based OAuth
    // cycle, overwriting a still-valid refresh_token with a fresh one and
    // churning the bot pool on a problem that fixes itself on the next
    // refresh tick. Live symptom: bursty 401s on access-token expiry hit
    // the per-org /oauth/token rate limiter, so every refresh after the
    // first races into 429 and we relogin half the pool needlessly,
    // burning Camoufox time + magic-link availability and accelerating
    // the appearance of "5h cap finishing fast" because the pool churns
    // through accounts instead of saturating one.
    //
    // We only triggerRelogin on a *permanent* shape: a 4xx (excluding
    // 429) from /oauth/token/refresh, or the post-refresh replay still
    // 401-ing on the freshly-minted access token (refresh accepted but
    // tokens already dead), or the write-side cross-write branch which
    // fired its own triggerRelogin already.
    const refreshStatus = refreshErr?.status;
    const isTransientRefreshErr =
      refreshErr != null &&
      (refreshStatus === 429 ||
        (typeof refreshStatus === 'number' && refreshStatus >= 500) ||
        refreshStatus == null);
    if (isTransientRefreshErr) {
      trigger = 'transient-refresh-error';
      console.log(
        `[callMessages] account=${cand.email} refresh error transient (status=${refreshStatus ?? 'network'}) — rotating without relogin`,
      );
    } else {
      trigger = 'refresh-fail';
      try {
        triggerRelogin(cand.email, 'claude');
      } catch (err) {
        console.log(`[callMessages] reloginTrigger threw: ${err?.message ?? err}`);
      }
    }
    lastResponse = response;
    cand = await pickNextCandidate(store, tried, payload.model);
  }

  // Pool exhausted
  if (quotaResponse) {
    logAttribution('request_complete', attribution, {
      account: null,
      status: 429,
      attempts,
      trigger: 'quota',
      durationMs: Date.now() - requestStartedAt,
      poolExhausted: true,
    });
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
    logAttribution('request_complete', attribution, {
      account: null,
      status: 429,
      attempts,
      trigger: 'transient-429',
      durationMs: Date.now() - requestStartedAt,
      poolExhausted: true,
    });
    return {
      status: 429,
      response: transient429Response,
      attempts,
      account: null,
      trigger: 'transient-429',
      poolExhausted: true,
    };
  }
  if (trigger?.startsWith?.('throttle-') && !lastResponse) {
    logAttribution('request_complete', attribution, {
      account: null,
      status: 429,
      attempts,
      trigger,
      durationMs: Date.now() - requestStartedAt,
      poolExhausted: true,
    });
    return {
      status: 429,
      response: new Response(JSON.stringify({
        error: {
          type: 'rate_limit_error',
          message: 'All ccrotate Anthropic accounts are currently cooling down from proxy-observed rate limits.',
        },
      }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
      attempts,
      account: null,
      trigger,
      poolExhausted: true,
    };
  }
  logAttribution('request_complete', attribution, {
    account: null,
    status: 502,
    attempts,
    trigger,
    durationMs: Date.now() - requestStartedAt,
    poolExhausted: true,
  });
  return {
    status: 502,
    response: lastResponse,
    attempts,
    account: null,
    trigger,
    poolExhausted: true,
  };
}
