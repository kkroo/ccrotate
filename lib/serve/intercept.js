import fs from 'node:fs';
import path from 'node:path';
import { renderAccountTable } from '../account-table.js';
import { createStateStore } from './state-store.js';
import { probeOne } from './freshness-loop.js';
import { pickNextCandidate } from './anthropic-client.js';
import { pickNextCodex } from './openai-client.js';

// Side-channel command interception for ccrotate-serve.
//
// Slash commands installed by the ccrotate plugin embed a marker like:
//
//   <!-- ccrotate-serve:cmd=when -->
//   <!-- ccrotate-serve:cmd=switch args=user@example.com -->
//
// When ccrotate-serve sees a marker in the inbound user message, it skips
// the upstream model call and synthesizes an assistant response built from
// its in-process pool state. Zero tokens consumed; works when the pool is
// 100% rate-limited.
//
// The interceptor is dispatched in router.js after Bearer auth and body
// parse, before the model-mismatch / upstream-call branches.

const MARKER_RE = /<!--\s*ccrotate-serve:\s*cmd=([a-z][a-z0-9_-]*)(?:\s+args=([^>]*?))?\s*-->/i;

const ANSI_RE = /\x1b\[[0-9;]*m/g;

const stripAnsi = (s) => String(s ?? '').replace(ANSI_RE, '');

/** Parse `<!-- ccrotate-serve:cmd=X args=Y -->` from a string. */
export function parseMarker(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(MARKER_RE);
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), args: (m[2] || '').trim() };
}

/**
 * Pull the most recent user-message text from any of the request body shapes
 * ccrotate-serve handles. Returns '' if nothing user-shaped is present.
 */
export function extractUserText(body) {
  if (!body || typeof body !== 'object') return '';

  // Anthropic /v1/messages — { messages: [{role, content}] }
  if (Array.isArray(body.messages)) {
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const m = body.messages[i];
      if (!m || m.role !== 'user') continue;
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter((b) => b && (b.type === 'text' || b.type === 'input_text'))
          .map((b) => b.text || '')
          .join('\n');
      }
    }
  }

  // OpenAI /v1/responses — { input: "..." } OR { input: [...] }
  if (typeof body.input === 'string') return body.input;
  if (Array.isArray(body.input)) {
    for (let i = body.input.length - 1; i >= 0; i--) {
      const m = body.input[i];
      if (!m || m.role !== 'user') continue;
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter((b) => b && (b.type === 'input_text' || b.type === 'text'))
          .map((b) => b.text || '')
          .join('\n');
      }
    }
  }

  return '';
}

// ----- state hydration -----

/**
 * Pull the five rotation-state files from the StateStore and write them
 * into `dir` (the serve pod's profilesDir). In HTTP-state mode — the
 * PV-less ccrotate-serve, onprem-k8s#227 — the pod has no shared mount, so
 * `renderAccountTable` / `ccrotate.loadProfiles` would otherwise read an
 * empty emptyDir. The read-side intercept commands (when/accounts/status/
 * health) call this first so the CLI renderer sees real pool state. In
 * file mode it's a harmless atomic re-serialize of already-local files.
 *
 * Writes are atomic (tmp+rename) so a concurrent reader never sees a
 * half-written file. Returns an array of per-file error strings — a
 * partial state-server failure degrades the table rather than throwing.
 */
async function hydrateState(store, dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  const files = [
    ['profiles.json', () => store.getProfiles()],
    ['profiles.codex.json', () => store.getCodexProfiles()],
    ['tier-cache.json', () => store.getTierCache()],
    ['tier-cache.codex.json', () => store.getCodexTierCache()],
    ['current.json', async () => ({ email: await store.getActiveEmail() })],
  ];
  const errors = [];
  for (const [name, getter] of files) {
    try {
      const data = await getter();
      const dest = path.join(dir, name);
      const tmp = dest + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, dest);
    } catch (e) {
      errors.push(`${name}: ${e?.message ?? e}`);
    }
  }
  return errors;
}

