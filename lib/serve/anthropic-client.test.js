import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { callMessages, classifyQuotaError, pickNextCandidate } from './anthropic-client.js';
import { isAccountExhausted } from '../state-helpers.js';

// Disable the transient-429 inter-attempt backoff by default so the 429-walk
// tests don't sleep. The dedicated backoff describe re-enables it explicitly.
process.env.CCROTATE_TRANSIENT_429_BACKOFF_MS = '0';
// Disable the Usage API probe by default — without this, every test that
// triggers a structural-classified 429 would fire a real https.request at
// api.anthropic.com. The verify-on-429 describe block explicitly injects
// `probeUsageApi` to exercise the probe-driven branches.
process.env.CCROTATE_USAGE_PROBE_DISABLED = '1';

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
    // Future reset ~2h out so classifyQuotaError's horizon gate reads this
    // as a genuine 5h/7d cap, not a transient burst throttle.
    const epoch = Math.floor(Date.now() / 1000) + 7200;
    return JSON.stringify({
      error: {
        type: 'rate_limit_error',
        message: `You have exceeded your usage limit. Resets at unix ${epoch}.`,
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

    // tier-cache.json now records a@x.com exhausted FOR THE HAIKU MODEL
    // (markAccountExhausted side effect — model-scoped, not account-wide).
    const tc = JSON.parse(fs.readFileSync(path.join(dir, 'tier-cache.json'), 'utf8'));
    const aEntry = (tc.accounts || []).find(a => a.email === 'a@x.com');
    expect(isAccountExhausted(aEntry, { model: 'claude-haiku-4-5-20251001' })).toBe(true);
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
    // Must propagate as transient-429 after walking the request-local pool —
    // NOT mark accounts exhausted.
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
    expect(result.account).toBe(null);
    expect(result.trigger).toBe('transient-429');
    // Crucially: a@x.com must NOT be marked exhausted in tier-cache.
    let tc = { accounts: [] };
    try { tc = JSON.parse(fs.readFileSync(path.join(dir, 'tier-cache.json'), 'utf8')); } catch {}
    const aEntry = (tc.accounts || []).find(a => a.email === 'a@x.com');
    expect(aEntry?.serviceTier).not.toBe('exhausted');
    expect(call).toBe(2);
  });

  it('walks transient 429s without marking exhausted and succeeds on a later account', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
      call += 1;
      if (call === 1) {
        expect(opts.headers['Authorization']).toBe('Bearer TOK_A');
        return new Response(JSON.stringify({
          error: {type: 'rate_limit_error', message: 'Error'},
        }), { status: 429 });
      }
      expect(opts.headers['Authorization']).toBe('Bearer TOK_B');
      return new Response(JSON.stringify({
        id: 'msg_B', type: 'message', role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [{type:'text', text:'ok'}], stop_reason: 'end_turn',
        usage: {input_tokens: 1, output_tokens: 1},
      }), { status: 200 });
    });

    const result = await callMessages(
      {model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}]},
      { profilesDir: dir }
    );
    expect(result.status).toBe(200);
    expect(result.account).toBe('b@x.com');
    expect(result.trigger).toBe('transient-429');
    let tc = { accounts: [] };
    try { tc = JSON.parse(fs.readFileSync(path.join(dir, 'tier-cache.json'), 'utf8')); } catch {}
    expect(tc.accounts || []).toEqual([]);
    expect(call).toBe(2);
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
        { status: 429, headers: {'anthropic-ratelimit-tokens-reset': String(Math.floor(Date.now() / 1000) + 7200)} }
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
    // The header carried a ~2h-future epoch; classifyQuotaError keeps the
    // absolute value as-is (long horizon → structural).
    const nowS = Math.floor(Date.now() / 1000);
    expect(aEntry?.rateLimits?.reset5h).toBeGreaterThan(nowS + 6000);
  });
});

