import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock, spawnSync: spawnSyncMock }));

import { callChat, callResponses, callEmbeddings, callImages } from './openai-client.js';

function tmpCodexDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccrotate-serve-oai-'));
}
function codexProfile(email, idTok) {
  return { email, credentials: { tokens: { id_token: idTok, access_token: `ACCESS_${email}`, refresh_token: 'rt-' + email } } };
}
function realCodexProfile(email, idTok) {
  return { email, auth: { tokens: { id_token: idTok, access_token: `ACCESS_${email}`, refresh_token: 'rt-' + email } } };
}
async function collectStream(stream) {
  let out = '';
  for await (const chunk of stream) out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  return out;
}
describe('openai-client — single-key path (OPENAI_API_KEY)', () => {
  beforeEach(() => {
    delete process.env.CCROTATE_CODEX_DIR;
    spawnSyncMock.mockReset();
    spawnMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    spawnSyncMock.mockReset();
    spawnMock.mockReset();
    delete process.env.OPENAI_API_KEY;
    delete process.env.CCROTATE_CODEX_DIR;
    delete process.env.CCROTATE_CODEX_RESPONSES_MODE;
  });

  it('callChat passes Bearer OPENAI_API_KEY and POSTs to /v1/chat/completions', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-123';
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({id:'chatcmpl-x', choices:[{message:{role:'assistant', content:'ok'}}]}),
                   { status: 200 })
    );
    const result = await callChat({model: 'gpt-4o-mini', messages: [{role:'user', content:'q'}]});
    expect(spy).toHaveBeenCalledOnce();
    const [url, opts] = spy.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(opts.headers['Authorization']).toBe('Bearer sk-test-123');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body).model).toBe('gpt-4o-mini');
    expect(result.status).toBe(200);
    expect(result.attempts).toBe(1);
  });

  it('callEmbeddings POSTs to /v1/embeddings', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-123';
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({data:[{embedding: [0.1, 0.2]}]}), { status: 200 })
    );
    const result = await callEmbeddings({model: 'text-embedding-3-small', input: 'hello'});
    expect(spy.mock.calls[0][0]).toBe('https://api.openai.com/v1/embeddings');
    expect(result.status).toBe(200);
  });

  it('callImages requires CCROTATE_CODEX_DIR and never falls back to OPENAI_API_KEY', async () => {
    // Image generation is Codex-only by design. Even with OPENAI_API_KEY set,
    // callImages must error rather than hit api.openai.com with the Platform key.
    process.env.OPENAI_API_KEY = 'sk-test-123';
    delete process.env.CCROTATE_CODEX_DIR;
    const spy = vi.spyOn(global, 'fetch');
    await expect(callImages({model: 'gpt-image-1', prompt: 'a cat'}))
      .rejects.toThrow(/CCROTATE_CODEX_DIR/);
    const hitOpenAi = spy.mock.calls.some(c => String(c[0]).includes('api.openai.com'));
    expect(hitOpenAi).toBe(false);
  });

  it('callResponses POSTs to /v1/responses', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-123';
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({id:'resp_x', output: []}), { status: 200 })
    );
    const result = await callResponses({model: 'gpt-5.5', input: 'hello'});
    expect(spy.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses');
    expect(spy.mock.calls[0][1].headers['Authorization']).toBe('Bearer sk-test-123');
    expect(result.status).toBe(200);
  });

  it('throws when OPENAI_API_KEY is unset', async () => {
    await expect(callChat({model: 'gpt-4o-mini', messages: []}))
      .rejects.toThrow(/OPENAI_API_KEY/);
  });

  it('propagates 429 / 401 / 5xx without retry (single-key path)', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-123';
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 429 }));
    const result = await callChat({model: 'gpt-4o-mini', messages: []});
    expect(result.status).toBe(429);
    expect(result.attempts).toBe(1);
  });
});

