import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { callMessages } from './anthropic-client.js';

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

  it('propagates 401 when both attempts fail', async () => {
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
    expect(result.status).toBe(401);
    expect(result.attempts).toBe(2);
  });
});