describe('anthropic-client.callMessages — self-heal stale exhausted on 200', () => {
  // Regression contract for the stale-exhausted-label deadlock observed
  // 2026-05-18: an account is labeled `serviceTier: exhausted` in
  // tier-cache, the freshness-loop probe path keeps returning
  // status='unknown' (Usage API on 1hr cooldown + /v1/messages fallback
  // gated to extra-mode only), and upsertTierCacheEntries' anti-clobber
  // rule preserves the stale label indefinitely. Meanwhile,
  // callMessages may be successfully serving requests on the same
  // account. The fix: on a 200-class response, clear the stale label
  // for that account so /ccrotate:when, paperclip-server tier-gate,
  // and pickNextCandidate see truth instead of the poisoned snapshot.
  let dir;
  beforeEach(() => { dir = tmpProfilesDir(); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

  function seedExhaustedTierCache(dir, email, { exhaustedModel = null } = {}) {
    fs.writeFileSync(path.join(dir, 'tier-cache.json'), JSON.stringify({
      updatedAt: '2026-05-01T00:00:00Z',
      accounts: [{
        email,
        status: 'success',
        serviceTier: 'exhausted',
        ...(exhaustedModel ? { exhaustedModel } : {}),
        response: 'quota exhausted',
        rateLimits: {
          utilization5h: 100,
          utilization7d: 58,
          snapshotCapturedAt: '2026-05-01T00:00:00Z',
          ...(exhaustedModel ? { exhaustedModel } : {}),
        },
      }],
    }));
  }

  it('clears the stale exhausted label after a 200 on an unlabeled-model entry', async () => {
    writeProfiles(dir, { 'a@x.com': profile('a@x.com', 'TOK_A') }, 'a@x.com');
    seedExhaustedTierCache(dir, 'a@x.com');

    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 })
    );

    const result = await callMessages(
      { model: 'claude-opus-4-7[1m]', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] },
      { profilesDir: dir }
    );

    expect(result.status).toBe(200);
    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'tier-cache.json'), 'utf8'));
    expect(cache.accounts[0].serviceTier).toBeNull();
    // Utilization data preserved
    expect(cache.accounts[0].rateLimits.utilization5h).toBe(100);
  });

  it('clears the label when the existing exhaustedModel matches the success model', async () => {
    writeProfiles(dir, { 'a@x.com': profile('a@x.com') }, 'a@x.com');
    seedExhaustedTierCache(dir, 'a@x.com', { exhaustedModel: 'claude-opus-4-7' });

    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 })
    );

    await callMessages(
      { model: 'claude-opus-4-7', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] },
      { profilesDir: dir }
    );

    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'tier-cache.json'), 'utf8'));
    expect(cache.accounts[0].serviceTier).toBeNull();
    expect(cache.accounts[0].exhaustedModel).toBeUndefined();
  });

  it('preserves the label when the existing exhaustedModel does NOT match (per-model independence)', async () => {
    // Haiku succeeding does NOT prove opus quota has recovered. The
    // exhaustedModel tag stays put so pickNextCandidate keeps avoiding
    // this account for opus requests.
    writeProfiles(dir, { 'a@x.com': profile('a@x.com') }, 'a@x.com');
    seedExhaustedTierCache(dir, 'a@x.com', { exhaustedModel: 'claude-opus-4-7' });

    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 })
    );

    await callMessages(
      { model: 'claude-haiku-4-5-20251001', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] },
      { profilesDir: dir }
    );

    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'tier-cache.json'), 'utf8'));
    expect(cache.accounts[0].serviceTier).toBe('exhausted');
    expect(cache.accounts[0].exhaustedModel).toBe('claude-opus-4-7');
  });

  it('does not touch tier-cache when the response is NOT 2xx (no false self-heal on 4xx)', async () => {
    // Ensure self-heal is gated to the explicit 2xx success contract —
    // don't accidentally clear labels on, say, a 400 validation error
    // that doesn't prove the account is healthy.
    writeProfiles(dir, { 'a@x.com': profile('a@x.com') }, 'a@x.com');
    seedExhaustedTierCache(dir, 'a@x.com');
    const before = fs.readFileSync(path.join(dir, 'tier-cache.json'), 'utf8');

    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { type: 'invalid_request' } }), { status: 400 })
    );

    await callMessages(
      { model: 'claude-opus-4-7[1m]', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] },
      { profilesDir: dir }
    );

    expect(fs.readFileSync(path.join(dir, 'tier-cache.json'), 'utf8')).toBe(before);
  });

  it('clears the label after a successful refresh+replay path (401 → refresh → 200)', async () => {
    // Cover the second setActiveOnSuccess call site in callMessages: when
    // the initial token is rejected with 401, refreshed, and the replay
    // returns 200, we still want self-heal to fire.
    writeProfiles(dir, { 'a@x.com': profile('a@x.com', 'TOK_OLD') }, 'a@x.com');
    seedExhaustedTierCache(dir, 'a@x.com');

    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      call += 1;
      if (call === 1) return new Response('{}', { status: 401 });
      // Refresh endpoint
      if (String(url).endsWith('/oauth/token/refresh')) {
        return new Response(JSON.stringify({
          access_token: 'TOK_NEW', refresh_token: 'rt-new', expires_in: 3600,
        }), { status: 200 });
      }
      // Replay
      return new Response('{}', { status: 200 });
    });

    const result = await callMessages(
      { model: 'claude-opus-4-7[1m]', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] },
      { profilesDir: dir }
    );

    expect(result.status).toBe(200);
    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'tier-cache.json'), 'utf8'));
    expect(cache.accounts[0].serviceTier).toBeNull();
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

  it('classifies a SHORT retry-after as transient (structural:false), not exhaustion', () => {
    // 2026-05-19 incident: Anthropic's burst / org-level 429s carry a short
    // retry-after. Marking those structural poisoned the shared tier-cache
    // and deadlocked the pool all-`exhausted`. 60s is a burst throttle.
    const body = { error: { type: 'rate_limit_error', message: 'rate limit' } };
    const result = classifyQuotaError(body, new Map([['retry-after', '60']]));
    expect(result.structural).toBe(false);
  });

  it('classifies a LONG retry-after as structural exhaustion with an absolute reset epoch', () => {
    // A retry-after on the scale of a real rolling-window reset (here 2h)
    // IS a genuine cap. retry-after is a duration → converted to an
    // absolute future epoch (now + duration), not stored raw.
    const body = { error: { type: 'rate_limit_error', message: 'rate limit' } };
    const before = Math.floor(Date.now() / 1000);
    const result = classifyQuotaError(body, new Map([['retry-after', '7200']]));
    const after = Math.floor(Date.now() / 1000);
    expect(result.structural).toBe(true);
    expect(result.reset5h).toBeGreaterThanOrEqual(before + 7200);
    expect(result.reset5h).toBeLessThanOrEqual(after + 7200);
  });

  it('does NOT add Date.now to anthropic-ratelimit-tokens-reset (that header IS already an epoch)', () => {
    // Anthropic's `anthropic-ratelimit-tokens-reset` is documented as a
    // unix timestamp, NOT a duration. Make sure the retry-after fix
    // doesn't accidentally inflate this header by adding Date.now/1000 to
    // a value that's already an absolute epoch.
    const epoch = Math.floor(Date.now() / 1000) + 3600;
    const body = { error: { type: 'rate_limit_error', message: 'rate limit' } };
    const headers = new Map([['anthropic-ratelimit-tokens-reset', String(epoch)]]);
    const result = classifyQuotaError(body, headers);
    expect(result.reset5h).toBe(epoch);
  });

  it('classifies retry-after 0 (immediate-retry hint) as transient, not exhaustion', () => {
    // retry-after: 0 = "retry now" — definitionally a transient burst
    // throttle, never a real 5h/7d quota cap.
    const body = { error: { type: 'rate_limit_error', message: 'rate limit' } };
    const result = classifyQuotaError(body, new Map([['retry-after', '0']]));
    expect(result.structural).toBe(false);
  });
});

