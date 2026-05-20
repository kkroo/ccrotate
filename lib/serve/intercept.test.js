import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  parseMarker,
  extractUserText,
  synthesizeMessagesResponse,
  synthesizeChatResponse,
  synthesizeResponsesResponse,
  synthesizeMessagesSse,
  tryIntercept,
  __test__,
} from './intercept.js';

describe('parseMarker', () => {
  it('extracts cmd from a bare marker', () => {
    expect(parseMarker('<!-- ccrotate-serve:cmd=when -->')).toEqual({ cmd: 'when', args: '' });
  });
  it('extracts cmd + args', () => {
    expect(parseMarker('<!-- ccrotate-serve:cmd=switch args=user@example.com -->'))
      .toEqual({ cmd: 'switch', args: 'user@example.com' });
  });
  it('is case-insensitive on the marker prefix', () => {
    expect(parseMarker('<!-- CCROTATE-SERVE:CMD=when -->')).toEqual({ cmd: 'when', args: '' });
  });
  it('returns null when no marker is present', () => {
    expect(parseMarker('hello world')).toBeNull();
    expect(parseMarker('')).toBeNull();
    expect(parseMarker(null)).toBeNull();
    expect(parseMarker(undefined)).toBeNull();
  });
  it('ignores markers with bad cmd characters', () => {
    expect(parseMarker('<!-- ccrotate-serve:cmd=$$$ -->')).toBeNull();
  });
});

describe('extractUserText', () => {
  it('reads anthropic messages with string content', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] };
    expect(extractUserText(body)).toBe('hi');
  });
  it('reads anthropic messages with array content (text blocks)', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] },
      ],
    };
    expect(extractUserText(body)).toBe('first\nsecond');
  });
  it('returns the LAST user message when assistant turns are interleaved', () => {
    const body = {
      messages: [
        { role: 'user', content: 'old' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'new' },
      ],
    };
    expect(extractUserText(body)).toBe('new');
  });
  it('reads openai responses body with string input', () => {
    expect(extractUserText({ input: 'hello' })).toBe('hello');
  });
  it('reads openai responses body with array input', () => {
    const body = {
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'q1' }] },
      ],
    };
    expect(extractUserText(body)).toBe('q1');
  });
  it('returns empty string for empty bodies', () => {
    expect(extractUserText({})).toBe('');
    expect(extractUserText(null)).toBe('');
  });
});

