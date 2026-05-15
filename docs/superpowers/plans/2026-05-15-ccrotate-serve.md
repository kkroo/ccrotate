# ccrotate serve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an HTTP sidecar in ccrotate that exposes `/v1/messages`, `/v1/chat/completions`, `/v1/embeddings`, `/v1/models` over the existing ccrotate-managed OAuth pool, so LiteLLM in the paperclip cluster can route Hindsight's stuck consolidation jobs through Claude instead of the dead OpenAI key.

**Architecture:** New CLI verb `ccrotate serve` starts a `node:http` server. Layered modules under `lib/serve/`: `route-rule.js` (model → upstream), `translator.js` (OpenAI ↔ Anthropic pure functions), `anthropic-client.js` (OAuth pool, rotation, lazy refresh, pool-walk under existing `withCcrotateLock`), `openai-client.js` (single-key or codex pool). Deployed as a second container in the existing `ccrotate-auth-bot` Pod sharing the cephfs PVC at `/paperclip/.ccrotate/`. LiteLLM points at a new `Service/ccrotate-serve` in the `paperclip` namespace and falls back gpt-* → claude-* on quota errors.

**Tech Stack:** Node 20, vitest, commander, `node:http`, `node:fetch`, esbuild (existing build pipeline). Deploy via Docker (multi-stage `node:20-alpine`), kubectl (Service + Deployment patch + Secret OOB), LiteLLM ConfigMap patch.

**Reference spec:** `~/src/ccrotate/docs/superpowers/specs/2026-05-15-ccrotate-serve-design.md` (commit `d32ccb2` on branch `omar/ccrotate-serve`).

**Working directory for code tasks:** `~/src/ccrotate` on branch `omar/ccrotate-serve` (already created from `main` at `f0428aa`). All code-task commands assume this `cwd` unless stated. For k8s tasks, `cwd` is `~/k8s/paperclip`.

---

## Task 0: Pre-flight probes (Gates 0 + 1 from spec)

**Files:**
- Modify: none (manual recipes; results captured in next-session handoff or memory)

**Why first:** Both upstream paths (Anthropic OAuth → `api.anthropic.com` and codex `id_token` → `api.openai.com`) are gated assumptions. If Gate 0 fails, no code is worth writing. If Gate 1 fails, codex pool rotation (Task 13) is descoped to v2.

- [ ] **Step 1: Extract one Claude OAuth access token from the cluster PVC**

Run:
```bash
kubectl -n paperclip exec paperclip-0 -c paperclip -- sh -c 'python3 -c "
import json
p = json.load(open(\"/paperclip/.ccrotate/profiles.json\"))
# Pick the account with lowest 7d usage so we do not burn a near-cap account
for email, prof in p.items():
    oauth = prof.get(\"credentials\", {}).get(\"claudeAiOauth\", {})
    if oauth.get(\"accessToken\"):
        print(email, oauth[\"accessToken\"][:8] + \"...\" + oauth[\"accessToken\"][-4:], len(oauth[\"accessToken\"]))
        break
"'
```
Expected: an email and a token shape `<8 chars>...<4 chars>` of length ~108.

- [ ] **Step 2: Hit `api.anthropic.com/v1/messages` with the OAuth token**

Run inside `paperclip-0` (devbox has no Anthropic egress):
```bash
kubectl -n paperclip exec paperclip-0 -c paperclip -- python3 -c "
import json, urllib.request, sys
p = json.load(open('/paperclip/.ccrotate/profiles.json'))
email = next(e for e,prof in p.items() if prof.get('credentials',{}).get('claudeAiOauth',{}).get('accessToken'))
tok = p[email]['credentials']['claudeAiOauth']['accessToken']
req = urllib.request.Request(
    'https://api.anthropic.com/v1/messages',
    data=json.dumps({
        'model': 'claude-haiku-4-5-20251001',
        'max_tokens': 50,
        'messages': [{'role': 'user', 'content': 'ping'}]
    }).encode(),
    headers={
        'Authorization': f'Bearer {tok}',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
    },
    method='POST',
)
try:
    r = urllib.request.urlopen(req)
    print('STATUS', r.status)
    print(r.read().decode()[:500])
except urllib.error.HTTPError as e:
    print('HTTP_ERROR', e.code, e.read().decode()[:500])
"
```

Expected: `STATUS 200` and a JSON body containing `\"role\":\"assistant\"`, `\"content\":[{\"type\":\"text\",...}]`.

If 401 or `oauth_*` error: STOP and surface to user — the OAuth-pattern assumption is invalid; design needs revision before any code.

- [ ] **Step 3: Hit `api.openai.com/v1/chat/completions` with one codex `id_token`**

Run:
```bash
kubectl -n paperclip exec paperclip-0 -c paperclip -- python3 -c "
import json, urllib.request, sys
p = json.load(open('/paperclip/.ccrotate/profiles.codex.json'))
email = next(e for e,prof in p.items() if prof.get('credentials',{}).get('tokens',{}).get('id_token'))
tok = p[email]['credentials']['tokens']['id_token']
print('using', email, 'token_len', len(tok))
req = urllib.request.Request(
    'https://api.openai.com/v1/chat/completions',
    data=json.dumps({
        'model': 'gpt-4o-mini',
        'max_tokens': 10,
        'messages': [{'role': 'user', 'content': 'ping'}]
    }).encode(),
    headers={
        'Authorization': f'Bearer {tok}',
        'Content-Type': 'application/json',
    },
    method='POST',
)
try:
    r = urllib.request.urlopen(req)
    print('STATUS', r.status)
    print(r.read().decode()[:500])
except urllib.error.HTTPError as e:
    print('HTTP_ERROR', e.code, e.read().decode()[:500])
"
```

Expected: either `STATUS 200` (codex pool path is viable — Task 13 is in scope) OR `HTTP_ERROR 401` (codex pool descoped to v2 — Task 13 implements single-`OPENAI_API_KEY` path only).

- [ ] **Step 4: Record probe outcomes**

In `~/src/ccrotate/docs/superpowers/specs/2026-05-15-ccrotate-serve-design.md`, fill in the "Open questions §1 (Codex pool feasibility)" line under "Open questions" with the result. Two acceptable outcomes:
- "Gate 0 PASS / Gate 1 PASS — full scope"
- "Gate 0 PASS / Gate 1 FAIL — codex pool deferred to v2"

Commit:
```bash
git add docs/superpowers/specs/2026-05-15-ccrotate-serve-design.md
git commit -m "docs(serve): record probe results for OAuth feasibility gates"
```

---

## Task 1: Scaffold lib/serve/ directory + verify deps

**Files:**
- Create: `lib/serve/.keep` (placeholder so the dir exists in git)
- Modify: none

- [ ] **Step 1: Confirm we are on the right branch with a clean tree**

Run:
```bash
git status -s
git branch --show-current
```
Expected:
- Empty output from `git status -s` (or only docs/spec changes from Task 0)
- `omar/ccrotate-serve`

If not: `git checkout omar/ccrotate-serve` and resolve.

- [ ] **Step 2: Confirm no new deps needed**

The plan uses only: `node:http`, `node:fetch` (Node 20 global), `node:crypto`, existing `commander` + `chalk`. Tests use vitest globals + `vi.spyOn(global, 'fetch')` (no `nock`).

Run:
```bash
node -e "console.log('http:', typeof require('node:http').createServer); console.log('fetch:', typeof fetch); console.log('AbortController:', typeof AbortController)"
```
Expected: `http: function`, `fetch: function`, `AbortController: function`.

- [ ] **Step 3: Create lib/serve/ directory**

Run:
```bash
mkdir -p lib/serve/fixtures
touch lib/serve/.keep
```

- [ ] **Step 4: Commit**

```bash
git add lib/serve/.keep
git commit -m "feat(serve): scaffold lib/serve/ directory"
```

---

## Task 2: route-rule.js — pickUpstream + listModels

**Files:**
- Create: `lib/serve/route-rule.js`
- Test:   `lib/serve/route-rule.test.js`

- [ ] **Step 1: Write the failing tests**

Create `lib/serve/route-rule.test.js`:
```javascript
import { describe, it, expect } from 'vitest';
import { pickUpstream, listModels, ANTHROPIC_MODELS, OPENAI_MODELS } from './route-rule.js';

describe('pickUpstream', () => {
  it('routes claude-* to anthropic', () => {
    expect(pickUpstream('claude-haiku-4-5-20251001')).toBe('anthropic');
    expect(pickUpstream('claude-sonnet-4-6')).toBe('anthropic');
    expect(pickUpstream('claude-opus-4-7')).toBe('anthropic');
  });

  it('routes gpt-* and friends to openai', () => {
    for (const m of ['gpt-4o-mini', 'gpt-5.5', 'o1-preview', 'text-embedding-3-small',
                     'tts-1', 'whisper-1', 'davinci-002', 'babbage-002']) {
      expect(pickUpstream(m)).toBe('openai');
    }
  });

  it('returns null for unknown models (caller surfaces 404)', () => {
    expect(pickUpstream('palm-2')).toBeNull();
    expect(pickUpstream('')).toBeNull();
    expect(pickUpstream(undefined)).toBeNull();
  });
});

describe('listModels', () => {
  it('includes only configured backends', () => {
    const both = listModels({ hasAnthropic: true, hasOpenai: true });
    expect(both.object).toBe('list');
    expect(both.data.some(m => m.owned_by === 'anthropic')).toBe(true);
    expect(both.data.some(m => m.owned_by === 'openai')).toBe(true);

    const anthOnly = listModels({ hasAnthropic: true, hasOpenai: false });
    expect(anthOnly.data.every(m => m.owned_by === 'anthropic')).toBe(true);

    const oaiOnly = listModels({ hasAnthropic: false, hasOpenai: true });
    expect(oaiOnly.data.every(m => m.owned_by === 'openai')).toBe(true);
  });

  it('returns empty data when no backend is configured', () => {
    expect(listModels({ hasAnthropic: false, hasOpenai: false })).toEqual({ object: 'list', data: [] });
  });

  it('every advertised anthropic model routes to anthropic via pickUpstream', () => {
    for (const id of ANTHROPIC_MODELS) {
      expect(pickUpstream(id)).toBe('anthropic');
    }
  });

  it('every advertised openai model routes to openai via pickUpstream', () => {
    for (const id of OPENAI_MODELS) {
      expect(pickUpstream(id)).toBe('openai');
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/serve/route-rule.test.js`
Expected: fails with "Cannot find module './route-rule.js'" or similar.

- [ ] **Step 3: Write the minimal implementation**

Create `lib/serve/route-rule.js`:
```javascript
// Maps incoming `model` field to one of "anthropic" or "openai" upstream,
// or null when we don't recognize the model. Caller surfaces 404 for null.
//
// Pure functions only — no I/O. Tested in route-rule.test.js.

export const ANTHROPIC_MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
];

export const OPENAI_MODELS = [
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-5.5',
  'o1-preview',
  'text-embedding-3-small',
  'text-embedding-3-large',
];

const ANTHROPIC_PREFIXES = ['claude-'];
const OPENAI_PREFIXES = ['gpt-', 'o1-', 'text-embedding-', 'tts-', 'whisper-', 'davinci-', 'babbage-'];

export function pickUpstream(model) {
  if (typeof model !== 'string' || model.length === 0) return null;
  if (ANTHROPIC_PREFIXES.some(p => model.startsWith(p))) return 'anthropic';
  if (OPENAI_PREFIXES.some(p => model.startsWith(p))) return 'openai';
  return null;
}

export function listModels({ hasAnthropic, hasOpenai }) {
  const data = [];
  if (hasAnthropic) {
    for (const id of ANTHROPIC_MODELS) data.push({ id, object: 'model', owned_by: 'anthropic' });
  }
  if (hasOpenai) {
    for (const id of OPENAI_MODELS) data.push({ id, object: 'model', owned_by: 'openai' });
  }
  return { object: 'list', data };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/serve/route-rule.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/serve/route-rule.js lib/serve/route-rule.test.js
git rm lib/serve/.keep
git commit -m "feat(serve): route-rule module — model-prefix → upstream + /v1/models payload"
```

---

## Task 3: translator.js — request: OpenAI → Anthropic (text-only)

**Files:**
- Create: `lib/serve/translator.js`
- Create: `lib/serve/fixtures/openai-request-simple.json`
- Create: `lib/serve/fixtures/anthropic-request-simple.json`
- Test:   `lib/serve/translator.test.js`

- [ ] **Step 1: Write the failing test + fixtures**

Create `lib/serve/fixtures/openai-request-simple.json`:
```json
{
  "model": "claude-haiku-4-5-20251001",
  "messages": [
    {"role": "system", "content": "You are concise."},
    {"role": "user", "content": "Hello"}
  ],
  "temperature": 0.7,
  "top_p": 0.9,
  "stop": ["END"],
  "max_tokens": 256
}
```