describe('anthropic-client.callMessages — injected StateStore (HTTP-mode contract)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // Minimal in-memory StateStore — the same async interface FileStateStore /
  // HttpStateStore implement. Lets us assert callMessages drives the store
  // correctly without touching the filesystem or a real state-server.
  function fakeStore({ profiles, activeEmail = null, tierCache = { accounts: [] } }) {
    const calls = [];
    return {
      calls,
      async getProfiles() { calls.push(['getProfiles']); return profiles; },
      async getActiveEmail() { calls.push(['getActiveEmail']); return activeEmail; },
      async getTierCache() { calls.push(['getTierCache']); return tierCache; },
      async setActiveEmail(e) { calls.push(['setActiveEmail', e]); },
      async markExhausted(e, o) { calls.push(['markExhausted', e, o]); return { skipped: false }; },
      async clearExhausted(e, o) { calls.push(['clearExhausted', e, o]); return { changed: true }; },
      async writeProfileToken(e, o) { calls.push(['writeProfileToken', e, o]); return { updated: true }; },
    };
  }
  const names = (store) => store.calls.map(c => c[0]);

  it('throws when given neither profilesDir, store, nor CCROTATE_STATE_URL', async () => {
    await expect(callMessages({ model: 'claude-haiku-4-5-20251001' }, {}))
      .rejects.toThrow(/profilesDir or CCROTATE_STATE_URL/);
  });

  it('routes a 200 through the store: setActiveEmail + clearExhausted', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const store = fakeStore({ profiles: { 'a@x.com': profile('a@x.com') }, activeEmail: 'a@x.com' });
    const result = await callMessages(
      { model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] },
      { store },
    );
    expect(result.status).toBe(200);
    expect(result.account).toBe('a@x.com');
    expect(store.calls).toContainEqual(['setActiveEmail', 'a@x.com']);
    expect(store.calls).toContainEqual(['clearExhausted', 'a@x.com', { model: 'claude-haiku-4-5-20251001' }]);
  });

  it('marks the account exhausted via the store on a structural 429, then rotates', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }),
        { status: 429, headers: { 'retry-after': '7200' } },
      ))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const store = fakeStore({
      profiles: { 'a@x.com': profile('a@x.com'), 'b@x.com': profile('b@x.com') },
      activeEmail: 'a@x.com',
    });
    const result = await callMessages(
      { model: 'claude-opus-4-7', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] },
      { store },
    );
    expect(result.status).toBe(200);
    expect(result.account).toBe('b@x.com');
    expect(result.attempts).toBe(2);
    const mark = store.calls.find(c => c[0] === 'markExhausted');
    expect(mark[1]).toBe('a@x.com');
    expect(mark[2]).toMatchObject({ model: 'claude-opus-4-7' });
  });

  it('persists a refreshed token via the store on a 401 → refresh → replay', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ access_token: 'fresh-at', refresh_token: 'fresh-rt', expires_in: 3600 }),
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const store = fakeStore({ profiles: { 'a@x.com': profile('a@x.com') }, activeEmail: 'a@x.com' });
    const result = await callMessages(
      { model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] },
      { store },
    );
    expect(result.status).toBe(200);
    const wpt = store.calls.find(c => c[0] === 'writeProfileToken');
    expect(wpt[1]).toBe('a@x.com');
    expect(wpt[2]).toMatchObject({ accessToken: 'fresh-at', refreshToken: 'fresh-rt' });
  });

  it('falls back to the first profile when getActiveEmail returns null', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const store = fakeStore({ profiles: { 'a@x.com': profile('a@x.com') }, activeEmail: null });
    const result = await callMessages(
      { model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] },
      { store },
    );
    expect(result.status).toBe(200);
    expect(result.account).toBe('a@x.com');
    expect(names(store)).toContain('getActiveEmail');
  });
});

