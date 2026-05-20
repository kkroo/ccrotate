import http from 'node:http';
import chalk from 'chalk';
import { createStateRouter } from '../serve/state-server.js';

// Thin node:http wrapper around createStateRouter — same shape as
// ServeCommand wraps the serve router. Runs as its own process (a sidecar
// container alongside ccrotate-auth-bot, per onprem-k8s#227 phase 1d), so
// ccrotate-serve can read/write rotation state over HTTP instead of the
// shared cephfs PVC.
export class StateServerCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute(options = {}) {
    const port = Number(options.port ?? process.env.CCROTATE_STATE_PORT ?? 4002);
    const bind = options.bind ?? process.env.CCROTATE_STATE_BIND ?? '0.0.0.0';
    const dir = options.dir ?? process.env.CCROTATE_STATE_DIR ?? this.ccrotate.profilesDir;
    const token = process.env.CCROTATE_STATE_TOKEN || null;

    const router = createStateRouter({ dir, token });

    const server = http.createServer(async (req, res) => {
      // Per-request abort signal so SSE streams (and any future long-lived
      // handler) can detach listeners when the client disconnects. Without
      // this, every dropped SSE connection would leak its EventEmitter
      // listener until the server process restarts.
      const ac = new AbortController();
      const onClose = () => ac.abort();
      req.once('close', onClose);
      try {
        // Don't drain the body for GET/HEAD — SSE clients keep the request
        // open indefinitely, and `for await (const chunk of req)` would never
        // resolve. Body is only meaningful on writes.
        let body = '';
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          body = Buffer.concat(chunks).toString('utf8');
        }
        const result = await router.dispatch({
          method: req.method, url: req.url, headers: req.headers, body, signal: ac.signal,
        });
        res.statusCode = result.status;
        for (const [k, v] of Object.entries(result.headers || {})) {
          res.setHeader(k, v);
        }
        if (result.stream) {
          // Streaming response (SSE). flushHeaders so the EventSource
          // resolves its `onopen` immediately and starts processing the
          // first `event: connected` block without waiting for keepalive.
          if (typeof res.flushHeaders === 'function') res.flushHeaders();
          try {
            for await (const chunk of result.stream) {
              if (ac.signal.aborted) break;
              if (!res.write(chunk)) {
                await new Promise(resolve => res.once('drain', resolve));
              }
            }
          } finally {
            res.end();
          }
          return;
        }
        res.end(result.body);
      } catch (e) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: { code: 'internal', message: e.message } }));
        } else {
          res.end();
        }
      } finally {
        req.off('close', onClose);
      }
    });

    server.keepAliveTimeout = 60_000;
    server.headersTimeout = 65_000;

    return new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(port, bind, () => {
        console.log(chalk.green(`ccrotate state-server listening on ${bind}:${port}`));
        console.log(chalk.dim(`state dir: ${dir}  auth: ${token ? 'bearer' : 'open'}`));
      });
      const shutdown = () => server.close(() => resolve());
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    });
  }
}
