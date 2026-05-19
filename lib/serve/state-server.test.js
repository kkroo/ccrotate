import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import msgpack from 'msgpack-lite';
import { gzipSync } from 'zlib';
import { createStateRouter } from './state-server.js';
import { optimizeProfile, computeCrc } from '../commands/export.js';

function encodeImportPayload(profiles, tierCache = null) {
  const optimized = {};
  for (const [email, profile] of Object.entries(profiles)) {
    optimized[email] = optimizeProfile(email, profile);
  }
  if (tierCache) optimized.__tier_cache__ = tierCache;
  const crc = computeCrc(optimized);
  return `mp-gz-b64:${crc}:${gzipSync(msgpack.encode(optimized)).toString('base64')}`;
}

function importableClaudeProfile(email) {
  return {
    provider: 'claude',
    credentials: {
      claudeAiOauth: {
        accessToken: 'tok', refreshToken: 'r', expiresAt: 1770000000000,
        scopes: ['chat'], subscriptionType: 'pro',
      },
    },
    oauthAccount: {
      accountUuid: 'u', emailAddress: email, organizationUuid: 'o',
      organizationRole: 'member', workspaceRole: 'member', organizationName: 'Org',
    },
    lastApiSyncAt: '2026-05-01T00:00:00.000Z',
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccrotate-state-'));
}

function makeReq({ method = 'GET', url = '/state/profiles', headers = {}, body = '' } = {}) {
  return { method, url, headers, body };
}

function post(url, obj) {
  return makeReq({ method: 'POST', url, body: JSON.stringify(obj) });
}

const SAMPLE_PROFILES = {
  'a@x.net': { credentials: { claudeAiOauth: { accessToken: 'tok-a', refreshToken: 'rt-a', expiresAt: 111 } } },
  'b@x.net': { credentials: { claudeAiOauth: { accessToken: 'tok-b', refreshToken: 'rt-b', expiresAt: 222 } } },
};

describe('state-server — createStateRouter', () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  function writeFile(name, obj) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(obj));
  }
  function readFile(name) {
    return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  }

  describe('healthz + auth', () => {
    it('returns 200 on /healthz with no auth', async () => {
      const router = createStateRouter({ dir });
      const r = await router.dispatch(makeReq({ method: 'GET', url: '/healthz' }));
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body).status).toBe('ok');
    });

    it('allows /state/* with no bearer when no token configured', async () => {
      const router = createStateRouter({ dir });
      const r = await router.dispatch(makeReq({ url: '/state/profiles' }));
      expect(r.status).toBe(200);
    });

    it('rejects /state/* without bearer when a token is configured', async () => {
      const router = createStateRouter({ dir, token: 'sekret' });
      const r = await router.dispatch(makeReq({ url: '/state/profiles' }));
      expect(r.status).toBe(401);
    });

    it('rejects /state/* with wrong bearer when a token is configured', async () => {
      const router = createStateRouter({ dir, token: 'sekret' });
      const r = await router.dispatch(makeReq({
        url: '/state/profiles', headers: { authorization: 'Bearer nope' },
      }));
      expect(r.status).toBe(401);
    });

    it('accepts /state/* with correct bearer when a token is configured', async () => {
      const router = createStateRouter({ dir, token: 'sekret' });
      const r = await router.dispatch(makeReq({
        url: '/state/profiles', headers: { authorization: 'Bearer sekret' },
      }));
      expect(r.status).toBe(200);
    });

    it('leaves /healthz open even when a token is configured', async () => {
      const router = createStateRouter({ dir, token: 'sekret' });
      const r = await router.dispatch(makeReq({ method: 'GET', url: '/healthz' }));
      expect(r.status).toBe(200);
    });
  });

  describe('GET /state/profiles', () => {
    it('returns the profiles.json contents', async () => {
      writeFile('profiles.json', SAMPLE_PROFILES);
      const router = createStateRouter({ dir });
      const r = await router.dispatch(makeReq({ url: '/state/profiles' }));
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual(SAMPLE_PROFILES);
    });

    it('returns {} when profiles.json is missing', async () => {
      const router = createStateRouter({ dir });
      const r = await router.dispatch(makeReq({ url: '/state/profiles' }));
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual({});
    });

    it('reads profiles.codex.json for target=codex', async () => {
      writeFile('profiles.codex.json', { 'c@x.net': { auth: {} } });
      const router = createStateRouter({ dir });
      const r = await router.dispatch(makeReq({ url: '/state/profiles?target=codex' }));
      expect(JSON.parse(r.body)).toEqual({ 'c@x.net': { auth: {} } });
    });

    it('fails closed with 500 when profiles.json is corrupt', async () => {
      fs.writeFileSync(path.join(dir, 'profiles.json'), '{not json');
      const router = createStateRouter({ dir });
      const r = await router.dispatch(makeReq({ url: '/state/profiles' }));
      expect(r.status).toBe(500);
    });

    it('rejects an invalid target with 400', async () => {
      const router = createStateRouter({ dir });
      const r = await router.dispatch(makeReq({ url: '/state/profiles?target=bogus' }));
      expect(r.status).toBe(400);
    });
  });

  describe('GET/POST /state/current', () => {
    it('returns {email:null} when current.json is missing', async () => {
      const router = createStateRouter({ dir });
      const r = await router.dispatch(makeReq({ url: '/state/current' }));
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ email: null });
    });

    it('round-trips a POST then GET', async () => {
      const router = createStateRouter({ dir });
      const w = await router.dispatch(post('/state/current', { email: 'a@x.net' }));
      expect(w.status).toBe(200);
      expect(JSON.parse(w.body)).toEqual({ email: 'a@x.net' });
      const r = await router.dispatch(makeReq({ url: '/state/current' }));
      expect(JSON.parse(r.body)).toEqual({ email: 'a@x.net' });
      expect(readFile('current.json')).toEqual({ email: 'a@x.net' });
    });

    it('writes the single (non-target-scoped) current.json even for target=codex', async () => {
      const router = createStateRouter({ dir });
      await router.dispatch(post('/state/current', { email: 'c@x.net', target: 'codex' }));
      // current.json is shared by the claude and codex serve paths.
      expect(readFile('current.json')).toEqual({ email: 'c@x.net' });
    });

    it('rejects POST /state/current without email', async () => {
      const router = createStateRouter({ dir });
      const r = await router.dispatch(post('/state/current', {}));
      expect(r.status).toBe(400);
    });

    it('rejects POST with invalid JSON body', async () => {
      const router = createStateRouter({ dir });
      const r = await router.dispatch(makeReq({ method: 'POST', url: '/state/current', body: '{bad' }));
      expect(r.status).toBe(400);
    });
  });

  describe('GET /state/tier-cache', () => {
    it('returns an empty cache shape when the file is missing', async () => {
      const router = createStateRouter({ dir });
      const r = await router.dispatch(makeReq({ url: '/state/tier-cache' }));
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ updatedAt: null, accounts: [] });
    });

    it('returns the tier-cache.json contents', async () => {
      const cache = { updatedAt: 'now', accounts: [{ email: 'a@x.net', serviceTier: 'base' }] };
      writeFile('tier-cache.json', cache);
      const router = createStateRouter({ dir });
      const r = await router.dispatch(makeReq({ url: '/state/tier-cache' }));
      expect(JSON.parse(r.body)).toEqual(cache);
    });
  });

  describe('POST /state/exhausted + /state/clear-exhausted', () => {
    it('marks an account exhausted and tier-cache reflects it', async () => {
      const router = createStateRouter({ dir });
      const reset5h = Math.floor(Date.now() / 1000) + 3600;
      const w = await router.dispatch(post('/state/exhausted', {
        email: 'a@x.net', reset5h, model: 'claude-opus-4-7',
      }));
      expect(w.status).toBe(200);
      expect(JSON.parse(w.body).skipped).toBe(false);
      const cache = readFile('tier-cache.json');
      const entry = cache.accounts.find(a => a.email === 'a@x.net');
      expect(entry.serviceTier).toBe('exhausted');
      expect(entry.rateLimits.reset5h).toBe(reset5h);
    });

    it('clears a previously-exhausted account', async () => {
      const router = createStateRouter({ dir });
      const reset5h = Math.floor(Date.now() / 1000) + 3600;
      await router.dispatch(post('/state/exhausted', { email: 'a@x.net', reset5h }));
      const w = await router.dispatch(post('/state/clear-exhausted', { email: 'a@x.net' }));
      expect(w.status).toBe(200);
      expect(JSON.parse(w.body).changed).toBe(true);
      const entry = readFile('tier-cache.json').accounts.find(a => a.email === 'a@x.net');
      expect(entry.serviceTier).toBe(null);
    });

    it('rejects POST /state/exhausted without email', async () => {
      const router = createStateRouter({ dir });
      const r = await router.dispatch(post('/state/exhausted', { reset5h: 123 }));
      expect(r.status).toBe(400);
    });

    it('rejects target=codex for /state/exhausted (claude-only in phase 1b)', async () => {
      const router = createStateRouter({ dir });
      const r = await router.dispatch(post('/state/exhausted', { email: 'c@x.net', target: 'codex' }));
      expect(r.status).toBe(400);
    });
  });

  describe('GET/POST /state/cooldowns', () => {
    it('returns {} when the cooldowns file is missing', async () => {
      const router = createStateRouter({ dir });
      const r = await router.dispatch(makeReq({ url: '/state/cooldowns' }));
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual({});
    });

    it('round-trips a cooldown entry', async () => {
      const router = createStateRouter({ dir });
      const until = Date.now() + 3600_000;
      const w = await router.dispatch(post('/state/cooldown', { tokenKey: 'abc123', until }));
      expect(w.status).toBe(200);
      const r = await router.dispatch(makeReq({ url: '/state/cooldowns' }));
      expect(JSON.parse(r.body)).toEqual({ abc123: until });
    });

    it('rejects POST /state/cooldown without tokenKey', async () => {
      const router = createStateRouter({ dir });
      const r = await router.dispatch(post('/state/cooldown', { until: 123 }));
      expect(r.status).toBe(400);
    });
  });

  describe('POST /state/profile-access-token', () => {
    it('updates the OAuth tokens for an existing profile', async () => {
      writeFile('profiles.json', SAMPLE_PROFILES);
      const router = createStateRouter({ dir });
      const w = await router.dispatch(post('/state/profile-access-token', {
        email: 'a@x.net', accessToken: 'new-tok', refreshToken: 'new-rt', expiresAt: 999,
      }));
      expect(w.status).toBe(200);
      expect(JSON.parse(w.body).updated).toBe(true);
      const oauth = readFile('profiles.json')['a@x.net'].credentials.claudeAiOauth;
      expect(oauth).toEqual({ accessToken: 'new-tok', refreshToken: 'new-rt', expiresAt: 999 });
    });

    it('reports updated:false for an unknown profile', async () => {
      writeFile('profiles.json', SAMPLE_PROFILES);
      const router = createStateRouter({ dir });
      const w = await router.dispatch(post('/state/profile-access-token', {
        email: 'ghost@x.net', accessToken: 't', refreshToken: 'r', expiresAt: 1,
      }));
      expect(w.status).toBe(200);
      expect(JSON.parse(w.body).updated).toBe(false);
    });

    it('rejects a request missing accessToken', async () => {
      writeFile('profiles.json', SAMPLE_PROFILES);
      const router = createStateRouter({ dir });
      const r = await router.dispatch(post('/state/profile-access-token', { email: 'a@x.net' }));
      expect(r.status).toBe(400);
    });
  });

  describe('POST /state/codex-exhausted', () => {
    it('marks a codex account exhausted in tier-cache.codex.json', async () => {
      const router = createStateRouter({ dir });
      const w = await router.dispatch(post('/state/codex-exhausted', {
        email: 'c@x.net', response: 'Codex usage limit reached',
      }));
      expect(w.status).toBe(200);
      const entry = readFile('tier-cache.codex.json').accounts.find(a => a.email === 'c@x.net');
      expect(entry.serviceTier).toBe('exhausted');
      expect(entry.rateLimits.utilization5h).toBe(100);
    });

    it('replaces an existing codex tier-cache entry rather than duplicating', async () => {
      const router = createStateRouter({ dir });
      await router.dispatch(post('/state/codex-exhausted', { email: 'c@x.net' }));
      await router.dispatch(post('/state/codex-exhausted', { email: 'c@x.net' }));
      const rows = readFile('tier-cache.codex.json').accounts.filter(a => a.email === 'c@x.net');
      expect(rows.length).toBe(1);
    });

    it('rejects a request missing email', async () => {
      const router = createStateRouter({ dir });
      const r = await router.dispatch(post('/state/codex-exhausted', {}));
      expect(r.status).toBe(400);
    });
  });

  describe('POST /state/profile-stale', () => {
    it('flags a codex profile stale in profiles.codex.json', async () => {
      writeFile('profiles.codex.json', { 'c@x.net': { auth: {} } });
      const router = createStateRouter({ dir });
      const w = await router.dispatch(post('/state/profile-stale', { email: 'c@x.net', target: 'codex' }));
      expect(w.status).toBe(200);
      expect(JSON.parse(w.body).updated).toBe(true);
      const prof = readFile('profiles.codex.json')['c@x.net'];
      expect(prof.stale).toBe(true);
      expect(typeof prof.staleAt).toBe('string');
    });

    it('reports updated:false for an unknown profile', async () => {
      writeFile('profiles.codex.json', { 'c@x.net': { auth: {} } });
      const router = createStateRouter({ dir });
      const w = await router.dispatch(post('/state/profile-stale', { email: 'ghost@x.net', target: 'codex' }));
      expect(w.status).toBe(200);
      expect(JSON.parse(w.body).updated).toBe(false);
    });

    it('rejects a request missing email', async () => {
      const router = createStateRouter({ dir });
      const r = await router.dispatch(post('/state/profile-stale', { target: 'codex' }));
      expect(r.status).toBe(400);
    });
  });

  describe('routing errors', () => {
    it('returns 404 for an unknown path', async () => {
      const router = createStateRouter({ dir });
      const r = await router.dispatch(makeReq({ url: '/state/nope' }));
      expect(r.status).toBe(404);
    });

    it('returns 405 for an unsupported method', async () => {
      const router = createStateRouter({ dir });
      const r = await router.dispatch(makeReq({ method: 'PUT', url: '/state/profiles' }));
      expect(r.status).toBe(405);
    });

    it('returns 405 for GET on a write-only endpoint', async () => {
      const router = createStateRouter({ dir });
      const r = await router.dispatch(makeReq({ method: 'GET', url: '/state/exhausted' }));
      expect(r.status).toBe(405);
    });
  });

  describe('POST /state/import', () => {
    it('decodes a blob and merges profiles into profiles.json', async () => {
      const router = createStateRouter({ dir });
      const blob = encodeImportPayload({ 'a@x.net': importableClaudeProfile('a@x.net') });
      const r = await router.dispatch(post('/state/import', { data: blob }));
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toMatchObject({ accounts: 1, added: 1 });
      expect(readFile('profiles.json')['a@x.net'].provider).toBe('claude');
    });

    it('merges the export tier-cache into tier-cache.json', async () => {
      const router = createStateRouter({ dir });
      const tierCache = {
        updatedAt: '2026-05-01T00:00:00.000Z',
        accounts: [{ email: 'a@x.net', serviceTier: 'base', syncedAt: '2026-05-01T00:00:00.000Z' }],
      };
      const blob = encodeImportPayload({ 'a@x.net': importableClaudeProfile('a@x.net') }, tierCache);
      const r = await router.dispatch(post('/state/import', { data: blob }));
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body).tierMerged).toBe(1);
      expect(readFile('tier-cache.json').accounts[0].email).toBe('a@x.net');
    });

    it('rejects a missing data field with 400', async () => {
      const router = createStateRouter({ dir });
      const r = await router.dispatch(post('/state/import', {}));
      expect(r.status).toBe(400);
      expect(JSON.parse(r.body).error.code).toBe('missing_data');
    });

    it('rejects a corrupted blob with 400, not 500', async () => {
      const router = createStateRouter({ dir });
      const blob = encodeImportPayload({ 'a@x.net': importableClaudeProfile('a@x.net') });
      const [prefix, , data] = blob.split(':');
      const r = await router.dispatch(post('/state/import', { data: `${prefix}:deadbeef:${data}` }));
      expect(r.status).toBe(400);
      expect(JSON.parse(r.body).error.code).toBe('import_failed');
    });

    it('returns 405 for GET on /state/import', async () => {
      const router = createStateRouter({ dir });
      const r = await router.dispatch(makeReq({ method: 'GET', url: '/state/import' }));
      expect(r.status).toBe(405);
    });
  });
});