describe('anthropic-client.callMessages — transient-429 backoff', () => {
  let dir;
  let savedBackoffEnv;
  beforeEach(() => {
    dir = tmpProfilesDir();
    savedBackoffEnv = process.env.CCROTATE_TRANSIENT_429_BACKOFF_MS;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    if (savedBackoffEnv === undefined) delete process.env.CCROTATE_TRANSIENT_429_BACKOFF_MS;
    else process.env.CCROTATE_TRANSIENT_429_BACKOFF_MS = savedBackoffEnv;
  });

  const okResponse = () => new Response(JSON.stringify({
    id: 'msg_B', type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001',
    content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200 });
  const transient429 = () => new Response(
    JSON.stringify({ error: { type: 'rate_limit_error', message: 'Error' } }), { status: 429 });
  const ping = { model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] };

  it('sleeps a jittered backoff before rotating off a transient 429', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({ error: { type: 'rate_limit_error', message: 'Error' } }), { status: 429 });
      }
      return okResponse();
    });
    const sleepSpy = vi.fn(async () => {});
    const result = await callMessages(ping, { profilesDir: dir, transient429BackoffMs: 200, sleep: sleepSpy });
    expect(result.status).toBe(200);
    expect(result.account).toBe('b@x.com');
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    const delay = sleepSpy.mock.calls[0][0];
    expect(delay).toBeGreaterThanOrEqual(150); // 200 * 0.75
    expect(delay).toBeLessThanOrEqual(250);    // 200 * 1.25
  });

  it('does not back off on a structural 429 — that account is genuinely capped', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        // retry-after far in the future → classifyQuotaError reads structural.
        return new Response(JSON.stringify({ error: { type: 'rate_limit_error', message: 'usage limit' } }),
          { status: 429, headers: { 'retry-after': '7200' } });
      }
      return okResponse();
    });
    const sleepSpy = vi.fn(async () => {});
    const result = await callMessages(ping, { profilesDir: dir, transient429BackoffMs: 200, sleep: sleepSpy });
    expect(result.status).toBe(200);
    expect(result.account).toBe('b@x.com');
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('transient429BackoffMs=0 disables the backoff', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({ error: { type: 'rate_limit_error', message: 'Error' } }), { status: 429 });
      return okResponse();
    });
    const sleepSpy = vi.fn(async () => {});
    await callMessages(ping, { profilesDir: dir, transient429BackoffMs: 0, sleep: sleepSpy });
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('backs off on every hop of a multi-account transient walk', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
      'c@x.com': profile('c@x.com', 'TOK_C'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      return call <= 2 ? transient429() : okResponse();
    });
    const sleepSpy = vi.fn(async () => {});
    const result = await callMessages(ping, { profilesDir: dir, transient429BackoffMs: 200, sleep: sleepSpy });
    expect(result.status).toBe(200);
    expect(result.account).toBe('c@x.com');
    // One backoff after each of the two transient hops (a→b, b→c).
    expect(sleepSpy).toHaveBeenCalledTimes(2);
    for (const [delay] of sleepSpy.mock.calls) {
      expect(delay).toBeGreaterThanOrEqual(150);
      expect(delay).toBeLessThanOrEqual(250);
    }
  });

  it('does not back off after the last candidate when the pool is exhausted', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    vi.spyOn(global, 'fetch').mockImplementation(async () => transient429());
    const sleepSpy = vi.fn(async () => {});
    const result = await callMessages(ping, { profilesDir: dir, transient429BackoffMs: 200, sleep: sleepSpy });
    expect(result.status).toBe(429);
    expect(result.account).toBe(null);
    expect(result.trigger).toBe('transient-429');
    // Sleep only between a→b; after b there is no next candidate, so no
    // pointless trailing backoff before the request fails.
    expect(sleepSpy).toHaveBeenCalledTimes(1);
  });

  it('reads the backoff duration from CCROTATE_TRANSIENT_429_BACKOFF_MS when opts omits it', async () => {
    process.env.CCROTATE_TRANSIENT_429_BACKOFF_MS = '150';
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      return call === 1 ? transient429() : okResponse();
    });
    const sleepSpy = vi.fn(async () => {});
    const result = await callMessages(ping, { profilesDir: dir, sleep: sleepSpy });
    expect(result.status).toBe(200);
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    const delay = sleepSpy.mock.calls[0][0];
    expect(delay).toBeGreaterThanOrEqual(112.5); // 150 * 0.75
    expect(delay).toBeLessThanOrEqual(187.5);    // 150 * 1.25
  });

  it('falls back to the 400ms default when the env value is empty (not Number("")→0 disable)', async () => {
    process.env.CCROTATE_TRANSIENT_429_BACKOFF_MS = '';
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      return call === 1 ? transient429() : okResponse();
    });
    const sleepSpy = vi.fn(async () => {});
    await callMessages(ping, { profilesDir: dir, sleep: sleepSpy });
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    const delay = sleepSpy.mock.calls[0][0];
    expect(delay).toBeGreaterThanOrEqual(300); // 400 * 0.75 — backoff still ON
    expect(delay).toBeLessThanOrEqual(500);    // 400 * 1.25
  });

  it('degrades to immediate rotation when the backoff sleep rejects', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      return call === 1 ? transient429() : okResponse();
    });
    const sleepSpy = vi.fn(async () => { throw new Error('sleep boom'); });
    const result = await callMessages(ping, { profilesDir: dir, transient429BackoffMs: 200, sleep: sleepSpy });
    // A rejecting backoff must not abort the request — it rotates and succeeds.
    expect(result.status).toBe(200);
    expect(result.account).toBe('b@x.com');
    expect(sleepSpy).toHaveBeenCalledTimes(1);
  });
});

