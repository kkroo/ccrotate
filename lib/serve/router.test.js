import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouter } from './router.js';

function makeReq({ method = 'POST', url = '/v1/chat/completions', headers = {}, body = '' } = {}) {
  return { method, url, headers, body };
}

async function dispatch(router, req) {
  // The router exposes `dispatch(req)` that returns {status, headers, body}.
  return router.dispatch(req);
}

async function collectStream(stream) {
  let out = '';
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    out += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  }
  out += decoder.decode();
  return out;
}

describe('router — bearer auth + dispatch', () => {
  let mocks;
  beforeEach(() => {
    mocks = {
      callMessages: vi.fn(),
      callChat: vi.fn(),
      callResponses: vi.fn(),
      callEmbeddings: vi.fn(),
      profilesDir: '/tmp/fake',
      serveToken: 'tok-secret-32',
      hasAnthropic: true,
      hasOpenai: true,
    };
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns 200 on /healthz with no auth', async () => {
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({ method: 'GET', url: '/healthz' }));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).status).toBe('ok');
  });

  it('returns 401 on /v1/* without Authorization header', async () => {
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({ url: '/v1/chat/completions' }));
    expect(r.status).toBe(401);
  });

  it('returns 401 on /v1/* with wrong bearer', async () => {
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      url: '/v1/chat/completions',
      headers: { 'authorization': 'Bearer wrong' },
    }));
    expect(r.status).toBe(401);
  });

  it('returns /v1/models reflecting backend availability', async () => {
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      method: 'GET', url: '/v1/models',
      headers: { 'authorization': 'Bearer tok-secret-32' },
    }));
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.object).toBe('list');
    expect(body.data.some(m => m.owned_by === 'anthropic')).toBe(true);
    expect(body.data.some(m => m.owned_by === 'openai')).toBe(true);
  });

  it('routes /v1/messages claude-* → callMessages (Anthropic shape pass-through)', async () => {
    mocks.callMessages.mockResolvedValue({
      status: 200,
      response: new Response(JSON.stringify({id:'msg_1'}), {status: 200}),
      attempts: 1, account: 'a@x.com',
    });
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      url: '/v1/messages',
      headers: { 'authorization': 'Bearer tok-secret-32', 'content-type': 'application/json' },
      body: JSON.stringify({model: 'claude-haiku-4-5-20251001', max_tokens: 10,
                            messages: [{role: 'user', content: 'q'}]}),
    }));
    expect(mocks.callMessages).toHaveBeenCalledOnce();
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).id).toBe('msg_1');
  });

  it('passes Claude Code Opus [1m] model through unchanged', async () => {
    mocks.callMessages.mockResolvedValue({
      status: 200,
      response: new Response(JSON.stringify({id:'msg_1'}), {status: 200}),
      attempts: 1,
    });
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      url: '/v1/messages',
      headers: { 'authorization': 'Bearer tok-secret-32', 'content-type': 'application/json' },
      body: JSON.stringify({model: 'claude-opus-4-7[1m]', max_tokens: 10,
                            messages: [{role: 'user', content: 'q'}]}),
    }));
    expect(r.status).toBe(200);
    expect(mocks.callMessages.mock.calls[0][0].model).toBe('claude-opus-4-7[1m]');
  });

  it('routes Claude Code /v1/messages?beta=true by pathname', async () => {
    mocks.callMessages.mockResolvedValue({
      status: 200,
      response: new Response(JSON.stringify({id:'msg_1'}), {status: 200}),
      attempts: 1,
    });
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      url: '/v1/messages?beta=true',
      headers: { 'authorization': 'Bearer tok-secret-32', 'content-type': 'application/json' },
      body: JSON.stringify({model: 'claude-opus-4-7[1m]', max_tokens: 10,
                            messages: [{role: 'user', content: 'q'}]}),
    }));
    expect(r.status).toBe(200);
    expect(mocks.callMessages).toHaveBeenCalledOnce();
  });

  it('wraps /v1/messages stream:true responses as Anthropic SSE', async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start"}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta"}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    mocks.callMessages.mockResolvedValue({
      status: 200,
      response: new Response(sse, {status: 200, headers: {'content-type': 'text/event-stream'}}),
      attempts: 1,
    });
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      url: '/v1/messages?beta=true',
      headers: { 'authorization': 'Bearer tok-secret-32', 'content-type': 'application/json' },
      body: JSON.stringify({model: 'claude-opus-4-7[1m]', max_tokens: 10, stream: true,
                            messages: [{role: 'user', content: 'q'}]}),
    }));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/event-stream');
    const body = await collectStream(r.stream);
    expect(body).toContain('event: message_start');
    expect(body).toContain('event: content_block_delta');
    expect(body).toContain('event: message_stop');
    expect(mocks.callMessages.mock.calls[0][0].stream).toBe(true);
  });

  it('passes /v1/messages tool_use SSE through without buffering', async () => {
    const sse = [
      'event: content_block_start',
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"printf ok\\"}"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
      '',
    ].join('\n');
    mocks.callMessages.mockResolvedValue({
      status: 200,
      response: new Response(sse, {status: 200, headers: {'content-type': 'text/event-stream'}}),
      attempts: 1,
    });
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      url: '/v1/messages?beta=true',
      headers: { 'authorization': 'Bearer tok-secret-32', 'content-type': 'application/json' },
      body: JSON.stringify({model: 'claude-opus-4-7[1m]', max_tokens: 10, stream: true,
                            messages: [{role: 'user', content: 'q'}]}),
    }));
    expect(r.status).toBe(200);
    const body = await collectStream(r.stream);
    expect(body).toContain('"type":"tool_use"');
    expect(body).toContain('"type":"input_json_delta"');
    expect(body).toContain('"partial_json":"{\\"command\\":\\"printf ok\\"}"');
    expect(body).toContain('"stop_reason":"tool_use"');
  });

  it('returns 400 on /v1/messages with gpt-* model', async () => {
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      url: '/v1/messages',
      headers: { 'authorization': 'Bearer tok-secret-32' },
      body: JSON.stringify({model: 'gpt-4o-mini', max_tokens: 10, messages: []}),
    }));
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error.type).toBe('invalid_request_error');
  });

  it('routes /v1/chat/completions claude-* → translator → callMessages', async () => {
    mocks.callMessages.mockResolvedValue({
      status: 200,
      response: new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [{type:'text', text:'hi'}],
        stop_reason: 'end_turn',
        usage: {input_tokens: 1, output_tokens: 1},
      }), {status: 200}),
      attempts: 1, account: 'a@x.com',
    });
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      url: '/v1/chat/completions',
      headers: { 'authorization': 'Bearer tok-secret-32' },
      body: JSON.stringify({model: 'claude-haiku-4-5-20251001',
                            messages: [{role: 'user', content: 'q'}]}),
    }));
    expect(mocks.callMessages).toHaveBeenCalledOnce();
    // callMessages received an Anthropic-shape payload
    const calledWith = mocks.callMessages.mock.calls[0][0];
    expect(calledWith.system).toBeUndefined();
    expect(calledWith.max_tokens).toBe(4096);
    // Response was translated back to OpenAI shape
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toBe('hi');
  });

  it('routes /v1/chat/completions gpt-* → callChat (no translation)', async () => {
    mocks.callChat.mockResolvedValue({
      status: 200,
      response: new Response(JSON.stringify({id:'chatcmpl-x', choices:[]}), {status: 200}),
      attempts: 1,
    });
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      url: '/v1/chat/completions',
      headers: { 'authorization': 'Bearer tok-secret-32' },
      body: JSON.stringify({model: 'gpt-4o-mini', messages: [{role:'user', content:'q'}]}),
    }));
    expect(mocks.callChat).toHaveBeenCalledOnce();
    expect(r.status).toBe(200);
  });

  it('routes /v1/responses claude-* → Anthropic and returns Codex-compatible SSE', async () => {
    mocks.callMessages.mockResolvedValue({
      status: 200,
      response: new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [{type:'text', text:'hi'}],
        stop_reason: 'end_turn',
        usage: {input_tokens: 1, output_tokens: 1},
      }), {status: 200}),
      attempts: 1, account: 'a@x.com',
    });
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      url: '/v1/responses',
      headers: { 'authorization': 'Bearer tok-secret-32', accept: 'text/event-stream' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        instructions: 'Be brief.',
        input: [{type: 'message', role: 'user', content: [{type: 'input_text', text: 'q'}]}],
      }),
    }));

    expect(mocks.callMessages).toHaveBeenCalledOnce();
    const calledWith = mocks.callMessages.mock.calls[0][0];
    expect(calledWith.system).toBe('Be brief.');
    expect(calledWith.messages[0].content[0]).toEqual({type: 'text', text: 'q'});
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/event-stream');
    expect(r.body).toContain('"type":"response.completed"');
  });

  it('returns JSON for /v1/responses when SSE is not requested', async () => {
    mocks.callMessages.mockResolvedValue({
      status: 200,
      response: new Response(JSON.stringify({
        id: 'msg_1',
        model: 'claude-haiku-4-5-20251001',
        content: [{type:'text', text:'hi'}],
        usage: {input_tokens: 1, output_tokens: 1},
      }), {status: 200}),
      attempts: 1,
    });
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      url: '/v1/responses',
      headers: { 'authorization': 'Bearer tok-secret-32' },
      body: JSON.stringify({model: 'claude-haiku-4-5-20251001', input: 'q'}),
    }));

    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/json');
    expect(JSON.parse(r.body).output_text).toBe('hi');
  });

  it('routes /v1/responses gpt-* → callResponses and wraps JSON as SSE when requested', async () => {
    mocks.callResponses.mockResolvedValue({
      status: 200,
      response: new Response(JSON.stringify({
        id:'resp_x', object: 'response', status: 'completed', output: [], output_text: '',
      }), {status: 200, headers: { 'content-type': 'application/json' }}),
      attempts: 1,
    });
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      url: '/v1/responses',
      headers: { 'authorization': 'Bearer tok-secret-32', accept: 'text/event-stream' },
      body: JSON.stringify({model: 'gpt-5.5', input: 'q'}),
    }));

    expect(mocks.callResponses).toHaveBeenCalledOnce();
    expect(mocks.callResponses.mock.calls[0][0]).toEqual({model: 'gpt-5.5', input: 'q'});
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/event-stream');
    expect(r.body).toContain('"type":"response.completed"');
  });

  it('routes /v1/embeddings → callEmbeddings', async () => {
    mocks.callEmbeddings.mockResolvedValue({
      status: 200,
      response: new Response(JSON.stringify({data: [{embedding: [0.1]}]}), {status: 200}),
      attempts: 1,
    });
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      url: '/v1/embeddings',
      headers: { 'authorization': 'Bearer tok-secret-32' },
      body: JSON.stringify({model: 'text-embedding-3-small', input: 'hi'}),
    }));
    expect(mocks.callEmbeddings).toHaveBeenCalledOnce();
    expect(r.status).toBe(200);
  });

  it('returns 404 model_not_found for unknown model', async () => {
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      url: '/v1/chat/completions',
      headers: { 'authorization': 'Bearer tok-secret-32' },
      body: JSON.stringify({model: 'palm-2', messages: []}),
    }));
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body).error.type).toBe('invalid_request_error');
    expect(JSON.parse(r.body).error.code).toBe('model_not_found');
  });

  it('returns 400 on stream:true (v1 deferral)', async () => {
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      url: '/v1/chat/completions',
      headers: { 'authorization': 'Bearer tok-secret-32' },
      body: JSON.stringify({model: 'claude-haiku-4-5-20251001',
                            messages: [{role:'user', content:'q'}], stream: true}),
    }));
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error.code).toBe('streaming_not_supported_v1');
  });
});

