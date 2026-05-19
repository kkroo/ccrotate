import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock, spawnSync: spawnSyncMock }));

import { callChat, callResponses, callEmbeddings, callImages } from './openai-client.js';

function tmpCodexDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccrotate-serve-oai-'));
}
function codexProfile(email, idTok) {
  return { email, credentials: { tokens: { id_token: idTok, refresh_token: 'rt-' + email } } };
}
function realCodexProfile(email, idTok) {
  return { email, auth: { tokens: { id_token: idTok, refresh_token: 'rt-' + email } } };
}
async function collectStream(stream) {
  let out = '';
  for await (const chunk of stream) out += String(chunk);
  return out;
}
function mockSpawnResult({ status, stdout = '', stderr = '' }) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { end: vi.fn(() => {
    queueMicrotask(() => {
      if (stdout) child.stdout.write(stdout);
      if (stderr) child.stderr.write(stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', status);
    });
  }) };
  child.kill = vi.fn();
  return child;
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
    spawnMock.mockReset();
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

  it('uses OPENAI_API_KEY for embeddings even when codex bank is present', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_A'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
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

  it('routes /v1/responses via codex exec instead of public OpenAI API', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_A'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    const fetchSpy = vi.spyOn(global, 'fetch');
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
      stderr: '',
    });
    const result = await callResponses({ model: 'gpt-5.5', input: 'hi' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spawnSyncMock.mock.calls[0][0]).toBe('codex');
    expect(spawnSyncMock.mock.calls[0][1]).toContain('gpt-5.5');
    expect(spawnSyncMock.mock.calls[0][1].at(-1)).toBe('-');
    expect(spawnSyncMock.mock.calls[0][2].input).toContain('user: hi');
    expect(result.status).toBe(200);
  });

  it('routes /v1/responses via codex exec even when OPENAI_API_KEY is also present', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_A'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    process.env.OPENAI_API_KEY = 'sk-should-not-be-used';
    const fetchSpy = vi.spyOn(global, 'fetch');
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
      stderr: '',
    });

    const result = await callResponses({ model: 'gpt-5.5', input: 'hi' });

    expect(result.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spawnSyncMock).toHaveBeenCalledOnce();
  });

  it('rotates streaming /v1/responses when active codex account is out of credits', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': realCodexProfile('a@x.com', 'IDTOK_A'),
      'b@x.com': realCodexProfile('b@x.com', 'IDTOK_B'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    spawnMock
      .mockReturnValueOnce(mockSpawnResult({
        status: 1,
        stdout: JSON.stringify({
          type: 'turn.failed',
          error: { message: "You've hit your usage limit. Try again at 3:32 AM." },
        }),
      }))
      .mockReturnValueOnce(mockSpawnResult({
        status: 0,
        stdout: [
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
          JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 1 } }),
        ].join('\n'),
      }));

    const result = await callResponses({ model: 'gpt-5.5', input: 'hi' }, { stream: true });
    const body = await collectStream(result.stream);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(body).toContain(': ccrotate-serve rotated a@x.com -> b@x.com');
    expect(body).toContain('"type":"response.completed"');
    expect(body).not.toContain('"type":"response.failed"');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8')).email).toBe('b@x.com');
    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'tier-cache.codex.json'), 'utf8'));
    expect(cache.accounts.find(a => a.email === 'a@x.com')?.serviceTier).toBe('exhausted');
  });

  it('passes large /v1/responses prompts through stdin with a bounded env', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': realCodexProfile('a@x.com', 'IDTOK_A'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
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
