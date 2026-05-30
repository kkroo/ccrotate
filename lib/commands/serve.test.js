import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';

// Reproduces the response-handling contract of ServeCommand's http handler:
// a stream that throws mid-iteration (every account throttled partway, upstream
// drop) must NOT crash the process by calling setHeader after headers are sent
// (ERR_HTTP_HEADERS_SENT). The handler body below mirrors lib/commands/serve.js.
//
// We exercise the real Node http server rather than ServeCommand.execute() so we
// don't need profiles / tokens / the freshness loop — the bug lives entirely in
// the request handler's response lifecycle.

function makeHandler(dispatch) {
  return async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      const result = await dispatch({ method: req.method, url: req.url, headers: req.headers, body });
      res.statusCode = result.status;
      for (const [k, v] of Object.entries(result.headers || {})) res.setHeader(k, v);
      if (result.stream) {
        try {
          for await (const chunk of result.stream) {
            if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
          }
        } catch (streamErr) {
          // swallowed: headers already sent, just terminate the response
        }
        if (!res.writableEnded) res.end();
        return;
      }
      res.end(result.body);
    } catch (e) {
      if (res.headersSent || res.writableEnded) {
        if (!res.writableEnded) res.end();
        return;
      }
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { type: 'internal', message: e.message } }));
    }
  };
}

async function startServer(dispatch) {
  const server = http.createServer(makeHandler(dispatch));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

function get(server) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end('{}');
  });
}

describe('serve response handler — ERR_HTTP_HEADERS_SENT regression', () => {
  let server;
  let uncaught = [];
  const onUncaught = (e) => uncaught.push(e);

  afterEach(async () => {
    process.off('uncaughtException', onUncaught);
    uncaught = [];
    if (server) { server.close(); server = null; }
  });

  it('does not crash when a stream throws after headers are sent', async () => {
    process.on('uncaughtException', onUncaught);

    // Stream that emits one chunk (flushing headers) then throws — the
    // "all accounts throttled partway through" shape that crashed prod.
    async function* throwingStream() {
      yield Buffer.from('event: message_start\n\n');
      throw new Error('all candidate accounts throttled');
    }

    server = await startServer(async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      stream: throwingStream(),
    }));

    const res = await get(server);
    // Headers committed as 200 before the throw; client gets a truncated body,
    // not a second header block, and crucially the process survived.
    expect(res.status).toBe(200);
    expect(res.body).toContain('message_start');

    // Give any deferred microtask/uncaught a tick to surface.
    await new Promise((r) => setTimeout(r, 20));
    expect(uncaught).toHaveLength(0);
  });

  it('still returns a clean 500 when dispatch throws before any write', async () => {
    server = await startServer(async () => {
      throw new Error('dispatch blew up before headers');
    });
    const res = await get(server);
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).error.type).toBe('internal');
  });

  it('serves a normal non-stream response unchanged', async () => {
    server = await startServer(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    }));
    const res = await get(server);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });
});
