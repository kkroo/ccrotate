import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ServeCommand } from '../commands/serve.js';

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccrotate-int-'));
}

function withServer(serveToken, profilesDir, fn) {
  return new Promise(async (resolve, reject) => {
    // Stand up a minimal CCRotate-like object that exposes profilesDir and loadProfiles().
    const fakeCC = {
      profilesDir,
      loadProfiles: () => JSON.parse(fs.readFileSync(path.join(profilesDir, 'profiles.json'), 'utf8')),
    };
    process.env.CCROTATE_SERVE_TOKEN = serveToken;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CCROTATE_CODEX_DIR;
    // Random ephemeral port
    const port = 17000 + Math.floor(Math.random() * 1000);
    const cmd = new ServeCommand(fakeCC);
    let server;
    const origCreate = http.createServer;
    http.createServer = (handler) => {
      server = origCreate(handler);
      return server;
    };
    cmd.execute({ port, bind: '127.0.0.1' }).catch(() => {});
    // Wait briefly for listen
    await new Promise(r => setTimeout(r, 200));
    http.createServer = origCreate;
    try {
      await fn(`http://127.0.0.1:${port}`);
      resolve();
    } catch (e) { reject(e); }
    finally {
      server?.close?.();
    }
  });
}

describe('serve — integration', () => {
  let dir;
  beforeEach(() => {
    dir = freshDir();
    fs.writeFileSync(path.join(dir, 'profiles.json'), JSON.stringify({
      'a@x.com': {
        email: 'a@x.com',
        credentials: { claudeAiOauth: {
          accessToken: 'TOK_A', refreshToken: 'rt-a',
          expiresAt: Date.now() + 3600_000,
          scopes: ['user:inference'], subscriptionType: 'pro',
        }},
      },
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('OpenAI-in → Anthropic-translated → OpenAI-out (byte parity for happy path)', async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(global, 'fetch').mockImplementation((url, opts) => {
      // Intercept outbound Anthropic API calls; let local server calls through.
      if (typeof url === 'string' && url.includes('api.anthropic.com')) {
        return Promise.resolve(new Response(JSON.stringify({
          id: 'msg_int_1', type: 'message', role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [{type:'text', text:'pong'}],
          stop_reason: 'end_turn',
          usage: {input_tokens: 1, output_tokens: 1},
        }), { status: 200 }));
      }
      return realFetch(url, opts);
    });

    await withServer('test-tok', dir, async (base) => {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: {'Authorization': 'Bearer test-tok', 'Content-Type': 'application/json'},
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          messages: [{role:'user', content:'ping'}],
        }),
      });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.object).toBe('chat.completion');
      expect(body.choices[0].message.content).toBe('pong');
    });
  });

  it('healthz unauthenticated returns 200', async () => {
    await withServer('test-tok', dir, async (base) => {
      const r = await fetch(`${base}/healthz`);
      expect(r.status).toBe(200);
      expect((await r.json()).status).toBe('ok');
    });
  });

  it('wrong bearer returns 401', async () => {
    await withServer('test-tok', dir, async (base) => {
      const r = await fetch(`${base}/v1/models`, { headers: {'Authorization':'Bearer wrong'} });
      expect(r.status).toBe(401);
    });
  });
});