// ----- pool render helpers -----

/** Render a target-scoped pool table by capturing the CLI's renderAccountTable. */
function renderPool(ccrotate, target, _nowMs) {
  const originalTarget = ccrotate.target;
  let restore = () => {};
  if (typeof ccrotate.setTarget === 'function' && ccrotate.target !== target) {
    ccrotate.setTarget(target);
    restore = () => {
      try { ccrotate.setTarget(originalTarget); } catch { /* best effort */ }
    };
  }

  const captured = [];
  const origLog = console.log;
  // eslint-disable-next-line no-console
  console.log = (...args) => {
    captured.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  };

  let renderError = null;
  try {
    // Reuse the CLI's renderer so interception output matches `ccrotate when`
    // exactly — emoji, "no data (needs refresh)", "stale (needs /login + snap)",
    // tier columns and reset columns are all handled there.
    renderAccountTable(ccrotate, { mode: 'when' });
  } catch (e) {
    renderError = e;
  } finally {
    // eslint-disable-next-line no-console
    console.log = origLog;
    restore();
  }

  if (renderError) {
    // Retry once — transient parse errors can occur during refresh-one
    // writeback (temp+rename race window).
    try {
      if (typeof ccrotate.setTarget === 'function' && ccrotate.target !== target) {
        ccrotate.setTarget(target);
      }
      const captured2 = [];
      // eslint-disable-next-line no-console
      console.log = (...args) => {
        captured2.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
      };
      try {
        renderAccountTable(ccrotate, { mode: 'when' });
        // eslint-disable-next-line no-console
        console.log = origLog;
        restore();
        return stripAnsi(captured2.join('\n'));
      } finally {
        // eslint-disable-next-line no-console
        console.log = origLog;
        restore();
      }
    } catch (e2) {
      return `(${target}: ${e2?.message ?? e2})`;
    }
  }

  return stripAnsi(captured.join('\n'));
}

function renderBothPools(ccrotate, nowMs) {
  const sections = [];
  for (const target of ['claude', 'codex']) {
    try {
      sections.push(renderPool(ccrotate, target, nowMs));
    } catch (e) {
      sections.push(`(${target}: ${e?.message ?? e})`);
    }
  }
  return sections.join('\n\n');
}

// ----- command handlers -----
// Each handler returns a plain string. Handlers may be async.