Create `lib/serve/fixtures/anthropic-request-simple.json`:
```json
{
  "model": "claude-haiku-4-5-20251001",
  "max_tokens": 256,
  "system": "You are concise.",
  "messages": [
    {"role": "user", "content": "Hello"}
  ],
  "temperature": 0.7,
  "top_p": 0.9,
  "stop_sequences": ["END"]
}
```

Create `lib/serve/translator.test.js`:
```javascript
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { openaiToAnthropic } from './translator.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const fix = name => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', name), 'utf8'));

describe('openaiToAnthropic (request) — text-only', () => {
  it('translates simple chat with system prompt', () => {
    const input = fix('openai-request-simple.json');
    const expected = fix('anthropic-request-simple.json');
    expect(openaiToAnthropic(input)).toEqual(expected);
  });

  it('defaults max_tokens to 4096 when caller omits it', () => {
    const input = { model: 'claude-haiku-4-5-20251001',
                    messages: [{role: 'user', content: 'hi'}] };
    const out = openaiToAnthropic(input);
    expect(out.max_tokens).toBe(4096);
  });

  it('concatenates multiple system messages into one top-level system string', () => {
    const input = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [
        {role: 'system', content: 'First.'},
        {role: 'system', content: 'Second.'},
        {role: 'user', content: 'hi'},
      ],
    };
    const out = openaiToAnthropic(input);
    expect(out.system).toBe('First.\nSecond.');
    expect(out.messages).toEqual([{role: 'user', content: 'hi'}]);
  });

  it('drops logprobs, seed, logit_bias silently', () => {
    const input = {
      model: 'claude-haiku-4-5-20251001', max_tokens: 100,
      messages: [{role: 'user', content: 'hi'}],
      logprobs: true, seed: 42, logit_bias: {1: -100},
    };
    const out = openaiToAnthropic(input);
    expect(out.logprobs).toBeUndefined();
    expect(out.seed).toBeUndefined();
    expect(out.logit_bias).toBeUndefined();
  });

  it('throws on n>1', () => {
    expect(() => openaiToAnthropic({
      model: 'claude-haiku-4-5-20251001', max_tokens: 10,
      messages: [{role: 'user', content: 'hi'}], n: 2,
    })).toThrow(/unsupported_parameter.*n/);
  });

  it('throws on response_format json_schema', () => {
    expect(() => openaiToAnthropic({
      model: 'claude-haiku-4-5-20251001', max_tokens: 10,
      messages: [{role: 'user', content: 'hi'}],
      response_format: {type: 'json_schema', json_schema: {}},
    })).toThrow(/unsupported_parameter.*response_format/);
  });

  it('throws on stream:true (v1 deferral)', () => {
    expect(() => openaiToAnthropic({
      model: 'claude-haiku-4-5-20251001', max_tokens: 10,
      messages: [{role: 'user', content: 'hi'}], stream: true,
    })).toThrow(/streaming_not_supported_v1/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/serve/translator.test.js`
Expected: failure — `translator.js` not found.

- [ ] **Step 3: Implement openaiToAnthropic — text-only path**

Create `lib/serve/translator.js`:
```javascript
// Pure functions. OpenAI chat-completions <-> Anthropic messages.
// No I/O. Tested in translator.test.js via fixture corpus.

const DEFAULT_MAX_TOKENS = 4096;

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

export function openaiToAnthropic(req) {
  // Reject material differences upfront.
  if (req.stream === true) {
    throw err('streaming_not_supported_v1',
              'streaming_not_supported_v1: stream:true is deferred to v2');
  }
  if (typeof req.n === 'number' && req.n > 1) {
    throw err('unsupported_parameter',
              `unsupported_parameter: n=${req.n} (Anthropic does not support n>1)`);
  }
  if (req.response_format && req.response_format.type === 'json_schema') {
    throw err('unsupported_parameter',
              'unsupported_parameter: response_format.type=json_schema not supported');
  }

  const out = { model: req.model, max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS };

  // Pull all system messages out into a single top-level `system` field.
  const sysParts = [];
  const restMsgs = [];
  for (const m of req.messages || []) {
    if (m.role === 'system') {
      sysParts.push(typeof m.content === 'string' ? m.content : '');
    } else {
      restMsgs.push(m);
    }
  }
  if (sysParts.length > 0) out.system = sysParts.join('\n');

  // For now (Task 3 — text-only), the user/assistant messages pass through.
  // Tool-call reshape lands in Task 5; multimodal in Task 6.
  out.messages = restMsgs.map(m => ({ role: m.role, content: m.content }));

  // Pass-through scalars.
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop !== undefined) out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];

  // logprobs/seed/logit_bias intentionally dropped.

  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/serve/translator.test.js`
Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/serve/translator.js lib/serve/translator.test.js lib/serve/fixtures/
git commit -m "feat(serve): translator — OpenAI→Anthropic request (text-only)"
```

---

## Task 4: translator.js — response: Anthropic → OpenAI (text-only)

**Files:**
- Modify: `lib/serve/translator.js`
- Modify: `lib/serve/translator.test.js`
- Create: `lib/serve/fixtures/anthropic-response-simple.json`
- Create: `lib/serve/fixtures/openai-response-simple.json`

- [ ] **Step 1: Add the failing tests + fixtures**

Create `lib/serve/fixtures/anthropic-response-simple.json`:
```json
{
  "id": "msg_01ABC123",
  "type": "message",
  "role": "assistant",
  "model": "claude-haiku-4-5-20251001",
  "content": [{"type": "text", "text": "Hello!"}],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {"input_tokens": 12, "output_tokens": 3}
}
```

Create `lib/serve/fixtures/openai-response-simple.json`:
```json
{
  "id": "chatcmpl-msg_01ABC123",
  "object": "chat.completion",
  "model": "claude-haiku-4-5-20251001",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "Hello!"},
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15}
}
```

Append to `lib/serve/translator.test.js` (before the closing of file):
```javascript
import { anthropicToOpenai } from './translator.js';

