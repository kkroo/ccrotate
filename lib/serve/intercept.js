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

// ----- pool render helpers -----

function fmtRel(epochMs, nowMs) {
  if (!Number.isFinite(epochMs)) return '—';
  const deltaMs = epochMs - nowMs;
  const absMin = Math.round(Math.abs(deltaMs) / 60000);
  const h = Math.floor(absMin / 60);
  const m = absMin % 60;
  const abs = `${h ? h + 'h' : ''}${m}m`;
  return deltaMs >= 0 ? `in ${abs}` : `${abs} ago`;
}

function fmtAbs(epochMs) {
  if (!Number.isFinite(epochMs)) return '';
  const d = new Date(epochMs);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}Z`;
}

/** Render a target-scoped pool table to plain text (no ANSI). */
function renderPool(ccrotate, target, nowMs) {
  // ccrotate is single-target. To render the other target, swap and restore.
  const originalTarget = typeof ccrotate.getTargetName === 'function' ? ccrotate.target : null;
  let restore = () => {};
  if (originalTarget && ccrotate.target !== target) {
    ccrotate.setTarget?.(target);
    restore = () => ccrotate.setTarget?.(originalTarget);
  }

  try {
    const profiles = ccrotate.loadProfiles?.() ?? {};
    const cache = ccrotate.loadTierCache?.() ?? {};
    const cachedAccounts = new Map(
      Array.isArray(cache?.accounts) ? cache.accounts.map((a) => [a.email, a]) : []
    );
    const emails = Object.keys(profiles);
    if (emails.length === 0) {
      return `(${target}: no accounts saved)`;
    }
    let currentEmail = null;
    try {
      currentEmail = ccrotate.getCurrentAccount?.()?.email ?? null;
    } catch {
      currentEmail = null;
    }

    const ageMin = cache?.updatedAt
      ? Math.max(0, Math.round((nowMs - new Date(cache.updatedAt).getTime()) / 60000))
      : null;

    const header =
      `📋 ccrotate pool (${target}) — ` +
      (ageMin == null ? 'no tier-cache' : `tier-cache ${ageMin}m old`) +
      `, ${emails.length} accounts`;

    const lines = [header];
    for (const email of emails) {
      const cached = cachedAccounts.get(email);
      const isCurrent = email === currentEmail ? '★' : ' ';
      const tier = cached?.serviceTier ?? '—';
      const r5 = Number(cached?.rateLimits?.reset5h);
      const r7 = Number(cached?.rateLimits?.reset7d);
      const r5ms = Number.isFinite(r5) ? r5 * 1000 : NaN;
      const r7ms = Number.isFinite(r7) ? r7 * 1000 : NaN;
      const resetCol = Number.isFinite(r5ms)
        ? `${fmtRel(r5ms, nowMs)} (${fmtAbs(r5ms)})`
        : Number.isFinite(r7ms)
        ? `${fmtRel(r7ms, nowMs)} (${fmtAbs(r7ms)})`
        : tier === 'exhausted'
        ? 'exhausted'
        : '—';
      lines.push(`${isCurrent} ${tier.padEnd(11)} ${email.padEnd(40)} ${resetCol}`);
    }
    return lines.join('\n');
  } finally {
    restore();
  }
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
  async when({ ccrotate }) {
    return renderBothPools(ccrotate, Date.now());
  },

  async accounts({ ccrotate }) {
    // Same data as when, intentional alias for readability.
    return renderBothPools(ccrotate, Date.now());
  },

  async status({ ccrotate }) {
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

  async health({ ccrotate, serveStartedAt }) {
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

  async next({ ccrotate, args }) {
    const target = args && /^(claude|codex)$/i.test(args) ? args.toLowerCase() : null;
    const original = ccrotate.target;
    if (target && ccrotate.target !== target) ccrotate.setTarget?.(target);
    try {
      const result = await ccrotate.next({ wait: false });
      const email = result?.email ?? '(unknown)';
      return `rotated ${ccrotate.target} → ${email}`;
    } catch (e) {
      return `rotate failed (${ccrotate.target}): ${e?.message ?? e}`;
    } finally {
      if (target && ccrotate.target !== original) ccrotate.setTarget?.(original);
    }
  },

  async switch({ ccrotate, args }) {
    if (!args) return 'switch: missing args (need email)';
    const email = args.trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) return `switch: invalid email "${email}"`;
    try {
      await ccrotate.switch(email);
      return `switched ${ccrotate.target} → ${email}`;
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

  async refresh() {
    return [
      'refresh: cluster auth-bot owns refresh in cloud mode.',
      'Do not run `ccrotate refresh` locally — it rotates single-use refresh_tokens',
      'and invalidates the cluster pool. The */5 freshness loop in ccrotate-serve',
      'handles tier-cache updates automatically.',
    ].join('\n');
  },

  async help() {
    return [
      'ccrotate-serve interception commands:',
      '  when      — render both Claude and Codex pool tables',
      '  accounts  — alias of when',
      '  status    — current active account per pool',
      '  health    — ccrotate-serve uptime and pool sizes',
      '  next      — rotate active account (optional args=claude|codex)',
      '  switch    — switch active account (args=user@example.com)',
      '  snap      — informational (must run locally)',
      '  refresh   — informational (cluster owns refresh)',
      '  help      — this message',
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
 *   tryIntercept({ body, endpoint, wantsStream, ccrotate, serveStartedAt })
 *
 * `endpoint` is one of 'messages' | 'chat' | 'responses'.
 */
export async function tryIntercept({ body, endpoint, wantsStream, ccrotate, serveStartedAt }) {
  if (!ccrotate) return null;
  const text = extractUserText(body);
  if (!text) return null;
  const marker = parseMarker(text);
  if (!marker) return null;

  const handler = HANDLERS[marker.cmd];
  let rendered;
  if (!handler) {
    rendered = `ccrotate-serve: unknown command "${marker.cmd}". Try one of: ${Object.keys(HANDLERS).join(', ')}.`;
  } else {
    try {
      rendered = await handler({ ccrotate, args: marker.args, serveStartedAt });
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
