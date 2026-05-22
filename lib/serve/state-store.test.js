import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import msgpack from 'msgpack-lite';
import { gzipSync } from 'zlib';
import { FileStateStore, HttpStateStore, createStateStore } from './state-store.js';
import { optimizeProfile, computeCrc } from '../commands/export.js';
import { isAccountExhausted } from '../state-helpers.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccrotate-store-'));
}

function encodeImportPayload(profiles) {
  const optimized = {};
  for (const [email, profile] of Object.entries(profiles)) {
    optimized[email] = optimizeProfile(email, profile);
  }
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

const SAMPLE_PROFILES = {
  'a@x.net': { credentials: { claudeAiOauth: { accessToken: 'tok-a', refreshToken: 'rt-a', expiresAt: 111 } } },
  'b@x.net': { credentials: { claudeAiOauth: { accessToken: 'tok-b', refreshToken: 'rt-b', expiresAt: 222 } } },
};

describe('FileStateStore', () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  const write = (name, obj) => fs.writeFileSync(path.join(dir, name), JSON.stringify(obj));
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

  it('throws without a profilesDir', () => {
    expect(() => new FileStateStore()).toThrow(/profilesDir/);
  });

  it('getProfiles reads profiles.json', async () => {
    write('profiles.json', SAMPLE_PROFILES);
    expect(await new FileStateStore(dir).getProfiles()).toEqual(SAMPLE_PROFILES);
  });

  it('getActiveEmail reads current.json, null when missing', async () => {
    const store = new FileStateStore(dir);
    expect(await store.getActiveEmail()).toBe(null);
    write('current.json', { email: 'a@x.net' });
    expect(await store.getActiveEmail()).toBe('a@x.net');
  });

  it('getTierCache returns an empty shape when missing', async () => {
    expect(await new FileStateStore(dir).getTierCache()).toEqual({ accounts: [] });
  });

  it('records Anthropic response headers into rate-limit-state.json', async () => {
    const store = new FileStateStore(dir);
    await store.recordAnthropicRateLimit(
      'a@x.net',
      'claude-sonnet-4-5',
      new Response('{}', {
        status: 429,
        headers: {
          'retry-after': '30',
          'anthropic-ratelimit-requests-limit': '8',
          'anthropic-ratelimit-requests-remaining': '0',
          'anthropic-ratelimit-requests-reset': String(Math.floor(Date.now() / 1000) + 30),
        },
      }),
    );
    const state = read('rate-limit-state.json');
    const entry = state.anthropic.accounts['a@x.net'].modelGroups['claude-sonnet'];
    expect(entry.requests.limit).toBe(8);
    expect(entry.requests.remaining).toBe(0);
    expect(entry.last429Reason).toBe('requests');
    expect(await store.getAnthropicRateLimitBlock('a@x.net', 'claude-sonnet-4-5')).toMatchObject({
      blocked: true,
      modelGroup: 'claude-sonnet',
      reason: 'requests',
    });
  });

  it('setActiveEmail writes current.json', async () => {
    await new FileStateStore(dir).setActiveEmail('b@x.net');
    expect(read('current.json')).toEqual({ email: 'b@x.net' });
  });

  it('markExhausted then getTierCache reflects the exhausted entry', async () => {
    const store = new FileStateStore(dir);
    const reset5h = Math.floor(Date.now() / 1000) + 3600;
    await store.markExhausted('a@x.net', { reset5h, model: 'claude-opus-4-7' });
    const entry = (await store.getTierCache()).accounts.find(a => a.email === 'a@x.net');
    expect(isAccountExhausted(entry, { model: 'claude-opus-4-7' })).toBe(true);
    expect(entry.rateLimits.reset5h).toBe(reset5h);
  });

  it('clearExhausted clears a previously-exhausted entry', async () => {
    const store = new FileStateStore(dir);
    await store.markExhausted('a@x.net', { reset5h: Math.floor(Date.now() / 1000) + 3600 });
    const res = await store.clearExhausted('a@x.net');
    expect(res.changed).toBe(true);
    expect((await store.getTierCache()).accounts.find(a => a.email === 'a@x.net').serviceTier).toBe(null);
  });

  it('writeProfileToken updates the OAuth triple in place', async () => {
    write('profiles.json', SAMPLE_PROFILES);
    await new FileStateStore(dir).writeProfileToken('a@x.net', {
      accessToken: 'new', refreshToken: 'new-rt', expiresAt: 999,
    });
    expect(read('profiles.json')['a@x.net'].credentials.claudeAiOauth)
      .toEqual({ accessToken: 'new', refreshToken: 'new-rt', expiresAt: 999 });
  });

  it('getCodexProfiles reads profiles.codex.json', async () => {
    write('profiles.codex.json', { 'c@x.net': { auth: {} } });
    expect(await new FileStateStore(dir).getCodexProfiles()).toEqual({ 'c@x.net': { auth: {} } });
  });

  it('markCodexStale flags the codex profile stale', async () => {
    write('profiles.codex.json', { 'c@x.net': { auth: {} } });
    const res = await new FileStateStore(dir).markCodexStale('c@x.net');
    expect(res.updated).toBe(true);
    const prof = read('profiles.codex.json')['c@x.net'];
    expect(prof.stale).toBe(true);
    expect(typeof prof.staleAt).toBe('string');
  });

  it('markCodexExhausted writes a codex-shaped exhausted tier-cache entry', async () => {
    await new FileStateStore(dir).markCodexExhausted('c@x.net', 'usage limit');
    const entry = read('tier-cache.codex.json').accounts.find(a => a.email === 'c@x.net');
    expect(entry.serviceTier).toBe('exhausted');
    // codex framing is inverse of claude: 100% used / 0% remaining = run out.
    expect(entry.rateLimits.utilization5h).toBe(100);
    expect(entry.rateLimits.remaining5h).toBe(0);
  });

  it('getCodexTierCache reads tier-cache.codex.json', async () => {
    write('tier-cache.codex.json', { updatedAt: 't', accounts: [{ email: 'c@x.net' }] });
    expect(await new FileStateStore(dir).getCodexTierCache())
      .toEqual({ updatedAt: 't', accounts: [{ email: 'c@x.net' }] });
  });

  it('getCodexTierCache returns an empty shape when the file is missing', async () => {
    expect(await new FileStateStore(dir).getCodexTierCache())
      .toEqual({ updatedAt: null, accounts: [] });
  });

  it('import decodes a blob and writes profiles.json', async () => {
    const blob = encodeImportPayload({ 'a@x.net': importableClaudeProfile('a@x.net') });
    const res = await new FileStateStore(dir).import(blob);
    expect(res).toMatchObject({ accounts: 1, added: 1 });
    expect(read('profiles.json')['a@x.net'].provider).toBe('claude');
  });
});