const HANDLERS = {
  async when({ ccrotate, store }) {
    const errs = await hydrateState(store, ccrotate.profilesDir);
    const table = renderBothPools(ccrotate, Date.now());
    return errs.length
      ? `(state hydration warnings: ${errs.join('; ')})\n\n${table}`
      : table;
  },

  async accounts({ ccrotate, store }) {
    // Same data as when, intentional alias for readability.
    const errs = await hydrateState(store, ccrotate.profilesDir);
    const table = renderBothPools(ccrotate, Date.now());
    return errs.length
      ? `(state hydration warnings: ${errs.join('; ')})\n\n${table}`
      : table;
  },

  async status({ ccrotate, store }) {
    await hydrateState(store, ccrotate.profilesDir);
    const out = [];
    for (const target of ['claude', 'codex']) {
      try {
        const original = ccrotate.target;
        if (ccrotate.target !== target) ccrotate.setTarget?.(target);
        let active = null;
        try {
          active = ccrotate.getCurrentAccount?.() ?? null;
        } catch {
          active = null;
        }
        const email = active?.email ?? '(none)';
        out.push(`★ ${target}: ${email}`);
        if (ccrotate.target !== original) ccrotate.setTarget?.(original);
      } catch (e) {
        out.push(`★ ${target}: error — ${e?.message ?? e}`);
      }
    }
    return out.join('\n');
  },

  async health({ ccrotate, store, serveStartedAt }) {
    await hydrateState(store, ccrotate.profilesDir);
    const upMs = serveStartedAt ? Date.now() - serveStartedAt : null;
    const upStr = upMs == null ? 'unknown' : `${Math.round(upMs / 1000)}s`;
    const claudeN = (() => {
      try {
        const o = ccrotate.target;
        ccrotate.setTarget?.('claude');
        const n = Object.keys(ccrotate.loadProfiles?.() ?? {}).length;
        ccrotate.setTarget?.(o);
        return n;
      } catch {
        return '?';
      }
    })();
    const codexN = (() => {
      try {
        const o = ccrotate.target;
        ccrotate.setTarget?.('codex');
        const n = Object.keys(ccrotate.loadProfiles?.() ?? {}).length;
        ccrotate.setTarget?.(o);
        return n;
      } catch {
        return '?';
      }
    })();
    return [
      'ccrotate-serve: ok',
      `uptime: ${upStr}`,
      `pools: claude=${claudeN}, codex=${codexN}`,
    ].join('\n');
  },

  async next({ ccrotate, store, args }) {
    // Serve-aware rotate: ccrotate.next() writes ~/.claude/.credentials.json
    // (and ~/.codex/auth.json) on the local filesystem, which on a PV-less
    // ccrotate-serve pod is an emptyDir without a `.claude/` directory —
    // every invocation crashed with `ENOENT: ... /paperclip/.claude/
    // .credentials.json.tmp` until this handler stopped touching local files.
    //
    // The slash-command rotate only needs to flip the shared active-account
    // pointer (current.json); the request-side anthropic-client / openai-client
    // route requests by reading current.json + per-account tokens directly,
    // never by reading the local .credentials.json. So we compute the next
    // candidate via the same per-model exhaustion-aware picker the request
    // path uses (pickNextCandidate / pickNextCodex) and publish the pointer
    // through the StateStore (the /state/current POST endpoint).
    //
    // Real incident 2026-05-19: `/ccrotate:rotate` failed with the ENOENT
    // above, leaving the user to fall back to `/ccrotate:switch <email>`.
    const target = args && /^(claude|codex)$/i.test(args)
      ? args.toLowerCase()
      : (ccrotate.target === 'codex' ? 'codex' : 'claude');

    let currentEmail = null;
    try { currentEmail = await store.getActiveEmail(); } catch { /* non-fatal */ }
    const tried = new Set();
    if (currentEmail) tried.add(currentEmail);

    let nextEmail;
    try {
      if (target === 'codex') {
        const profiles = await store.getCodexProfiles();
        const pick = pickNextCodex(profiles || {}, tried);
        nextEmail = pick?.email ?? null;
      } else {
        const pick = await pickNextCandidate(store, tried, null);
        nextEmail = pick?.email ?? null;
      }
    } catch (e) {
      return `rotate failed (${target}): ${e?.message ?? e}`;
    }

    if (!nextEmail) {
      return `rotate failed (${target}): no usable next account (pool exhausted or every account already tried)`;
    }

    try {
      await store.setActiveEmail(nextEmail);
      return `rotated ${target} → ${nextEmail}`;
    } catch (e) {
      return `rotate failed (${target}): ${e?.message ?? e}`;
    }
  },

  async switch({ store, args }) {
    if (!args) return 'switch: missing args (need email)';
    const email = args.trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) return `switch: invalid email "${email}"`;
    // current.json is shared across both pools — accept an email that is
    // saved in either the claude or codex profile set. The active pointer
    // is written through the StateStore (the /state/current POST endpoint),
    // not ccrotate.switch() — on the PV-less serve pod ccrotate.switch
    // would write a throwaway emptyDir, not the auth-bot's real state.
    let inPool = false;
    try {
      const profiles = await store.getProfiles();
      inPool = !!profiles?.[email];
    } catch (e) {
      return `switch failed: cannot read pool — ${e?.message ?? e}`;
    }
    if (!inPool) {
      try {
        const codex = await store.getCodexProfiles();
        inPool = !!codex?.[email];
      } catch { /* codex profiles optional */ }
    }
    if (!inPool) {
      return `switch: "${email}" is not a saved account. Run \`when\` to list the pool.`;
    }
    try {
      await store.setActiveEmail(email);
      return `switched active account → ${email}`;
    } catch (e) {
      return `switch failed: ${e?.message ?? e}`;
    }
  },

  async snap() {
    // Snap needs local-session credentials that ccrotate-serve cannot see.
    return [
      'snap: must run locally (server has no access to your Claude/Codex session).',
      '',
      'Run on your machine:',
      '  ccrotate snap            # capture currently active account',
      '  ccrotate snap --force    # overwrite existing profile',
    ].join('\n');
  },

  async refresh({ ccrotate, store }) {
    let profiles;
    try {
      profiles = await store.getProfiles();
    } catch (e) {
      return `refresh failed: cannot read claude pool — ${e?.message ?? e}`;
    }
    const emails = Object.keys(profiles || {});
    if (emails.length === 0) return 'refresh: no claude accounts in the pool.';

    // Walk the whole claude pool one probe at a time, spaced to stay under
    // Anthropic's per-org Usage API throttle — same guard as the
    // `ccrotate refresh` CLI (commands/refresh.js INTER_PROBE_DELAY_MS). A
    // zero-gap pool-wide burst trips the throttle and the trailing 429s get
    // misread as exhaustion. probeOne writes each result back through the
    // StateStore (clear/mark exhausted).
    const delayMs = Number(process.env.CCROTATE_REFRESH_INTER_PROBE_DELAY_MS ?? 2000);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const tally = { base: 0, extra: 0, exhausted: 0, unknown: 0, error: 0 };
    const lines = [];
    for (let i = 0; i < emails.length; i++) {
      if (i > 0) await sleep(delayMs);
      const email = emails[i];
      let result;
      try {
        result = await probeOne('claude', email, ccrotate, store);
      } catch (e) {
        result = { email, status: 'error', serviceTier: null, response: String(e?.message ?? e) };
      }
      const tier = result?.serviceTier ?? (result?.status === 'error' ? 'error' : 'unknown');
      tally[tier in tally ? tier : 'unknown']++;
      lines.push(`  ${email} → ${tier}`);
    }
    const summary = Object.entries(tally)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`)
      .join(', ');
    return [
      `refresh: probed ${emails.length} claude account(s) — ${summary}.`,
      '(codex pool skipped — fixed API keys, no tier-cache exhaustion model.)',
      '',
      ...lines,
    ].join('\n');
  },

  async config({ ccrotate }) {
    const out = ['ccrotate-serve config (cloud mode):'];
    out.push(`  CCROTATE_SERVE_BASE_URL=${process.env.CCROTATE_SERVE_BASE_URL || '(unset)'}`);
    out.push(`  CCROTATE_SERVE_ANTHROPIC_BASE_URL=${process.env.CCROTATE_SERVE_ANTHROPIC_BASE_URL || '(unset)'}`);
    out.push(`  CCROTATE_SERVE_PORT=${process.env.CCROTATE_SERVE_PORT || '(default 4001)'}`);
    out.push('');
    out.push('ccrotate library config:');
    try {
      const cfg = ccrotate.loadConfig?.() ?? {};
      const extraUsage = cfg.extraUsage ?? 'prompt';
      out.push(`  extraUsage: ${extraUsage}`);
    } catch (e) {
      out.push(`  (error loading config: ${e?.message ?? e})`);
    }
    return out.join('\n');
  },

  async export() {
    return [
      'export: must run locally — the export payload contains live OAuth refresh',
      'tokens and ccrotate-serve never has them in clear in memory (they live on disk',
      'on each pool host). Server-side export would also leak credentials across',
      'callers since the served pool is multi-tenant.',
      '',
      'Run on your local machine:',
      '  ccrotate export > ~/ccrotate-export.txt',
      '  # then import into this pool:',
      '  /ccrotate:import "$(cat ~/ccrotate-export.txt)"',
    ].join('\n');
  },

  async import({ store, args }) {
    if (!args) {
      return 'import: missing args — paste an `mp-gz-b64:` export blob from `ccrotate export`.';
    }
    let result;
    try {
      result = await store.import(args.trim());
    } catch (e) {
      return `import failed: ${e?.message ?? e}`;
    }
    const parts = [];
    if (result.added) parts.push(`${result.added} new`);
    if (result.updated) parts.push(`${result.updated} updated`);
    if (result.kept) parts.push(`${result.kept} kept (local fresher)`);
    if (result.tierMerged) parts.push(`${result.tierMerged} tier-cache synced`);
    return `import complete: ${result.accounts} account(s) in payload — ${parts.join(', ') || 'no changes'}.`;
  },

  // /ccrotate:setSession email sessionKey  —  paperclip incident 2026-05-20
  // follow-up. The auth-bot can only auto-fetch magic-link codes for
  // accounts whose mail is readable by its GMAIL_REFRESH_TOKEN (usually
  // ONE Gmail identity). For non-Gmail / non-authorized accounts the
  // operator has to grab a fresh sessionKey from a real browser and
  // hand it to the bot — pre-G5 that meant kubectl-exec'ing curl
  // inside the pod. This handler accepts the sessionKey as a slash
  // command arg, forwards it to the bot's /setSession, then chains
  // /reloginViaSession, returning the snap outcome inline so the
  // operator sees pass/fail in one round-trip.
  //
  // Args format:  `<email> <sessionKey>`
  // sessionKey shape: `sk-ant-sid01-...` (≥40 chars) — basic shape
  // check up front so a malformed paste fails fast without a 60s
  // camoufox timeout.
  //
  // Bot URL: CCROTATE_RELOGIN_TRIGGER_URL (already used by serve to
  // self-heal on refresh-fail). When unset (devbox, tests), the
  // handler errors out cleanly.
  //
  // Security note: the sessionKey transits in the request body as
  // model-prompt text — already TLS-protected at the ingress / pod
  // network. We deliberately do NOT echo the sessionKey value into
  // the response body or logs; on success we report only the snap
  // outcome (which includes the resolved email — the SESSIONKEY_IDENTITY_
  // MISMATCH check in v4.13's reloginViaSession surfaces wrong-account
  // keys as 409, so the operator gets immediate feedback).
  // Handler key MUST be all-lowercase: parseMarker normalises every
  // `cmd=...` to lowercase before dispatch (`marker.cmd =
  // m[1].toLowerCase()`), and HANDLERS lookup is `HANDLERS[marker.cmd]`.
  // The slash command file is still `setSession.md` (user-facing camelCase
  // for readability) — the marker comment becomes `cmd=setSession` which
  // dispatches as `setsession`.
  async setsession({ args }) {
    const url = process.env.CCROTATE_RELOGIN_TRIGGER_URL ?? '';
    if (!url) {
      return 'setSession: CCROTATE_RELOGIN_TRIGGER_URL not set — this serve instance has no auth-bot wired up. Set the env var to the auth-bot URL (e.g. http://ccrotate-auth-bot.paperclip.svc:7000) on the serve Deployment.';
    }
    const trimmed = (args ?? '').trim();
    if (!trimmed) {
      return 'setSession: missing args — expected `<email> <sessionKey>`. Example: /ccrotate:setSession bot4@blockcast.net sk-ant-sid01-...';
    }
    // Split into email + the REST so a sessionKey that happens to
    // contain whitespace (shouldn't, but be defensive) is preserved.
    const sepIdx = trimmed.search(/\s+/);
    if (sepIdx === -1) {
      return 'setSession: args missing sessionKey — expected `<email> <sessionKey>`.';
    }
    const email = trimmed.slice(0, sepIdx);
    const sessionKey = trimmed.slice(sepIdx).trim();
    if (!email.includes('@')) {
      return `setSession: malformed email "${email}" — must contain @.`;
    }
    if (sessionKey.length < 40 || !sessionKey.startsWith('sk-ant-')) {
      return 'setSession: sessionKey shape check failed — expected `sk-ant-sid01-...` (≥40 chars). Grab the `sessionKey` cookie from claude.ai while logged in as the target account.';
    }
    const base = url.replace(/\/+$/, '');
    // Step 1: /setSession
    let setRes;
    try {
      setRes = await fetch(`${base}/setSession`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, target: 'claude', sessionKey }),
      });
    } catch (e) {
      return `setSession: bot unreachable at ${base}/setSession — ${e?.message ?? e}`;
    }
    if (!setRes.ok) {
      const errBody = await setRes.text().catch(() => '');
      return `setSession: bot /setSession returned ${setRes.status}. ${errBody.slice(0, 300)}`;
    }
    // Step 2: /reloginViaSession (long-running — bot's relogin chain
    // takes ~30s; allow 120s ceiling matching the bot's own timeout).
    let loginRes;
    const controller = new AbortController();
    const loginTimer = setTimeout(() => controller.abort(), 120_000);
    try {
      loginRes = await fetch(`${base}/reloginViaSession`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, target: 'claude' }),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(loginTimer);
      return `setSession: sessionKey persisted, but /reloginViaSession failed — ${e?.message ?? e}. The stale-poller will retry on its next tick.`;
    }
    clearTimeout(loginTimer);
    const loginJson = await loginRes.json().catch(() => ({}));
    if (loginRes.status === 409 && loginJson?.code === 'SESSIONKEY_IDENTITY_MISMATCH') {
      return [
        `setSession: ✗ sessionKey identity mismatch for ${email}.`,
        `  Provided sessionKey actually belongs to: ${loginJson.snappedEmail}`,
        `  Tokens were correctly written to ${loginJson.snappedEmail}'s profile (useful side effect).`,
        `  ${email} still needs a sessionKey from a browser logged in as ${email}.`,
      ].join('\n');
    }
    if (!loginRes.ok) {
      return `setSession: /reloginViaSession failed (${loginRes.status}): ${(loginJson?.error || '').slice(0, 300)}`;
    }
    return [
      `setSession: ✓ ${email} relogged in.`,
      `  ${loginJson?.snapStdout ?? '(no snap output)'}`,
      '  Next tier-cache refresh tick will reflect updated quota status.',
    ].join('\n');
  },

  async help() {
    return [
      'ccrotate-serve interception commands:',
      '  when         — render both Claude and Codex pool tables',
      '  accounts     — alias of when',
      '  status       — current active account per pool',
      '  health       — ccrotate-serve uptime and pool sizes',
      '  next         — rotate active account (optional args=claude|codex)',
      '  switch       — set active account (args=user@example.com)',
      '  config       — show ccrotate-serve config + extraUsage policy',
      '  refresh      — probe the whole Claude pool, refresh tier-cache',
      '  import       — merge an mp-gz-b64 export blob into the pool (args=blob)',
      '  setsession   — paste a sessionKey for an account (args=email sk-ant-sid01-...)',
      '  snap         — informational (must run locally)',
      '  export       — informational (must run locally)',
      '  help         — this message',
    ].join('\n');
  },
};

