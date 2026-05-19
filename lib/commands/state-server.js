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
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        const result = await router.dispatch({
          method: req.method, url: req.url, headers: req.headers, body,
        });
        res.statusCode = result.status;
        for (const [k, v] of Object.entries(result.headers || {})) {
          res.setHeader(k, v);
        }
        res.end(result.body);
      } catch (e) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { code: 'internal', message: e.message } }));
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