describe('openai-client — codex pool path (CCROTATE_CODEX_DIR)', () => {
  let dir;
  beforeEach(() => {
    dir = tmpCodexDir();
    delete process.env.OPENAI_API_KEY;
    spawnSyncMock.mockReset();
    spawnMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CCROTATE_CODEX_DIR;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CCROTATE_CODEX_RESPONSES_MODE;
    spawnMock.mockReset();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('routes chat completions via ChatGPT Codex Responses when CCROTATE_CODEX_DIR is set', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_A'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'b@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    const sse = [
      'event: response.output_text.done',
      'data: {"type":"response.output_text.done","text":"ok"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_x","created_at":123,"model":"gpt-5.5","status":"completed","usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}',
      '',
    ].join('\n');
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const result = await callChat({
      model: 'gpt-5.5',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'ping' },
      ],
      max_tokens: 8,
    });
    const body = await result.response.json();

    expect(result.status).toBe(200);
    expect(result.account).toBe('a@x.com');
    expect(spy.mock.calls[0][0]).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(spy.mock.calls[0][1].headers.Authorization).toBe('Bearer ACCESS_a@x.com');
    expect(spy.mock.calls[0][1].headers.Authorization).not.toBe('Bearer IDTOK_A');
    expect(spy.mock.calls[0][1].headers.accept).toBe('text/event-stream');
    const requestBody = JSON.parse(spy.mock.calls[0][1].body);
    expect(requestBody.instructions).toBe('Be terse.');
    expect(requestBody.input[0].content[0].text).toBe('ping');
    expect(requestBody.stream).toBe(true);
    expect(requestBody.max_output_tokens).toBeUndefined();
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toBe('ok');
    expect(body.usage.total_tokens).toBe(4);
  });

  it('rotates chat completions on Codex usage limit', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': realCodexProfile('a@x.com', 'IDTOK_A'),
      'b@x.com': realCodexProfile('b@x.com', 'IDTOK_B'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'b@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { message: "You've hit your usage limit. Try again later." } }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ id: 'resp_x', model: 'gpt-5.5', output_text: 'ok' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));

    const result = await callChat({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'ping' }] });
    const body = await result.response.json();

    expect(result.status).toBe(200);
    expect(result.account).toBe('b@x.com');
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer ACCESS_a@x.com');
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer ACCESS_b@x.com');
    expect(body.choices[0].message.content).toBe('ok');
  });

  it('uses OPENAI_API_KEY for embeddings even when codex bank is present', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_A'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'b@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    process.env.OPENAI_API_KEY = 'sk-should-not-be-used';
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), { status: 200 }),
    );

    const result = await callEmbeddings({ model: 'text-embedding-3-small', input: 'hi' });

    expect(result.status).toBe(200);
    expect(result.account).toBeUndefined();
    expect(result.attempts).toBe(1);
    expect(spy.mock.calls[0][1].headers['Authorization']).toBe('Bearer sk-should-not-be-used');
  });

  it('uses real profiles.codex auth.tokens shape for codex exec bridge', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': realCodexProfile('a@x.com', 'IDTOK_A'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    process.env.CCROTATE_CODEX_RESPONSES_MODE = 'exec';
    let capturedAuth = null;
    spawnSyncMock.mockImplementation((_bin, _args, opts) => {
      capturedAuth = JSON.parse(fs.readFileSync(path.join(opts.env.CODEX_HOME, 'auth.json'), 'utf8'));
      return {
        status: 0,
        stdout: [
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
          JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 1 } }),
        ].join('\n'),
        stderr: '',
      };
    });
    const result = await callResponses({ model: 'gpt-5.5', input: 'hi' });
    expect(result.status).toBe(200);
    expect(result.account).toBe('a@x.com');
    expect(spawnSyncMock).toHaveBeenCalledOnce();
    expect(capturedAuth.tokens.id_token).toBe('IDTOK_A');
    const body = await result.response.json();
    expect(body.output_text).toBe('ok');
    expect(body.usage.total_tokens).toBe(4);
  });

  it('routes /v1/embeddings via codex pool with id_token bearer', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_A'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), { status: 200 }),
    );
    const result = await callEmbeddings({ model: 'text-embedding-3-small', input: 'hi' });
    expect(spy.mock.calls[0][0]).toBe('https://api.openai.com/v1/embeddings');
    expect(spy.mock.calls[0][1].headers['Authorization']).toBe('Bearer IDTOK_A');
    expect(result.status).toBe(200);
  });

  it('rotates embeddings on expired codex id_token', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_A'),
      'b@x.com': codexProfile('b@x.com', 'IDTOK_B'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, opts) => {
      call += 1;
      if (call === 1) {
        expect(opts.headers['Authorization']).toBe('Bearer IDTOK_A');
        return new Response(
          JSON.stringify({ error: { code: 'token_expired', message: 'Your authentication token has expired.' } }),
          { status: 401 },
        );
      }
      expect(opts.headers['Authorization']).toBe('Bearer IDTOK_B');
      return new Response(JSON.stringify({ data: [{ embedding: [0.2] }] }), { status: 200 });
    });

    const result = await callEmbeddings({ model: 'text-embedding-3-small', input: 'hi' });

    expect(result.status).toBe(200);
    expect(result.attempts).toBe(2);
    expect(result.account).toBe('b@x.com');
    const profiles = JSON.parse(fs.readFileSync(path.join(dir, 'profiles.codex.json'), 'utf8'));
    expect(profiles['a@x.com'].stale).toBe(true);
  });

  it('rotates embeddings on invalid_claims codex id_token', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_A'),
      'b@x.com': codexProfile('b@x.com', 'IDTOK_B'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, opts) => {
      call += 1;
      if (call === 1) {
        expect(opts.headers['Authorization']).toBe('Bearer IDTOK_A');
        return new Response(
          JSON.stringify({ error: { code: 'invalid_claims', message: 'Invalid token claims.' } }),
          { status: 401 },
        );
      }
      expect(opts.headers['Authorization']).toBe('Bearer IDTOK_B');
      return new Response(JSON.stringify({ data: [{ embedding: [0.2] }] }), { status: 200 });
    });

    const result = await callEmbeddings({ model: 'text-embedding-3-small', input: 'hi' });

    expect(result.status).toBe(200);
    expect(result.attempts).toBe(2);
    expect(result.account).toBe('b@x.com');
  });

  it('proxies /v1/responses to ChatGPT Codex with access_token instead of public OpenAI API', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_A'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_x', output: [] }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-codex-turn-state': 'turn-state-1',
          'x-request-id': 'req_123',
        },
      }),
    );
    const result = await callResponses({ model: 'gpt-5.5', input: 'hi' }, {
      headers: { accept: 'text/event-stream', 'x-codex-turn-state': 'turn-state-0' },
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer ACCESS_a@x.com');
    expect(fetchSpy.mock.calls[0][1].headers.accept).toBe('text/event-stream');
    expect(fetchSpy.mock.calls[0][1].headers['x-codex-turn-state']).toBe('turn-state-0');
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(result.status).toBe(200);
    expect(result.headers['x-codex-turn-state']).toBe('turn-state-1');
    expect(result.headers['x-request-id']).toBe('req_123');
  });

  it('emits structured Codex proxy attribution logs without secrets', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_SECRET'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_x', output: [] }), {
        status: 200,
        headers: { 'x-request-id': 'req_codex_123' },
      }),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await callResponses({ model: 'gpt-5.5', input: 'secret prompt' }, {
      attribution: {
        requestId: 'ccr_req_codex',
        endpoint: 'responses',
        model: 'gpt-5.5',
        stream: false,
        bodyBytes: 123,
        estimatedInputTokens: 12,
        requestedMaxOutputTokens: null,
        caller: { paperclipCompanyId: 'co_123', paperclipKeyId: 'key_456' },
      },
    });

    const lines = logSpy.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith('[openaiClient.attribution] '));
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.some((line) => line.includes('"event":"attempt_result"') && line.includes('"account":"a@x.com"'))).toBe(true);
    const allLogs = logSpy.mock.calls.map(([line]) => String(line)).join('\n');
    expect(allLogs).toContain('"requestId":"ccr_req_codex"');
    expect(allLogs).toContain('"paperclipCompanyId":"co_123"');
    expect(allLogs).not.toContain('IDTOK_SECRET');
    expect(allLogs).not.toContain('ACCESS_a@x.com');
    expect(allLogs).not.toContain('secret prompt');
  });

  it('routes /v1/responses via ChatGPT Codex even when OPENAI_API_KEY is also present', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_A'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    process.env.OPENAI_API_KEY = 'sk-should-not-be-used';
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_x', output: [] }), { status: 200 }),
    );

    const result = await callResponses({ model: 'gpt-5.5', input: 'hi' });

    expect(result.status).toBe(200);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer ACCESS_a@x.com');
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).not.toContain('sk-should-not-be-used');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('skips codex profiles marked exhausted in tier-cache when choosing a Responses account', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'exhausted@x.com': codexProfile('exhausted@x.com', 'IDTOK_A'),
      'usable@x.com': codexProfile('usable@x.com', 'IDTOK_B'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'bot7@x.com' }));
    fs.writeFileSync(path.join(dir, 'tier-cache.codex.json'), JSON.stringify({
      accounts: [
        { email: 'exhausted@x.com', status: 'success', serviceTier: 'exhausted' },
        { email: 'usable@x.com', status: 'success', serviceTier: 'available' },
      ],
    }));
    process.env.CCROTATE_CODEX_DIR = dir;
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_x', output: [] }), { status: 200 }),
    );

    const result = await callResponses({ model: 'gpt-5.5', input: 'hi' });

    expect(result.status).toBe(200);
    expect(result.account).toBe('usable@x.com');
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer ACCESS_usable@x.com');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8')).email).toBe('usable@x.com');
  });

  it('round-robins usable Codex Responses accounts instead of sticking to current.json', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_A'),
      'b@x.com': codexProfile('b@x.com', 'IDTOK_B'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    fs.writeFileSync(path.join(dir, 'tier-cache.codex.json'), JSON.stringify({
      accounts: [
        { email: 'a@x.com', status: 'success', serviceTier: 'available' },
        { email: 'b@x.com', status: 'success', serviceTier: 'available' },
      ],
    }));
    process.env.CCROTATE_CODEX_DIR = dir;
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_x', output: [] }), { status: 200 }),
    );

    const first = await callResponses({ model: 'gpt-5.5', input: 'hi' });
    const second = await callResponses({ model: 'gpt-5.5', input: 'hi again' });

    expect(first.status).toBe(200);
    expect(first.account).toBe('b@x.com');
    expect(second.status).toBe(200);
    expect(second.account).toBe('a@x.com');
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer ACCESS_b@x.com');
    expect(fetchSpy.mock.calls[1][1].headers.Authorization).toBe('Bearer ACCESS_a@x.com');
  });

  it('round-robin skips exhausted Codex Responses accounts', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_A'),
      'exhausted@x.com': codexProfile('exhausted@x.com', 'IDTOK_EX'),
      'b@x.com': codexProfile('b@x.com', 'IDTOK_B'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    fs.writeFileSync(path.join(dir, 'tier-cache.codex.json'), JSON.stringify({
      accounts: [
        { email: 'a@x.com', status: 'success', serviceTier: 'available' },
        { email: 'exhausted@x.com', status: 'success', serviceTier: 'exhausted' },
        { email: 'b@x.com', status: 'success', serviceTier: 'available' },
      ],
    }));
    process.env.CCROTATE_CODEX_DIR = dir;
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_x', output: [] }), { status: 200 }),
    );

    const result = await callResponses({ model: 'gpt-5.5', input: 'hi' });

    expect(result.status).toBe(200);
    expect(result.account).toBe('b@x.com');
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer ACCESS_b@x.com');
  });

  it('does not reuse an active codex account marked exhausted in tier-cache', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'exhausted@x.com': codexProfile('exhausted@x.com', 'IDTOK_A'),
      'usable@x.com': codexProfile('usable@x.com', 'IDTOK_B'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'exhausted@x.com' }));
    fs.writeFileSync(path.join(dir, 'tier-cache.codex.json'), JSON.stringify({
      accounts: [
        { email: 'exhausted@x.com', status: 'success', serviceTier: 'exhausted' },
        { email: 'usable@x.com', status: 'success', serviceTier: 'available' },
      ],
    }));
    process.env.CCROTATE_CODEX_DIR = dir;
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_x', output: [] }), { status: 200 }),
    );

    const result = await callResponses({ model: 'gpt-5.5', input: 'hi' });

    expect(result.status).toBe(200);
    expect(result.account).toBe('usable@x.com');
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer ACCESS_usable@x.com');
  });

  it('forwards tool-bearing /v1/responses instead of falling back to OPENAI_API_KEY', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_A'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    process.env.OPENAI_API_KEY = 'paperclip-auth-not-model-key';
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('data: {"type":"response.output_item.added","item":{"type":"function_call"}}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    const result = await callResponses({
      model: 'gpt-5.5',
      input: 'run hostname',
      tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }],
      stream: true,
    }, { stream: true });
    const body = await collectStream(result.stream);

    expect(result.status).toBe(200);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer ACCESS_a@x.com');
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(body).toContain('response.output_item.added');
  });

  it('preserves upstream SSE body and x-codex-turn-state for tool-bearing /v1/responses', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_A'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('data: {"type":"response.created"}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-codex-turn-state': 'next-state' },
      }),
    );

    const result = await callResponses({
      model: 'gpt-5.5',
      input: 'run hostname',
      tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }],
    }, { stream: true });
    const body = await collectStream(result.stream);

    expect(result.status).toBe(200);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(result.headers['x-codex-turn-state']).toBe('next-state');
    expect(body).toContain('response.created');
    expect(body).toContain('[DONE]');
  });

  it('passes through requested Codex SSE even when upstream content-type is not event-stream', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_A'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await callResponses({
      model: 'gpt-5.5',
      store: false,
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    }, { stream: true });
    const body = await collectStream(result.stream);

    expect(result.status).toBe(200);
    expect(result.account).toBe('a@x.com');
    expect(body).toContain('event: response.completed');
  });

  it('allows explicit server-side tool execution only when CCROTATE_CODEX_RESPONSES_MODE=exec', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_A'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    process.env.CCROTATE_CODEX_RESPONSES_MODE = 'exec';
    const fetchSpy = vi.spyOn(global, 'fetch');
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
      stderr: '',
    });

    const result = await callResponses({
      model: 'gpt-5.5',
      input: 'run hostname',
      tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }],
    });

    expect(result.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spawnSyncMock).toHaveBeenCalledOnce();
  });

  it('rotates streaming /v1/responses proxy when active codex account is out of credits', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': realCodexProfile('a@x.com', 'IDTOK_A'),
      'b@x.com': realCodexProfile('b@x.com', 'IDTOK_B'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'b@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { message: "You've hit your usage limit. Try again at 3:32 AM." } }),
        { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' } },
      ))
      .mockResolvedValueOnce(new Response(
        'data: {"type":"response.completed"}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream', 'x-codex-turn-state': 'state-b' } },
      ));

    const result = await callResponses({ model: 'gpt-5.5', input: 'hi' }, { stream: true });
    const body = await collectStream(result.stream);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer ACCESS_a@x.com');
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer ACCESS_b@x.com');
    expect(body).toContain('"type":"response.completed"');
    expect(body).not.toContain('"type":"response.failed"');
    expect(result.headers['x-codex-turn-state']).toBe('state-b');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8')).email).toBe('b@x.com');
    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'tier-cache.codex.json'), 'utf8'));
    expect(cache.accounts.find(a => a.email === 'a@x.com')?.serviceTier).toBe('exhausted');
  });

  it('marks stale and rotates when ChatGPT reports reused refresh token as plain text', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': realCodexProfile('a@x.com', 'IDTOK_A'),
      'b@x.com': realCodexProfile('b@x.com', 'IDTOK_B'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'b@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(
        'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
        { status: 401, headers: { 'content-type': 'text/plain' } },
      ))
      .mockResolvedValueOnce(new Response(
        'data: {"type":"response.completed"}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream', 'x-codex-turn-state': 'state-b' } },
      ));

    const result = await callResponses({ model: 'gpt-5.5', input: 'hi' }, { stream: true });
    const body = await collectStream(result.stream);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer ACCESS_a@x.com');
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer ACCESS_b@x.com');
    expect(body).toContain('"type":"response.completed"');
    expect(result.account).toBe('b@x.com');
    const profiles = JSON.parse(fs.readFileSync(path.join(dir, 'profiles.codex.json'), 'utf8'));
    expect(profiles['a@x.com'].stale).toBe(true);
  });

  it('passes large /v1/responses prompts through stdin with a bounded env', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': realCodexProfile('a@x.com', 'IDTOK_A'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    process.env.CCROTATE_CODEX_RESPONSES_MODE = 'exec';
    process.env.CCROTATE_TEST_HUGE_ENV = 'x'.repeat(1024 * 1024);
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
      stderr: '',
    });

    const largeInput = 'hello '.repeat(40_000);
    const result = await callResponses({ model: 'gpt-5.5', input: largeInput });

    expect(result.status).toBe(200);
    const [, args, opts] = spawnSyncMock.mock.calls[0];
    expect(args.at(-1)).toBe('-');
    expect(args.join(' ')).not.toContain(largeInput);
    expect(opts.input).toContain(largeInput);
    expect(opts.env.CODEX_HOME).toBeTruthy();
    expect(opts.env.CCROTATE_TEST_HUGE_ENV).toBeUndefined();
    delete process.env.CCROTATE_TEST_HUGE_ENV;
  });

  it('rotates codex accounts on 429+insufficient_quota', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_A'),
      'b@x.com': codexProfile('b@x.com', 'IDTOK_B'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
      call += 1;
      expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
      if (call === 1) {
        expect(opts.headers.Authorization).toBe('Bearer ACCESS_b@x.com');
        return new Response(
          JSON.stringify({ error: { code: 'insufficient_quota' } }),
          { status: 429 },
        );
      }
      expect(opts.headers.Authorization).toBe('Bearer ACCESS_a@x.com');
      return new Response(JSON.stringify({ id: 'resp_x', output_text: 'ok' }), { status: 200 });
    });
    const result = await callChat({ model: 'gpt-4o-mini', messages: [] });
    expect(result.status).toBe(200);
    expect(result.attempts).toBe(2);
    expect(result.account).toBe('a@x.com');
  });

  it('returns 502 pool-exhausted when all codex accounts are quota-blocked', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_A'),
      'b@x.com': codexProfile('b@x.com', 'IDTOK_B'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'insufficient_quota' } }),
        { status: 429 },
      ),
    );
    const result = await callChat({ model: 'gpt-4o-mini', messages: [] });
    expect(result.status).toBe(429);
    expect(result.attempts).toBe(2);
    expect(result.poolExhausted).toBe(true);
  });

  it('does not rotate on non-quota 429 (transient rate limit)', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_A'),
      'b@x.com': codexProfile('b@x.com', 'IDTOK_B'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), { status: 429 }),
    );
    const result = await callChat({ model: 'gpt-4o-mini', messages: [] });
    expect(result.status).toBe(429);
    expect(result.attempts).toBe(1);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('throws when neither OPENAI_API_KEY nor CCROTATE_CODEX_DIR is set', async () => {
    await expect(callChat({ model: 'gpt-4o-mini', messages: [] }))
      .rejects.toThrow(/OPENAI_API_KEY/);
  });
});