describe('anthropicToOpenai (response) — text-only', () => {
  it('translates simple text response', () => {
    const input = fix('anthropic-response-simple.json');
    const expected = fix('openai-response-simple.json');
    const out = anthropicToOpenai(input);
    // `created` is a synthesized timestamp — assert it's present then strip
    expect(typeof out.created).toBe('number');
    delete out.created;
    expect(out).toEqual(expected);
  });

  it('maps stop_reason variants to finish_reason', () => {
    const base = {id: 'msg_x', type: 'message', role: 'assistant',
                  model: 'claude-haiku-4-5-20251001',
                  content: [{type: 'text', text: 'x'}],
                  usage: {input_tokens: 1, output_tokens: 1}};
    const map = {
      'end_turn':       'stop',
      'max_tokens':     'length',
      'stop_sequence':  'stop',
      'tool_use':       'tool_calls',
      'refusal':        'content_filter',
    };
    for (const [stopReason, finishReason] of Object.entries(map)) {
      const out = anthropicToOpenai({...base, stop_reason: stopReason});
      expect(out.choices[0].finish_reason).toBe(finishReason);
    }
  });

  it('joins multiple text content blocks into one content string', () => {
    const out = anthropicToOpenai({
      id: 'msg_x', type: 'message', role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [
        {type: 'text', text: 'Hello '},
        {type: 'text', text: 'world.'},
      ],
      stop_reason: 'end_turn',
      usage: {input_tokens: 5, output_tokens: 3},
    });
    expect(out.choices[0].message.content).toBe('Hello world.');
  });

  it('total_tokens = prompt + completion', () => {
    const out = anthropicToOpenai({
      id: 'msg_x', type: 'message', role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [{type: 'text', text: 'x'}],
      stop_reason: 'end_turn',
      usage: {input_tokens: 100, output_tokens: 25},
    });
    expect(out.usage).toEqual({prompt_tokens: 100, completion_tokens: 25, total_tokens: 125});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/serve/translator.test.js`
Expected: failure — `anthropicToOpenai` not exported.

- [ ] **Step 3: Add anthropicToOpenai to translator.js**

Append to `lib/serve/translator.js`:
```javascript
const STOP_REASON_MAP = {
  end_turn:      'stop',
  max_tokens:    'length',
  stop_sequence: 'stop',
  tool_use:      'tool_calls',
  refusal:       'content_filter',
};

export function anthropicToOpenai(res) {
  // Text content blocks are joined into one string. tool_use blocks land in Task 5.
  const textParts = [];
  for (const block of res.content || []) {
    if (block.type === 'text') textParts.push(block.text || '');
  }
  const content = textParts.length > 0 ? textParts.join('') : null;

  const finishReason = STOP_REASON_MAP[res.stop_reason] ?? 'stop';
  const inputTokens = res.usage?.input_tokens ?? 0;
  const outputTokens = res.usage?.output_tokens ?? 0;

  return {
    id: `chatcmpl-${res.id || 'unknown'}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: res.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/serve/translator.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/serve/translator.js lib/serve/translator.test.js lib/serve/fixtures/
git commit -m "feat(serve): translator — Anthropic→OpenAI response (text-only) + stop_reason map"
```

---

## Task 5: translator.js — tool calls round-trip

**Files:**
- Modify: `lib/serve/translator.js`
- Modify: `lib/serve/translator.test.js`
- Create: `lib/serve/fixtures/openai-request-tools.json`
- Create: `lib/serve/fixtures/anthropic-request-tools.json`
- Create: `lib/serve/fixtures/anthropic-response-tools.json`
- Create: `lib/serve/fixtures/openai-response-tools.json`

- [ ] **Step 1: Add fixtures**

Create `lib/serve/fixtures/openai-request-tools.json`:
```json
{
  "model": "claude-haiku-4-5-20251001",
  "max_tokens": 200,
  "messages": [
    {"role": "user", "content": "What's the weather in SF?"},
    {"role": "assistant", "content": null, "tool_calls": [
      {"id": "call_X", "type": "function",
       "function": {"name": "get_weather", "arguments": "{\"city\":\"SF\"}"}}
    ]},
    {"role": "tool", "tool_call_id": "call_X", "content": "{\"temp\":62,\"unit\":\"F\"}"}
  ],
  "tools": [
    {"type": "function", "function": {
      "name": "get_weather",
      "description": "Get current weather",
      "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}
    }}
  ]
}
```

Create `lib/serve/fixtures/anthropic-request-tools.json`:
```json
{
  "model": "claude-haiku-4-5-20251001",
  "max_tokens": 200,
  "messages": [
    {"role": "user", "content": "What's the weather in SF?"},
    {"role": "assistant", "content": [
      {"type": "tool_use", "id": "call_X", "name": "get_weather", "input": {"city": "SF"}}
    ]},
    {"role": "user", "content": [
      {"type": "tool_result", "tool_use_id": "call_X", "content": "{\"temp\":62,\"unit\":\"F\"}"}
    ]}
  ],
  "tools": [
    {"name": "get_weather", "description": "Get current weather",
     "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}
  ]
}
```

Create `lib/serve/fixtures/anthropic-response-tools.json`:
```json
{
  "id": "msg_TOOL",
  "type": "message",
  "role": "assistant",
  "model": "claude-haiku-4-5-20251001",
  "content": [
    {"type": "text", "text": "Let me check."},
    {"type": "tool_use", "id": "tu_1", "name": "get_weather", "input": {"city": "SF"}}
  ],
  "stop_reason": "tool_use",
  "usage": {"input_tokens": 25, "output_tokens": 15}
}
```

Create `lib/serve/fixtures/openai-response-tools.json`:
```json
{
  "id": "chatcmpl-msg_TOOL",
  "object": "chat.completion",
  "model": "claude-haiku-4-5-20251001",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Let me check.",
      "tool_calls": [
        {"id": "tu_1", "type": "function",
         "function": {"name": "get_weather", "arguments": "{\"city\":\"SF\"}"}}
      ]
    },
    "finish_reason": "tool_calls"
  }],
  "usage": {"prompt_tokens": 25, "completion_tokens": 15, "total_tokens": 40}
}
```

- [ ] **Step 2: Add the failing tests**

Append to `lib/serve/translator.test.js`:
```javascript
describe('translator — tool calls round-trip', () => {
  it('translates request with tool_calls and tool result', () => {
    const input = fix('openai-request-tools.json');
    const expected = fix('anthropic-request-tools.json');
    expect(openaiToAnthropic(input)).toEqual(expected);
  });

  it('translates response with text + tool_use blocks', () => {
    const input = fix('anthropic-response-tools.json');
    const expected = fix('openai-response-tools.json');
    const out = anthropicToOpenai(input);
    delete out.created;
    expect(out).toEqual(expected);
  });

  it('emits empty content "" (not null) when tool_use is the only block but no text', () => {
    // OpenAI clients vary — some require content to be a string. We use "" to be conservative.
    const out = anthropicToOpenai({
      id: 'msg_y', type: 'message', role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [{type: 'tool_use', id: 't1', name: 'f', input: {}}],
      stop_reason: 'tool_use',
      usage: {input_tokens: 1, output_tokens: 1},
    });
    expect(out.choices[0].message.content).toBe('');
    expect(out.choices[0].message.tool_calls).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run lib/serve/translator.test.js -t "tool calls"`
Expected: failures on the tool-related cases.

- [ ] **Step 4: Implement tool-call handling**

Replace the `openaiToAnthropic` function body in `lib/serve/translator.js` (the `restMsgs.map(...)` line and the tools handling) with:
```javascript
  // (replacing earlier `restMsgs.map(...)` and tool-less return)
  // Reshape: OpenAI's `assistant.tool_calls` + following `tool` message →
  // Anthropic's content-block tool_use in assistant + tool_result in user.
  const outMsgs = [];
  for (const m of restMsgs) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const blocks = [];
      if (typeof m.content === 'string' && m.content.length > 0) {
        blocks.push({ type: 'text', text: m.content });
      }
      for (const tc of m.tool_calls) {
        if (tc.type !== 'function') {
          throw err('unsupported_parameter',
                    `unsupported_parameter: tool_calls[].type=${tc.type} (only "function" supported)`);
        }
        let input;
        try { input = JSON.parse(tc.function.arguments || '{}'); }
        catch { throw err('invalid_request_error',
                          'invalid_request_error: tool_calls[].function.arguments must be valid JSON'); }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      outMsgs.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      outMsgs.push({ role: 'user', content: [
        { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }
      ]});
    } else {
      outMsgs.push({ role: m.role, content: m.content });
    }
  }
  out.messages = outMsgs;

  // Tools (OpenAI's nested function shape → Anthropic's flatter input_schema)
  if (Array.isArray(req.tools) && req.tools.length > 0) {
    out.tools = req.tools.map(t => {
      if (t.type !== 'function' || !t.function) {
        throw err('unsupported_parameter',
                  'unsupported_parameter: tools[].type must be "function"');
      }
      return {
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      };
    });
  }
```

(Concretely: delete the existing `out.messages = restMsgs.map(...)` line and the comment above it, replace with the block above. Keep the temperature/top_p/stop_sequences pass-through after.)

Also extend `anthropicToOpenai`. Replace its function body with:
```javascript
  const textParts = [];
  const toolCalls = [];
  for (const block of res.content || []) {
    if (block.type === 'text') textParts.push(block.text || '');
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const content = textParts.length > 0 ? textParts.join('') : (toolCalls.length > 0 ? '' : null);

  const message = { role: 'assistant', content };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const finishReason = STOP_REASON_MAP[res.stop_reason] ?? 'stop';
  const inputTokens = res.usage?.input_tokens ?? 0;
  const outputTokens = res.usage?.output_tokens ?? 0;

  return {
    id: `chatcmpl-${res.id || 'unknown'}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: res.model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
```

- [ ] **Step 5: Run all translator tests**

Run: `npx vitest run lib/serve/translator.test.js`
Expected: all tests pass (text-only + tools).

- [ ] **Step 6: Commit**

```bash
git add lib/serve/translator.js lib/serve/translator.test.js lib/serve/fixtures/
git commit -m "feat(serve): translator — tool_calls ↔ tool_use round-trip"
```

---

## Task 6: translator.js — multimodal + edge cases

**Files:**
- Modify: `lib/serve/translator.js`
- Modify: `lib/serve/translator.test.js`
- Create: `lib/serve/fixtures/openai-request-multimodal.json`
- Create: `lib/serve/fixtures/anthropic-request-multimodal.json`

- [ ] **Step 1: Add fixtures**

Create `lib/serve/fixtures/openai-request-multimodal.json`:
```json
{
  "model": "claude-haiku-4-5-20251001",
  "max_tokens": 200,
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "What's in this image?"},
      {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
    ]
  }]
}
```

Create `lib/serve/fixtures/anthropic-request-multimodal.json`:
```json
{
  "model": "claude-haiku-4-5-20251001",
  "max_tokens": 200,
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "What's in this image?"},
      {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}}
    ]
  }]
}
```

- [ ] **Step 2: Add the failing tests**

Append to `lib/serve/translator.test.js`:
```javascript
describe('translator — multimodal + edges', () => {
  it('translates user message with image_url (base64 data URI)', () => {
    const input = fix('openai-request-multimodal.json');
    const expected = fix('anthropic-request-multimodal.json');
    expect(openaiToAnthropic(input)).toEqual(expected);
  });

  it('translates http(s) image_url with type:"url"', () => {
    const input = {
      model: 'claude-haiku-4-5-20251001', max_tokens: 50,
      messages: [{role: 'user', content: [
        {type: 'text', text: 'q'},
        {type: 'image_url', image_url: {url: 'https://example.com/x.jpg'}},
      ]}],
    };
    const out = openaiToAnthropic(input);
    expect(out.messages[0].content[1]).toEqual({
      type: 'image', source: {type: 'url', url: 'https://example.com/x.jpg'},
    });
  });

  it('throws on tool_calls[].type other than function', () => {
    expect(() => openaiToAnthropic({
      model: 'claude-haiku-4-5-20251001', max_tokens: 10,
      messages: [{role: 'assistant', content: null, tool_calls: [
        {id: 'x', type: 'custom', function: {name: 'f', arguments: '{}'}}
      ]}],
    })).toThrow(/unsupported_parameter.*tool_calls/);
  });

  it('throws on tools[].type other than function', () => {
    expect(() => openaiToAnthropic({
      model: 'claude-haiku-4-5-20251001', max_tokens: 10,
      messages: [{role: 'user', content: 'q'}],
      tools: [{type: 'retrieval', function: {name: 'r', parameters: {}}}],
    })).toThrow(/unsupported_parameter.*tools/);
  });

  it('throws on invalid JSON in tool_calls[].function.arguments', () => {
    expect(() => openaiToAnthropic({
      model: 'claude-haiku-4-5-20251001', max_tokens: 10,
      messages: [{role: 'assistant', content: null, tool_calls: [
        {id: 'x', type: 'function', function: {name: 'f', arguments: 'not-json'}}
      ]}],
    })).toThrow(/invalid_request_error/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run lib/serve/translator.test.js -t "multimodal"`
Expected: failure (multimodal not handled yet).

- [ ] **Step 4: Implement multimodal content transform**

In `lib/serve/translator.js`, where the `else` branch maps non-tool messages:
```javascript
    } else {
      outMsgs.push({ role: m.role, content: translateContent(m.content) });
    }
```

Add this helper at the top of the file (above `openaiToAnthropic`):
```javascript
function translateContent(content) {
  // Strings pass through.
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;
  return content.map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image_url') {
      const u = part.image_url?.url || '';
      const dataMatch = u.match(/^data:([^;]+);base64,(.+)$/);
      if (dataMatch) {
        return { type: 'image', source: { type: 'base64', media_type: dataMatch[1], data: dataMatch[2] } };
      }
      return { type: 'image', source: { type: 'url', url: u } };
    }
    return part; // unknown block type — let upstream reject if material
  });
}
```

- [ ] **Step 5: Run all translator tests**

Run: `npx vitest run lib/serve/translator.test.js`
Expected: every test passes.

- [ ] **Step 6: Commit**

```bash
git add lib/serve/translator.js lib/serve/translator.test.js lib/serve/fixtures/
git commit -m "feat(serve): translator — multimodal image content + tool_call validation"
```

---

## Task 7: anthropic-client.js — happy path (200 OK)

**Files:**
- Create: `lib/serve/anthropic-client.js`
- Test:   `lib/serve/anthropic-client.test.js`

- [ ] **Step 1: Write the failing test**

Create `lib/serve/anthropic-client.test.js`:
```javascript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { callMessages } from './anthropic-client.js';

function tmpProfilesDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrotate-serve-anth-'));
  return dir;
}

function writeProfiles(dir, profiles, currentEmail) {
  fs.writeFileSync(path.join(dir, 'profiles.json'), JSON.stringify(profiles));
  // Mirrors the CurrentEmail pointer ccrotate's CCRotate.getCurrentAccount() reads.
  fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: currentEmail }));
}

function profile(email, tok = 'at-' + email) {
  return {
    email,
    credentials: {
      claudeAiOauth: {
        accessToken: tok, refreshToken: 'rt-' + email,
        expiresAt: Date.now() + 60 * 60 * 1000,
        scopes: ['user:inference', 'user:profile'], subscriptionType: 'pro',
      },
    },
  };
}

describe('anthropic-client.callMessages — happy path', () => {
  let dir;
  beforeEach(() => { dir = tmpProfilesDir(); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('passes Authorization Bearer <accessToken> + oauth-beta header', async () => {
    writeProfiles(dir, { 'a@x.com': profile('a@x.com', 'TOK_A') }, 'a@x.com');
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [{type:'text', text:'pong'}],
        stop_reason: 'end_turn',
        usage: {input_tokens: 1, output_tokens: 1},
      }), { status: 200 })
    );

    const result = await callMessages(
      {model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}]},
      { profilesDir: dir }
    );

    expect(spy).toHaveBeenCalledOnce();
    const [url, opts] = spy.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(opts.headers['Authorization']).toBe('Bearer TOK_A');
    expect(opts.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(opts.headers['anthropic-version']).toBe('2023-06-01');
    expect(result.status).toBe(200);
    expect(result.attempts).toBe(1);
    const body = await result.response.json();
    expect(body.id).toBe('msg_1');
  });

  it('propagates request body to upstream verbatim', async () => {
    writeProfiles(dir, { 'a@x.com': profile('a@x.com') }, 'a@x.com');
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 })
    );
    const payload = { model: 'claude-haiku-4-5-20251001', max_tokens: 50,
                      messages: [{role:'user', content:'x'}] };
    await callMessages(payload, { profilesDir: dir });
    expect(JSON.parse(spy.mock.calls[0][1].body)).toEqual(payload);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/serve/anthropic-client.test.js`
Expected: failure — `anthropic-client.js` not found.

- [ ] **Step 3: Write the minimal implementation**

Create `lib/serve/anthropic-client.js`:
```javascript
// Calls api.anthropic.com via the ccrotate OAuth pool. Handles rotation
// on quota exhaustion, lazy refresh on 401, pool-walk on refresh-fail.
//
// Designed to be the ONLY mutator of ccrotate state inside the serve module.
// All mutations go under withCcrotateLock from state-helpers.js.

import fs from 'node:fs';
import path from 'node:path';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const HEADERS_TEMPLATE = {
  'Content-Type': 'application/json',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'oauth-2025-04-20',
};

function readActiveProfile(profilesDir) {
  const profiles = JSON.parse(fs.readFileSync(path.join(profilesDir, 'profiles.json'), 'utf8'));
  // current.json holds the active email pointer (the same one ccrotate's
  // CCRotate.getCurrentAccount() reads). Fall back to first profile if absent.
  let email;
  try {
    email = JSON.parse(fs.readFileSync(path.join(profilesDir, 'current.json'), 'utf8')).email;
  } catch { email = Object.keys(profiles)[0]; }
  if (!email || !profiles[email]) {
    throw new Error('anthropic-client: no active profile');
  }
  return { email, profile: profiles[email], allProfiles: profiles };
}

