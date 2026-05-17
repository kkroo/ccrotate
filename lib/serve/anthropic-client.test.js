import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { callMessages, classifyQuotaError } from './anthropic-client.js';

function tmpProfilesDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrotate-serve-anth-'));
  return dir;
}

function writeProfiles(dir, profiles, currentEmail) {
  fs.writeFileSync(path.join(dir, 'profiles.json'), JSON.stringify(profiles));
  // Mirrors the CurrentEmail pointer ccrotate's CCRotate.getCurrentAccount() reads.
  fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: currentEmail }));
}

function profile(email, tok = 'at-' + email) {
  return {
    email,
    credentials: {
      claudeAiOauth: {
        accessToken: tok, refreshToken: 'rt-' + email,
        expiresAt: Date.now() + 60 * 60 * 1000,
        scopes: ['user:inference', 'user:profile'], subscriptionType: 'pro',
      },
    },
  };
}

describe('anthropic-client.callMessages — happy path', () => {
  let dir;
  beforeEach(() => { dir = tmpProfilesDir(); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('passes Authorization Bearer <accessToken> + oauth-beta header', async () => {
    writeProfiles(dir, { 'a@x.com': profile('a@x.com', 'TOK_A') }, 'a@x.com');
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [{type:'text', text:'pong'}],
        stop_reason: 'end_turn',
        usage: {input_tokens: 1, output_tokens: 1},
      }), { status: 200 })
    );

    const result = await callMessages(
      {model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}]},
      { profilesDir: dir }
    );

    expect(spy).toHaveBeenCalledOnce();
    const [url, opts] = spy.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(opts.headers['Authorization']).toBe('Bearer TOK_A');
    expect(opts.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(opts.headers['anthropic-version']).toBe('2023-06-01');
    expect(result.status).toBe(200);
    expect(result.attempts).toBe(1);
    const body = await result.response.json();
    expect(body.id).toBe('msg_1');
  });

  it('propagates request body to upstream verbatim', async () => {
    writeProfiles(dir, { 'a@x.com': profile('a@x.com') }, 'a@x.com');
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 })
    );
    const payload = { model: 'claude-haiku-4-5-20251001', max_tokens: 50,
                      messages: [{role:'user', content:'x'}] };
    await callMessages(payload, { profilesDir: dir });
    expect(JSON.parse(spy.mock.calls[0][1].body)).toEqual(payload);
  });

  it('removes Claude Code-only context management fields before upstream', async () => {
    writeProfiles(dir, { 'a@x.com': profile('a@x.com') }, 'a@x.com');
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 })
    );
    const payload = {
      model: 'claude-opus-4-7',
      max_tokens: 50,
      stream: false,
      context_management: { edits: [] },
      messages: [{role:'user', content:'x'}],
    };
    await callMessages(payload, { profilesDir: dir });

    expect(JSON.parse(spy.mock.calls[0][1].body)).toEqual({
      model: 'claude-opus-4-7',
      max_tokens: 50,
      messages: [{role:'user', content:'x'}],
    });
  });

  it('maps Claude Code Opus [1m] alias to Anthropic model plus 1M beta header', async () => {
    writeProfiles(dir, { 'a@x.com': profile('a@x.com') }, 'a@x.com');
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 })
    );
    const payload = { model: 'claude-opus-4-7[1m]', max_tokens: 50,
                      messages: [{role:'user', content:'x'}] };
    await callMessages(payload, { profilesDir: dir });

    const [, opts] = spy.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ ...payload, model: 'claude-opus-4-7' });
    expect(opts.headers['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(opts.headers['anthropic-beta']).toContain('context-1m-2025-08-07');
  });
});