describe('anthropic-client.callMessages — verify-on-429 via Usage API', () => {
  // Incident handoff: 2026-05-19. classifyQuotaError marked transient
  // per-account RPM throttles as structural because Anthropic's
  // anthropic-ratelimit-tokens-reset header points 3+ hours out even on
  // burst throttles. Pool got poisoned across 11/15 accounts in seconds.
  // Fix: probe /api/oauth/usage and only mark exhausted when utilization
  // confirms it.
  let dir;
  beforeEach(() => { dir = tmpProfilesDir(); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

  function structuralQuotaBody() {
    // ~2h out so the horizon gate reads structural.
    const epoch = Math.floor(Date.now() / 1000) + 7200;
    return JSON.stringify({
      error: {
        type: 'rate_limit_error',
        message: `You have exceeded your usage limit. Resets at unix ${epoch}.`,
      },
    });
  }
  const ping = { model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}] };
  const okBody = JSON.stringify({
    id:'m', type:'message', role:'assistant',
    model:'claude-haiku-4-5-20251001',
    content:[{type:'text', text:'ok'}], stop_reason:'end_turn',
    usage:{input_tokens:1, output_tokens:1},
  });

  it('demotes structural 429 to transient when 5h+7d util both < 95%', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 1) return new Response(structuralQuotaBody(), { status: 429 });
      return new Response(okBody, { status: 200 });
    });
    const probe = vi.fn(async () => ({ utilization5h: 14, utilization7d: 3, stale: false }));

    const result = await callMessages(ping, { profilesDir: dir, probeUsageApi: probe });

    expect(probe).toHaveBeenCalledOnce();
    expect(result.status).toBe(200);
    expect(result.account).toBe('b@x.com');
    // markExhausted MUST NOT have run — the demoted account is still picky-eligible
    // for the next request (transient-429 path doesn't write tier-cache).
    expect(fs.existsSync(path.join(dir, 'tier-cache.json'))).toBe(false);
    expect(result.trigger).toBe('transient-429');
  });

  it('still marks exhausted when probe confirms util5h >= 95%', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 1) return new Response(structuralQuotaBody(), { status: 429 });
      return new Response(okBody, { status: 200 });
    });
    const probe = vi.fn(async () => ({ utilization5h: 100, utilization7d: 19, stale: false }));

    const result = await callMessages(ping, { profilesDir: dir, probeUsageApi: probe });

    expect(probe).toHaveBeenCalledOnce();
    expect(result.status).toBe(200);
    expect(result.trigger).toBe('quota');
    const tc = JSON.parse(fs.readFileSync(path.join(dir, 'tier-cache.json'), 'utf8'));
    const aEntry = (tc.accounts || []).find(a => a.email === 'a@x.com');
    expect(isAccountExhausted(aEntry, { model: 'claude-haiku-4-5-20251001' })).toBe(true);
  });

  it('still marks exhausted when probe confirms util7d >= 95%', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 1) return new Response(structuralQuotaBody(), { status: 429 });
      return new Response(okBody, { status: 200 });
    });
    const probe = vi.fn(async () => ({ utilization5h: 40, utilization7d: 99, stale: false }));

    const result = await callMessages(ping, { profilesDir: dir, probeUsageApi: probe });

    expect(result.trigger).toBe('quota');
    const tc = JSON.parse(fs.readFileSync(path.join(dir, 'tier-cache.json'), 'utf8'));
    const aEntry = (tc.accounts || []).find(a => a.email === 'a@x.com');
    expect(isAccountExhausted(aEntry, { model: 'claude-haiku-4-5-20251001' })).toBe(true);
  });

  it('still demotes when util7d is null (5h is the only signal)', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 1) return new Response(structuralQuotaBody(), { status: 429 });
      return new Response(okBody, { status: 200 });
    });
    const probe = vi.fn(async () => ({ utilization5h: 10, utilization7d: null, stale: false }));

    const result = await callMessages(ping, { profilesDir: dir, probeUsageApi: probe });

    expect(result.trigger).toBe('transient-429');
    expect(fs.existsSync(path.join(dir, 'tier-cache.json'))).toBe(false);
  });

  it('is conservative when probe returns null (trusts the 429)', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 1) return new Response(structuralQuotaBody(), { status: 429 });
      return new Response(okBody, { status: 200 });
    });
    const probe = vi.fn(async () => null);

    const result = await callMessages(ping, { profilesDir: dir, probeUsageApi: probe });

    expect(result.trigger).toBe('quota');
    const tc = JSON.parse(fs.readFileSync(path.join(dir, 'tier-cache.json'), 'utf8'));
    const aEntry = (tc.accounts || []).find(a => a.email === 'a@x.com');
    expect(isAccountExhausted(aEntry, { model: 'claude-haiku-4-5-20251001' })).toBe(true);
  });

  it('is conservative when probe throws (trusts the 429)', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 1) return new Response(structuralQuotaBody(), { status: 429 });
      return new Response(okBody, { status: 200 });
    });
    const probe = vi.fn(async () => { throw new Error('boom'); });

    const result = await callMessages(ping, { profilesDir: dir, probeUsageApi: probe });

    expect(result.trigger).toBe('quota');
    const tc = JSON.parse(fs.readFileSync(path.join(dir, 'tier-cache.json'), 'utf8'));
    const aEntry = (tc.accounts || []).find(a => a.email === 'a@x.com');
    expect(isAccountExhausted(aEntry, { model: 'claude-haiku-4-5-20251001' })).toBe(true);
  });

  it('is conservative when probe returns util5h:null (cannot confirm low)', async () => {
    // Edge case: payload had seven_day but no five_hour. Without a 5h
    // signal we cannot confidently demote — the burst could have hit the
    // 5h cap that the API simply doesn't expose for this account.
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 1) return new Response(structuralQuotaBody(), { status: 429 });
      return new Response(okBody, { status: 200 });
    });
    const probe = vi.fn(async () => ({ utilization5h: null, utilization7d: 3, stale: false }));

    const result = await callMessages(ping, { profilesDir: dir, probeUsageApi: probe });

    expect(result.trigger).toBe('quota');
    const tc = JSON.parse(fs.readFileSync(path.join(dir, 'tier-cache.json'), 'utf8'));
    const aEntry = (tc.accounts || []).find(a => a.email === 'a@x.com');
    expect(isAccountExhausted(aEntry, { model: 'claude-haiku-4-5-20251001' })).toBe(true);
  });

  it('respects stale LKG values when demoting', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 1) return new Response(structuralQuotaBody(), { status: 429 });
      return new Response(okBody, { status: 200 });
    });
    // Probe served the LKG snapshot (stale:true) because the token is on
    // Usage-API cooldown. 5h/7d windows move slowly — a stale 14%/3% is
    // still a strong negative signal against 3-hour exhaustion.
    const probe = vi.fn(async () => ({ utilization5h: 14, utilization7d: 3, stale: true }));

    const result = await callMessages(ping, { profilesDir: dir, probeUsageApi: probe });

    expect(result.trigger).toBe('transient-429');
    expect(fs.existsSync(path.join(dir, 'tier-cache.json'))).toBe(false);
  });

  it('does not probe when the 429 was classified transient (no structural escalation)', async () => {
    // A burst-429 with retry-after:5s never enters the structural branch,
    // so the probe must not be called.
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }),
          { status: 429, headers: { 'retry-after': '5' } },
        );
      }
      return new Response(okBody, { status: 200 });
    });
    const probe = vi.fn(async () => ({ utilization5h: 100, utilization7d: 100, stale: false }));

    const result = await callMessages(ping, { profilesDir: dir, probeUsageApi: probe });

    expect(probe).not.toHaveBeenCalled();
    expect(result.trigger).toBe('transient-429');
  });
});

