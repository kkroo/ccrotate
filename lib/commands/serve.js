import http from 'node:http';
import chalk from 'chalk';
import { createRouter } from '../serve/router.js';
import { callMessages } from '../serve/anthropic-client.js';
import { callChat, callResponses, callEmbeddings } from '../serve/openai-client.js';
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
      callMessages, callChat, callResponses, callEmbeddings,
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
          for await (const chunk of result.stream) {
            if (!res.write(chunk)) {
              await new Promise(resolve => res.once('drain', resolve));
            }
          }
          res.end();
          return;
        }
        res.end(result.body);
      } catch (e) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { type: 'internal', message: e.message } }));
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
