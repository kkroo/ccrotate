import http from 'node:http';
import chalk from 'chalk';
import { createRouter } from '../serve/router.js';
import { callMessages } from '../serve/anthropic-client.js';
import { callChat, callResponses, callEmbeddings, callImages } from '../serve/openai-client.js';
import { startFreshnessLoop } from '../serve/freshness-loop.js';

export class ServeCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute(options = {}) {
    const port = Number(options.port ?? process.env.CCROTATE_SERVE_PORT ?? 4001);
    const bind = options.bind ?? process.env.CCROTATE_SERVE_BIND ?? '0.0.0.0';
    const serveToken = process.env.CCROTATE_SERVE_TOKEN;
    if (!serveToken) throw new Error('CCROTATE_SERVE_TOKEN env required');

    // Backend availability flags — used by /v1/models.
    const profilesDir = this.ccrotate.profilesDir;
    // In HTTP state mode (CCROTATE_STATE_URL set) the claude profiles live
    // behind the state-server, not on disk under profilesDir — loadProfiles
    // would read an empty emptyDir and wrongly report no anthropic backend,
    // dropping claude models from /v1/models. serve still serves claude.
    const hasAnthropic = (() => {
      if (process.env.CCROTATE_STATE_URL) return true;
      try { return Object.keys(this.ccrotate.loadProfiles()).length > 0; }
      catch { return false; }
    })();
    const hasOpenai = !!process.env.OPENAI_API_KEY || !!process.env.CCROTATE_CODEX_DIR;

    const router = createRouter({
      callMessages, callChat, callResponses, callEmbeddings, callImages,
      profilesDir, serveToken, hasAnthropic, hasOpenai,
      ccrotate: this.ccrotate,
    });

    const server = http.createServer(async (req, res) => {
      try {
        // Buffer body.
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        const synthetic = { method: req.method, url: req.url, headers: req.headers, body };
        const result = await router.dispatch(synthetic);
        res.statusCode = result.status;
        for (const [k, v] of Object.entries(result.headers || {})) {
          res.setHeader(k, v);
        }
        if (result.stream) {
          // A stream that throws mid-iteration (e.g. every account throttled
          // partway through, upstream connection drop) does so *after* the
          // first res.write has already flushed the status line + headers.
          // We must NOT fall through to the catch below and call setHeader on
          // an already-committed response — that throws ERR_HTTP_HEADERS_SENT,
          // which is uncaught here and crashes the whole serve process,
          // taking down every in-flight request on the replica.
          try {
            for await (const chunk of result.stream) {
              if (!res.write(chunk)) {
                await new Promise(resolve => res.once('drain', resolve));
              }
            }
          } catch (streamErr) {
            console.error(
              `[serve] stream aborted after headers sent: ${streamErr?.message ?? streamErr}`,
            );
            // Headers are already on the wire; the only correct action is to
            // terminate the (now-truncated) response. The client sees a
            // closed stream rather than a fabricated second header block.
          }
          if (!res.writableEnded) res.end();
          return;
        }
        res.end(result.body);
      } catch (e) {
        // Only safe to write an error response if nothing has been committed
        // yet. If headers are already sent (e.g. an error surfaced after a
        // partial non-stream write), just close the socket.
        if (res.headersSent || res.writableEnded) {
          console.error(
            `[serve] error after response already started: ${e?.message ?? e}`,
          );
          if (!res.writableEnded) res.end();
          return;
        }
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { type: 'internal', message: e.message } }));
      }
    });

    // Defense in depth: an unexpected throw anywhere in request handling
    // (or a rejected promise) must never take the process down — the serve
    // proxy is a shared singleton on the critical path for every model call,
    // including the Bash command-safety classifier. Log and stay up.
    server.on('clientError', (err, socket) => {
      if (socket.writable && !socket.destroyed) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      }
    });

    server.keepAliveTimeout = 60_000;
    server.headersTimeout = 65_000;

    // Background single-account probe rotation. Only meaningful for the
    // Anthropic backend (tier-cache + profiles live there); the OpenAI
    // path uses fixed API keys and doesn't have a "stale exhausted label"
    // failure mode. Set CCROTATE_FRESHNESS_PROBE_MS=0 to disable.
    const freshnessHandle = hasAnthropic
      ? startFreshnessLoop(this.ccrotate)
      : { stop: () => {}, _disabled: true };

    // Last-resort process guard. The request handler above already contains
    // every error path we know of, but serve is a shared singleton: a single
    // uncaught throw or unhandled rejection that exits the process drops every
    // in-flight request on the replica (the ERR_HTTP_HEADERS_SENT crash this
    // file fixes was exactly that). Log and stay up rather than exit(1).
    process.on('uncaughtException', (err) => {
      console.error(`[serve] uncaughtException (staying up): ${err?.stack ?? err}`);
    });
    process.on('unhandledRejection', (reason) => {
      console.error(`[serve] unhandledRejection (staying up): ${reason?.stack ?? reason}`);
    });

    return new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(port, bind, () => {
        console.log(chalk.green(`ccrotate serve listening on ${bind}:${port}`));
        console.log(chalk.dim(`backends: anthropic=${hasAnthropic} openai=${hasOpenai}`));
      });
      // Graceful shutdown
      const shutdown = () => {
        freshnessHandle.stop();
        server.close(() => resolve());
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    });
  }
}