describe('synthesizers', () => {
  it('synthesizeMessagesResponse has the Anthropic message shape', () => {
    const m = synthesizeMessagesResponse('hello');
    expect(m.type).toBe('message');
    expect(m.role).toBe('assistant');
    expect(m.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(m.stop_reason).toBe('end_turn');
    expect(m.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
  it('synthesizeChatResponse has the OpenAI chat completion shape', () => {
    const c = synthesizeChatResponse('hi');
    expect(c.object).toBe('chat.completion');
    expect(c.choices[0].message.content).toBe('hi');
    expect(c.usage.total_tokens).toBe(0);
  });
  it('synthesizeResponsesResponse has the OpenAI responses shape', () => {
    const r = synthesizeResponsesResponse('payload');
    expect(r.object).toBe('response');
    expect(r.status).toBe('completed');
    expect(r.output[0].content[0]).toEqual({ type: 'output_text', text: 'payload' });
  });
  it('synthesizeMessagesSse emits the canonical event sequence', () => {
    const sse = synthesizeMessagesSse('streamed');
    expect(sse).toContain('event: message_start');
    expect(sse).toContain('event: content_block_start');
    expect(sse).toContain('event: content_block_delta');
    expect(sse).toContain('"text_delta"');
    expect(sse).toContain('streamed');
    expect(sse).toContain('event: message_stop');
  });
});

describe('tryIntercept — dispatch', () => {
  function makeFakeCcrotate() {
    const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-intercept-'));
    return {
      target: 'claude',
      profilesDir,
      setTarget: vi.fn(function (t) { this.target = t; }),
      getTargetName() { return this.target === 'claude' ? 'Claude Code' : 'Codex'; },
      isCodexTarget() { return this.target === 'codex'; },
      getCurrentAccount: vi.fn(() => ({ email: 'active@x' })),
      loadProfiles: vi.fn(() => ({ 'a@x': { credentials: {} }, 'b@x': { credentials: {} } })),
      loadTierCache: vi.fn(() => ({
        updatedAt: new Date().toISOString(),
        accounts: [
          { email: 'a@x', serviceTier: 'exhausted', rateLimits: { reset5h: Math.floor(Date.now() / 1000) + 3600 } },
          { email: 'b@x', serviceTier: 'available' },
        ],
      })),
      loadConfig: vi.fn(() => ({ extraUsage: 'prompt' })),
      next: vi.fn(async () => ({ email: 'b@x' })),
    };
  }

  // A fake StateStore — the same async surface HttpStateStore exposes.
  function makeFakeStore(overrides = {}) {
    return {
      getProfiles: vi.fn(async () => ({
        'a@x': { provider: 'claude', credentials: { claudeAiOauth: { accessToken: null } } },
        'b@x': { provider: 'claude', credentials: { claudeAiOauth: { accessToken: null } } },
      })),
      getCodexProfiles: vi.fn(async () => ({})),
      getTierCache: vi.fn(async () => ({ updatedAt: new Date().toISOString(), accounts: [] })),
      getCodexTierCache: vi.fn(async () => ({ updatedAt: null, accounts: [] })),
      getActiveEmail: vi.fn(async () => 'active@x'),
      setActiveEmail: vi.fn(async () => {}),
      import: vi.fn(async () => ({ accounts: 2, added: 1, updated: 1, kept: 0, tierMerged: 0 })),
      ...overrides,
    };
  }

  it('returns null when there is no marker', async () => {
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: 'just a normal prompt' }] },
      endpoint: 'messages',
      wantsStream: false,
      ccrotate: makeFakeCcrotate(),
    });
    expect(r).toBeNull();
  });

  it('returns null when ccrotate is missing', async () => {
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: '<!-- ccrotate-serve:cmd=when -->' }] },
      endpoint: 'messages',
      wantsStream: false,
      ccrotate: null,
    });
    expect(r).toBeNull();
  });

  it('cmd=when hydrates from the store, then renders a pool table', async () => {
    const store = makeFakeStore();
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: '<!-- ccrotate-serve:cmd=when -->' }] },
      endpoint: 'messages',
      wantsStream: false,
      ccrotate: makeFakeCcrotate(),
      store,
    });
    expect(r.status).toBe(200);
    expect(r.headers['X-Ccrotate-Intercepted']).toBe('when');
    // Hydration pulled all five state files.
    expect(store.getProfiles).toHaveBeenCalled();
    expect(store.getCodexProfiles).toHaveBeenCalled();
    expect(store.getTierCache).toHaveBeenCalled();
    expect(store.getCodexTierCache).toHaveBeenCalled();
    expect(store.getActiveEmail).toHaveBeenCalled();
    const parsed = JSON.parse(r.body);
    expect(parsed.type).toBe('message');
    expect(parsed.content[0].text).toContain('ccrotate pool');
  });

  it('intercepts /v1/messages stream=true with SSE body', async () => {
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: '<!-- ccrotate-serve:cmd=help -->' }] },
      endpoint: 'messages',
      wantsStream: true,
      ccrotate: makeFakeCcrotate(),
      store: makeFakeStore(),
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/event-stream');
    expect(r.body).toContain('event: message_start');
    expect(r.body).toContain('event: message_stop');
  });

  it('cmd=health on /v1/chat/completions returns OpenAI shape', async () => {
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: '<!-- ccrotate-serve:cmd=health -->' }] },
      endpoint: 'chat',
      wantsStream: false,
      ccrotate: makeFakeCcrotate(),
      store: makeFakeStore(),
      serveStartedAt: Date.now() - 5000,
    });
    expect(r.status).toBe(200);
    const parsed = JSON.parse(r.body);
    expect(parsed.object).toBe('chat.completion');
    expect(parsed.choices[0].message.content).toContain('ccrotate-serve');
  });

  it('cmd=status on /v1/responses reports the active account', async () => {
    const r = await tryIntercept({
      body: { input: [{ role: 'user', content: [{ type: 'input_text', text: '<!-- ccrotate-serve:cmd=status -->' }] }] },
      endpoint: 'responses',
      wantsStream: false,
      ccrotate: makeFakeCcrotate(),
      store: makeFakeStore(),
    });
    expect(r.status).toBe(200);
    const parsed = JSON.parse(r.body);
    expect(parsed.object).toBe('response');
    expect(parsed.output[0].content[0].text).toContain('active@x');
  });

  it('switch validates against the pool and writes through the store', async () => {
    const store = makeFakeStore();
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: '<!-- ccrotate-serve:cmd=switch args=a@x -->' }] },
      endpoint: 'messages',
      wantsStream: false,
      ccrotate: makeFakeCcrotate(),
      store,
    });
    expect(r.status).toBe(200);
    expect(store.setActiveEmail).toHaveBeenCalledWith('a@x');
    expect(JSON.parse(r.body).content[0].text).toContain('switched active account → a@x');
  });

  it('switch rejects a malformed email without touching the store', async () => {
    const store = makeFakeStore();
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: '<!-- ccrotate-serve:cmd=switch args=not-an-email -->' }] },
      endpoint: 'messages',
      wantsStream: false,
      ccrotate: makeFakeCcrotate(),
      store,
    });
    expect(r.status).toBe(200);
    expect(store.setActiveEmail).not.toHaveBeenCalled();
    expect(JSON.parse(r.body).content[0].text).toContain('invalid email');
  });

  it('switch rejects an email that is not a saved account', async () => {
    const store = makeFakeStore();
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: '<!-- ccrotate-serve:cmd=switch args=ghost@nowhere.com -->' }] },
      endpoint: 'messages',
      wantsStream: false,
      ccrotate: makeFakeCcrotate(),
      store,
    });
    expect(store.setActiveEmail).not.toHaveBeenCalled();
    expect(JSON.parse(r.body).content[0].text).toContain('not a saved account');
  });

  it('refresh probes the whole claude pool through the store', async () => {
    const prev = process.env.CCROTATE_REFRESH_INTER_PROBE_DELAY_MS;
    process.env.CCROTATE_REFRESH_INTER_PROBE_DELAY_MS = '0';
    try {
      const store = makeFakeStore();
      const r = await tryIntercept({
        body: { messages: [{ role: 'user', content: '<!-- ccrotate-serve:cmd=refresh -->' }] },
        endpoint: 'messages',
        wantsStream: false,
        ccrotate: makeFakeCcrotate(),
        store,
      });
      expect(r.status).toBe(200);
      const text = JSON.parse(r.body).content[0].text;
      expect(text).toContain('probed 2 claude account(s)');
      expect(text).toContain('a@x');
      expect(text).toContain('b@x');
    } finally {
      if (prev === undefined) delete process.env.CCROTATE_REFRESH_INTER_PROBE_DELAY_MS;
      else process.env.CCROTATE_REFRESH_INTER_PROBE_DELAY_MS = prev;
    }
  });

  it('import forwards the blob to store.import and renders the merge summary', async () => {
    const store = makeFakeStore();
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: '<!-- ccrotate-serve:cmd=import args=mp-gz-b64:deadbeef:AAAA -->' }] },
      endpoint: 'messages',
      wantsStream: false,
      ccrotate: makeFakeCcrotate(),
      store,
    });
    expect(r.status).toBe(200);
    expect(store.import).toHaveBeenCalledWith('mp-gz-b64:deadbeef:AAAA');
    const text = JSON.parse(r.body).content[0].text;
    expect(text).toContain('import complete');
    expect(text).toContain('1 new');
    expect(text).toContain('1 updated');
  });

  it('import without args reports a missing-blob message', async () => {
    const store = makeFakeStore();
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: '<!-- ccrotate-serve:cmd=import -->' }] },
      endpoint: 'messages',
      wantsStream: false,
      ccrotate: makeFakeCcrotate(),
      store,
    });
    expect(store.import).not.toHaveBeenCalled();
    expect(JSON.parse(r.body).content[0].text).toContain('missing args');
  });

  it('next picks the first non-current claude candidate via pickNextCandidate and writes the pointer through StateStore', async () => {
    // Serve-aware rotate: must NOT call ccrotate.next() (writes local
    // .credentials.json — ENOENT on PV-less serve pods). It must compute
    // the next email from the StateStore and publish via setActiveEmail.
    const fake = makeFakeCcrotate();
    const store = makeFakeStore({
      getProfiles: vi.fn(async () => ({
        'active@x': { credentials: { claudeAiOauth: { accessToken: 'tok-A' } } },
        'b@x': { credentials: { claudeAiOauth: { accessToken: 'tok-B' } } },
      })),
    });
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: '<!-- ccrotate-serve:cmd=next -->' }] },
      endpoint: 'messages',
      wantsStream: false,
      ccrotate: fake,
      store,
    });
    // The legacy CLI path must not fire — that's the ENOENT trap.
    expect(fake.next).not.toHaveBeenCalled();
    // Active account 'active@x' is in `tried`, so 'b@x' is picked.
    expect(store.setActiveEmail).toHaveBeenCalledWith('b@x');
    expect(JSON.parse(r.body).content[0].text).toContain('rotated claude → b@x');
  });

  it('next reports failure cleanly when the pool has no usable candidate (no setActiveEmail call)', async () => {
    const fake = makeFakeCcrotate();
    const store = makeFakeStore({
      // Only one profile, and it's the current active — `tried` includes it,
      // so pickNextCandidate has no other email to return.
      getProfiles: vi.fn(async () => ({
        'active@x': { credentials: { claudeAiOauth: { accessToken: 'tok-A' } } },
      })),
    });
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: '<!-- ccrotate-serve:cmd=next -->' }] },
      endpoint: 'messages',
      wantsStream: false,
      ccrotate: fake,
      store,
    });
    expect(store.setActiveEmail).not.toHaveBeenCalled();
    expect(JSON.parse(r.body).content[0].text).toContain('rotate failed');
    expect(JSON.parse(r.body).content[0].text).toContain('no usable next account');
  });

  it('snap returns informational text without touching ccrotate', async () => {
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: '<!-- ccrotate-serve:cmd=snap -->' }] },
      endpoint: 'messages',
      wantsStream: false,
      ccrotate: makeFakeCcrotate(),
      store: makeFakeStore(),
    });
    expect(JSON.parse(r.body).content[0].text).toContain('must run locally');
  });

  it('unknown command surfaces the available list', async () => {
    const r = await tryIntercept({
      body: { messages: [{ role: 'user', content: '<!-- ccrotate-serve:cmd=banana -->' }] },
      endpoint: 'messages',
      wantsStream: false,
      ccrotate: makeFakeCcrotate(),
      store: makeFakeStore(),
    });
    expect(JSON.parse(r.body).content[0].text).toContain('unknown command');
    expect(JSON.parse(r.body).content[0].text).toContain('when');
  });
});

