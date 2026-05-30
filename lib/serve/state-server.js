// HTTP state API for ccrotate's shared rotation state. Decoupled from
// node:http so it's unit-testable — commands/state-server.js wraps the
// `dispatch(req)` returned here in a node:http server.
//
// Why this exists: ccrotate-serve and ccrotate-auth-bot today coordinate
// rotation state (profiles.json, current.json, tier-cache.json,
// usage-api-cooldowns.json) through files on a shared cephfs PVC. That
// shared mount is the blast-radius source for both the fsGroup chown-thrash
// outage and the D-state wedge (onprem-k8s#227). This server lets the
// auth-bot — already the sole owner of that state — expose it over HTTP so
// ccrotate-serve can drop the PVC mount entirely and pull/push state here
// instead (HttpStateStore, phase 1c).
//
// Auth: optional bearer. If a token is configured, every /state/* request
// must carry `Authorization: Bearer <token>`; /healthz stays open. With no
// token, the NetworkPolicy fronting the Service is the boundary.
//
// Writes serialize through withCcrotateLock — the same advisory lockfile
// the file-mode path uses — so a half-migrated cluster (old file-mode serve
// still writing) and this server don't race.

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { withCcrotateLock, markAccountExhausted, clearAccountExhausted, applyImport } from '../state-helpers.js';
import {
  applyAnthropicRateLimitHeaders,
  clearAnthropicRateLimitState,
  emptyRateLimitState,
} from './rate-limit-state.js';

const VALID_TARGETS = new Set(['claude', 'codex']);

// Path → allowed methods. Lets dispatch distinguish 404 (unknown path) from
// 405 (known path, wrong method).
const ROUTES = {
  '/state/profiles': ['GET'],
  '/state/current': ['GET', 'POST'],
  '/state/tier-cache': ['GET'],
  '/state/rate-limits': ['GET'],
  '/state/rate-limits/anthropic': ['POST'],
  '/state/rate-limits/anthropic/clear': ['POST'],
  '/state/exhausted': ['POST'],
  '/state/clear-exhausted': ['POST'],
  '/state/codex-exhausted': ['POST'],
  '/state/profile-stale': ['POST'],
  '/state/profile-stale/clear': ['POST'],
  '/state/cross-wired': ['POST'],
  '/state/cooldowns': ['GET'],
  '/state/cooldown': ['POST'],
  '/state/profile-access-token': ['POST'],
  '/state/profile-codex-auth': ['POST'],
  '/state/import': ['POST'],
  // SSE mutation feed — clients (e.g. paperclip-plugin-ccrotate worker)
  // subscribe to get a push the moment any state file is rewritten, instead
  // of polling /state/tier-cache every N seconds. Each successful write
  // emits one event; a `: keepalive <ts>` comment goes out every 25s so
  // intermediate proxies don't idle-close the connection.
  '/state/events': ['GET'],
};

// SSE keepalive cadence. Anything under typical proxy idle timeouts (Cilium
// gateway = 60s, Cloudflare = 100s, common nginx default = 75s).
const SSE_KEEPALIVE_MS = 25_000;

function json(status, body) {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function errorResponse(status, code, message) {
  return json(status, { error: { code, message } });
}

function getHeader(req, name) {
  const lower = name.toLowerCase();
  for (const k of Object.keys(req.headers || {})) {
    if (k.toLowerCase() === lower) return req.headers[k];
  }
  return undefined;
}

function parseBearer(req) {
  const h = getHeader(req, 'authorization');
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return null;
  return h.slice('Bearer '.length).trim();
}

// Read a JSON state file. Missing file → { ok:true, data:fallback }; corrupt
// file → { ok:false } so the caller can fail closed with a 500 rather than
// silently serving an empty default over real-but-broken state.
function readJsonFile(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, data: fallback };
    return { ok: false };
  }
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

function writeJsonFileAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function clearAnthropicRateLimitStateFileLocked(dir, email, opts = {}) {
  const file = path.join(dir, 'rate-limit-state.json');
  const r = readJsonFile(file, emptyRateLimitState());
  const state = r.ok ? r.data : emptyRateLimitState();
  const before = JSON.stringify(state?.anthropic?.accounts?.[email] ?? null);
  const updated = clearAnthropicRateLimitState(state, {
    email,
    model: opts.model ?? null,
    modelGroup: opts.modelGroup ?? null,
  });
  const after = JSON.stringify(updated?.anthropic?.accounts?.[email] ?? null);
  const cleared = before !== after;
  if (cleared) writeJsonFileAtomic(file, updated);
  return {
    email,
    cleared,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.modelGroup !== undefined ? { modelGroup: opts.modelGroup } : {}),
  };
}

function profilesFileName(target) {
  return target === 'codex' ? 'profiles.codex.json' : 'profiles.json';
}
function tierCacheFileName(target) {
  return target === 'codex' ? 'tier-cache.codex.json' : 'tier-cache.json';
}
// current.json is NOT target-scoped: both the claude (anthropic-client)
// and codex (openai-client) serve paths read and write this one pointer
// file. Kept as a function for symmetry with the target-scoped names.
function currentFileName() {
  return 'current.json';
}