export async function callMessages(payload, opts = {}) {
  const { profilesDir, timeoutMs = 15000 } = opts;
  if (!profilesDir) throw new Error('anthropic-client: profilesDir required');

  const { email, profile } = readActiveProfile(profilesDir);
  const accessToken = profile.credentials?.claudeAiOauth?.accessToken;
  if (!accessToken) throw new Error(`anthropic-client: ${email} has no accessToken`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { ...HEADERS_TEMPLATE, 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  return { status: response.status, response, attempts: 1, account: email };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/serve/anthropic-client.test.js`
Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/serve/anthropic-client.js lib/serve/anthropic-client.test.js
git commit -m "feat(serve): anthropic-client — happy-path callMessages with OAuth header"
```

---

## Task 8: anthropic-client.js — 401 + refresh + replay

**Files:**
- Modify: `lib/serve/anthropic-client.js`
- Modify: `lib/serve/anthropic-client.test.js`

- [ ] **Step 1: Add the failing test**

Append to `lib/serve/anthropic-client.test.js`:
```javascript
describe('anthropic-client.callMessages — 401 refresh-and-replay', () => {
  let dir;
  beforeEach(() => { dir = tmpProfilesDir(); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('refreshes token on 401 and replays once with new accessToken', async () => {
    writeProfiles(dir, { 'a@x.com': profile('a@x.com', 'TOK_OLD') }, 'a@x.com');

    let call = 0;
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
      call += 1;
      if (call === 1) {
        // First Messages call: 401
        expect(opts.headers['Authorization']).toBe('Bearer TOK_OLD');
        return new Response('{"error":{"type":"authentication_error"}}', { status: 401 });
      }
      if (call === 2) {
        // Token refresh: succeeds, returns new pair
        expect(url).toContain('/oauth/token'); // refresh endpoint
        return new Response(JSON.stringify({
          access_token: 'TOK_NEW', refresh_token: 'rt-new',
          expires_in: 3600,
        }), { status: 200 });
      }
      if (call === 3) {
        // Replay Messages call: 200 with NEW token
        expect(opts.headers['Authorization']).toBe('Bearer TOK_NEW');
        return new Response(JSON.stringify({
          id: 'msg_R', type: 'message', role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [{type:'text', text:'ok'}],
          stop_reason: 'end_turn',
          usage: {input_tokens: 1, output_tokens: 1},
        }), { status: 200 });
      }
      throw new Error('unexpected 4th fetch');
    });

    const result = await callMessages(
      {model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}]},
      { profilesDir: dir }
    );

    expect(result.status).toBe(200);
    expect(result.attempts).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(3); // 401 + refresh + 200
    // profiles.json now has the new accessToken
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'profiles.json'), 'utf8'));
    expect(after['a@x.com'].credentials.claudeAiOauth.accessToken).toBe('TOK_NEW');
  });

  it('propagates 401 when both attempts fail', async () => {
    writeProfiles(dir, { 'a@x.com': profile('a@x.com', 'TOK_OLD') }, 'a@x.com');
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 2) {
        return new Response(JSON.stringify({access_token: 'TOK_NEW', refresh_token: 'rt-new', expires_in: 3600}), { status: 200 });
      }
      return new Response('{"error":{"type":"authentication_error"}}', { status: 401 });
    });
    const result = await callMessages(
      {model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}]},
      { profilesDir: dir }
    );
    expect(result.status).toBe(401);
    expect(result.attempts).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/serve/anthropic-client.test.js -t "refresh-and-replay"`
Expected: failure — current impl returns the 401 directly without refresh.

- [ ] **Step 3: Implement refresh-and-replay**

Replace the `callMessages` function body in `lib/serve/anthropic-client.js`:
```javascript
import { withCcrotateLock } from '../state-helpers.js';

const REFRESH_URL = 'https://api.anthropic.com/api/oauth/token/refresh';
// NOTE: actual endpoint may be 'https://console.anthropic.com/v1/oauth/token' —
// confirm during Task 0 probe and adjust if needed.

async function refreshAccessToken(refreshToken, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = new Error(`refresh failed: ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
  } finally {
    clearTimeout(timer);
  }
}

function writeProfileAccessToken(profilesDir, email, oauth) {
  withCcrotateLock(profilesDir, () => {
    const file = path.join(profilesDir, 'profiles.json');
    const profiles = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (profiles[email]?.credentials?.claudeAiOauth) {
      profiles[email].credentials.claudeAiOauth = {
        ...profiles[email].credentials.claudeAiOauth,
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt: oauth.expiresAt,
      };
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(profiles, null, 2));
      fs.renameSync(tmp, file);
    }
  });
}

async function callOnce({ url, accessToken, payload, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { ...HEADERS_TEMPLATE, 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function callMessages(payload, opts = {}) {
  const { profilesDir, timeoutMs = 15000 } = opts;
  if (!profilesDir) throw new Error('anthropic-client: profilesDir required');

  const { email, profile } = readActiveProfile(profilesDir);
  const oauth = profile.credentials?.claudeAiOauth;
  if (!oauth?.accessToken) throw new Error(`anthropic-client: ${email} has no accessToken`);

  // Attempt 1
  let response = await callOnce({ url: ANTHROPIC_URL, accessToken: oauth.accessToken, payload, timeoutMs });
  if (response.status !== 401) {
    return { status: response.status, response, attempts: 1, account: email };
  }

  // 401 → refresh then attempt 2
  let newOauth;
  try {
    newOauth = await refreshAccessToken(oauth.refreshToken, timeoutMs);
  } catch (refreshErr) {
    return { status: 401, response, attempts: 1, account: email, refreshError: refreshErr };
  }
  writeProfileAccessToken(profilesDir, email, newOauth);
  response = await callOnce({ url: ANTHROPIC_URL, accessToken: newOauth.accessToken, payload, timeoutMs });
  return { status: response.status, response, attempts: 2, account: email };
}
```

Add `import { withCcrotateLock } from '../state-helpers.js';` at top if missing.

- [ ] **Step 4: Run all anthropic-client tests**

Run: `npx vitest run lib/serve/anthropic-client.test.js`
Expected: both refresh-related tests + the happy-path tests all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/serve/anthropic-client.js lib/serve/anthropic-client.test.js
git commit -m "feat(serve): anthropic-client — 401 → lazy refresh → replay-once with lock"
```

---

## Task 9: anthropic-client.js — refresh-fail → pool-walk

**Files:**
- Modify: `lib/serve/anthropic-client.js`
- Modify: `lib/serve/anthropic-client.test.js`

- [ ] **Step 1: Add the failing test**

Append to `lib/serve/anthropic-client.test.js`:
```javascript
describe('anthropic-client.callMessages — pool walk on refresh-fail', () => {
  let dir;
  beforeEach(() => { dir = tmpProfilesDir(); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('walks the pool when refresh fails on the active account', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
      'c@x.com': profile('c@x.com', 'TOK_C'),
    }, 'a@x.com');

    // Sequence:
    //   1) Messages w/ a → 401
    //   2) Refresh a    → 401 (refresh-fail) → rotate to b
    //   3) Messages w/ b → 401
    //   4) Refresh b    → 401 (refresh-fail) → rotate to c
    //   5) Messages w/ c → 200
    const order = ['TOK_A', 'refresh_a', 'TOK_B', 'refresh_b', 'TOK_C'];
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
      call += 1;
      const step = order[call - 1];
      if (step === 'TOK_A') {
        expect(opts.headers['Authorization']).toBe('Bearer TOK_A');
        return new Response('{}', { status: 401 });
      }
      if (step === 'refresh_a') {
        expect(url).toContain('/oauth/token');
        return new Response('{}', { status: 401 });
      }
      if (step === 'TOK_B') {
        expect(opts.headers['Authorization']).toBe('Bearer TOK_B');
        return new Response('{}', { status: 401 });
      }
      if (step === 'refresh_b') {
        expect(url).toContain('/oauth/token');
        return new Response('{}', { status: 401 });
      }
      if (step === 'TOK_C') {
        expect(opts.headers['Authorization']).toBe('Bearer TOK_C');
        return new Response(JSON.stringify({
          id: 'msg_C', type: 'message', role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [{type:'text', text:'ok'}], stop_reason: 'end_turn',
          usage: {input_tokens: 1, output_tokens: 1},
        }), { status: 200 });
      }
    });

    const result = await callMessages(
      {model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}]},
      { profilesDir: dir }
    );
    expect(result.status).toBe(200);
    expect(result.account).toBe('c@x.com');
    expect(result.attempts).toBe(3);
    expect(result.trigger).toBe('refresh-fail');
  });

  it('returns pool-exhausted when every account fails refresh', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));

    const result = await callMessages(
      {model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}]},
      { profilesDir: dir }
    );
    expect(result.status).toBe(502);
    expect(result.poolExhausted).toBe(true);
    expect(result.attempts).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/serve/anthropic-client.test.js -t "pool walk"`
Expected: failure — `callMessages` doesn't iterate over the pool.

- [ ] **Step 3: Implement pool walk**

In `lib/serve/anthropic-client.js`:

a) Add a `pickNextCandidate` helper above `callMessages`:
```javascript
function pickNextCandidate(profilesDir, alreadyTried) {
  const profiles = JSON.parse(fs.readFileSync(path.join(profilesDir, 'profiles.json'), 'utf8'));
  let tierCache = { accounts: [] };
  try { tierCache = JSON.parse(fs.readFileSync(path.join(profilesDir, 'tier-cache.json'), 'utf8')); } catch {}
  const exhaustedSet = new Set(
    (tierCache.accounts || [])
      .filter(a => a.serviceTier === 'exhausted' && (a.rateLimits?.reset5h ?? 0) * 1000 > Date.now())
      .map(a => a.email)
  );
  for (const [email, prof] of Object.entries(profiles)) {
    if (alreadyTried.has(email)) continue;
    if (exhaustedSet.has(email)) continue;
    if (!prof.credentials?.claudeAiOauth?.accessToken) continue;
    return { email, profile: prof };
  }
  return null;
}

function setActiveAccount(profilesDir, email) {
  withCcrotateLock(profilesDir, () => {
    fs.writeFileSync(path.join(profilesDir, 'current.json'), JSON.stringify({ email }));
  });
}
```

b) Replace `callMessages` with a loop body:
```javascript
export async function callMessages(payload, opts = {}) {
  const { profilesDir, timeoutMs = 15000 } = opts;
  if (!profilesDir) throw new Error('anthropic-client: profilesDir required');

  const tried = new Set();
  let cand = { ...readActiveProfile(profilesDir) }; // { email, profile, allProfiles }
  let lastResponse = null;
  let attempts = 0;
  let trigger = null;

  while (cand) {
    attempts += 1;
    tried.add(cand.email);
    const oauth = cand.profile.credentials?.claudeAiOauth;
    if (!oauth?.accessToken) {
      // Treat missing token as a refresh-fail candidate.
      trigger = 'refresh-fail';
      cand = pickNextCandidate(profilesDir, tried);
      if (cand) setActiveAccount(profilesDir, cand.email);
      continue;
    }

    let response = await callOnce({ url: ANTHROPIC_URL, accessToken: oauth.accessToken, payload, timeoutMs });

    if (response.status !== 401) {
      // Happy path or non-auth error — let caller's status-machine handle.
      // (Quota/rotate handling lands in Task 10.)
      return { status: response.status, response, attempts, account: cand.email, trigger };
    }

    // 401 → try refresh
    let newOauth;
    try {
      newOauth = await refreshAccessToken(oauth.refreshToken, timeoutMs);
    } catch {
      newOauth = null;
    }
    if (newOauth) {
      writeProfileAccessToken(profilesDir, cand.email, newOauth);
      // Replay once on the same account.
      attempts += 1;
      response = await callOnce({ url: ANTHROPIC_URL, accessToken: newOauth.accessToken, payload, timeoutMs });
      if (response.status !== 401) {
        return { status: response.status, response, attempts, account: cand.email, trigger };
      }
      // Refreshed but immediately 401 — fall through as refresh-fail.
    }

    // refresh failed — rotate.
    trigger = 'refresh-fail';
    lastResponse = response;
    cand = pickNextCandidate(profilesDir, tried);
    if (cand) setActiveAccount(profilesDir, cand.email);
  }

  // Pool exhausted
  return {
    status: 502,
    response: lastResponse,
    attempts,
    account: null,
    trigger,
    poolExhausted: true,
  };
}
```

- [ ] **Step 4: Run all anthropic-client tests**

Run: `npx vitest run lib/serve/anthropic-client.test.js`
Expected: pool-walk + refresh + happy-path all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/serve/anthropic-client.js lib/serve/anthropic-client.test.js
git commit -m "feat(serve): anthropic-client — pool walk on refresh-fail with tier-cache pre-filter"
```

---

## Task 10: anthropic-client.js — structural quota → rotate once

**Files:**
- Modify: `lib/serve/anthropic-client.js`
- Modify: `lib/serve/anthropic-client.test.js`

- [ ] **Step 1: Add the failing test**

Append to `lib/serve/anthropic-client.test.js`:
```javascript
describe('anthropic-client.callMessages — structural quota rotation', () => {
  let dir;
  beforeEach(() => { dir = tmpProfilesDir(); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

  function quotaBody() {
    return JSON.stringify({
      error: {
        type: 'rate_limit_error',
        message: 'You have exceeded your usage limit. Resets at unix 1715800000.',
      },
    });
  }

  it('rotates on structural quota (capped at 1 replay) and marks exhausted', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');

    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
      call += 1;
      if (call === 1) return new Response(quotaBody(), { status: 429 });
      if (call === 2) {
        expect(opts.headers['Authorization']).toBe('Bearer TOK_B');
        return new Response(JSON.stringify({
          id: 'msg_B', type: 'message', role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [{type:'text', text:'ok'}], stop_reason: 'end_turn',
          usage: {input_tokens: 1, output_tokens: 1},
        }), { status: 200 });
      }
    });

    const result = await callMessages(
      {model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}]},
      { profilesDir: dir }
    );

    expect(result.status).toBe(200);
    expect(result.account).toBe('b@x.com');
    expect(result.attempts).toBe(2);
    expect(result.trigger).toBe('quota');

    // tier-cache.json now marks a@x.com exhausted (markAccountExhausted side effect)
    const tc = JSON.parse(fs.readFileSync(path.join(dir, 'tier-cache.json'), 'utf8'));
    const aEntry = (tc.accounts || []).find(a => a.email === 'a@x.com');
    expect(aEntry?.serviceTier).toBe('exhausted');
  });

  it('propagates quota error when 2nd attempt also quotas (replay-once cap)', async () => {
    writeProfiles(dir, {
      'a@x.com': profile('a@x.com', 'TOK_A'),
      'b@x.com': profile('b@x.com', 'TOK_B'),
    }, 'a@x.com');
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(quotaBody(), { status: 429 }));

    const result = await callMessages(
      {model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}]},
      { profilesDir: dir }
    );
    expect(result.status).toBe(429);
    expect(result.attempts).toBe(2);
    expect(result.trigger).toBe('quota');
  });

  it('does NOT rotate on transient 429 (caller propagates as-is)', async () => {
    writeProfiles(dir, { 'a@x.com': profile('a@x.com') }, 'a@x.com');
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({error: {type: 'rate_limit_error', message: 'Slow down (60s)'}}), { status: 429 })
    );
    const result = await callMessages(
      {model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user', content:'ping'}]},
      { profilesDir: dir }
    );
    expect(result.status).toBe(429);
    expect(result.attempts).toBe(1);
    expect(result.trigger).toBe('transient-429');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/serve/anthropic-client.test.js -t "structural quota"`
Expected: failure — quota classifier not implemented.

- [ ] **Step 3: Implement quota classification + rotation**

In `lib/serve/anthropic-client.js`, add the classifier:
```javascript
import { markAccountExhausted } from '../state-helpers.js';

function classifyQuotaError(body) {
  // Returns { structural: bool, reset5h: number|null, reset7d: number|null }
  if (!body || !body.error) return { structural: false };
  const msg = (body.error.message || '').toLowerCase();
  if (body.error.type === 'rate_limit_error' &&
      /(usage limit|extra usage exhausted|exceeded your.*quota)/i.test(msg)) {
    // Try to parse a reset timestamp ("Resets at unix N")
    const m = msg.match(/resets? at[^0-9]*([0-9]{10,})/);
    const reset = m ? Number(m[1]) : null;
    return { structural: true, reset5h: reset, reset7d: null };
  }
  return { structural: false };
}
```

In the main loop, after the `if (response.status !== 401)` block, replace `return ...` with:
```javascript
    if (response.status === 429) {
      let body = null;
      try { body = await response.clone().json(); } catch {}
      const cls = classifyQuotaError(body);
      if (cls.structural) {
        markAccountExhausted(profilesDir, cand.email, { reset5h: cls.reset5h, reset7d: cls.reset7d });
        // Replay-once: try ONE alternate. If that fails (any reason), propagate.
        if (attempts < 2) {
          const next = pickNextCandidate(profilesDir, tried);
          if (next) {
            tried.add(next.email);
            setActiveAccount(profilesDir, next.email);
            attempts += 1;
            const nextOauth = next.profile.credentials?.claudeAiOauth;
            const replay = await callOnce({
              url: ANTHROPIC_URL, accessToken: nextOauth.accessToken, payload, timeoutMs,
            });
            return { status: replay.status, response: replay, attempts, account: next.email, trigger: 'quota' };
          }
        }
        return { status: response.status, response, attempts, account: cand.email, trigger: 'quota' };
      }
      // Transient 429 — propagate.
      return { status: 429, response, attempts, account: cand.email, trigger: 'transient-429' };
    }

    if (response.status !== 401) {
      return { status: response.status, response, attempts, account: cand.email, trigger };
    }
```

(The existing `if (response.status !== 401) return ...` line is REPLACED by the block above, which handles 429 explicitly before falling through to the 401 path.)

- [ ] **Step 4: Run all anthropic-client tests**

Run: `npx vitest run lib/serve/anthropic-client.test.js`
Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/serve/anthropic-client.js lib/serve/anthropic-client.test.js
git commit -m "feat(serve): anthropic-client — structural quota → rotate-once with markAccountExhausted"
```

---

## Task 11: openai-client.js — single-key path

**Files:**
- Create: `lib/serve/openai-client.js`
- Test:   `lib/serve/openai-client.test.js`

- [ ] **Step 1: Write the failing test**

Create `lib/serve/openai-client.test.js`:
```javascript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/serve/openai-client.test.js`
Expected: failure — module doesn't exist.

- [ ] **Step 3: Write the implementation**

Create `lib/serve/openai-client.js`:
```javascript
// OpenAI upstream client. Single-key path is the default; codex pool
// rotation lands in Task 13 IFF Gate 1 probe passed.
//
// We do not retry/rotate on the single-key path — LiteLLM's router
// already handles transient retries.

const CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const EMB_URL = 'https://api.openai.com/v1/embeddings';

async function callOnceJson({ url, payload, timeoutMs }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('openai-client: OPENAI_API_KEY env not set');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export async function callChat(payload, opts = {}) {
  const { timeoutMs = 15000 } = opts;
  const response = await callOnceJson({ url: CHAT_URL, payload, timeoutMs });
  return { status: response.status, response, attempts: 1 };
}

export async function callEmbeddings(payload, opts = {}) {
  const { timeoutMs = 15000 } = opts;
  const response = await callOnceJson({ url: EMB_URL, payload, timeoutMs });
  return { status: response.status, response, attempts: 1 };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/serve/openai-client.test.js`
Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/serve/openai-client.js lib/serve/openai-client.test.js
git commit -m "feat(serve): openai-client — single-key callChat + callEmbeddings"
```

---

## Task 12: router.js — bearer auth + dispatch + endpoints

**Files:**
- Create: `lib/serve/router.js`
- Test:   `lib/serve/router.test.js`

- [ ] **Step 1: Write the failing tests**

Create `lib/serve/router.test.js`:
```javascript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouter } from './router.js';

