// Probe Anthropic's per-account /api/oauth/usage to verify whether a 429
// represents real per-account exhaustion (utilization >= 95%) or a transient
// burst/concurrency throttle that has nothing to do with the account's 5h/7d
// cap. Used by callMessages (anthropic-client.js) before markExhausted to
// prevent false-positive exhausted poisoning of the pool — incident handoff:
// .planning/2026-05-19-ccrotate-rate-limit-classification-handoff.md.
//
// Modeled on lib/ccrotate.js:fetchAccountUsage but with no filesystem (serve
// pods run without the shared cephfs PVC). State lives in-process:
//   - cooldownMap: tokenHash -> until_epoch_ms; honor Anthropic's retry-after
//     so we don't re-trigger the per-token cooldown on every 429 in a burst.
//   - lkgCache: tokenHash -> last successful parsed payload; served stale
//     during cooldown so we don't drop to "unknown" and force the
//     conservative-trust-the-429 branch every time.
//   - inFlight: tokenHash -> Promise; concurrent probes for the same token
//     collapse to a single upstream call so a 429 burst doesn't beat the
//     Usage API into a long cooldown.

import { createHash } from 'crypto';
import https from 'https';

const cooldownMap = new Map();
const lkgCache = new Map();
const inFlight = new Map();

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function toPercent(utilization) {
  if (utilization == null) return null;
  return Math.min(100, Math.round(utilization < 1 ? utilization * 100 : utilization));
}

function doFetch(accessToken, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/api/oauth/usage',
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/1.0.38',
        'x-app': 'cli',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on('error', () => resolve(null));
    const timer = setTimeout(() => { req.destroy(); resolve(null); }, timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}

/**
 * Probe /api/oauth/usage for an account. Returns:
 *   { utilization5h, utilization7d, stale }  on hit (current or LKG)
 *   null                                     on no signal
 * `stale: true` means the value came from the LKG cache because the token
 * is in cooldown. Callers should still trust LKG (5h/7d windows move slowly).
 *
 * opts:
 *   timeoutMs (default 5000)
 *   _fetch (test injection — same shape as doFetch result)
 *   _now   (test injection — returns ms-since-epoch)
 *   _reset (test helper — clears all in-process caches; used by tests only)
 */
export async function probeUsageApi(accessToken, opts = {}) {
  if (opts._reset) {
    cooldownMap.clear();
    lkgCache.clear();
    inFlight.clear();
    return null;
  }
  if (!accessToken) return null;
  // Test gate: anthropic-client.test.js sets CCROTATE_USAGE_PROBE_DISABLED=1
  // so existing tests that exercise the structural-429 path don't fire a
  // real https.request at api.anthropic.com — same pattern as
  // CCROTATE_TRANSIENT_429_BACKOFF_MS=0 at the top of that file.
  // Returning null here drives the conservative-trust-the-429 branch in
  // callMessages, preserving the existing tests' expected behavior.
  if (process.env.CCROTATE_USAGE_PROBE_DISABLED === '1') return null;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const now = (opts._now ?? Date.now)();
  const key = tokenHash(accessToken);

  if (inFlight.has(key)) return inFlight.get(key);

  const cooldownUntil = cooldownMap.get(key);
  if (cooldownUntil && now < cooldownUntil) {
    const lkg = lkgCache.get(key);
    return lkg ? { ...lkg, stale: true } : null;
  }

  const p = (async () => {
    const fetcher = opts._fetch ?? doFetch;
    const res = await fetcher(accessToken, timeoutMs);
    if (!res) return null;
    if (res.statusCode === 429) {
      const retryAfterHeader = res.headers?.['retry-after'];
      const retryAfter = Number.parseInt(retryAfterHeader || '3600', 10);
      const until = now + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 3600) * 1000;
      cooldownMap.set(key, until);
      const lkg = lkgCache.get(key);
      return lkg ? { ...lkg, stale: true } : null;
    }
    if (res.statusCode !== 200) return null;
    cooldownMap.delete(key);
    let parsed;
    try { parsed = JSON.parse(res.body); } catch { return null; }
    if (!parsed) return null;
    const out = {
      utilization5h: toPercent(parsed.five_hour?.utilization),
      utilization7d: toPercent(parsed.seven_day?.utilization),
      stale: false,
    };
    lkgCache.set(key, { utilization5h: out.utilization5h, utilization7d: out.utilization7d });
    return out;
  })();
  inFlight.set(key, p);
  p.finally(() => inFlight.delete(key));
  return p;
}

// Exported for unit testing.
export { tokenHash, toPercent };