describe('HANDLERS.setsession (G5 — operator sessionKey paste)', () => {
  const { HANDLERS } = __test__;

  const validSessionKey = 'sk-ant-sid01-' + 'x'.repeat(60);

  it('errors when CCROTATE_RELOGIN_TRIGGER_URL is unset', async () => {
    const prev = process.env.CCROTATE_RELOGIN_TRIGGER_URL;
    delete process.env.CCROTATE_RELOGIN_TRIGGER_URL;
    try {
      const out = await HANDLERS.setsession({ args: `bot4@x.com ${validSessionKey}` });
      expect(out).toContain('CCROTATE_RELOGIN_TRIGGER_URL not set');
    } finally {
      if (prev !== undefined) process.env.CCROTATE_RELOGIN_TRIGGER_URL = prev;
    }
  });

  it('rejects malformed args without making a network call', async () => {
    process.env.CCROTATE_RELOGIN_TRIGGER_URL = 'http://bot-test:7000';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) });
    try {
      // Missing sessionKey
      expect(await HANDLERS.setsession({ args: 'bot4@x.com' })).toContain('missing sessionKey');
      // Bad email
      expect(await HANDLERS.setsession({ args: `noatsign ${validSessionKey}` })).toContain('malformed email');
      // Wrong sessionKey prefix
      expect(await HANDLERS.setsession({ args: 'bot4@x.com sk-NOT-ant-too-short' })).toContain('sessionKey shape check failed');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      delete process.env.CCROTATE_RELOGIN_TRIGGER_URL;
    }
  });

  it('forwards to /setSession then /reloginViaSession and reports success', async () => {
    process.env.CCROTATE_RELOGIN_TRIGGER_URL = 'http://bot-test:7000';
    const calls = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ snapStdout: '✓ Account bot4@x.com saved successfully.' }),
        text: async () => '',
      };
    });
    try {
      const out = await HANDLERS.setsession({ args: `bot4@x.com ${validSessionKey}` });
      expect(calls).toHaveLength(2);
      expect(calls[0].url).toBe('http://bot-test:7000/setSession');
      expect(calls[0].body).toEqual({ email: 'bot4@x.com', target: 'claude', sessionKey: validSessionKey });
      expect(calls[1].url).toBe('http://bot-test:7000/reloginViaSession');
      expect(out).toContain('✓ bot4@x.com relogged in');
      expect(out).toContain('Account bot4@x.com saved successfully');
    } finally {
      fetchSpy.mockRestore();
      delete process.env.CCROTATE_RELOGIN_TRIGGER_URL;
    }
  });

  it('reports SESSIONKEY_IDENTITY_MISMATCH 409 with the resolved identity', async () => {
    process.env.CCROTATE_RELOGIN_TRIGGER_URL = 'http://bot-test:7000';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/setSession')) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
      }
      return {
        ok: false,
        status: 409,
        json: async () => ({
          error: 'mismatch',
          code: 'SESSIONKEY_IDENTITY_MISMATCH',
          requestedEmail: 'bot4@x.com',
          snappedEmail: 'ally@x.com',
        }),
        text: async () => '',
      };
    });
    try {
      const out = await HANDLERS.setsession({ args: `bot4@x.com ${validSessionKey}` });
      expect(out).toContain('sessionKey identity mismatch for bot4@x.com');
      expect(out).toContain('actually belongs to: ally@x.com');
    } finally {
      fetchSpy.mockRestore();
      delete process.env.CCROTATE_RELOGIN_TRIGGER_URL;
    }
  });
});
