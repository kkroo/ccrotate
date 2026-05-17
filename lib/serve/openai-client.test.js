import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callChat, callResponses, callEmbeddings } from './openai-client.js';

function tmpCodexDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccrotate-serve-oai-'));
}
function codexProfile(email, idTok) {
  return { email, credentials: { tokens: { id_token: idTok, refresh_token: 'rt-' + email } } };
}

describe('openai-client — single-key path (OPENAI_API_KEY)', () => {
  afterEach(() => { vi.restoreAllMocks(); delete process.env.OPENAI_API_KEY; });

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
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CCROTATE_CODEX_DIR;
    delete process.env.OPENAI_API_KEY;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('uses id_token from codex profile when CCROTATE_CODEX_DIR is set', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_A'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'chatcmpl-x', choices: [] }), { status: 200 }),
    );
    const result = await callChat({ model: 'gpt-4o-mini', messages: [] });
    expect(result.status).toBe(200);
    expect(result.account).toBe('a@x.com');
    expect(spy.mock.calls[0][1].headers['Authorization']).toBe('Bearer IDTOK_A');
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

  it('routes /v1/responses via codex pool with id_token bearer', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_A'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_x', output: [] }), { status: 200 }),
    );
    const result = await callResponses({ model: 'gpt-5.5', input: 'hi' });
    expect(spy.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses');
    expect(spy.mock.calls[0][1].headers['Authorization']).toBe('Bearer IDTOK_A');
    expect(result.status).toBe(200);
  });

  it('rotates codex accounts on 429+insufficient_quota', async () => {
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
        return new Response(
          JSON.stringify({ error: { code: 'insufficient_quota' } }),
          { status: 429 },
        );
      }
      expect(opts.headers['Authorization']).toBe('Bearer IDTOK_B');
      return new Response('{}', { status: 200 });
    });
    const result = await callChat({ model: 'gpt-4o-mini', messages: [] });
    expect(result.status).toBe(200);
    expect(result.attempts).toBe(2);
    expect(result.account).toBe('b@x.com');
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