describe('anthropic-client.callMessages — cross-write self-heal on 429-structural', () => {
  // Paperclip incident 2026-05-19 follow-up. Identity probe inside the
  // structural-429 branch: BEFORE markExhausted, check /api/oauth/profile
  // to confirm the token's owning identity matches the profile email
  // we're serving. Mismatch = profiles.json is cross-wired (the original
  // 9-of-15 incident pattern). On detection: skip markExhausted (the 429
  // is on the wrong identity), fire triggerRelogin so the auth-bot
  // heals the cross-wire, treat the response as transient-429 and
  // rotate. The kept-narrow scope (only fires on 429-structural, not
  // every 200) keeps the probe traffic low.
  let dir;
  beforeEach(() => { dir = tmpProfilesDir(); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

  function structuralQuotaBody() {
    const epoch = Math.floor(Date.now() / 1000) + 7200;
    return JSON.stringify({
      error: { type: 'rate_limit_error', message: `resets at ${epoch}` },
    });
  }
  const ping = { model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}] };
  const okBody = JSON.stringify({
    id:'m', type:'message', role:'assistant',
    model:'claude-haiku-4-5-20251001',
    content:[{type:'text', text:'ok'}], stop_reason:'end_turn',
    usage:{input_tokens:1, output_tokens:1},
  });

  it('skips markExhausted and fires relogin when identity probe shows cross-write', async () => {
    writeProfiles(dir, {
      'wrong-key@x.com': profile('wrong-key@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'wrong-key@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 1) return new Response(structuralQuotaBody(), { status: 429 });
      return new Response(okBody, { status: 200 });
    });
    // Usage probe says util high (would normally markExhausted)
    const probeUsage = vi.fn(async () => ({ utilization5h: 100, utilization7d: 99, stale: false }));
    // Identity probe says the token actually belongs to a DIFFERENT email
    const probeProfile = vi.fn(async () => ({ email: 'real-owner@x.com', uuid: 'u-real', stale: false }));
    const trigger = vi.fn(() => true);

    const result = await callMessages(ping, {
      profilesDir: dir,
      probeUsageApi: probeUsage,
      probeOauthProfile: probeProfile,
      triggerRelogin: trigger,
    });

    expect(result.status).toBe(200);
    expect(result.account).toBe('b@x.com');
    expect(result.trigger).toBe('transient-429');
    // Cross-write detected → relogin fired for the cross-wired profile
    expect(trigger).toHaveBeenCalledWith('wrong-key@x.com', 'claude');
    // markExhausted MUST NOT have been called (the 429 was on the wrong identity)
    expect(fs.existsSync(path.join(dir, 'tier-cache.json'))).toBe(false);
  });

  it('proceeds with markExhausted normally when identity matches (no cross-write)', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 1) return new Response(structuralQuotaBody(), { status: 429 });
      return new Response(okBody, { status: 200 });
    });
    const probeUsage = vi.fn(async () => ({ utilization5h: 100, utilization7d: 99, stale: false }));
    // Identity probe says the token belongs to the SAME email (no cross-write)
    const probeProfile = vi.fn(async () => ({ email: 'a@x.com', uuid: 'u-a', stale: false }));
    const trigger = vi.fn(() => true);

    const result = await callMessages(ping, {
      profilesDir: dir,
      probeUsageApi: probeUsage,
      probeOauthProfile: probeProfile,
      triggerRelogin: trigger,
    });

    expect(result.trigger).toBe('quota');
    expect(trigger).not.toHaveBeenCalled();
    const tc = JSON.parse(fs.readFileSync(path.join(dir, 'tier-cache.json'), 'utf8'));
    const aEntry = (tc.accounts || []).find(a => a.email === 'a@x.com');
    expect(isAccountExhausted(aEntry, { model: 'claude-haiku-4-5-20251001' })).toBe(true);
  });

  it('case-insensitive identity match (operator-entered Mixed-Case email vs Anthropic lowercase)', async () => {
    writeProfiles(dir, { 'Mixed@X.com': profile('Mixed@X.com', 'TOK_A') }, 'Mixed@X.com');
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(structuralQuotaBody(), { status: 429 }));
    const probeUsage = vi.fn(async () => ({ utilization5h: 100, utilization7d: 99, stale: false }));
    const probeProfile = vi.fn(async () => ({ email: 'mixed@x.com', uuid: 'u', stale: false }));
    const trigger = vi.fn(() => true);

    await callMessages(ping, {
      profilesDir: dir,
      probeUsageApi: probeUsage,
      probeOauthProfile: probeProfile,
      triggerRelogin: trigger,
    });

    // No cross-write, no relogin trigger
    expect(trigger).not.toHaveBeenCalled();
  });

  it('proceeds with markExhausted normally when the identity probe fails (conservative)', async () => {
    // If we can't tell whether identities match, fall back to the
    // existing 429-structural path. Don't fire spurious relogins.
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 1) return new Response(structuralQuotaBody(), { status: 429 });
      return new Response(okBody, { status: 200 });
    });
    const probeUsage = vi.fn(async () => ({ utilization5h: 100, utilization7d: 99, stale: false }));
    const probeProfile = vi.fn(async () => null); // probe failed
    const trigger = vi.fn(() => true);

    const result = await callMessages(ping, {
      profilesDir: dir,
      probeUsageApi: probeUsage,
      probeOauthProfile: probeProfile,
      triggerRelogin: trigger,
    });

    expect(result.trigger).toBe('quota');
    expect(trigger).not.toHaveBeenCalled();
  });

  it('does NOT probe identity when the 429 was demoted (low util) — already handled', async () => {
    // When verify-on-429 demotes the 429 to transient, we never enter
    // the markExhausted branch, so no identity check is needed.
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 1) return new Response(structuralQuotaBody(), { status: 429 });
      return new Response(okBody, { status: 200 });
    });
    // Usage probe says low util → demoted
    const probeUsage = vi.fn(async () => ({ utilization5h: 14, utilization7d: 3, stale: false }));
    const probeProfile = vi.fn(async () => ({ email: 'real-owner@x.com', uuid: 'u', stale: false }));
    const trigger = vi.fn(() => true);

    await callMessages(ping, {
      profilesDir: dir,
      probeUsageApi: probeUsage,
      probeOauthProfile: probeProfile,
      triggerRelogin: trigger,
    });

    expect(probeProfile).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });

  it('swallows a thrown identity probe without aborting the request', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 1) return new Response(structuralQuotaBody(), { status: 429 });
      return new Response(okBody, { status: 200 });
    });
    const probeUsage = vi.fn(async () => ({ utilization5h: 100, utilization7d: 99, stale: false }));
    const probeProfile = vi.fn(async () => { throw new Error('boom'); });
    const trigger = vi.fn(() => true);

    const result = await callMessages(ping, {
      profilesDir: dir,
      probeUsageApi: probeUsage,
      probeOauthProfile: probeProfile,
      triggerRelogin: trigger,
    });

    expect(result.status).toBe(200);
    expect(result.trigger).toBe('quota');
    expect(trigger).not.toHaveBeenCalled();
  });
});

