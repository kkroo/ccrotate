import http from 'node:http';
import chalk from 'chalk';
import { createRouter } from '../serve/router.js';
import { callMessages } from '../serve/anthropic-client.js';
import { callChat, callEmbeddings } from '../serve/openai-client.js';

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
    const hasAnthropic = (() => {
      try { return Object.keys(this.ccrotate.loadProfiles()).length > 0; }
      catch { return false; }
    })();
    const hasOpenai = !!process.env.OPENAI_API_KEY || !!process.env.CCROTATE_CODEX_DIR;

    const router = createRouter({
      callMessages, callChat, callEmbeddings,
      profilesDir, serveToken, hasAnthropic, hasOpenai,
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
        res.end(result.body);
      } catch (e) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { type: 'internal', message: e.message } }));
      }
    });

    server.keepAliveTimeout = 60_000;
    server.headersTimeout = 65_000;

    return new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(port, bind, () => {
        console.log(chalk.green(`ccrotate serve listening on ${bind}:${port}`));
        console.log(chalk.dim(`backends: anthropic=${hasAnthropic} openai=${hasOpenai}`));
      });
      // Graceful shutdown
      const shutdown = () => { server.close(() => resolve()); };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    });
  }
}