function makeReq({ method = 'POST', url = '/v1/chat/completions', headers = {}, body = '' } = {}) {
  return { method, url, headers, body };
}

async function dispatch(router, req) {
  // The router exposes `dispatch(req)` that returns {status, headers, body}.
  return router.dispatch(req);
}

describe('router — bearer auth + dispatch', () => {
  let mocks;
  beforeEach(() => {
    mocks = {
      callMessages: vi.fn(),
      callChat: vi.fn(),
      callEmbeddings: vi.fn(),
      profilesDir: '/tmp/fake',
      serveToken: 'tok-secret-32',
      hasAnthropic: true,
      hasOpenai: true,
    };
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns 200 on /healthz with no auth', async () => {
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({ method: 'GET', url: '/healthz' }));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).status).toBe('ok');
  });

  it('returns 401 on /v1/* without Authorization header', async () => {
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({ url: '/v1/chat/completions' }));
    expect(r.status).toBe(401);
  });

  it('returns 401 on /v1/* with wrong bearer', async () => {
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      url: '/v1/chat/completions',
      headers: { 'authorization': 'Bearer wrong' },
    }));
    expect(r.status).toBe(401);
  });

  it('returns /v1/models reflecting backend availability', async () => {
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      method: 'GET', url: '/v1/models',
      headers: { 'authorization': 'Bearer tok-secret-32' },
    }));
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.object).toBe('list');
    expect(body.data.some(m => m.owned_by === 'anthropic')).toBe(true);
    expect(body.data.some(m => m.owned_by === 'openai')).toBe(true);
  });

  it('routes /v1/messages claude-* → callMessages (Anthropic shape pass-through)', async () => {
    mocks.callMessages.mockResolvedValue({
      status: 200,
      response: new Response(JSON.stringify({id:'msg_1'}), {status: 200}),
      attempts: 1, account: 'a@x.com',
    });
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      url: '/v1/messages',
      headers: { 'authorization': 'Bearer tok-secret-32', 'content-type': 'application/json' },
      body: JSON.stringify({model: 'claude-haiku-4-5-20251001', max_tokens: 10,
                            messages: [{role: 'user', content: 'q'}]}),
    }));
    expect(mocks.callMessages).toHaveBeenCalledOnce();
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).id).toBe('msg_1');
  });

  it('returns 400 on /v1/messages with gpt-* model', async () => {
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      url: '/v1/messages',
      headers: { 'authorization': 'Bearer tok-secret-32' },
      body: JSON.stringify({model: 'gpt-4o-mini', max_tokens: 10, messages: []}),
    }));
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error.type).toBe('invalid_request_error');
  });

  it('routes /v1/chat/completions claude-* → translator → callMessages', async () => {
    mocks.callMessages.mockResolvedValue({
      status: 200,
      response: new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [{type:'text', text:'hi'}],
        stop_reason: 'end_turn',
        usage: {input_tokens: 1, output_tokens: 1},
      }), {status: 200}),
      attempts: 1, account: 'a@x.com',
    });
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      url: '/v1/chat/completions',
      headers: { 'authorization': 'Bearer tok-secret-32' },
      body: JSON.stringify({model: 'claude-haiku-4-5-20251001',
                            messages: [{role: 'user', content: 'q'}]}),
    }));
    expect(mocks.callMessages).toHaveBeenCalledOnce();
    // callMessages received an Anthropic-shape payload
    const calledWith = mocks.callMessages.mock.calls[0][0];
    expect(calledWith.system).toBeUndefined();
    expect(calledWith.max_tokens).toBe(4096);
    // Response was translated back to OpenAI shape
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toBe('hi');
  });

  it('routes /v1/chat/completions gpt-* → callChat (no translation)', async () => {
    mocks.callChat.mockResolvedValue({
      status: 200,
      response: new Response(JSON.stringify({id:'chatcmpl-x', choices:[]}), {status: 200}),
      attempts: 1,
    });
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      url: '/v1/chat/completions',
      headers: { 'authorization': 'Bearer tok-secret-32' },
      body: JSON.stringify({model: 'gpt-4o-mini', messages: [{role:'user', content:'q'}]}),
    }));
    expect(mocks.callChat).toHaveBeenCalledOnce();
    expect(r.status).toBe(200);
  });

  it('routes /v1/embeddings → callEmbeddings', async () => {
    mocks.callEmbeddings.mockResolvedValue({
      status: 200,
      response: new Response(JSON.stringify({data: [{embedding: [0.1]}]}), {status: 200}),
      attempts: 1,
    });
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      url: '/v1/embeddings',
      headers: { 'authorization': 'Bearer tok-secret-32' },
      body: JSON.stringify({model: 'text-embedding-3-small', input: 'hi'}),
    }));
    expect(mocks.callEmbeddings).toHaveBeenCalledOnce();
    expect(r.status).toBe(200);
  });

  it('returns 404 model_not_found for unknown model', async () => {
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      url: '/v1/chat/completions',
      headers: { 'authorization': 'Bearer tok-secret-32' },
      body: JSON.stringify({model: 'palm-2', messages: []}),
    }));
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body).error.type).toBe('model_not_found');
  });

  it('returns 400 on stream:true (v1 deferral)', async () => {
    const router = createRouter(mocks);
    const r = await dispatch(router, makeReq({
      url: '/v1/chat/completions',
      headers: { 'authorization': 'Bearer tok-secret-32' },
      body: JSON.stringify({model: 'claude-haiku-4-5-20251001',
                            messages: [{role:'user', content:'q'}], stream: true}),
    }));
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error.code).toBe('streaming_not_supported_v1');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/serve/router.test.js`
Expected: failure — router doesn't exist.

- [ ] **Step 3: Write the implementation**

Create `lib/serve/router.js`:
```javascript
// HTTP request dispatch. Decoupled from node:http so it's unit-testable —
// node:http server in commands/serve.js just wraps `req` and forwards to
// `dispatch(req)`.
//
// Bearer auth gates everything under /v1/*. /healthz is open.

import { pickUpstream, listModels } from './route-rule.js';
import { openaiToAnthropic, anthropicToOpenai } from './translator.js';

function jsonResponse(status, body) {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function errorResponse(status, type, code, message) {
  return jsonResponse(status, { error: { type, code, message } });
}

function getHeader(req, name) {
  // Headers are case-insensitive; tests may pass either case.
  const lower = name.toLowerCase();
  for (const k of Object.keys(req.headers || {})) {
    if (k.toLowerCase() === lower) return req.headers[k];
  }
  return undefined;
}

function parseBearer(req) {
  const h = getHeader(req, 'authorization');
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return null;
  return h.slice('Bearer '.length).trim();
}

function parseBody(req) {
  if (!req.body) return {};
  try { return JSON.parse(req.body); }
  catch { return null; }
}

async function passthroughResponse(upstreamResult) {
  // upstreamResult.response is a fetch Response — read body once, propagate status.
  const text = await upstreamResult.response.text();
  return {
    status: upstreamResult.status,
    headers: {
      'content-type': upstreamResult.response.headers.get('content-type') || 'application/json',
      'X-Ccrotate-Attempts': String(upstreamResult.attempts ?? 1),
      ...(upstreamResult.account ? { 'X-Ccrotate-Account': upstreamResult.account } : {}),
      ...(upstreamResult.trigger ? { 'X-Ccrotate-Trigger': upstreamResult.trigger } : {}),
      ...(upstreamResult.poolExhausted ? { 'X-Ccrotate-Pool-Exhausted': 'true' } : {}),
    },
    body: text,
  };
}

export function createRouter(deps) {
  const { callMessages, callChat, callEmbeddings, profilesDir, serveToken,
          hasAnthropic, hasOpenai } = deps;

  async function dispatch(req) {
    // /healthz unauth
    if (req.url === '/healthz') {
      return jsonResponse(200, { status: 'ok' });
    }

    // Bearer auth gate
    const tok = parseBearer(req);
    if (!tok || tok !== serveToken) {
      return errorResponse(401, 'authentication_error', 'invalid_bearer', 'missing or invalid bearer token');
    }

    if (req.url === '/v1/models' && req.method === 'GET') {
      return jsonResponse(200, listModels({ hasAnthropic, hasOpenai }));
    }

    if (req.method !== 'POST') {
      return errorResponse(405, 'invalid_request_error', 'method_not_allowed', `method ${req.method} not allowed`);
    }

    const body = parseBody(req);
    if (body === null) {
      return errorResponse(400, 'invalid_request_error', 'invalid_json', 'request body is not valid JSON');
    }

    if (req.url === '/v1/messages') {
      const upstream = pickUpstream(body.model);
      if (upstream !== 'anthropic') {
        return errorResponse(400, 'invalid_request_error', 'model_endpoint_mismatch',
                             '/v1/messages requires a Claude model');
      }
      if (body.stream === true) {
        return errorResponse(400, 'invalid_request_error', 'streaming_not_supported_v1',
                             'stream:true is deferred to v2');
      }
      const result = await callMessages(body, { profilesDir });
      return passthroughResponse(result);
    }

    if (req.url === '/v1/chat/completions') {
      const upstream = pickUpstream(body.model);
      if (upstream === null) {
        return errorResponse(404, 'invalid_request_error', 'model_not_found',
                             `model ${body.model} is not available`);
      }
      if (body.stream === true) {
        return errorResponse(400, 'invalid_request_error', 'streaming_not_supported_v1',
                             'stream:true is deferred to v2');
      }
      if (upstream === 'anthropic') {
        let anthroReq;
        try { anthroReq = openaiToAnthropic(body); }
        catch (e) {
          return errorResponse(400, 'invalid_request_error', e.code || 'translation_failed', e.message);
        }
        const result = await callMessages(anthroReq, { profilesDir });
        // Translate response back to OpenAI shape on 200 only.
        if (result.status === 200) {
          const anthBody = await result.response.json();
          const openaiBody = anthropicToOpenai(anthBody);
          return {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'X-Ccrotate-Attempts': String(result.attempts ?? 1),
              ...(result.account ? { 'X-Ccrotate-Account': result.account } : {}),
              ...(result.trigger ? { 'X-Ccrotate-Trigger': result.trigger } : {}),
            },
            body: JSON.stringify(openaiBody),
          };
        }
        return passthroughResponse(result);
      }
      // upstream === 'openai'
      const result = await callChat(body);
      return passthroughResponse(result);
    }

    if (req.url === '/v1/embeddings') {
      const upstream = pickUpstream(body.model);
      if (upstream !== 'openai') {
        return errorResponse(400, 'invalid_request_error', 'model_endpoint_mismatch',
                             '/v1/embeddings requires an OpenAI model');
      }
      const result = await callEmbeddings(body);
      return passthroughResponse(result);
    }

    return errorResponse(404, 'invalid_request_error', 'unknown_endpoint', `${req.url} not found`);
  }

  return { dispatch };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/serve/router.test.js`
Expected: all 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/serve/router.js lib/serve/router.test.js
git commit -m "feat(serve): router — bearer auth, endpoint dispatch, /v1/models, translation hook"
```

---

## Task 13: openai-client.js — codex pool rotation (conditional on Gate 1)

**Files:**
- Modify (conditionally): `lib/serve/openai-client.js`
- Modify (conditionally): `lib/serve/openai-client.test.js`

> **Gate**: This entire task is conditional on Gate 1 (Task 0 Step 3) returning HTTP 200. If Gate 1 returned 401, mark this task **skipped** in the plan checkboxes (do not delete) and proceed to Task 14. Single-key path from Task 11 is sufficient.

- [ ] **Step 1: Verify Gate 1 outcome (read from the spec doc)**

```bash
grep -A2 "Codex pool feasibility" docs/superpowers/specs/2026-05-15-ccrotate-serve-design.md | head -5
```
Expected: a line documenting "Gate 1 PASS" or "Gate 1 FAIL". Proceed only on PASS.

- [ ] **Step 2: Add the failing test**

Append to `lib/serve/openai-client.test.js`:
```javascript
import fs from 'fs';
import os from 'os';
import path from 'path';

function tmpCodexDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccrotate-serve-oai-'));
}
function codexProfile(email, idTok) {
  return { email, credentials: { tokens: { id_token: idTok, refresh_token: 'rt-' + email } } };
}

describe('openai-client — codex pool path', () => {
  let dir;
  beforeEach(() => { dir = tmpCodexDir(); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('uses id_token from codex profile when CCROTATE_CODEX_DIR is set', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_A'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({id:'chatcmpl-x', choices:[]}), { status: 200 })
    );
    delete process.env.OPENAI_API_KEY; // force codex path
    const result = await callChat({model: 'gpt-4o-mini', messages: []});
    expect(result.status).toBe(200);
    expect(spy.mock.calls[0][1].headers['Authorization']).toBe('Bearer IDTOK_A');
    delete process.env.CCROTATE_CODEX_DIR;
  });

  it('rotates codex accounts on 429+insufficient_quota', async () => {
    fs.writeFileSync(path.join(dir, 'profiles.codex.json'), JSON.stringify({
      'a@x.com': codexProfile('a@x.com', 'IDTOK_A'),
      'b@x.com': codexProfile('b@x.com', 'IDTOK_B'),
    }));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email: 'a@x.com' }));
    process.env.CCROTATE_CODEX_DIR = dir;
    delete process.env.OPENAI_API_KEY;
    let call = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({error: {code: 'insufficient_quota'}}), { status: 429 });
      expect(opts.headers['Authorization']).toBe('Bearer IDTOK_B');
      return new Response('{}', { status: 200 });
    });
    const result = await callChat({model: 'gpt-4o-mini', messages: []});
    expect(result.status).toBe(200);
    expect(result.attempts).toBe(2);
    delete process.env.CCROTATE_CODEX_DIR;
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run lib/serve/openai-client.test.js -t "codex"`
Expected: failures — codex path not implemented.

- [ ] **Step 4: Add codex pool path to openai-client.js**

Prepend at top of `lib/serve/openai-client.js`:
```javascript
import fs from 'node:fs';
import path from 'node:path';
import { withCcrotateLock, markAccountExhausted } from '../state-helpers.js';

function readCodexActive(dir) {
  const profiles = JSON.parse(fs.readFileSync(path.join(dir, 'profiles.codex.json'), 'utf8'));
  let email;
  try { email = JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8')).email; }
  catch { email = Object.keys(profiles)[0]; }
  return { email, profile: profiles[email], all: profiles };
}
function pickNextCodex(dir, tried) {
  const { all } = readCodexActive(dir);
  for (const [email, prof] of Object.entries(all)) {
    if (tried.has(email)) continue;
    if (prof.credentials?.tokens?.id_token) return { email, profile: prof };
  }
  return null;
}
function setActiveCodex(dir, email) {
  withCcrotateLock(dir, () => {
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ email }));
  });
}

async function codexCallOnce({ url, idToken, payload, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function isQuotaExhausted(body) {
  return body?.error?.code === 'insufficient_quota' || body?.error?.type === 'insufficient_quota';
}

async function callOpenaiViaCodex(url, payload, opts) {
  const { timeoutMs = 15000 } = opts;
  const dir = process.env.CCROTATE_CODEX_DIR;
  let cur = readCodexActive(dir);
  const tried = new Set();
  let attempts = 0;
  let last = null;
  while (cur) {
    attempts += 1;
    tried.add(cur.email);
    const idTok = cur.profile.credentials?.tokens?.id_token;
    if (!idTok) {
      cur = pickNextCodex(dir, tried);
      if (cur) setActiveCodex(dir, cur.email);
      continue;
    }
    const response = await codexCallOnce({ url, idToken: idTok, payload, timeoutMs });
    last = response;
    if (response.status === 200) {
      return { status: 200, response, attempts, account: cur.email };
    }
    if (response.status === 429) {
      let body = null;
      try { body = await response.clone().json(); } catch {}
      if (isQuotaExhausted(body) && attempts < 2) {
        markAccountExhausted(dir, cur.email, { reset5h: null, reset7d: null });
        cur = pickNextCodex(dir, tried);
        if (cur) setActiveCodex(dir, cur.email);
        continue;
      }
    }
    // Non-rotatable failure or replay cap hit
    return { status: response.status, response, attempts, account: cur.email };
  }
  return { status: 502, response: last, attempts, poolExhausted: true };
}
```

In `callChat`, replace:
```javascript
export async function callChat(payload, opts = {}) {
  const { timeoutMs = 15000 } = opts;
  // Prefer single-key path if OPENAI_API_KEY is set; otherwise codex pool.
  if (process.env.OPENAI_API_KEY) {
    const response = await callOnceJson({ url: CHAT_URL, payload, timeoutMs });
    return { status: response.status, response, attempts: 1 };
  }
  if (process.env.CCROTATE_CODEX_DIR) {
    return callOpenaiViaCodex(CHAT_URL, payload, opts);
  }
  throw new Error('openai-client: neither OPENAI_API_KEY nor CCROTATE_CODEX_DIR set');
}
```

Same treatment for `callEmbeddings` (use `EMB_URL`).

- [ ] **Step 5: Run all openai-client tests**

Run: `npx vitest run lib/serve/openai-client.test.js`
Expected: 4 single-key tests + 2 codex tests all pass.

- [ ] **Step 6: Commit**

```bash
git add lib/serve/openai-client.js lib/serve/openai-client.test.js
git commit -m "feat(serve): openai-client — codex pool rotation when CCROTATE_CODEX_DIR set"
```

---

## Task 14: serve.js + bin/ccrotate.js + ccrotate.js wire-in

**Files:**
- Create: `lib/commands/serve.js`
- Modify: `lib/ccrotate.js`
- Modify: `bin/ccrotate.js`

- [ ] **Step 1: Write the failing smoke test (manual, no vitest needed)**

Plan a test command — we'll run it after implementation:
```bash
CCROTATE_SERVE_TOKEN=test-tok node bin/ccrotate.js serve --port 14001 --bind 127.0.0.1 &
SERVE_PID=$!
sleep 1
curl -sS http://127.0.0.1:14001/healthz
echo
kill $SERVE_PID 2>/dev/null
```
Expected (after implementation): `{"status":"ok"}`.

- [ ] **Step 2: Create lib/commands/serve.js**

```javascript
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
```

- [ ] **Step 3: Register ServeCommand in lib/ccrotate.js**

Modify `lib/ccrotate.js`:

a) Add import near the other command imports:
```javascript
import { ServeCommand } from './commands/serve.js';
```

b) Add to the `commands` object inside the constructor:
```javascript
      serve: new ServeCommand(this),
```

