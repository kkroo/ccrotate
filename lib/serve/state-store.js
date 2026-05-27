// StateStore — the rotation-state access layer for the serve module.
//
// Two implementations behind one async interface:
//
//   FileStateStore  — reads/writes the ccrotate state files directly under a
//                     profilesDir, the same file+flock behavior the serve
//                     module has always used. Selected when CCROTATE_STATE_URL
//                     is unset (local dev, the file-mode cluster deploy).
//
//   HttpStateStore  — calls the `ccrotate state-server` HTTP API. Selected
//                     when CCROTATE_STATE_URL is set. This is what lets
//                     ccrotate-serve drop its shared cephfs PVC mount
//                     (onprem-k8s#227 phase 1d): state lives with the
//                     auth-bot, serve reaches it over HTTP.
//
// Interface (all async):
//   getProfiles()                              -> profiles object
//   getActiveEmail()                           -> string | null
//   getTierCache()                             -> { accounts: [...] }
//   getCodexTierCache()                        -> { accounts: [...] }
//   setActiveEmail(email)                      -> void
//   markExhausted(email, { reset5h, reset7d, model, response }) -> result
//   clearExhausted(email, { model })           -> result
//   markCodexStale(email)                      -> result
//   clearCodexStale(email, { lastApiSyncAt })  -> result
//   clearAnthropicRateLimitState(email, { model }) -> result
//   writeProfileToken(email, { accessToken, refreshToken, expiresAt }) -> result
//   import(mpGzB64String)                      -> { added, updated, kept, tierMerged }

import fs from 'node:fs';
import path from 'node:path';
import { withCcrotateLock, markAccountExhausted, clearAccountExhausted, applyImport } from '../state-helpers.js';
import { atomicWriteFileSync as writeAtomic } from '../ccrotate.js';
import {
  applyAnthropicRateLimitHeaders,
  clearAnthropicRateLimitState,
  emptyRateLimitState,
  getAnthropicRateLimitBlock,
} from './rate-limit-state.js';

const DEFAULT_READ_CACHE_TTL_MS = 1000;
const DEFAULT_HTTP_TIMEOUT_MS = 5000;

function readRateLimitStateFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return emptyRateLimitState();
  }
}

function clearAnthropicRateLimitStateFileLocked(profilesDir, email, opts = {}) {
  const file = path.join(profilesDir, 'rate-limit-state.json');
  const state = readRateLimitStateFile(file);
  const before = JSON.stringify(state?.anthropic?.accounts?.[email] ?? null);
  const updated = clearAnthropicRateLimitState(state, {
    email,
    model: opts.model ?? null,
    modelGroup: opts.modelGroup ?? null,
  });
  const after = JSON.stringify(updated?.anthropic?.accounts?.[email] ?? null);
  const cleared = before !== after;
  if (cleared) {
    writeAtomic(file, JSON.stringify(updated, null, 2));
  }
  return {
    email,
    cleared,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.modelGroup !== undefined ? { modelGroup: opts.modelGroup } : {}),
  };
}

export class FileStateStore {
  constructor(profilesDir) {
    if (!profilesDir) throw new Error('FileStateStore: profilesDir required');
    this.profilesDir = profilesDir;
  }

  async getProfiles() {
    return JSON.parse(fs.readFileSync(path.join(this.profilesDir, 'profiles.json'), 'utf8'));
  }

  async getActiveEmail() {
    try {
      const cur = JSON.parse(fs.readFileSync(path.join(this.profilesDir, 'current.json'), 'utf8'));
      return cur?.email ?? null;
    } catch {
      return null;
    }
  }