describe('anthropic-client.callMessages — 401 refresh-and-replay', () => {
  let dir;
  beforeEach(() => { dir = tmpProfilesDir(); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('refreshes token on 401 and replays once with new accessToken', async () => {
    writeProfiles(dir, { 'a@x.com': profile('a@x.com', 'TOK_OLD') }, 'a@x.com');

    let call = 0;
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
      call += 1;
      if (call === 1) {
        // First Messages call: 401
        expect(opts.headers['Authorization']).toBe('Bearer TOK_OLD');
        return new Response('{"error":{"type":"authentication_error"}}', { status: 401 });
      }
      if (call === 2) {
        // Token refresh: succeeds, returns new pair
        expect(url).toContain('/oauth/token'); // refresh endpoint
        return new Response(JSON.stringify({
          access_token: 'TOK_NEW', refresh_token: 'rt-new',
          expires_in: 3600,
        }), { status: 200 });
      }
      if (call === 3) {
        // Replay Messages call: 200 with NEW token
        expect(opts.headers['Authorization']).toBe('Bearer TOK_NEW');
        return new Response(JSON.stringify({
          id: 'msg_R', type: 'message', role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [{type:'text', text:'ok'}],
          stop_reason: 'end_turn',
          usage: {input_tokens: 1, output_tokens: 1},
        }), { status: 200 });
      }
      throw new Error('unexpected 4th fetch');
    });

    const result = await callMessages(
      {model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}]},
      { profilesDir: dir }
    );

    expect(result.status).toBe(200);
    expect(result.attempts).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(3); // 401 + refresh + 200
    // profiles.json now has the new accessToken
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'profiles.json'), 'utf8'));
    expect(after['a@x.com'].credentials.claudeAiOauth.accessToken).toBe('TOK_NEW');
  });

  it('returns pool-exhausted (502) when refresh succeeds but replay 401 and no more accounts', async () => {
    writeProfiles(dir, { 'a@x.com': profile('a@x.com', 'TOK_OLD') }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 2) {
        return new Response(JSON.stringify({access_token: 'TOK_NEW', refresh_token: 'rt-new', expires_in: 3600}), { status: 200 });
      }
      return new Response('{"error":{"type":"authentication_error"}}', { status: 401 });
    });
    const result = await callMessages(
      {model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}]},
      { profilesDir: dir }
    );
    expect(result.status).toBe(502);
    expect(result.poolExhausted).toBe(true);
    expect(result.attempts).toBe(2);
  });
});

describe('anthropic-client.callMessages — pool walk on refresh-fail', () => {
  let dir;
  beforeEach(() => { dir = tmpProfilesDir(); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('walks the pool when refresh fails on the active account', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
      'c@x.com': profile('c@x.com', 'TOK_C'),
    }, 'a@x.com');

    // Sequence:
    //   1) Messages w/ a → 401
    //   2) Refresh a    → 401 (refresh-fail) → rotate to b
    //   3) Messages w/ b → 401
    //   4) Refresh b    → 401 (refresh-fail) → rotate to c
    //   5) Messages w/ c → 200
    const order = ['TOK_A', 'refresh_a', 'TOK_B', 'refresh_b', 'TOK_C'];
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
      call += 1;
      const step = order[call - 1];
      if (step === 'TOK_A') {
        expect(opts.headers['Authorization']).toBe('Bearer TOK_A');
        return new Response('{}', { status: 401 });
      }
      if (step === 'refresh_a') {
        expect(url).toContain('/oauth/token');
        return new Response('{}', { status: 401 });
      }
      if (step === 'TOK_B') {
        expect(opts.headers['Authorization']).toBe('Bearer TOK_B');
        return new Response('{}', { status: 401 });
      }
      if (step === 'refresh_b') {
        expect(url).toContain('/oauth/token');
        return new Response('{}', { status: 401 });
      }
      if (step === 'TOK_C') {
        expect(opts.headers['Authorization']).toBe('Bearer TOK_C');
        return new Response(JSON.stringify({
          id: 'msg_C', type: 'message', role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [{type:'text', text:'ok'}], stop_reason: 'end_turn',
          usage: {input_tokens: 1, output_tokens: 1},
        }), { status: 200 });
      }
    });

    const result = await callMessages(
      {model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}]},
      { profilesDir: dir }
    );
    expect(result.status).toBe(200);
    expect(result.account).toBe('c@x.com');
    expect(result.attempts).toBe(3);
    expect(result.trigger).toBe('refresh-fail');
  });

  it('returns pool-exhausted when every account fails refresh', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));

    const result = await callMessages(
      {model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}]},
      { profilesDir: dir }
    );
    expect(result.status).toBe(502);
    expect(result.poolExhausted).toBe(true);
    expect(result.attempts).toBe(2);
  });
});