describe('anthropic-client.callMessages — auto-relogin trigger on refresh-fail', () => {
  // Self-heal hook (paperclip incident 2026-05-19 follow-up). When the
  // stored refresh_token can't mint a new access_token, callMessages
  // rotates (THIS request is served by the next account) AND fires a
  // fire-and-forget relogin notification at the auth-bot so the
  // dead profile gets healed for the next request. No more "rotated
  // forever, manual operator relogin to fix".
  let dir;
  beforeEach(() => { dir = tmpProfilesDir(); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

  const ping = { model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}] };
  const okBody = JSON.stringify({
    id:'m', type:'message', role:'assistant',
    model:'claude-haiku-4-5-20251001',
    content:[{type:'text', text:'ok'}], stop_reason:'end_turn',
    usage:{input_tokens:1, output_tokens:1},
  });

  it('fires triggerRelogin with the failing account when refresh fails', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
      // 1: 401 on TOK_A   2: refresh→401   3: 200 on TOK_B
      if (opts.headers?.['Authorization'] === 'Bearer TOK_A')
        return new Response('{}', { status: 401 });
      if (url === 'https://api.anthropic.com/api/oauth/token/refresh')
        return new Response(JSON.stringify({ error: 'bad refresh' }), { status: 401 });
      return new Response(okBody, { status: 200 });
    });
    const trigger = vi.fn(() => true);

    const result = await callMessages(ping, { profilesDir: dir, triggerRelogin: trigger });

    expect(result.status).toBe(200);
    expect(result.account).toBe('b@x.com');
    expect(result.trigger).toBe('refresh-fail');
    // The dead account triggers a relogin, the rotation target does not.
    expect(trigger).toHaveBeenCalledOnce();
    expect(trigger).toHaveBeenCalledWith('a@x.com', 'claude');
  });

  it('does NOT fire triggerRelogin on a clean rotation (no 401 anywhere)', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(okBody, { status: 200 }));
    const trigger = vi.fn(() => true);

    await callMessages(ping, { profilesDir: dir, triggerRelogin: trigger });

    expect(trigger).not.toHaveBeenCalled();
  });

  it('does NOT fire triggerRelogin when refresh succeeds (no relogin needed)', async () => {
    writeProfiles(dir, { 'a@x.com': profile('a@x.com', 'TOK_A') }, 'a@x.com');
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'NEW', refresh_token: 'NEW_RT', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(okBody, { status: 200 }));
    const trigger = vi.fn(() => true);

    const result = await callMessages(ping, { profilesDir: dir, triggerRelogin: trigger });

    expect(result.status).toBe(200);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('swallows a thrown triggerRelogin without aborting the rotation', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
      if (opts.headers?.['Authorization'] === 'Bearer TOK_A')
        return new Response('{}', { status: 401 });
      if (url === 'https://api.anthropic.com/api/oauth/token/refresh')
        return new Response('{}', { status: 401 });
      return new Response(okBody, { status: 200 });
    });
    const trigger = vi.fn(() => { throw new Error('boom'); });

    const result = await callMessages(ping, { profilesDir: dir, triggerRelogin: trigger });

    expect(result.status).toBe(200);
    expect(result.account).toBe('b@x.com');
    expect(trigger).toHaveBeenCalledOnce();
  });
});

