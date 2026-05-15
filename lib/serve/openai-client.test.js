import { afterEach, describe, expect, it, vi } from 'vitest';
import { callChat, callEmbeddings } from './openai-client.js';

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