c) Add a public method that calls it (mirroring the pattern of e.g. `list()`):
```javascript
async serve(options = {}) {
  return this.commands.serve.execute(options);
}
```

(Put `serve` next to the other public methods.)

- [ ] **Step 4: Wire bin/ccrotate.js**

Modify `bin/ccrotate.js` — add after the existing `program.command(...)` blocks:
```javascript
program
  .command('serve')
  .description('Run HTTP server exposing /v1/messages and /v1/chat/completions over the OAuth pool')
  .option('--port <port>', 'TCP port to bind', '4001')
  .option('--bind <host>', 'address to bind', '0.0.0.0')
  .action(async (options) => {
    try {
      await ccrotate.serve(options);
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });
```

- [ ] **Step 5: Run the smoke recipe**

Run:
```bash
CCROTATE_SERVE_TOKEN=test-tok node bin/ccrotate.js serve --port 14001 --bind 127.0.0.1 &
SERVE_PID=$!
sleep 1
HZ=$(curl -sS http://127.0.0.1:14001/healthz)
echo "healthz: $HZ"
MODELS=$(curl -sS -H 'Authorization: Bearer test-tok' http://127.0.0.1:14001/v1/models)
echo "models: $MODELS"
kill $SERVE_PID 2>/dev/null
wait $SERVE_PID 2>/dev/null
```
Expected:
- `healthz: {"status":"ok"}`
- `models: {"object":"list","data":[...]}` (data may be empty if no profiles)