  async getTierCache() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.profilesDir, 'tier-cache.json'), 'utf8'));
    } catch {
      return { accounts: [] };
    }
  }

  async getRateLimitState() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.profilesDir, 'rate-limit-state.json'), 'utf8'));
    } catch {
      return emptyRateLimitState();
    }
  }

  async getAnthropicRateLimitBlock(email, model) {
    return getAnthropicRateLimitBlock(await this.getRateLimitState(), email, model);
  }

  async recordAnthropicRateLimit(email, model, response) {
    let updated;
    withCcrotateLock(this.profilesDir, () => {
      const file = path.join(this.profilesDir, 'rate-limit-state.json');
      let state = emptyRateLimitState();
      try {
        state = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        // fresh state
      }
      updated = applyAnthropicRateLimitHeaders(state, {
        email,
        model,
        status: response.status,
        headers: response.headers,
      });
      writeAtomic(file, JSON.stringify(updated, null, 2));
    });
    return updated;
  }

  async clearAnthropicRateLimitState(email, opts = {}) {
    let result;
    withCcrotateLock(this.profilesDir, () => {
      result = clearAnthropicRateLimitStateFileLocked(this.profilesDir, email, opts);
    });
    return result;
  }

  async setActiveEmail(email) {
    withCcrotateLock(this.profilesDir, () => {
      // Atomic write — see atomicWriteFileSync in lib/ccrotate.js. The
      // previous direct writeFileSync left a 0-byte window during which
      // /state/current readers got JSON.parse failures. Same pattern as
      // every other writer under profilesDir.
      const file = path.join(this.profilesDir, 'current.json');
      const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
      try {
        const fd = fs.openSync(tmp, 'w');
        try {
          fs.writeSync(fd, JSON.stringify({ email }), 0, 'utf8');
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(tmp, file);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch {}
        throw e;
      }
    });
  }

  async markExhausted(email, opts = {}) {
    return markAccountExhausted(this.profilesDir, email, opts);
  }

  async clearExhausted(email, opts = {}) {
    return clearAccountExhausted(this.profilesDir, email, opts);
  }

  // Cross-write quarantine (paperclip incident 2026-05-20). When the
  // freshness loop's identity probe finds that profile `email`'s
  // accessToken actually belongs to a different Anthropic identity,
  // the offending tokens are quarantined to a forensics file and
  // nulled in profiles.json + the profile is marked stale. This
  // prevents the rotator from burning 429-structural retries on
  // wrong-identity tokens while the auth-bot's relogin path resolves
  // the conflict in the background.
  //
  // Effect on the rotator's hot path:
  //   - oauth.accessToken becomes null
  //   - anthropic-client.js's `if (!oauth?.accessToken)` branch routes
  //     directly to 'refresh-fail' → pickNextCandidate, skipping the
  //     wrong-identity 429s entirely
  //   - stale-poller picks the profile up on its next tick and
  //     re-runs reloginViaSession (or magic-link auto-fallback)
  //
  // The original tokens are preserved in `cross-write-quarantine.json`
  // under `<email>.history[]` (capped at 5 entries per email) so an
  // operator can forensically reconstruct what happened.
  //
  // B8 EXTENSION 2026-05-20: optional `offendingOauthSnapshot` captures
  // an extra OAuth pair (e.g. tokens just minted by the 401-refresh path
  // that probed to a wrong identity). The pre-existing on-disk tokens
  // are still snapshotted as the primary history entry; the offending
  // snapshot is recorded alongside under `offendingOauthSnapshot` so a
  // forensic reader can tell apart "what was on disk" vs "what we just
  // got back from refresh and refused to write". Without this, only the
  // stale on-disk pair gets preserved — the cross-wired refresh token
  // that perpetuated the bug would disappear silently.
  async markCrossWritten(email, detectedIdentity, offendingAccessToken = null, offendingOauthSnapshot = null) {
    let result = { updated: false };
    withCcrotateLock(this.profilesDir, () => {
      const file = path.join(this.profilesDir, 'profiles.json');
      let profiles;
      try {
        profiles = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return;
      }
      const oauth = profiles[email]?.credentials?.claudeAiOauth;
      if (!oauth) return;

      // RACE FIX 2026-05-20: only quarantine if the CURRENT token still
      // matches the one whose identity was probed. The caller probed a
      // possibly-stale cached snapshot; if a relogin landed in the
      // meantime, the current token is fresh and quarantining it would
      // clobber valid credentials. When the offending token is unknown
      // (legacy callers), fall through to the original behavior.
      if (offendingAccessToken && oauth.accessToken !== offendingAccessToken) {
        result = { updated: false, reason: 'token rotated past offending one' };
        return;
      }

      // 1. Quarantine the offending tokens for forensics. Capped per-email
      //    history, never grows unbounded.
      const bakFile = path.join(this.profilesDir, 'cross-write-quarantine.json');
      let quarantine = {};
      try { quarantine = JSON.parse(fs.readFileSync(bakFile, 'utf8')); } catch {}
      if (!quarantine[email] || !Array.isArray(quarantine[email].history)) {
        quarantine[email] = { history: [] };
      }
      const entry = {
        at: new Date().toISOString(),
        detectedIdentity,
        oauthSnapshot: {
          accessToken: oauth.accessToken,
          refreshToken: oauth.refreshToken,
          expiresAt: oauth.expiresAt,
        },
      };
      if (offendingOauthSnapshot && typeof offendingOauthSnapshot === 'object') {
        entry.offendingOauthSnapshot = {
          accessToken: offendingOauthSnapshot.accessToken ?? null,
          refreshToken: offendingOauthSnapshot.refreshToken ?? null,
          expiresAt: offendingOauthSnapshot.expiresAt ?? null,
          source: offendingOauthSnapshot.source ?? 'refresh-write-refused',
        };
      }
      quarantine[email].history.push(entry);
      quarantine[email].history = quarantine[email].history.slice(-5);
      writeAtomic(bakFile, JSON.stringify(quarantine, null, 2));

      // 2. Null the tokens + mark stale + record detection metadata.
      profiles[email].credentials.claudeAiOauth = {
        ...oauth,
        accessToken: null,
        refreshToken: null,
      };
      profiles[email].stale = true;
      profiles[email].crossWriteDetectedAt = new Date().toISOString();
      profiles[email].crossWriteIdentity = detectedIdentity;
      writeAtomic(file, JSON.stringify(profiles, null, 2));
      const rateLimitState = clearAnthropicRateLimitStateFileLocked(this.profilesDir, email);
      result = { updated: true, rateLimitState };
    });
    return result;
  }

  async writeProfileToken(email, oauth) {
    let updated = false;
    withCcrotateLock(this.profilesDir, () => {
      const file = path.join(this.profilesDir, 'profiles.json');
      const profiles = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (profiles[email]?.credentials?.claudeAiOauth) {
        profiles[email].credentials.claudeAiOauth = {
          ...profiles[email].credentials.claudeAiOauth,
          accessToken: oauth.accessToken,
          refreshToken: oauth.refreshToken,
          expiresAt: oauth.expiresAt,
        };
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(profiles, null, 2));
        fs.renameSync(tmp, file);
        clearAnthropicRateLimitStateFileLocked(this.profilesDir, email);
        updated = true;
      }
    });
    return { updated };
  }

  // ── codex pool (openai-client.js) ─────────────────────────────────────

  async getCodexProfiles() {
    return JSON.parse(fs.readFileSync(path.join(this.profilesDir, 'profiles.codex.json'), 'utf8'));
  }

  async getCodexTierCache() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.profilesDir, 'tier-cache.codex.json'), 'utf8'));
    } catch {
      return { updatedAt: null, accounts: [] };
    }
  }

  async import(data) {
    return applyImport(this.profilesDir, data);
  }

  async markCodexStale(email) {
    let updated = false;
    withCcrotateLock(this.profilesDir, () => {
      const file = path.join(this.profilesDir, 'profiles.codex.json');
      const profiles = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (profiles[email]) {
        profiles[email].stale = true;
        profiles[email].staleAt = new Date().toISOString();
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(profiles, null, 2));
        fs.renameSync(tmp, file);
        updated = true;
      }
    });
    return { updated };
  }

  async clearCodexStale(email, opts = {}) {
    let updated = false;
    withCcrotateLock(this.profilesDir, () => {
      const file = path.join(this.profilesDir, 'profiles.codex.json');
      const profiles = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (profiles[email]) {
        const before = JSON.stringify({
          stale: profiles[email].stale ?? false,
          staleAt: profiles[email].staleAt ?? null,
          lastApiSyncAt: profiles[email].lastApiSyncAt ?? null,
        });
        profiles[email].stale = false;
        delete profiles[email].staleAt;
        if (typeof opts.lastApiSyncAt === 'string' && opts.lastApiSyncAt) {
          profiles[email].lastApiSyncAt = opts.lastApiSyncAt;
        }
        const after = JSON.stringify({
          stale: profiles[email].stale ?? false,
          staleAt: profiles[email].staleAt ?? null,
          lastApiSyncAt: profiles[email].lastApiSyncAt ?? null,
        });
        if (before !== after) {
          const tmp = file + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(profiles, null, 2));
          fs.renameSync(tmp, file);
          updated = true;
        }
      }
    });
    return { updated };
  }

  async markCodexExhausted(email, response = null) {
    withCcrotateLock(this.profilesDir, () => {
      const file = path.join(this.profilesDir, 'tier-cache.codex.json');
      let cache = { updatedAt: null, accounts: [] };
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && Array.isArray(parsed.accounts)) cache = parsed;
      } catch { /* fresh cache */ }
      const existing = cache.accounts.find(a => a.email === email);
      cache.accounts = cache.accounts.filter(a => a.email !== email);
      // Tag workspace-credit exhaustion distinctly. It's invisible to the
      // headers/usage probe (which never sees the credit balance), so the
      // tier-cache merge keeps `out_of_credits` sticky until a real
      // credit-verified turn clears it (CCRotate.mergeTierCacheEntry). A plain
      // rate-limit exhaustion stays untagged so its normal headers-driven
      // recovery is unaffected.
      const msg = String(response || existing?.response || '').toLowerCase();
      const outOfCredits = msg.includes('out of credits')
        || msg.includes('workspace is out of credits')
        || msg.includes('add credits to continue');
      const entry = {
        ...(existing || {}),
        email,
        status: 'success',
        serviceTier: 'exhausted',
        response: response || existing?.response || 'Codex usage limit reached',
        rateLimits: {
          ...(existing?.rateLimits || {}),
          // codex window %: utilization (used) 100 and remaining (left) 0
          // both mean "run out" — note this is the inverse framing of
          // claude, where the high number is the bad one.
          utilization5h: 100,
          remaining5h: 0,
          snapshotCapturedAt: new Date().toISOString(),
        },
      };
      if (outOfCredits) entry.exhaustedReason = 'out_of_credits';
      else delete entry.exhaustedReason;
      cache.accounts.push(entry);
      cache.updatedAt = new Date().toISOString();
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    });
    return { email, serviceTier: 'exhausted' };
  }
}