describe('router — POST /v1/internal/probe-one', () => {
  let mocks;
  beforeEach(() => {
    mocks = {
      callMessages: vi.fn(), callChat: vi.fn(), callResponses: vi.fn(), callEmbeddings: vi.fn(),
      profilesDir: '/tmp/test-ccrotate-' + process.pid,
      serveToken: 'TOK',
      hasAnthropic: true,
      hasOpenai: true,
      ccrotate: {
        loadProfiles: vi.fn(() => ({
          'bot4@blockcast.net': {
            credentials: { claudeAiOauth: { accessToken: 'BOT4', expiresAt: Date.now() + 9e9 } },
          },
        })),
        testAccount: vi.fn(async () => ({
          status: 'success', serviceTier: 'base', rateLimits: { utilization5h: 4 },
        })),
        upsertTierCacheEntries: vi.fn(),
      },
    };
  });

  it('returns 401 without bearer', async () => {
    const router = createRouter(mocks);
    const res = await router.dispatch(makeReq({
      url: '/v1/internal/probe-one',
      body: JSON.stringify({ target: 'claude', email: 'bot4@blockcast.net' }),
    }));
    expect(res.status).toBe(401);
  });

  it('returns 405 on GET', async () => {
    const router = createRouter(mocks);
    const res = await router.dispatch(makeReq({
      method: 'GET',
      url: '/v1/internal/probe-one',
      headers: { authorization: 'Bearer TOK' },
    }));
    expect(res.status).toBe(405);
  });

  it('returns 400 on missing email', async () => {
    const router = createRouter(mocks);
    const res = await router.dispatch(makeReq({
      url: '/v1/internal/probe-one',
      headers: { authorization: 'Bearer TOK' },
      body: JSON.stringify({ target: 'claude' }),
    }));
    expect(res.status).toBe(400);
  });

  it('returns 400 on missing or invalid target', async () => {
    const router = createRouter(mocks);
    const res = await router.dispatch(makeReq({
      url: '/v1/internal/probe-one',
      headers: { authorization: 'Bearer TOK' },
      body: JSON.stringify({ email: 'bot4@blockcast.net' }),
    }));
    expect(res.status).toBe(400);
    const res2 = await router.dispatch(makeReq({
      url: '/v1/internal/probe-one',
      headers: { authorization: 'Bearer TOK' },
      body: JSON.stringify({ email: 'bot4@blockcast.net', target: 'gpt-5' }),
    }));
    expect(res2.status).toBe(400);
  });

  it('returns 200 with probe result on happy path', async () => {
    const router = createRouter(mocks);
    const res = await router.dispatch(makeReq({
      url: '/v1/internal/probe-one',
      headers: { authorization: 'Bearer TOK' },
      body: JSON.stringify({ target: 'claude', email: 'bot4@blockcast.net' }),
    }));
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.email).toBe('bot4@blockcast.net');
    expect(body.serviceTier).toBe('base');
    expect(mocks.ccrotate.upsertTierCacheEntries).toHaveBeenCalled();
  });

  it('returns 200 with status:error when email has no profile', async () => {
    mocks.ccrotate.loadProfiles = vi.fn(() => ({}));
    const router = createRouter(mocks);
    const res = await router.dispatch(makeReq({
      url: '/v1/internal/probe-one',
      headers: { authorization: 'Bearer TOK' },
      body: JSON.stringify({ target: 'claude', email: 'unknown@blockcast.net' }),
    }));
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('error');
  });

  it('returns 200 with status:error when loadProfiles throws (probeOne catches)', async () => {
    mocks.ccrotate.loadProfiles = vi.fn(() => { throw new Error('disk full'); });
    const router = createRouter(mocks);
    const res = await router.dispatch(makeReq({
      url: '/v1/internal/probe-one',
      headers: { authorization: 'Bearer TOK' },
      body: JSON.stringify({ target: 'claude', email: 'bot4@blockcast.net' }),
    }));
    // probeOne handles loadProfiles throw internally and returns error-result, so 200.
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('error');
  });
});