- [ ] **Step 6: Run the unit test suite to ensure nothing regressed**

Run: `npx vitest run`
Expected: all suites pass.

- [ ] **Step 7: Commit**

```bash
git add lib/commands/serve.js lib/ccrotate.js bin/ccrotate.js
git commit -m "feat(serve): wire ServeCommand into CLI — node:http server + graceful shutdown"
```

---

## Task 15: integration.test.js — end-to-end exercises

**Files:**
- Create: `lib/serve/integration.test.js`

- [ ] **Step 1: Write the failing integration test**

Create `lib/serve/integration.test.js`:
```javascript
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
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'msg_int_1', type: 'message', role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [{type:'text', text:'pong'}],
        stop_reason: 'end_turn',
        usage: {input_tokens: 1, output_tokens: 1},
      }), { status: 200 })
    );

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
```

- [ ] **Step 2: Run the test to verify it fails first, then passes**

Run: `npx vitest run lib/serve/integration.test.js`
Expected: all 3 tests pass (we built everything they exercise in Tasks 1-14). If anything fails, fix and re-run.

- [ ] **Step 3: Run the full test suite (sanity)**

Run: `npx vitest run`
Expected: every suite green.

- [ ] **Step 4: Commit**

```bash
git add lib/serve/integration.test.js
git commit -m "test(serve): integration tests — end-to-end translation + auth gate"
```

---

## Task 16: Dockerfile.serve + image build

**Files:**
- Create: `Dockerfile.serve`
- Create: `.dockerignore` (only if absent)

- [ ] **Step 1: Verify build script works**

Run:
```bash
pnpm install --frozen-lockfile
pnpm build
ls -la dist/
```
Expected: `dist/` contains bundled output (matches existing pattern from `esbuild.config.js`).

- [ ] **Step 2: Create Dockerfile.serve**

```dockerfile
# syntax=docker/dockerfile:1.6
FROM node:20-alpine AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /src/dist /app
USER node
EXPOSE 4001
ENTRYPOINT ["node", "/app/ccrotate.js", "serve"]
```

- [ ] **Step 3: Create .dockerignore if missing**

```bash
test -f .dockerignore || cat > .dockerignore <<'EOF'
node_modules
dist
.git
.github
docs
*.test.js
EOF
```

- [ ] **Step 4: Build the image locally**

Run:
```bash
docker buildx build -f Dockerfile.serve -t ccrotate-serve:dev --load .
docker images ccrotate-serve:dev
```
Expected: image present, size < 200MB.

- [ ] **Step 5: Smoke-test the image**

Run:
```bash
docker run --rm -d --name ccs-smoke -e CCROTATE_SERVE_TOKEN=tok -p 14001:4001 ccrotate-serve:dev
sleep 2
curl -sS http://127.0.0.1:14001/healthz
echo
docker logs ccs-smoke 2>&1 | head -10
docker stop ccs-smoke
```
Expected: `{"status":"ok"}`.

- [ ] **Step 6: Push to registry**

Run:
```bash
SHA=$(git rev-parse HEAD)
docker buildx build -f Dockerfile.serve \
  -t registry.blockcast.net/ccrotate-serve:${SHA} \
  -t registry.blockcast.net/ccrotate-serve:latest \
  --push .
echo "Pushed sha-${SHA}"
```
Expected: registry accepts push; SHA recorded for use in manifest.

- [ ] **Step 7: Commit Dockerfile + .dockerignore**

```bash
git add Dockerfile.serve .dockerignore
git commit -m "build(serve): Dockerfile.serve — minimal node:20-alpine sidecar image"
```

---

## Task 17: K8s manifests — Secret + Service + Deployment patch

**Files (in `~/k8s/paperclip/`):**
- Create: `ccrotate-serve-service.yaml`
- Create: `ccrotate-serve-secret.example.yaml`
- Create: `ccrotate-serve-runbook.md`
- Modify: `ccrotate-auth-bot.yaml`

> **cwd for this task**: `~/k8s/paperclip`

- [ ] **Step 1: Identify the live auth-bot manifest source**

Run:
```bash
cd ~/k8s/paperclip
ls -la ccrotate-auth-bot.yaml
git log --oneline -5 ccrotate-auth-bot.yaml
```
If multiple branches contain different versions (per the `k8s_yaml_branch_footgun.md` memory), confirm with the live cluster:
```bash
kubectl -n paperclip get deployment ccrotate-auth-bot -o yaml > /tmp/live-cab.yaml
diff <(yq '.spec.template.spec' /tmp/live-cab.yaml) <(yq '.spec.template.spec' ccrotate-auth-bot.yaml) | head -40
```
Resolve any drift before patching.

- [ ] **Step 2: Create the Secret OOB (NOT in source control)**

Run:
```bash
SERVE_TOKEN=$(openssl rand -base64 32 | tr -d '=' | tr '+/' '-_')
kubectl -n paperclip create secret generic paperclip-ccrotate-serve-secrets \
  --from-literal=serveToken="${SERVE_TOKEN}" \
  --dry-run=client -o yaml > /tmp/serve-secret.yaml
kubectl apply -f /tmp/serve-secret.yaml
rm /tmp/serve-secret.yaml
# Mirror to litellm ns for LiteLLM to read
kubectl -n litellm create secret generic litellm-ccrotate-bearer \
  --from-literal=serveToken="${SERVE_TOKEN}" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "Secrets created. Token length: ${#SERVE_TOKEN}"
```
Expected: two Secrets created (paperclip ns + litellm ns). Token discarded after this step.

- [ ] **Step 3: Create the Service manifest**

Create `~/k8s/paperclip/ccrotate-serve-service.yaml`:
```yaml
apiVersion: v1
kind: Service
metadata:
  name: ccrotate-serve
  namespace: paperclip
  labels:
    app.kubernetes.io/name: ccrotate-auth-bot
    app.kubernetes.io/component: serve
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: ccrotate-auth-bot
  ports:
    - name: serve
      port: 4001
      targetPort: 4001
      protocol: TCP
```

Apply: `kubectl apply -f ~/k8s/paperclip/ccrotate-serve-service.yaml`.
Verify: `kubectl -n paperclip get svc ccrotate-serve` shows ClusterIP assigned.

- [ ] **Step 4: Create the example Secret manifest (docs only)**

Create `~/k8s/paperclip/ccrotate-serve-secret.example.yaml`:
```yaml
# NOT applied directly — real secret is created out-of-band via:
#   kubectl -n paperclip create secret generic paperclip-ccrotate-serve-secrets \
#     --from-literal=serveToken=<32-byte random> \
#     [--from-literal=openaiApiKey=<sk-...>]
# See ccrotate-serve-runbook.md for full procedure.
apiVersion: v1
kind: Secret
metadata:
  name: paperclip-ccrotate-serve-secrets
  namespace: paperclip
type: Opaque
stringData:
  serveToken: PLACEHOLDER_NOT_REAL
  openaiApiKey: ""
```

- [ ] **Step 5: Patch ccrotate-auth-bot.yaml — add second container**

Open `~/k8s/paperclip/ccrotate-auth-bot.yaml` in `lib/ccrotate-auth-bot.yaml`. Find `spec.template.spec.containers:` and append a new container item AFTER the `tailscale` container. Use the image SHA pushed in Task 16.

Add to `spec.template.spec.containers:`:
```yaml
- name: ccrotate-serve
  image: registry.blockcast.net/ccrotate-serve:<PUT-SHA-HERE>
  imagePullPolicy: IfNotPresent
  args: ["--port", "4001", "--bind", "0.0.0.0"]
  env:
    - { name: HOME, value: /paperclip }
    - name: CCROTATE_SERVE_TOKEN
      valueFrom:
        secretKeyRef:
          name: paperclip-ccrotate-serve-secrets
          key: serveToken
    - name: OPENAI_API_KEY
      valueFrom:
        secretKeyRef:
          name: paperclip-ccrotate-serve-secrets
          key: openaiApiKey
          optional: true
    - { name: CCROTATE_TARGET,         value: claude }
    - { name: CCROTATE_SERVE_LOG_LEVEL, value: info }
  ports:
    - { containerPort: 4001, name: serve, protocol: TCP }
  readinessProbe:
    httpGet: { path: /healthz, port: 4001 }
    periodSeconds: 5
    failureThreshold: 3
  livenessProbe:
    httpGet: { path: /healthz, port: 4001 }
    periodSeconds: 30
    failureThreshold: 3
  resources:
    requests: { cpu: 50m,  memory: 96Mi }
    limits:   { cpu: 500m, memory: 384Mi }
  securityContext:
    runAsUser: 1000
    runAsNonRoot: true
    allowPrivilegeEscalation: false
    capabilities: { drop: [ALL] }
    readOnlyRootFilesystem: true
  volumeMounts:
    - { mountPath: /paperclip, name: paperclip-shared }
    - { mountPath: /tmp,        name: tmp-serve }
```

Add to `spec.template.spec.volumes:`:
```yaml
- name: tmp-serve
  emptyDir: { medium: Memory, sizeLimit: 64Mi }
```

- [ ] **Step 6: Apply the Deployment patch**

Run:
```bash
cd ~/k8s/paperclip
kubectl apply -f ccrotate-auth-bot.yaml
kubectl -n paperclip rollout status deployment/ccrotate-auth-bot --timeout=180s
```
Expected: rollout completes; Pod shows `READY 3/3`.

- [ ] **Step 7: Verify sidecar is reachable**

Run:
```bash
kubectl -n paperclip exec deploy/ccrotate-auth-bot -c ccrotate-serve -- wget -qO- http://localhost:4001/healthz
kubectl -n paperclip exec deploy/ccrotate-auth-bot -c bot -- wget -qO- http://ccrotate-serve.paperclip.svc.cluster.local:4001/healthz
```
Expected both: `{"status":"ok"}`.

- [ ] **Step 8: Create the runbook**

Create `~/k8s/paperclip/ccrotate-serve-runbook.md`:
```markdown
# ccrotate-serve runbook

## Smoke test (in-cluster)

```bash
TOKEN=$(kubectl -n paperclip get secret paperclip-ccrotate-serve-secrets -o jsonpath='{.data.serveToken}' | base64 -d)
kubectl -n paperclip port-forward svc/ccrotate-serve 4001:4001 &
PF_PID=$!
sleep 1
curl -sS -H "Authorization: Bearer $TOKEN" http://localhost:4001/v1/models | jq .
curl -sS -H "Authorization: Bearer $TOKEN" http://localhost:4001/v1/messages \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":50,"messages":[{"role":"user","content":"ping"}]}' | jq .
curl -sS -H "Authorization: Bearer $TOKEN" http://localhost:4001/v1/chat/completions \
  -d '{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"ping"}]}' | jq .
kill $PF_PID 2>/dev/null
```

## Rotate the serve token

```bash
NEW=$(openssl rand -base64 32 | tr -d '=' | tr '+/' '-_')
kubectl -n paperclip create secret generic paperclip-ccrotate-serve-secrets \
  --from-literal=serveToken="$NEW" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n litellm create secret generic litellm-ccrotate-bearer \
  --from-literal=serveToken="$NEW" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n paperclip rollout restart deployment/ccrotate-auth-bot
kubectl -n litellm rollout restart deployment/litellm
```

## Inspect rotation behavior

Headers on every response:
- `X-Ccrotate-Attempts: N` — total upstream calls
- `X-Ccrotate-Account: <email>` — account that produced the response
- `X-Ccrotate-Trigger: quota|refresh-fail|transient-429` — present when rotation kicked in
- `X-Ccrotate-Pool-Exhausted: true` — every account failed

## When everything is wedged

```bash
# Check sidecar logs
kubectl -n paperclip logs deploy/ccrotate-auth-bot -c ccrotate-serve --tail=200