describe('anthropic-client.callMessages — structural quota rotation', () => {
  let dir;
  beforeEach(() => { dir = tmpProfilesDir(); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

  function quotaBody() {
    return JSON.stringify({
      error: {
        type: 'rate_limit_error',
        message: 'You have exceeded your usage limit. Resets at unix 1715800000.',
      },
    });
  }

  it('rotates on structural quota (capped at 1 replay) and marks exhausted', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');

    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
      call += 1;
      if (call === 1) return new Response(quotaBody(), { status: 429 });
      if (call === 2) {
        expect(opts.headers['Authorization']).toBe('Bearer TOK_B');
        return new Response(JSON.stringify({
          id: 'msg_B', type: 'message', role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [{type:'text', text:'ok'}], stop_reason: 'end_turn',
          usage: {input_tokens: 1, output_tokens: 1},
        }), { status: 200 });
      }
    });

    const result = await callMessages(
      {model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}]},
      { profilesDir: dir }
    );

    expect(result.status).toBe(200);
    expect(result.account).toBe('b@x.com');
    expect(result.attempts).toBe(2);
    expect(result.trigger).toBe('quota');

    // tier-cache.json now marks a@x.com exhausted (markAccountExhausted side effect)
    const tc = JSON.parse(fs.readFileSync(path.join(dir, 'tier-cache.json'), 'utf8'));
    const aEntry = (tc.accounts || []).find(a => a.email === 'a@x.com');
    expect(aEntry?.serviceTier).toBe('exhausted');
  });

  it('walks quota failures across the pool and returns 429 when all candidates quota', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(quotaBody(), { status: 429 }));

    const result = await callMessages(
      {model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}]},
      { profilesDir: dir }
    );
    expect(result.status).toBe(429);
    expect(result.attempts).toBe(2);
    expect(result.trigger).toBe('quota');
    expect(result.poolExhausted).toBe(true);
  });

  it('does not change current account when the walked pool is exhausted', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(quotaBody(), { status: 429 }));

    const result = await callMessages(
      {model:'claude-opus-4-7', max_tokens:10, messages:[{role:'user', content:'ping'}]},
      { profilesDir: dir }
    );
    expect(result.status).toBe(429);
    const current = JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8'));
    expect(current.email).toBe('a@x.com');
  });

  it('continues after quota replay lands on stale credentials', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
      'c@x.com': profile('c@x.com', 'TOK_C'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
      call += 1;
      if (call === 1) return new Response(quotaBody(), { status: 429 });
      if (call === 2 && opts.headers['Authorization'] === 'Bearer TOK_B') {
        return new Response(JSON.stringify({error: {type: 'authentication_error'}}), { status: 401 });
      }
      if (call === 3 && url === 'https://api.anthropic.com/api/oauth/token/refresh') {
        return new Response(JSON.stringify({error: 'bad refresh'}), { status: 401 });
      }
      if (call === 4 && opts.headers['Authorization'] === 'Bearer TOK_C') {
        return new Response(JSON.stringify({
          id: 'msg_C', type: 'message', role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [{type:'text', text:'ok'}], stop_reason: 'end_turn',
          usage: {input_tokens: 1, output_tokens: 1},
        }), { status: 200 });
      }
    });

    const result = await callMessages(
      {model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}]},
      { profilesDir: dir }
    );
    expect(result.status).toBe(200);
    expect(result.account).toBe('c@x.com');
    expect(result.attempts).toBe(3);
    expect(result.trigger).toBe('refresh-fail');
  });

  it('preserves quota as terminal error when later candidates have stale credentials', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
      call += 1;
      if (call === 1) return new Response(quotaBody(), { status: 429 });
      if (call === 2 && opts.headers['Authorization'] === 'Bearer TOK_B') {
        return new Response(JSON.stringify({error: {type: 'authentication_error'}}), { status: 401 });
      }
      if (call === 3 && url === 'https://api.anthropic.com/api/oauth/token/refresh') {
        return new Response(JSON.stringify({error: 'bad refresh'}), { status: 401 });
      }
    });

    const result = await callMessages(
      {model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}]},
      { profilesDir: dir }
    );
    expect(result.status).toBe(429);
    expect(result.trigger).toBe('quota');
    expect(result.poolExhausted).toBe(true);
  });

  it('does not skip a model-specific exhausted account for a different model', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'b@x.com');
    fs.writeFileSync(path.join(dir, 'tier-cache.json'), JSON.stringify({
      updatedAt: new Date().toISOString(),
      accounts: [{
        email: 'a@x.com',
        status: 'success',
        serviceTier: 'exhausted',
        exhaustedModel: 'claude-opus-4-7',
        rateLimits: {
          reset5h: Math.floor(Date.now() / 1000) + 3600,
          exhaustedModel: 'claude-opus-4-7',
        },
      }],
    }));
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
      call += 1;
      if (call === 1 && opts.headers['Authorization'] === 'Bearer TOK_B') {
        return new Response(JSON.stringify({error: {type: 'authentication_error'}}), { status: 401 });
      }
      if (call === 2 && url === 'https://api.anthropic.com/api/oauth/token/refresh') {
        return new Response(JSON.stringify({error: 'bad refresh'}), { status: 401 });
      }
      if (call === 3 && opts.headers['Authorization'] === 'Bearer TOK_A') {
        return new Response(JSON.stringify({
          id: 'msg_A', type: 'message', role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [{type:'text', text:'ok'}], stop_reason: 'end_turn',
          usage: {input_tokens: 1, output_tokens: 1},
        }), { status: 200 });
      }
    });

    const result = await callMessages(
      {model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}]},
      { profilesDir: dir }
    );
    expect(result.status).toBe(200);
    expect(result.account).toBe('a@x.com');
  });

  it('skips a model-specific exhausted account for the same model', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'b@x.com');
    fs.writeFileSync(path.join(dir, 'tier-cache.json'), JSON.stringify({
      updatedAt: new Date().toISOString(),
      accounts: [{
        email: 'a@x.com',
        status: 'success',
        serviceTier: 'exhausted',
        exhaustedModel: 'claude-opus-4-7',
        rateLimits: {
          reset5h: Math.floor(Date.now() / 1000) + 3600,
          exhaustedModel: 'claude-opus-4-7',
        },
      }],
    }));
    vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
      expect(opts.headers['Authorization']).not.toBe('Bearer TOK_A');
      return new Response(JSON.stringify({error: {type: 'authentication_error'}}), { status: 401 });
    });

    const result = await callMessages(
      {model:'claude-opus-4-7', max_tokens:10, messages:[{role:'user', content:'ping'}]},
      { profilesDir: dir }
    );
    expect(result.status).toBe(502);
    expect(result.poolExhausted).toBe(true);
  });

  it('treats Anthropic\'s "exceed your account\'s rate" message WITHOUT reset signal as transient-429 (burst-throttle, T1 2026-05-17)', async () => {
    // Production-observed Anthropic 429 with no anthropic-ratelimit-*-reset
    // header and no parseable epoch in the message body. Per T1
    // (see anthropic-client.js classifyQuotaError comment), this is a burst-
    // throttle from the per-org rate limiter, not real per-account exhaustion.
    // Must propagate as transient-429 — NOT mark the account exhausted.
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      return new Response(JSON.stringify({
        error: {type: 'rate_limit_error',
                message: "This request would exceed your account's rate limit for messages."},
      }), { status: 429 });
    });
    const result = await callMessages(
      {model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}]},
      { profilesDir: dir }
    );
    expect(result.status).toBe(429);
    expect(result.account).toBe('a@x.com');
    expect(result.trigger).toBe('transient-429');
    // Crucially: a@x.com must NOT be marked exhausted in tier-cache.
    let tc = { accounts: [] };
    try { tc = JSON.parse(fs.readFileSync(path.join(dir, 'tier-cache.json'), 'utf8')); } catch {}
    const aEntry = (tc.accounts || []).find(a => a.email === 'a@x.com');
    expect(aEntry?.serviceTier).not.toBe('exhausted');
    // Only the first call should have happened (no rotation, no pool walk).
    expect(call).toBe(1);
  });

  it('reads reset epoch from anthropic-ratelimit-tokens-reset header when present', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 1) return new Response(
        JSON.stringify({error: {type: 'rate_limit_error', message: 'rate exceeded'}}),
        { status: 429, headers: {'anthropic-ratelimit-tokens-reset': '1715900000'} }
      );
      return new Response(JSON.stringify({
        id: 'msg_B', type: 'message', role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [{type:'text', text:'ok'}], stop_reason: 'end_turn',
        usage: {input_tokens: 1, output_tokens: 1},
      }), { status: 200 });
    });
    await callMessages(
      {model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}]},
      { profilesDir: dir }
    );
    const tc = JSON.parse(fs.readFileSync(path.join(dir, 'tier-cache.json'), 'utf8'));
    const aEntry = (tc.accounts || []).find(a => a.email === 'a@x.com');
    expect(aEntry?.rateLimits?.reset5h).toBe(1715900000);
  });
});

describe('classifyQuotaError — burst-429 vs real exhaustion', () => {
  it('returns structural:false when rate_limit_error has no reset headers and no epoch in message', () => {
    const body = { error: { type: 'rate_limit_error', message: 'Too many requests' } };
    const headers = new Map();
    const result = classifyQuotaError(body, headers);
    expect(result.structural).toBe(false);
  });

  it('returns structural:true when rate_limit_error has anthropic-ratelimit-tokens-reset header', () => {
    const body = { error: { type: 'rate_limit_error', message: 'Quota exceeded' } };
    const headers = new Map([['anthropic-ratelimit-tokens-reset', String(Math.floor(Date.now() / 1000) + 3600)]]);
    const result = classifyQuotaError(body, headers);
    expect(result.structural).toBe(true);
    expect(result.reset5h).toBeGreaterThan(Date.now() / 1000);
  });

  it('returns structural:true when message contains parseable reset epoch even without headers', () => {
    const epoch = Math.floor(Date.now() / 1000) + 7200;
    const body = { error: { type: 'rate_limit_error', message: `Quota exhausted; resets at ${epoch}` } };
    const result = classifyQuotaError(body, new Map());
    expect(result.structural).toBe(true);
  });
});
