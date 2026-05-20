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
import { withCcrotateLock, markAccountExhausted, clearAccountExhausted, applyImport } from '../state-helpers.js';

const VALID_TARGETS = new Set(['claude', 'codex']);

// Path → allowed methods. Lets dispatch distinguish 404 (unknown path) from
// 405 (known path, wrong method).
const ROUTES = {
  '/state/profiles': ['GET'],
  '/state/current': ['GET', 'POST'],
  '/state/tier-cache': ['GET'],
  '/state/exhausted': ['POST'],
  '/state/clear-exhausted': ['POST'],
  '/state/codex-exhausted': ['POST'],
  '/state/profile-stale': ['POST'],
  '/state/cross-wired': ['POST'],
  '/state/cooldowns': ['GET'],
  '/state/cooldown': ['POST'],
  '/state/profile-access-token': ['POST'],
  '/state/import': ['POST'],
};

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

export function createStateRouter({ dir, token = null }) {
  if (!dir) throw new Error('state-server: dir required');

  // Resolve `target` from the GET query string or the POST body, defaulting
  // to claude. Returns { ok:false } on an unrecognized value so the caller
  // can 400 instead of silently reading the wrong pool's files.
  function resolveTarget(raw) {
    if (raw === undefined || raw === null || raw === '') return { ok: true, target: 'claude' };
    if (!VALID_TARGETS.has(raw)) return { ok: false };
    return { ok: true, target: raw };
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
      return json(200, { email });
    }

    // ─── GET /state/tier-cache ─────────────────────────────────────────
    if (pathname === '/state/tier-cache') {
      const r = readJsonFile(path.join(dir, tierCacheFileName(target)), { updatedAt: null, accounts: [] });
      if (!r.ok) return errorResponse(500, 'state_unreadable', 'tier-cache file is unreadable');
      return json(200, r.data);
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
      return json(200, { email: body.email, serviceTier: 'exhausted' });
    }

    // ─── POST /state/profile-stale ─────────────────────────────────────
    // Flag a profile stale (triggers codex relogin via the auth-bot's
    // stale-poller). target-aware: profiles.codex.json for codex.
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
        writeJsonFileAtomic(file, profiles);
        return { ok: true, updated: true };
      });
      if (!result.ok) return errorResponse(500, 'state_unreadable', 'profiles file is unreadable');
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
      const file = path.join(dir, 'profiles.json');
      const bakFile = path.join(dir, 'cross-write-quarantine.json');
      const result = withCcrotateLock(dir, () => {
        const r = readJsonFile(file, null);
        if (!r.ok || r.data === null) return { ok: false };
        const profiles = r.data;
        const oauth = profiles[body.email]?.credentials?.claudeAiOauth;
        if (!oauth) return { ok: true, updated: false, reason: 'no oauth credentials for email' };
        const qRead = readJsonFile(bakFile, {});
        const quarantine = qRead.data && typeof qRead.data === 'object' ? qRead.data : {};
        if (!quarantine[body.email] || !Array.isArray(quarantine[body.email].history)) {
          quarantine[body.email] = { history: [] };
        }
        quarantine[body.email].history.push({
          at: new Date().toISOString(),
          detectedIdentity: body.detectedIdentity,
          oauthSnapshot: {
            accessToken: oauth.accessToken,
            refreshToken: oauth.refreshToken,
            expiresAt: oauth.expiresAt,
          },
        });
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
        return { ok: true, updated: true };
      });
      if (!result.ok) return errorResponse(500, 'state_unreadable', 'profiles file is unreadable');
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
        return { ok: true, updated: true };
      });
      if (!result.ok) return errorResponse(500, 'state_unreadable', 'profiles file is unreadable');
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
      return json(200, result);
    }

    return errorResponse(404, 'unknown_endpoint', `${pathname} not found`);
  }

  return { dispatch };
}
