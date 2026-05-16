import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouter } from './router.js';

function makeReq({ method = 'POST', url = '/v1/chat/completions', headers = {}, body = '' } = {}) {
  return { method, url, headers, body };
}

async function dispatch(router, req) {
  // The router exposes `dispatch(req)` that returns {status, headers, body}.
  return router.dispatch(req);
}

describe('router — bearer auth + dispatch', () => {
  let mocks;
  beforeEach(() => {
    mocks = {
      callMessages: vi.fn(),
      callChat: vi.fn(),
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