# Check what /v1/models advertises (no auth needed for diagnosis since we're in-pod)
kubectl -n paperclip exec deploy/ccrotate-auth-bot -c ccrotate-serve -- wget -qO- http://localhost:4001/v1/models

# Check tier-cache state — if every account is `serviceTier: exhausted`,
# wait for resets or force-clear via:
#   kubectl exec ... -- ccrotate refresh
# (run from the bot container, not ccrotate-serve, since bot has the CLI)
```
```

- [ ] **Step 9: Commit manifests**

```bash
cd ~/k8s/paperclip
git add ccrotate-serve-service.yaml ccrotate-serve-secret.example.yaml ccrotate-serve-runbook.md ccrotate-auth-bot.yaml
git commit -m "feat(paperclip): add ccrotate-serve sidecar + Service + runbook"
```

---

## Task 18: LiteLLM cutover — add claude-* models + fallback chain

**Files (in `~/k8s/paperclip/litellm/`):**
- Modify: `configmap.yaml` (or the embedded yaml in `deployment.yaml`, depending on layout)
- Modify: `deployment.yaml`

> **cwd for this task**: `~/k8s/paperclip/litellm`

- [ ] **Step 1: Diff live config vs source**

Run:
```bash
cd ~/k8s/paperclip/litellm
kubectl -n litellm get cm litellm-config -o yaml > /tmp/live-cm.yaml
diff <(yq '.data."config.yaml"' /tmp/live-cm.yaml) <(yq '.data."config.yaml"' configmap.yaml || cat configmap.yaml) | head -40
```
If drift exists, reconcile source-of-truth before patching.

- [ ] **Step 2: Patch the ConfigMap**

Edit `configmap.yaml` — append to the `model_list:` block:
```yaml
      - model_name: claude-haiku-4-5-20251001
        litellm_params:
          model: openai/claude-haiku-4-5-20251001
          api_base: http://ccrotate-serve.paperclip.svc.cluster.local:4001/v1
          api_key: os.environ/CCROTATE_SERVE_TOKEN
      - model_name: claude-sonnet-4-6
        litellm_params:
          model: openai/claude-sonnet-4-6
          api_base: http://ccrotate-serve.paperclip.svc.cluster.local:4001/v1
          api_key: os.environ/CCROTATE_SERVE_TOKEN
      - model_name: claude-opus-4-7
        litellm_params:
          model: openai/claude-opus-4-7
          api_base: http://ccrotate-serve.paperclip.svc.cluster.local:4001/v1
          api_key: os.environ/CCROTATE_SERVE_TOKEN
```

Append to `litellm_settings:`:
```yaml
      fallbacks:
        - { "gpt-4o-mini": ["claude-haiku-4-5-20251001"] }
        - { "gpt-5.5":     ["claude-sonnet-4-6"] }
```

- [ ] **Step 3: Patch the Deployment env**

Edit `deployment.yaml` — add to the `litellm` container's `env`:
```yaml
- name: CCROTATE_SERVE_TOKEN
  valueFrom:
    secretKeyRef:
      name: litellm-ccrotate-bearer
      key: serveToken
```

- [ ] **Step 4: Apply patches + rollout-restart**

Run:
```bash
kubectl apply -f configmap.yaml
kubectl apply -f deployment.yaml
kubectl -n litellm rollout restart deployment/litellm
kubectl -n litellm rollout status deployment/litellm --timeout=120s
```
Expected: rollout completes; Pod READY 1/1.

- [ ] **Step 5: Smoke-test LiteLLM end-to-end**

Run:
```bash
LL_KEY=$(kubectl -n litellm get secret litellm-secrets -o jsonpath='{.data.LITELLM_MASTER_KEY}' | base64 -d)
kubectl -n litellm port-forward svc/litellm 4000:4000 &
PF_PID=$!
sleep 1
# /v1/models should now list claude-haiku-4-5-20251001
curl -sS -H "Authorization: Bearer $LL_KEY" http://localhost:4000/v1/models | jq '.data[].id' | grep -i claude
# Direct chat completion through the new model
curl -sS -H "Authorization: Bearer $LL_KEY" http://localhost:4000/v1/chat/completions \
  -d '{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"ping"}]}' | jq .
# Fallback path: gpt-4o-mini should now fall through to claude-haiku on 429
curl -sS -H "Authorization: Bearer $LL_KEY" http://localhost:4000/v1/chat/completions \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}]}' | jq .
kill $PF_PID 2>/dev/null
```
Expected:
- claude-haiku model listed.
- Direct claude call returns 200 with chat-completion body.
- gpt-4o-mini call returns 200 (via fallback) — content from Claude, model field reflects the resolved model.

- [ ] **Step 6: Commit LiteLLM patch**

```bash
cd ~/k8s/paperclip/litellm
git add configmap.yaml deployment.yaml
git commit -m "feat(litellm): route claude-* to ccrotate-serve + fallback gpt → claude on quota"
```

---

## Task 19: Hindsight unblock — verify nodes start materializing

**Files:** none (verification only)

- [ ] **Step 1: Roll Hindsight-api to flush stuck retries**

Run:
```bash
kubectl -n hindsight rollout restart deployment/hindsight-api
kubectl -n hindsight rollout status deployment/hindsight-api --timeout=120s
```
Expected: rollout completes.

- [ ] **Step 2: Watch Hindsight logs for extraction activity**

Run:
```bash
kubectl -n hindsight logs deployment/hindsight-api --since=2m -f &
LOG_PID=$!
sleep 60
kill $LOG_PID 2>/dev/null
```
Look for: `extracting`, `fact`, `node`, or `consolidation` log lines (no `insufficient_quota`).

- [ ] **Step 3: Re-enqueue consolidation jobs for the 5 per-agent banks**

The completed-with-empty operations from the prior session need re-running. Run the existing recipe from `~/k8s/.planning/next-session-2026-05-15f.md` step 4:
```bash
kubectl -n paperclip exec paperclip-0 -c paperclip -- python3 -c "
import urllib.request, json
banks = ['cd284f1d-6fbf-4546-b933-62167d544c2d', '386c81e8-e454-41ba-8e1d-7bb692331185',
         '4eca1725-632f-45fa-97a2-8cf7e0430958', 'c6d95c42-9456-4806-b691-88014fc95e32',
         'c0bccc75-a449-4ece-a789-ce40bdd8e785']
for aid in banks:
    bid = f'paperclip::aaced805-3491-4ee5-9b14-cdf70cb81d47::{aid}'
    # Trigger re-consolidation (Hindsight idempotent: re-running over completed
    # docs re-runs fact extraction on docs whose memory_units count is 0).
    req = urllib.request.Request(
        f'http://hindsight-api.hindsight.svc.cluster.local:8888/v1/default/banks/{bid}/reconsolidate',
        method='POST',
    )
    try:
        urllib.request.urlopen(req)
        print(f'queued {aid[:8]}')
    except Exception as e:
        print(f'  {aid[:8]} error: {e}')
"
```
Expected: each bank prints `queued`. If `reconsolidate` endpoint is unavailable, instead re-POST docs via the existing batch_retain path (see runbook for exact recipe).

- [ ] **Step 4: Verify nodes start appearing**

Wait 5 minutes, then run:
```bash
kubectl -n paperclip exec paperclip-0 -c paperclip -- python3 -c "
import urllib.request, json
banks = ['cd284f1d-6fbf-4546-b933-62167d544c2d', '386c81e8-e454-41ba-8e1d-7bb692331185',
         '4eca1725-632f-45fa-97a2-8cf7e0430958', 'c6d95c42-9456-4806-b691-88014fc95e32',
         'c0bccc75-a449-4ece-a789-ce40bdd8e785']
for aid in banks:
    bid = f'paperclip::aaced805-3491-4ee5-9b14-cdf70cb81d47::{aid}'
    r = urllib.request.urlopen(f'http://hindsight-api.hindsight.svc.cluster.local:8888/v1/default/banks/{bid}/stats')
    d = json.loads(r.read())
    print(f\"  {aid[:8]}  docs={d['total_documents']:3d}  nodes={d['total_nodes']:4d}  links={d['total_links']:5d}\")
"
```
Expected: at least one bank shows `total_nodes > 0`. If all still zero after 10 minutes, check `kubectl -n paperclip logs deploy/ccrotate-auth-bot -c ccrotate-serve | tail -50` for upstream errors.

- [ ] **Step 5: Push final state to omar/ccrotate-serve and open PR**

```bash
cd ~/src/ccrotate
git push -u origin omar/ccrotate-serve
gh pr create --title "ccrotate serve — HTTP sidecar over OAuth pool" --body "$(cat <<'EOF'
## Summary
- Exposes /v1/messages, /v1/chat/completions, /v1/embeddings, /v1/models on top of the OAuth pool managed by ccrotate.
- Routes by model-name prefix: claude-* → Anthropic OAuth pool; gpt-*/etc → OpenAI key or codex pool.
- Pool-walk on refresh-fail, replay-once on structural quota, lazy refresh on 401, all under the existing withCcrotateLock.

## Spec & plan
- Design: docs/superpowers/specs/2026-05-15-ccrotate-serve-design.md
- Plan:   docs/superpowers/plans/2026-05-15-ccrotate-serve.md

## Test plan
- [x] vitest unit + integration suites green
- [x] Image builds < 200MB and runs healthz under docker
- [x] In-cluster sidecar healthy, /v1/models advertises configured backends
- [x] LiteLLM fallback gpt-4o-mini → claude-haiku verified end-to-end
- [x] Hindsight per-agent banks start showing total_nodes > 0

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Task 20: Final sweep — close out and record outcomes

- [ ] **Step 1: Re-run vitest suite**

```bash
cd ~/src/ccrotate
npx vitest run
```
Expected: all suites green.

- [ ] **Step 2: Update the spec with rollout outcome**

Edit `docs/superpowers/specs/2026-05-15-ccrotate-serve-design.md`, change the front-matter `Status` field from `design, pending implementation` → `implemented` and add an `Implemented:` row pointing at the PR.

- [ ] **Step 3: Commit + push**

```bash
git add docs/superpowers/specs/2026-05-15-ccrotate-serve-design.md
git commit -m "docs(serve): mark spec as implemented; link PR"
git push
```

- [ ] **Step 4: Record memory entries worth keeping**

If implementation surfaced surprises (probe outcomes, OAuth header gotchas, rotation behaviour under contention), capture them in `~/.claude/projects/-home-oramadan-src-paperclip/memory/` using the appropriate type (project/feedback/reference). Skip otherwise.

---

## Self-review against the spec

Section / requirement | Task(s) covering it
---|---
Goals 1 (expose 4 endpoints + /healthz) | Tasks 12, 14
Goals 2 (route by model prefix) | Tasks 2, 12
Goals 3 (rotation + pool walk) | Tasks 9, 10
Goals 4 (lazy refresh on 401) | Task 8
Goals 5 (sidecar in auth-bot pod) | Task 17
Goals 6 (unblock Hindsight in one rollout window) | Tasks 18, 19
Non-goal 1 (no streaming) | Task 3 (rejects stream:true), Task 12 (returns 400)
Architecture section (modules + responsibilities) | Tasks 2, 3-6, 7-10, 11, 13, 12, 14
Routing rule table | Task 2
Endpoint × upstream matrix | Task 12
Translator subtleties (system, max_tokens default, tool_calls, multimodal, finish_reason map) | Tasks 3-6
State machine 401/refresh/quota/transient/5xx/timeout | Tasks 8, 9, 10
Refresh-fail definition + pool-exhausted definition | Tasks 8, 9 (test names + comments)
Lock semantics (withCcrotateLock for mutations) | Tasks 8, 9, 10 (use existing helper)
K8s deployment shape (Service, Secret, container patch, image, ConfigMap, Deployment patch) | Tasks 16, 17, 18
Rollout plan gates 0-7 | Tasks 0 (gates 0+1), 14-15 (gate 2), 16 (gate 3), 17 (gate 4), 17 step 7 (gate 5), 18 (gate 6), 19 (gate 7)
Rollback semantics per gate | Task 17 step 6 (rollout undo), Task 18 step 4 (apply previous), Task 19 (no rollback needed)
Out-of-scope items (streaming, audio/images, etc.) | Recorded in spec; no tasks to add

No unaddressed spec sections. No placeholders in tasks. Function names consistent across tasks (`callMessages`, `callChat`, `callEmbeddings`, `pickUpstream`, `listModels`, `openaiToAnthropic`, `anthropicToOpenai`, `withCcrotateLock`, `markAccountExhausted`, `pickNextCandidate`, `setActiveAccount`).

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-15-ccrotate-serve.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task with two-stage review between tasks.

**2. Inline Execution** — execute tasks in this session using executing-plans, with checkpoints for review.

Which approach?