export class HttpStateStore {
  constructor({ baseUrl, token = null, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS, cacheTtlMs = DEFAULT_READ_CACHE_TTL_MS } = {}) {
    if (!baseUrl) throw new Error('HttpStateStore: baseUrl required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    // key -> { at, value }. Reads are cached for cacheTtlMs to keep the
    // hot rotation path from hammering the state-server; writes invalidate
    // the affected key. Cross-replica staleness is bounded by cacheTtlMs.
    this._cache = new Map();
  }

  _headers() {
    return {
      'content-type': 'application/json',
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
    };
  }

  async _request(pathSuffix, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl + pathSuffix, {
        ...init,
        headers: { ...this._headers(), ...(init.headers || {}) },
        signal: controller.signal,
      });
      const text = await res.text();
      let body = null;
      if (text) {
        try { body = JSON.parse(text); } catch { body = null; }
      }
      if (!res.ok) {
        const msg = body?.error?.message || `state-server returned ${res.status}`;
        const err = new Error(`HttpStateStore: ${msg}`);
        err.status = res.status;
        throw err;
      }
      return body ?? {};
    } finally {
      clearTimeout(timer);
    }
  }

  async _cachedGet(key, pathSuffix) {
    const hit = this._cache.get(key);
    if (hit && Date.now() - hit.at < this.cacheTtlMs) return hit.value;
    const value = await this._request(pathSuffix, { method: 'GET' });
    this._cache.set(key, { at: Date.now(), value });
    return value;
  }

  _invalidate(key) {
    this._cache.delete(key);
  }

  async getProfiles() {
    return this._cachedGet('profiles', '/state/profiles');
  }

  async getActiveEmail() {
    const r = await this._cachedGet('current', '/state/current');
    return r?.email ?? null;
  }

  async getTierCache() {
    return this._cachedGet('tier-cache', '/state/tier-cache');
  }

  async getRateLimitState() {
    return this._cachedGet('rate-limit-state', '/state/rate-limits');
  }

  async getAnthropicRateLimitBlock(email, model) {
    return getAnthropicRateLimitBlock(await this.getRateLimitState(), email, model);
  }

  async recordAnthropicRateLimit(email, model, response) {
    const r = await this._request('/state/rate-limits/anthropic', {
      method: 'POST',
      body: JSON.stringify({
        email,
        model,
        status: response.status,
        headers: Object.fromEntries(response.headers?.entries?.() ?? []),
      }),
    });
    this._invalidate('rate-limit-state');
    return r;
  }

  async clearAnthropicRateLimitState(email, opts = {}) {
    const r = await this._request('/state/rate-limits/anthropic/clear', {
      method: 'POST',
      body: JSON.stringify({
        email,
        model: opts.model ?? null,
        modelGroup: opts.modelGroup ?? null,
      }),
    });
    this._invalidate('rate-limit-state');
    return r;
  }

  async setActiveEmail(email) {
    await this._request('/state/current', { method: 'POST', body: JSON.stringify({ email }) });
    this._invalidate('current');
  }

  async markExhausted(email, opts = {}) {
    const r = await this._request('/state/exhausted', {
      method: 'POST',
      body: JSON.stringify({
        email,
        reset5h: opts.reset5h ?? null,
        reset7d: opts.reset7d ?? null,
        model: opts.model ?? null,
        response: opts.response ?? null,
      }),
    });
    this._invalidate('tier-cache');
    return r;
  }

  async clearExhausted(email, opts = {}) {
    const r = await this._request('/state/clear-exhausted', {
      method: 'POST',
      body: JSON.stringify({ email, model: opts.model ?? null }),
    });
    this._invalidate('tier-cache');
    return r;
  }

  async writeProfileToken(email, oauth) {
    const r = await this._request('/state/profile-access-token', {
      method: 'POST',
      body: JSON.stringify({
        email,
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt: oauth.expiresAt,
      }),
    });
    this._invalidate('profiles');
    this._invalidate('rate-limit-state');
    return r;
  }

  // ── codex pool (openai-client.js) ─────────────────────────────────────

  async getCodexProfiles() {
    return this._cachedGet('profiles.codex', '/state/profiles?target=codex');
  }

  async getCodexTierCache() {
    return this._cachedGet('tier-cache.codex', '/state/tier-cache?target=codex');
  }

  async import(data) {
    const r = await this._request('/state/import', {
      method: 'POST',
      body: JSON.stringify({ data }),
    });
    // An import can touch every state file — drop all cached reads.
    for (const key of ['profiles', 'profiles.codex', 'tier-cache', 'tier-cache.codex', 'current']) {
      this._invalidate(key);
    }
    return r;
  }

  async markCodexStale(email) {
    const r = await this._request('/state/profile-stale', {
      method: 'POST',
      body: JSON.stringify({ email, target: 'codex' }),
    });
    this._invalidate('profiles.codex');
    return r;
  }

  async clearCodexStale(email, opts = {}) {
    const r = await this._request('/state/profile-stale/clear', {
      method: 'POST',
      body: JSON.stringify({
        email,
        target: 'codex',
        lastApiSyncAt: opts.lastApiSyncAt ?? null,
      }),
    });
    this._invalidate('profiles.codex');
    return r;
  }

  async markCodexExhausted(email, response = null) {
    return this._request('/state/codex-exhausted', {
      method: 'POST',
      body: JSON.stringify({ email, response: response ?? null }),
    });
  }

  // Symmetric to FileStateStore.markCrossWritten — routes through the
  // state-server's /state/cross-wired endpoint when running in HTTP mode.
  // The optional `offendingAccessToken` arg lets the state-server skip
  // the null+quarantine if the profile's current token has already
  // rotated past the offending one (relogin race fix, see comments in
  // FileStateStore.markCrossWritten).
  //
  // B8 EXTENSION 2026-05-20: optional `offendingOauthSnapshot` carries a
  // freshly-minted OAuth pair (refresh→access tokens that probed to a
  // wrong identity) so the state-server records BOTH the stale on-disk
  // pair and the new offending pair in quarantine history.
  async markCrossWritten(email, detectedIdentity, offendingAccessToken = null, offendingOauthSnapshot = null) {
    const r = await this._request('/state/cross-wired', {
      method: 'POST',
      body: JSON.stringify({ email, detectedIdentity, offendingAccessToken, offendingOauthSnapshot }),
    });
    this._invalidate('profiles');
    this._invalidate('rate-limit-state');
    return r;
  }
}

// Factory: HTTP mode when CCROTATE_STATE_URL is set, file mode otherwise.
export function createStateStore({ profilesDir } = {}) {
  const url = process.env.CCROTATE_STATE_URL;
  if (url) {
    return new HttpStateStore({ baseUrl: url, token: process.env.CCROTATE_STATE_TOKEN || null });
  }
  return new FileStateStore(profilesDir);
}