describe('pickNextCandidate — operator-switch survives exhausted skip', () => {
  // Issue 2 handoff (2026-05-19). Defense-in-depth alongside Issue 1's
  // verify-on-429: when an operator runs `/ccrotate:switch <email>`,
  // pickNextCandidate must surface that account as the next candidate
  // even if tier-cache has it marked exhausted. The exhausted filter
  // applies to every OTHER account in the pool, just not the operator's
  // active choice. Without this, a tier-cache hangover (from a past
  // cascade or a model-scoped opus mark on a haiku request) makes
  // the switch silently no-op.
  function mkStore({ profiles, activeEmail = null, tierCacheAccounts = [] }) {
    return {
      async getProfiles() { return profiles; },
      async getActiveEmail() { return activeEmail; },
      async getTierCache() { return { accounts: tierCacheAccounts }; },
    };
  }
  function mkProfile(email, withToken = true) {
    return {
      credentials: withToken
        ? { claudeAiOauth: { accessToken: `at-${email}`, refreshToken: `rt-${email}`, expiresAt: Date.now() + 3600_000 } }
        : { claudeAiOauth: {} },
    };
  }

  it('returns the active email even when tier-cache marks it exhausted', async () => {
    const store = mkStore({
      profiles: {
        'bot5@blockcast.net': mkProfile('bot5@blockcast.net'),
        'other@blockcast.net': mkProfile('other@blockcast.net'),
      },
      activeEmail: 'bot5@blockcast.net',
      tierCacheAccounts: [{
        email: 'bot5@blockcast.net',
        status: 'success',
        serviceTier: 'exhausted',
        rateLimits: { reset5h: Math.floor(Date.now() / 1000) + 3600 },
      }],
    });
    const pick = await pickNextCandidate(store, new Set(), 'claude-haiku-4-5-20251001');
    expect(pick?.email).toBe('bot5@blockcast.net');
  });

  it('falls through to the unexhausted walk when active is already in alreadyTried', async () => {
    const store = mkStore({
      profiles: {
        'bot5@blockcast.net': mkProfile('bot5@blockcast.net'),
        'other@blockcast.net': mkProfile('other@blockcast.net'),
      },
      activeEmail: 'bot5@blockcast.net',
      tierCacheAccounts: [{
        email: 'bot5@blockcast.net',
        status: 'success',
        serviceTier: 'exhausted',
        rateLimits: { reset5h: Math.floor(Date.now() / 1000) + 3600 },
      }],
    });
    const pick = await pickNextCandidate(store, new Set(['bot5@blockcast.net']), 'claude-haiku-4-5-20251001');
    expect(pick?.email).toBe('other@blockcast.net');
  });

  it('falls through when the active email has no OAuth token (e.g. mid-registration)', async () => {
    const store = mkStore({
      profiles: {
        'bot5@blockcast.net': mkProfile('bot5@blockcast.net', false), // no token
        'other@blockcast.net': mkProfile('other@blockcast.net'),
      },
      activeEmail: 'bot5@blockcast.net',
      tierCacheAccounts: [],
    });
    const pick = await pickNextCandidate(store, new Set(), 'claude-haiku-4-5-20251001');
    expect(pick?.email).toBe('other@blockcast.net');
  });

  it('does not change behavior when no active email is set (preserves Object.entries order)', async () => {
    const store = mkStore({
      profiles: {
        'a@x.com': mkProfile('a@x.com'),
        'b@x.com': mkProfile('b@x.com'),
      },
      activeEmail: null,
      tierCacheAccounts: [{
        email: 'a@x.com',
        status: 'success',
        serviceTier: 'exhausted',
        rateLimits: { reset5h: Math.floor(Date.now() / 1000) + 3600 },
      }],
    });
    const pick = await pickNextCandidate(store, new Set(), 'claude-opus-4-7');
    expect(pick?.email).toBe('b@x.com');
  });

  it('does not return the active email when it is not in profiles (stale active pointer)', async () => {
    const store = mkStore({
      profiles: {
        'a@x.com': mkProfile('a@x.com'),
      },
      activeEmail: 'deleted@x.com', // pointer references a profile that's gone
      tierCacheAccounts: [],
    });
    const pick = await pickNextCandidate(store, new Set(), 'claude-opus-4-7');
    expect(pick?.email).toBe('a@x.com');
  });
});