export function createStateRouter({ dir, token = null, keepaliveMs = SSE_KEEPALIVE_MS } = {}) {
  if (!dir) throw new Error('state-server: dir required');

  // Mutation broadcaster. Every successful state write fans out one event;
  // /state/events subscribes. Set `events.setMaxListeners(0)` so a fleet of
  // long-lived SSE subscribers doesn't trip the default 10-listener warning.
  const events = new EventEmitter();
  events.setMaxListeners(0);

  function broadcast(kind, data = {}) {
    events.emit('mutation', { kind, at: new Date().toISOString(), ...data });
  }

  // Resolve `target` from the GET query string or the POST body, defaulting
  // to claude. Returns { ok:false } on an unrecognized value so the caller
  // can 400 instead of silently reading the wrong pool's files.
  function resolveTarget(raw) {
    if (raw === undefined || raw === null || raw === '') return { ok: true, target: 'claude' };
    if (!VALID_TARGETS.has(raw)) return { ok: false };
    return { ok: true, target: raw };
  }

  // Build the SSE response shape (status/headers/stream) for /state/events.
  // The async generator emits one `event: <kind>\ndata: <json>\n\n` block
  // per mutation and a `: keepalive <ts>\n\n` comment every keepaliveMs. The
  // HTTP wrapper passes through req's AbortSignal so a closed connection
  // makes the generator exit promptly and detaches the listener — without
  // this, dangling listeners would leak with every disconnect.
  function buildSseResponse(signal) {
    const stream = (async function* sseStream() {
      const queue = [];
      let resumeWait = null;
      const onMutation = (event) => {
        queue.push(event);
        if (resumeWait) {
          const fn = resumeWait;
          resumeWait = null;
          fn();
        }
      };
      events.on('mutation', onMutation);
      let aborted = false;
      let onAbort = null;
      if (signal) {
        if (signal.aborted) aborted = true;
        else {
          onAbort = () => {
            aborted = true;
            if (resumeWait) {
              const fn = resumeWait;
              resumeWait = null;
              fn();
            }
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }
      try {
        yield `event: connected\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`;
        while (!aborted) {
          while (queue.length > 0) {
            const ev = queue.shift();
            yield `event: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`;
          }
          if (aborted) break;
          // Sleep until a mutation arrives, abort fires, or keepalive ticks.
          let timer;
          await new Promise((resolve) => {
            resumeWait = resolve;
            timer = setTimeout(resolve, keepaliveMs);
          });
          if (timer) clearTimeout(timer);
          resumeWait = null;
          if (!aborted && queue.length === 0) {
            yield `: keepalive ${Date.now()}\n\n`;
          }
        }
      } finally {
        events.off('mutation', onMutation);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      }
    })();
    return {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      },
      stream,
    };
  }

  async function dispatch(req) {
    const url = new URL(req.url || '/', 'http://ccrotate.local');
    const pathname = url.pathname;

    if (pathname === '/healthz') {
      return json(200, { status: 'ok' });
    }

    if (token) {
      const tok = parseBearer(req);
      if (!tok || tok !== token) {
        return errorResponse(401, 'invalid_bearer', 'missing or invalid bearer token');
      }
    }

    // ─── GET /state/events ─────────────────────────────────────────────
    // Routed before the generic ROUTES table so it can short-circuit the
    // body-parsing path below (SSE is GET-only, never POST).
    if (pathname === '/state/events') {
      if (req.method !== 'GET') {
        return errorResponse(405, 'method_not_allowed', `method ${req.method} not allowed on ${pathname}`);
      }
      return buildSseResponse(req.signal ?? null);
    }

    const allowed = ROUTES[pathname];
    if (!allowed) {
      return errorResponse(404, 'unknown_endpoint', `${pathname} not found`);
    }
    if (!allowed.includes(req.method)) {
      return errorResponse(405, 'method_not_allowed', `method ${req.method} not allowed on ${pathname}`);
    }

    // Parse body for writes; reject malformed JSON.
    let body = {};
    if (req.method === 'POST') {
      if (req.body) {
        try { body = JSON.parse(req.body); }
        catch { return errorResponse(400, 'invalid_json', 'request body is not valid JSON'); }
      }
      if (body === null || typeof body !== 'object') {
        return errorResponse(400, 'invalid_body', 'request body must be a JSON object');
      }
    }

    const rawTarget = req.method === 'POST' ? body.target : url.searchParams.get('target');
    const t = resolveTarget(rawTarget);
    if (!t.ok) {
      return errorResponse(400, 'invalid_target', "target must be 'claude' or 'codex'");
    }
    const target = t.target;

    // ─── GET /state/profiles ───────────────────────────────────────────
    if (pathname === '/state/profiles') {
      const r = readJsonFile(path.join(dir, profilesFileName(target)), {});
      if (!r.ok) return errorResponse(500, 'state_unreadable', 'profiles file is unreadable');
      return json(200, r.data);
    }

    // ─── GET/POST /state/current ───────────────────────────────────────
    if (pathname === '/state/current') {
      const file = path.join(dir, currentFileName());
      if (req.method === 'GET') {
        const r = readJsonFile(file, { email: null });
        if (!r.ok) return errorResponse(500, 'state_unreadable', 'current file is unreadable');
        return json(200, { email: r.data?.email ?? null });
      }
      if (typeof body.email !== 'string' || !body.email) {
        return errorResponse(400, 'missing_email', 'email (non-empty string) required');
      }
      const email = body.email;
      withCcrotateLock(dir, () => writeJsonFileAtomic(file, { email }));
      broadcast('current.set', { email });
      return json(200, { email });
    }

    // ─── GET /state/tier-cache ─────────────────────────────────────────
    if (pathname === '/state/tier-cache') {
      const r = readJsonFile(path.join(dir, tierCacheFileName(target)), { updatedAt: null, accounts: [] });
      if (!r.ok) return errorResponse(500, 'state_unreadable', 'tier-cache file is unreadable');
      return json(200, r.data);
    }

    // ─── GET /state/rate-limits ────────────────────────────────────────
    if (pathname === '/state/rate-limits') {
      const r = readJsonFile(path.join(dir, 'rate-limit-state.json'), emptyRateLimitState());
      if (!r.ok) return errorResponse(500, 'state_unreadable', 'rate-limit-state file is unreadable');
      return json(200, r.data);
    }

    // ─── POST /state/rate-limits/anthropic ─────────────────────────────
    if (pathname === '/state/rate-limits/anthropic') {
      if (typeof body.email !== 'string' || !body.email) {
        return errorResponse(400, 'missing_email', 'email (non-empty string) required');
      }
      const file = path.join(dir, 'rate-limit-state.json');
      let updated;
      withCcrotateLock(dir, () => {
        const r = readJsonFile(file, emptyRateLimitState());
        const state = r.ok ? r.data : emptyRateLimitState();
        updated = applyAnthropicRateLimitHeaders(state, {
          email: body.email,
          model: body.model ?? null,
          status: Number(body.status),
          headers: body.headers && typeof body.headers === 'object' ? body.headers : {},
        });
        writeJsonFileAtomic(file, updated);
      });
      broadcast('rate-limit.updated', { email: body.email, target: 'claude', model: body.model ?? null });
      return json(200, updated);
    }

    // ─── POST /state/rate-limits/anthropic/clear ──────────────────────
    if (pathname === '/state/rate-limits/anthropic/clear') {
      if (typeof body.email !== 'string' || !body.email) {
        return errorResponse(400, 'missing_email', 'email (non-empty string) required');
      }
      let result;
      withCcrotateLock(dir, () => {
        result = clearAnthropicRateLimitStateFileLocked(dir, body.email, {
          model: body.model ?? null,
          modelGroup: body.modelGroup ?? null,
        });
      });
      if (result.cleared) {
        broadcast('rate-limit.cleared', {
          email: body.email,
          target: 'claude',
          model: body.model ?? null,
          modelGroup: body.modelGroup ?? null,
        });
      }
      return json(200, result);
    }

    // ─── POST /state/exhausted ─────────────────────────────────────────
    // Claude-only: codex accounts use fixed API keys and don't have the
    // stale-exhausted-label failure mode that tier-cache exhaustion tracks.
    if (pathname === '/state/exhausted') {
      if (target === 'codex') {
        return errorResponse(400, 'codex_exhaustion_unsupported',
          'exhaustion tracking is claude-only');
      }
      if (typeof body.email !== 'string' || !body.email) {
        return errorResponse(400, 'missing_email', 'email (non-empty string) required');
      }
      const result = markAccountExhausted(dir, body.email, {
        reset5h: body.reset5h ?? null,
        reset7d: body.reset7d ?? null,
        model: body.model ?? null,
        response: body.response ?? null,
      });
      if (!result.skipped) {
        broadcast('exhausted.set', { email: body.email, target, model: body.model ?? null });
      }
      return json(200, result);
    }

    // ─── POST /state/clear-exhausted ───────────────────────────────────
    if (pathname === '/state/clear-exhausted') {
      if (target === 'codex') {
        return errorResponse(400, 'codex_exhaustion_unsupported',
          'exhaustion tracking is claude-only');
      }
      if (typeof body.email !== 'string' || !body.email) {
        return errorResponse(400, 'missing_email', 'email (non-empty string) required');
      }
      const result = clearAccountExhausted(dir, body.email, { model: body.model ?? null });
      broadcast('exhausted.cleared', { email: body.email, target, model: body.model ?? null });
      return json(200, result);
    }

    // ─── POST /state/codex-exhausted ───────────────────────────────────
    // Mark a codex account exhausted in tier-cache.codex.json. The codex
    // exhausted shape differs from the claude one — codex usage limits
    // carry no machine-readable reset epoch — so this is a separate
    // endpoint rather than a target switch on /state/exhausted.
    if (pathname === '/state/codex-exhausted') {
      if (typeof body.email !== 'string' || !body.email) {
        return errorResponse(400, 'missing_email', 'email (non-empty string) required');
      }
      const file = path.join(dir, 'tier-cache.codex.json');
      withCcrotateLock(dir, () => {
        let cache = { updatedAt: null, accounts: [] };
        const r = readJsonFile(file, null);
        if (r.ok && r.data && Array.isArray(r.data.accounts)) cache = r.data;
        const existing = cache.accounts.find(a => a.email === body.email);
        cache.accounts = cache.accounts.filter(a => a.email !== body.email);
        cache.accounts.push({
          ...(existing || {}),
          email: body.email,
          status: 'success',
          serviceTier: 'exhausted',
          response: body.response || existing?.response || 'Codex usage limit reached',
          rateLimits: {
            ...(existing?.rateLimits || {}),
            // codex window %: utilization (used) 100 and remaining (left) 0
            // both mean "run out" — inverse framing of claude.
            utilization5h: 100,
            remaining5h: 0,
            snapshotCapturedAt: new Date().toISOString(),
          },
        });
        cache.updatedAt = new Date().toISOString();
        writeJsonFileAtomic(file, cache);
      });
      broadcast('exhausted.set', { email: body.email, target: 'codex' });
      return json(200, { email: body.email, serviceTier: 'exhausted' });
    }

    // ─── POST /state/profile-stale ─────────────────────────────────────
    // Flag a profile stale (triggers codex relogin via the auth-bot's
    // stale-poller for target=codex; marks an org-disabled Anthropic
    // seat for target=claude so the rotator skips it). target-aware:
    // profiles.codex.json for codex, profiles.json otherwise.
    //
    // Optional body fields (target=claude):
    //   reason    — short tag such as 'organization_disabled' for
    //               operator-visible badges + forensics
    //   response  — truncated upstream message string for context
    if (pathname === '/state/profile-stale') {
      if (typeof body.email !== 'string' || !body.email) {
        return errorResponse(400, 'missing_email', 'email (non-empty string) required');
      }
      const file = path.join(dir, profilesFileName(target));
      const result = withCcrotateLock(dir, () => {
        const r = readJsonFile(file, null);
        if (!r.ok || r.data === null) return { ok: false };
        const profiles = r.data;
        if (!profiles[body.email]) return { ok: true, updated: false, reason: 'no profile for email' };
        profiles[body.email].stale = true;
        profiles[body.email].staleAt = new Date().toISOString();
        if (typeof body.reason === 'string' && body.reason) {
          profiles[body.email].staleReason = body.reason;
        }
        if (typeof body.response === 'string' && body.response) {
          profiles[body.email].staleResponse = body.response.slice(0, 480);
        }
        writeJsonFileAtomic(file, profiles);
        return { ok: true, updated: true };
      });
      if (!result.ok) return errorResponse(500, 'state_unreadable', 'profiles file is unreadable');
      if (result.updated) broadcast('profile.stale', { email: body.email, target });
      return json(200, { updated: result.updated, ...(result.reason ? { reason: result.reason } : {}) });
    }

    // ─── POST /state/profile-stale/clear ────────────────────────────────
    // Clear a stale flag after a successful profile-targeted probe. This is
    // intentionally target-aware so codex serve pods can repair
    // profiles.codex.json while remaining PVC-less. Also clears the optional
    // staleReason / staleResponse fields written by /state/profile-stale.
    if (pathname === '/state/profile-stale/clear') {
      if (typeof body.email !== 'string' || !body.email) {
        return errorResponse(400, 'missing_email', 'email (non-empty string) required');
      }
      const file = path.join(dir, profilesFileName(target));
      const result = withCcrotateLock(dir, () => {
        const r = readJsonFile(file, null);
        if (!r.ok || r.data === null) return { ok: false };
        const profiles = r.data;
        if (!profiles[body.email]) return { ok: true, updated: false, reason: 'no profile for email' };
        const before = JSON.stringify({
          stale: profiles[body.email].stale ?? false,
          staleAt: profiles[body.email].staleAt ?? null,
          staleReason: profiles[body.email].staleReason ?? null,
          staleResponse: profiles[body.email].staleResponse ?? null,
          lastApiSyncAt: profiles[body.email].lastApiSyncAt ?? null,
        });
        profiles[body.email].stale = false;
        delete profiles[body.email].staleAt;
        delete profiles[body.email].staleReason;
        delete profiles[body.email].staleResponse;
        if (typeof body.lastApiSyncAt === 'string' && body.lastApiSyncAt) {
          profiles[body.email].lastApiSyncAt = body.lastApiSyncAt;
        }
        const after = JSON.stringify({
          stale: profiles[body.email].stale ?? false,
          staleAt: profiles[body.email].staleAt ?? null,
          staleReason: profiles[body.email].staleReason ?? null,
          staleResponse: profiles[body.email].staleResponse ?? null,
          lastApiSyncAt: profiles[body.email].lastApiSyncAt ?? null,
        });
        if (before === after) return { ok: true, updated: false };
        writeJsonFileAtomic(file, profiles);
        return { ok: true, updated: true };
      });
      if (!result.ok) return errorResponse(500, 'state_unreadable', 'profiles file is unreadable');
      if (result.updated) broadcast('profile.fresh', { email: body.email, target });
      return json(200, { updated: result.updated, ...(result.reason ? { reason: result.reason } : {}) });
    }

    // ─── POST /state/cross-wired ───────────────────────────────────────
    // Quarantine a cross-wired profile (paperclip incident 2026-05-20).
    // The freshness loop in anthropic-client.js detects when a profile's
    // accessToken belongs to a different Anthropic identity than the
    // profile key; this endpoint preserves the offending tokens in a
    // forensics file then nulls them in profiles.json + flags stale.
    // The next rotator call for that email skips directly to the next
    // candidate instead of burning 429-structural on the wrong identity.
    if (pathname === '/state/cross-wired') {
      if (typeof body.email !== 'string' || !body.email) {
        return errorResponse(400, 'missing_email', 'email (non-empty string) required');
      }
      if (typeof body.detectedIdentity !== 'string' || !body.detectedIdentity) {
        return errorResponse(400, 'missing_detected_identity', 'detectedIdentity (non-empty string) required');
      }
      const offendingAccessToken =
        typeof body.offendingAccessToken === 'string' && body.offendingAccessToken
          ? body.offendingAccessToken
          : null;
      // B8 EXTENSION 2026-05-20: optional freshly-minted offending OAuth
      // snapshot (the 401-refresh write-side path mints new tokens that
      // probe to a wrong identity; we want them in quarantine history
      // alongside the stale on-disk pair). Validated as an object with
      // string accessToken/refreshToken — anything else is dropped.
      const offendingOauthSnapshot = (() => {
        const s = body.offendingOauthSnapshot;
        if (!s || typeof s !== 'object') return null;
        return {
          accessToken: typeof s.accessToken === 'string' ? s.accessToken : null,
          refreshToken: typeof s.refreshToken === 'string' ? s.refreshToken : null,
          expiresAt: typeof s.expiresAt === 'number' ? s.expiresAt : null,
          source: typeof s.source === 'string' ? s.source : 'refresh-write-refused',
        };
      })();
      const file = path.join(dir, 'profiles.json');
      const bakFile = path.join(dir, 'cross-write-quarantine.json');
      const result = withCcrotateLock(dir, () => {
        const r = readJsonFile(file, null);
        if (!r.ok || r.data === null) return { ok: false };
        const profiles = r.data;
        const oauth = profiles[body.email]?.credentials?.claudeAiOauth;
        if (!oauth) return { ok: true, updated: false, reason: 'no oauth credentials for email' };
        // RACE FIX 2026-05-20: caller probed a possibly-stale cached
        // snapshot of profiles. If a relogin has landed since then, the
        // current token is fresh and the offending one is gone — skip
        // the quarantine so we don't clobber valid credentials. Legacy
        // callers that don't pass offendingAccessToken fall through to
        // the original behavior (always-null on detection).
        if (offendingAccessToken && oauth.accessToken !== offendingAccessToken) {
          return { ok: true, updated: false, reason: 'token rotated past offending one' };
        }
        const qRead = readJsonFile(bakFile, {});
        const quarantine = qRead.data && typeof qRead.data === 'object' ? qRead.data : {};
        if (!quarantine[body.email] || !Array.isArray(quarantine[body.email].history)) {
          quarantine[body.email] = { history: [] };
        }
        const entry = {
          at: new Date().toISOString(),
          detectedIdentity: body.detectedIdentity,
          oauthSnapshot: {
            accessToken: oauth.accessToken,
            refreshToken: oauth.refreshToken,
            expiresAt: oauth.expiresAt,
          },
        };
        if (offendingOauthSnapshot) {
          entry.offendingOauthSnapshot = offendingOauthSnapshot;
        }
        quarantine[body.email].history.push(entry);
        quarantine[body.email].history = quarantine[body.email].history.slice(-5);
        writeJsonFileAtomic(bakFile, quarantine);
        profiles[body.email].credentials.claudeAiOauth = {
          ...oauth,
          accessToken: null,
          refreshToken: null,
        };
        profiles[body.email].stale = true;
        profiles[body.email].crossWriteDetectedAt = new Date().toISOString();
        profiles[body.email].crossWriteIdentity = body.detectedIdentity;
        writeJsonFileAtomic(file, profiles);
        const rateLimitState = clearAnthropicRateLimitStateFileLocked(dir, body.email);
        return { ok: true, updated: true, rateLimitState };
      });
      if (!result.ok) return errorResponse(500, 'state_unreadable', 'profiles file is unreadable');
      if (result.updated) {
        broadcast('profile.cross-wired', { email: body.email, detectedIdentity: body.detectedIdentity });
        if (result.rateLimitState?.cleared) {
          broadcast('rate-limit.cleared', { email: body.email, target: 'claude', reason: 'cross-wired' });
        }
      }
      return json(200, { updated: result.updated, ...(result.reason ? { reason: result.reason } : {}) });
    }

    // ─── GET /state/cooldowns ──────────────────────────────────────────
    // Raw passthrough of usage-api-cooldowns.json — keyed by token hash,
    // not email (matches how fetchAccountUsage writes it). Claude-only.
    if (pathname === '/state/cooldowns') {
      const r = readJsonFile(path.join(dir, 'usage-api-cooldowns.json'), {});
      if (!r.ok) return errorResponse(500, 'state_unreadable', 'cooldowns file is unreadable');
      return json(200, r.data);
    }

    // ─── POST /state/cooldown ──────────────────────────────────────────
    if (pathname === '/state/cooldown') {
      if (typeof body.tokenKey !== 'string' || !body.tokenKey) {
        return errorResponse(400, 'missing_token_key', 'tokenKey (non-empty string) required');
      }
      if (typeof body.until !== 'number' || !Number.isFinite(body.until)) {
        return errorResponse(400, 'invalid_until', 'until (epoch ms number) required');
      }
      const file = path.join(dir, 'usage-api-cooldowns.json');
      let written;
      const lockResult = withCcrotateLock(dir, () => {
        const r = readJsonFile(file, {});
        if (!r.ok) return { ok: false };
        const cooldowns = r.data && typeof r.data === 'object' ? r.data : {};
        cooldowns[body.tokenKey] = body.until;
        writeJsonFileAtomic(file, cooldowns);
        return { ok: true };
      });
      if (!lockResult.ok) return errorResponse(500, 'state_unreadable', 'cooldowns file is unreadable');
      written = { tokenKey: body.tokenKey, until: body.until };
      broadcast('cooldown.set', { tokenKey: body.tokenKey, until: body.until });
      return json(200, written);
    }

    // ─── POST /state/profile-access-token ──────────────────────────────
    // Persist a refreshed OAuth token triple onto a profile. Claude-only —
    // codex profiles store auth under a different shape (auth.tokens).
    if (pathname === '/state/profile-access-token') {
      if (target === 'codex') {
        return errorResponse(400, 'codex_profile_token_unsupported',
          'profile-access-token is claude-only');
      }
      if (typeof body.email !== 'string' || !body.email) {
        return errorResponse(400, 'missing_email', 'email (non-empty string) required');
      }
      if (typeof body.accessToken !== 'string' || !body.accessToken) {
        return errorResponse(400, 'missing_access_token', 'accessToken (non-empty string) required');
      }
      const file = path.join(dir, profilesFileName('claude'));
      const result = withCcrotateLock(dir, () => {
        const r = readJsonFile(file, null);
        if (!r.ok || r.data === null) return { ok: false };
        const profiles = r.data;
        const oauth = profiles[body.email]?.credentials?.claudeAiOauth;
        if (!oauth) return { ok: true, updated: false, reason: 'no profile for email' };
        profiles[body.email].credentials.claudeAiOauth = {
          ...oauth,
          accessToken: body.accessToken,
          ...(body.refreshToken !== undefined ? { refreshToken: body.refreshToken } : {}),
          ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
        };
        writeJsonFileAtomic(file, profiles);
        const rateLimitState = clearAnthropicRateLimitStateFileLocked(dir, body.email);
        return { ok: true, updated: true, rateLimitState };
      });
      if (!result.ok) return errorResponse(500, 'state_unreadable', 'profiles file is unreadable');
      if (result.updated) {
        broadcast('profile.token-refreshed', { email: body.email });
        if (result.rateLimitState?.cleared) {
          broadcast('rate-limit.cleared', { email: body.email, target: 'claude', reason: 'token-refreshed' });
        }
      }
      return json(200, { updated: result.updated, ...(result.reason ? { reason: result.reason } : {}) });
    }

    // ─── POST /state/profile-codex-auth ─────────────────────────────────
    // Persist a token that `codex exec` rotated in CODEX_HOME/auth.json back
    // onto the codex profile (profiles.codex.json `auth` blob). Without this,
    // the serve pod discards the refreshed token on tempHome cleanup and the
    // account's stored refresh token goes dead → "logged out / signed in to
    // another account" hard-fail. Codex-only (claude uses profile-access-token).
    if (pathname === '/state/profile-codex-auth') {
      if (typeof body.email !== 'string' || !body.email) {
        return errorResponse(400, 'missing_email', 'email (non-empty string) required');
      }
      if (!body.auth || typeof body.auth !== 'object') {
        return errorResponse(400, 'missing_auth', 'auth (object) required');
      }
      const file = path.join(dir, profilesFileName('codex'));
      const result = withCcrotateLock(dir, () => {
        const r = readJsonFile(file, null);
        if (!r.ok || r.data === null) return { ok: false };
        const profiles = r.data;
        if (!profiles[body.email]) return { ok: true, updated: false, reason: 'no profile for email' };
        profiles[body.email].auth = body.auth;
        writeJsonFileAtomic(file, profiles);
        return { ok: true, updated: true };
      });
      if (!result.ok) return errorResponse(500, 'state_unreadable', 'profiles file is unreadable');
      if (result.updated) broadcast('profile.token-refreshed', { email: body.email, target: 'codex' });
      return json(200, { updated: result.updated, ...(result.reason ? { reason: result.reason } : {}) });
    }

    // ─── POST /state/import ────────────────────────────────────────────
    // Decode an `mp-gz-b64:` export blob and merge it into the state
    // files. Not target-scoped — applyImport splits the payload by
    // provider itself. A malformed blob / CRC mismatch is the caller's
    // fault → 400, not a 500.
    if (pathname === '/state/import') {
      if (typeof body.data !== 'string' || !body.data) {
        return errorResponse(400, 'missing_data', 'data (mp-gz-b64 export string) required');
      }
      let result;
      try {
        result = applyImport(dir, body.data);
      } catch (e) {
        return errorResponse(400, 'import_failed', String(e?.message ?? e).slice(0, 200));
      }
      broadcast('import.applied', { summary: result?.summary ?? null });
      return json(200, result);
    }

    return errorResponse(404, 'unknown_endpoint', `${pathname} not found`);
  }

  return { dispatch, events };
}