describe('HttpStateStore', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function mockFetch(handler) {
    return vi.spyOn(global, 'fetch').mockImplementation(async (url, init = {}) => handler(String(url), init));
  }
  function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  }

  it('throws without a baseUrl', () => {
    expect(() => new HttpStateStore({})).toThrow(/baseUrl/);
  });

  it('getProfiles GETs /state/profiles', async () => {
    const spy = mockFetch(() => json(SAMPLE_PROFILES));
    const store = new HttpStateStore({ baseUrl: 'http://s:4002' });
    expect(await store.getProfiles()).toEqual(SAMPLE_PROFILES);
    expect(spy.mock.calls[0][0]).toBe('http://s:4002/state/profiles');
    expect(spy.mock.calls[0][1].method).toBe('GET');
  });

  it('strips a trailing slash from baseUrl', async () => {
    const spy = mockFetch(() => json({}));
    await new HttpStateStore({ baseUrl: 'http://s:4002/' }).getProfiles();
    expect(spy.mock.calls[0][0]).toBe('http://s:4002/state/profiles');
  });

  it('sends a bearer token when configured', async () => {
    const spy = mockFetch(() => json({}));
    await new HttpStateStore({ baseUrl: 'http://s:4002', token: 'sek' }).getProfiles();
    expect(spy.mock.calls[0][1].headers.authorization).toBe('Bearer sek');
  });

  it('getActiveEmail unwraps {email}', async () => {
    mockFetch(() => json({ email: 'a@x.net' }));
    expect(await new HttpStateStore({ baseUrl: 'http://s:4002' }).getActiveEmail()).toBe('a@x.net');
  });

  it('caches reads within the TTL window', async () => {
    const spy = mockFetch(() => json(SAMPLE_PROFILES));
    const store = new HttpStateStore({ baseUrl: 'http://s:4002', cacheTtlMs: 1000 });
    await store.getProfiles();
    await store.getProfiles();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('re-fetches after the TTL expires', async () => {
    const spy = mockFetch(() => json(SAMPLE_PROFILES));
    const store = new HttpStateStore({ baseUrl: 'http://s:4002', cacheTtlMs: 0 });
    await store.getProfiles();
    await store.getProfiles();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('setActiveEmail POSTs /state/current and invalidates the current cache', async () => {
    let current = { email: 'a@x.net' };
    const spy = mockFetch((url, init) => {
      if (url.endsWith('/state/current') && init.method === 'POST') {
        current = JSON.parse(init.body);
        return json(current);
      }
      return json(current);
    });
    const store = new HttpStateStore({ baseUrl: 'http://s:4002', cacheTtlMs: 60_000 });
    expect(await store.getActiveEmail()).toBe('a@x.net');
    await store.setActiveEmail('b@x.net');
    expect(await store.getActiveEmail()).toBe('b@x.net');
    const gets = spy.mock.calls.filter(c => c[0].endsWith('/state/current') && c[1].method === 'GET');
    expect(gets.length).toBe(2);
  });

  it('markExhausted POSTs /state/exhausted with the payload', async () => {
    const spy = mockFetch(() => json({ skipped: false, email: 'a@x.net' }));
    const store = new HttpStateStore({ baseUrl: 'http://s:4002' });
    const res = await store.markExhausted('a@x.net', { reset5h: 123, model: 'claude-opus-4-7' });
    expect(res.skipped).toBe(false);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://s:4002/state/exhausted');
    expect(JSON.parse(init.body)).toMatchObject({ email: 'a@x.net', reset5h: 123, model: 'claude-opus-4-7' });
  });

  it('clearExhausted POSTs /state/clear-exhausted', async () => {
    const spy = mockFetch(() => json({ changed: true, email: 'a@x.net' }));
    const res = await new HttpStateStore({ baseUrl: 'http://s:4002' }).clearExhausted('a@x.net', { model: 'm' });
    expect(res.changed).toBe(true);
    expect(spy.mock.calls[0][0]).toBe('http://s:4002/state/clear-exhausted');
  });

  it('writeProfileToken POSTs /state/profile-access-token', async () => {
    const spy = mockFetch(() => json({ updated: true }));
    await new HttpStateStore({ baseUrl: 'http://s:4002' }).writeProfileToken('a@x.net', {
      accessToken: 'at', refreshToken: 'rt', expiresAt: 5,
    });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://s:4002/state/profile-access-token');
    expect(JSON.parse(init.body)).toMatchObject({ email: 'a@x.net', accessToken: 'at', refreshToken: 'rt', expiresAt: 5 });
  });

  it('throws with the upstream status on a non-2xx response', async () => {
    mockFetch(() => json({ error: { code: 'state_unreadable', message: 'boom' } }, 500));
    const store = new HttpStateStore({ baseUrl: 'http://s:4002' });
    await expect(store.getProfiles()).rejects.toThrow(/boom/);
  });

  it('getCodexProfiles GETs /state/profiles?target=codex', async () => {
    const spy = mockFetch(() => json({ 'c@x.net': { auth: {} } }));
    const r = await new HttpStateStore({ baseUrl: 'http://s:4002' }).getCodexProfiles();
    expect(r).toEqual({ 'c@x.net': { auth: {} } });
    expect(spy.mock.calls[0][0]).toBe('http://s:4002/state/profiles?target=codex');
  });

  it('markCodexStale POSTs /state/profile-stale with target codex', async () => {
    const spy = mockFetch(() => json({ updated: true }));
    await new HttpStateStore({ baseUrl: 'http://s:4002' }).markCodexStale('c@x.net');
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://s:4002/state/profile-stale');
    expect(JSON.parse(init.body)).toEqual({ email: 'c@x.net', target: 'codex' });
  });

  it('markCodexExhausted POSTs /state/codex-exhausted', async () => {
    const spy = mockFetch(() => json({ email: 'c@x.net', serviceTier: 'exhausted' }));
    const res = await new HttpStateStore({ baseUrl: 'http://s:4002' }).markCodexExhausted('c@x.net', 'limit');
    expect(res.serviceTier).toBe('exhausted');
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://s:4002/state/codex-exhausted');
    expect(JSON.parse(init.body)).toMatchObject({ email: 'c@x.net', response: 'limit' });
  });

  it('getCodexTierCache GETs /state/tier-cache?target=codex', async () => {
    const spy = mockFetch(() => json({ updatedAt: null, accounts: [] }));
    await new HttpStateStore({ baseUrl: 'http://s:4002' }).getCodexTierCache();
    expect(spy.mock.calls[0][0]).toBe('http://s:4002/state/tier-cache?target=codex');
  });

  it('import POSTs the blob to /state/import', async () => {
    const spy = mockFetch(() => json({ accounts: 2, added: 1, updated: 1, kept: 0, tierMerged: 0 }));
    const res = await new HttpStateStore({ baseUrl: 'http://s:4002' }).import('mp-gz-b64:deadbeef:AAAA');
    expect(res).toMatchObject({ accounts: 2, added: 1 });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('http://s:4002/state/import');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ data: 'mp-gz-b64:deadbeef:AAAA' });
  });
});

describe('createStateStore', () => {
  const saved = process.env.CCROTATE_STATE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.CCROTATE_STATE_URL;
    else process.env.CCROTATE_STATE_URL = saved;
    delete process.env.CCROTATE_STATE_TOKEN;
  });

  it('returns a FileStateStore when CCROTATE_STATE_URL is unset', () => {
    delete process.env.CCROTATE_STATE_URL;
    expect(createStateStore({ profilesDir: '/tmp/x' })).toBeInstanceOf(FileStateStore);
  });

  it('returns an HttpStateStore when CCROTATE_STATE_URL is set', () => {
    process.env.CCROTATE_STATE_URL = 'http://s:4002';
    expect(createStateStore({ profilesDir: '/tmp/x' })).toBeInstanceOf(HttpStateStore);
  });
});