describe('openai-client — callImages via codex exec $imagegen bridge', () => {
  // Helper that simulates `codex exec --json $imagegen ...`: writes a PNG
  // into ${CODEX_HOME}/generated_images/<thread>/<image>.png the same way
  // codex's imagegen skill does, then emits the expected JSON event stream
  // on stdout and exits 0. This is what runCodexExecImages then harvests.
  function makeSpawnSyncImagegen({ pngBytes = Buffer.from('PNGCONTENTABCD'), status = 0, stdout = '', stderr = '' } = {}) {
    return (_bin, _args, opts) => {
      const home = opts.env.CODEX_HOME;
      // Mimic the imagegen skill's write target (thread-id-keyed subdir).
      const sessionDir = path.join(home, 'generated_images', 'test-thread-id-0001');
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, 'ig_test.png'), pngBytes);
      const defaultStdout = [
        JSON.stringify({ type: 'thread.started', thread_id: 'test-thread-id-0001' }),
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
      ].join('\n');
      return { status, stdout: stdout || defaultStdout, stderr };
    };
  }

  let dir;
  beforeEach(() => {
    dir = tmpCodexDir();
    delete process.env.OPENAI_API_KEY;
    spawnSyncMock.mockReset();
    spawnMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CCROTATE_CODEX_DIR;
    delete process.env.OPENAI_API_KEY;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('returns OpenAI /v1/images/generations shape with b64_json from the PNG codex wrote', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': realCodexProfile('a@x.com', 'IDTOK_A'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]); // PNG signature + payload
    spawnSyncMock.mockImplementation(makeSpawnSyncImagegen({ pngBytes }));

    const result = await callImages({ model: 'gpt-image-1', prompt: 'a red circle', size: '256x256' });

    expect(result.status).toBe(200);
    expect(result.account).toBe('a@x.com');
    expect(spawnSyncMock).toHaveBeenCalledOnce();
    // Prompt sent to codex exec must include the $imagegen keyword.
    const stdinInput = spawnSyncMock.mock.calls[0][2].input;
    expect(stdinInput).toContain('$imagegen');
    expect(stdinInput).toContain('a red circle');
    expect(stdinInput).toContain('256x256');
    // Tight prompt — must explicitly suppress shell post-processing.
    expect(stdinInput).toMatch(/do NOT (run shell|use ffmpeg|imagemagick)/i);
    // Response: { created, data: [{ b64_json }] }.
    const body = await result.response.json();
    expect(typeof body.created).toBe('number');
    expect(body.data).toHaveLength(1);
    expect(body.data[0].b64_json).toBe(pngBytes.toString('base64'));
  });

  it('returns data URL when payload.response_format=url', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': realCodexProfile('a@x.com', 'IDTOK_A'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    spawnSyncMock.mockImplementation(makeSpawnSyncImagegen({ pngBytes: Buffer.from('AB') }));

    const result = await callImages({ model: 'gpt-image-1', prompt: 'x', response_format: 'url' });
    const body = await result.response.json();
    expect(body.data[0].url).toMatch(/^data:image\/png;base64,/);
    expect(body.data[0].b64_json).toBeUndefined();
  });

  it('rotates to the next account on codex-side usage-limit 429', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': realCodexProfile('a@x.com', 'IDTOK_A'),
      'b@x.com': realCodexProfile('b@x.com', 'IDTOK_B'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    let nthCall = 0;
    spawnSyncMock.mockImplementation((bin, args, opts) => {
      nthCall++;
      if (nthCall === 1) {
        return {
          status: 1,
          stdout: JSON.stringify({ type: 'turn.failed', error: { message: 'You have hit your usage limit. Try again in 5 hours.' } }),
          stderr: '',
        };
      }
      return makeSpawnSyncImagegen()(bin, args, opts);
    });

    const result = await callImages({ model: 'gpt-image-1', prompt: 'a red circle' });
    expect(result.status).toBe(200);
    expect(result.account).toBe('b@x.com');
    expect(result.attempts).toBe(2);
  });

  it('returns 502 no_image_generated when codex exec succeeds but writes no PNG', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': realCodexProfile('a@x.com', 'IDTOK_A'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    spawnSyncMock.mockImplementation(() => ({
      status: 0,
      stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'I refuse.' } }),
      stderr: '',
    }));

    const result = await callImages({ model: 'gpt-image-1', prompt: 'x' });
    expect(result.status).toBe(502);
    const body = await result.response.json();
    expect(body.error.code).toBe('no_image_generated');
    expect(body.error.message).toMatch(/no image file appeared/);
  });

  it('does NOT hit api.openai.com — the codex-exec bridge replaces the direct call', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': realCodexProfile('a@x.com', 'IDTOK_A'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    spawnSyncMock.mockImplementation(makeSpawnSyncImagegen());
    const fetchSpy = vi.spyOn(global, 'fetch');

    await callImages({ model: 'gpt-image-1', prompt: 'x' });
    const hitOpenAi = fetchSpy.mock.calls.some(c => String(c[0]).includes('api.openai.com'));
    expect(hitOpenAi).toBe(false);
  });
});