// ----- response synthesis -----

function ccrotateModel() {
  return 'ccrotate-serve-intercept';
}

function nowId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function synthesizeMessagesResponse(text) {
  return {
    id: nowId('msg'),
    type: 'message',
    role: 'assistant',
    model: ccrotateModel(),
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

export function synthesizeChatResponse(text) {
  return {
    id: nowId('chatcmpl'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: ccrotateModel(),
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export function synthesizeResponsesResponse(text) {
  return {
    id: nowId('resp'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: ccrotateModel(),
    output: [
      {
        type: 'message',
        id: nowId('msg'),
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    ],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

// SSE serializers — match the shapes in router.js (messagesSseBody / responsesSseBody).

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function synthesizeMessagesSse(text) {
  const msg = synthesizeMessagesResponse(text);
  let body = '';
  body += sseEvent('message_start', {
    type: 'message_start',
    message: { ...msg, content: [] },
  });
  body += sseEvent('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  body += sseEvent('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  });
  body += sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
  body += sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 0 },
  });
  body += sseEvent('message_stop', { type: 'message_stop' });
  return body;
}

export function synthesizeResponsesSse(text) {
  // Match the shape responsesSseBody() emits in translator.js — minimal output_text.delta.
  let body = '';
  body += sseEvent('response.created', synthesizeResponsesResponse(''));
  body += sseEvent('response.output_text.delta', { delta: text });
  body += sseEvent('response.completed', synthesizeResponsesResponse(text));
  return body;
}

/**
 * Main entry. Returns an HTTP response object if the body contains a
 * marker; null if not (caller should fall through to upstream dispatch).
 *
 *   tryIntercept({ body, endpoint, wantsStream, ccrotate, serveStartedAt, store })
 *
 * `endpoint` is one of 'messages' | 'chat' | 'responses'. `store` is
 * optional — when omitted it is built from CCROTATE_STATE_URL.
 */
export async function tryIntercept({ body, endpoint, wantsStream, ccrotate, serveStartedAt, store }) {
  if (!ccrotate) return null;
  const text = extractUserText(body);
  if (!text) return null;
  const marker = parseMarker(text);
  if (!marker) return null;

  // StateStore for the hydration + mutating commands. When the router
  // doesn't inject one (production serve passes no `store`), build from
  // CCROTATE_STATE_URL — HttpStateStore in the PV-less cluster deploy,
  // FileStateStore locally. Tests inject a fake store. Construction only
  // throws for FileStateStore with no profilesDir (no state backing at
  // all) — fall back to null so the store-free handlers (help, snap,
  // next, config, export) still work; the store-backed handlers report
  // the failure themselves.
  let stateStore = store;
  if (!stateStore) {
    try {
      stateStore = createStateStore({ profilesDir: ccrotate.profilesDir });
    } catch {
      stateStore = null;
    }
  }

  const handler = HANDLERS[marker.cmd];
  let rendered;
  if (!handler) {
    rendered = `ccrotate-serve: unknown command "${marker.cmd}". Try one of: ${Object.keys(HANDLERS).join(', ')}.`;
  } else {
    try {
      rendered = await handler({ ccrotate, args: marker.args, serveStartedAt, store: stateStore });
    } catch (e) {
      rendered = `ccrotate-serve: handler "${marker.cmd}" failed: ${e?.message ?? e}`;
    }
  }
  rendered = stripAnsi(rendered);

  const headers = {
    'X-Ccrotate-Intercepted': marker.cmd,
    'X-Ccrotate-Account': 'intercept',
  };

  if (endpoint === 'messages') {
    if (wantsStream) {
      return {
        status: 200,
        headers: { ...headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: synthesizeMessagesSse(rendered),
      };
    }
    return {
      status: 200,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(synthesizeMessagesResponse(rendered)),
    };
  }

  if (endpoint === 'chat') {
    return {
      status: 200,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(synthesizeChatResponse(rendered)),
    };
  }

  if (endpoint === 'responses') {
    if (wantsStream) {
      return {
        status: 200,
        headers: { ...headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: synthesizeResponsesSse(rendered),
      };
    }
    return {
      status: 200,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(synthesizeResponsesResponse(rendered)),
    };
  }

  return null;
}

// Exposed for tests.
export const __test__ = { HANDLERS, renderPool, renderBothPools };
