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
//   writeProfileToken(email, { accessToken, refreshToken, expiresAt }) -> result
//   import(mpGzB64String)                      -> { added, updated, kept, tierMerged }

import fs from 'node:fs';
import path from 'node:path';
import { withCcrotateLock, markAccountExhausted, clearAccountExhausted, applyImport } from '../state-helpers.js';

const DEFAULT_READ_CACHE_TTL_MS = 1000;
const DEFAULT_HTTP_TIMEOUT_MS = 5000;

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

  async setActiveEmail(email) {
    withCcrotateLock(this.profilesDir, () => {
      fs.writeFileSync(path.join(this.profilesDir, 'current.json'), JSON.stringify({ email }));
    });
  }

  async markExhausted(email, opts = {}) {
    return markAccountExhausted(this.profilesDir, email, opts);
  }

  async clearExhausted(email, opts = {}) {
    return clearAccountExhausted(this.profilesDir, email, opts);
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
      cache.accounts.push({
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
      });
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

  async markCodexExhausted(email, response = null) {
    return this._request('/state/codex-exhausted', {
      method: 'POST',
      body: JSON.stringify({ email, response: response ?? null }),
    });
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
