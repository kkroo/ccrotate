# ccrotate serve — design

- **Date**: 2026-05-15
- **Status**: design, pending implementation
- **Owner**: bot2@blockcast.net
- **Author**: brainstormed via superpowers:brainstorming in paperclip resume session
- **Related**:
  - `~/k8s/.planning/next-session-2026-05-15f.md` — origin of the LiteLLM/Hindsight blocker
  - `PAPERCLIP_PLUGIN_PLAN.md` — earlier ccrotate-as-paperclip-plugin work, complementary
  - Memory `hindsight-async-retain-quota-trap.md` — the silent-failure trap this unblocks
  - Memory `kubectl-apply-clobbers-inline-secrets.md` — secret bootstrapping pattern reused

## Context

Hindsight fact extraction is stalled. The OpenAI key in `litellm-secrets` returns HTTP 429 `insufficient_quota` — structurally exhausted, not throttled. 87 docs are stored across 5 per-agent banks but `total_nodes=0` everywhere because every consolidation operation's LLM call silently fails. Meanwhile we operate an 11-account Claude Code pool managed by ccrotate, with several accounts at low utilization and fast reset windows.

This document specifies a sidecar that exposes the ccrotate-managed OAuth pool as an OpenAI/Anthropic-compatible HTTP endpoint, so LiteLLM can route Hindsight's requests through Claude instead of the dead OpenAI key.

## Goals

1. Expose `/v1/chat/completions`, `/v1/messages`, `/v1/embeddings`, `/v1/models`, `/healthz`.
2. Route by model-name prefix to either the Claude OAuth pool (Anthropic) or OpenAI upstream.
3. Rotate accounts on structural quota errors and walk the pool on refresh failures, all under the existing ccrotate advisory lock.
4. Lazy token refresh on 401, without competing with ccrotate-auth-bot's existing cron.
5. Deploy as a second container in the existing `ccrotate-auth-bot` Pod, no new Deployment.
6. Unblock Hindsight's 87-doc backlog within one rollout window.

## Non-goals (v1)

- Streaming (`stream: true`) — returns 400 in v1.
- Multi-tenant access control beyond a single shared bearer token.
- `/v1/audio/*`, `/v1/images/*`.
- Prometheus metrics, OpenTelemetry traces.
- ChatGPT account `id_token` against `chatgpt.com/backend-api/conversation` if codex→api.openai.com probe fails (deferred).

## Architecture

```
┌─────────────────────┐                ┌──────────────────────────────────────┐
│  Hindsight worker   │                │            ccrotate-auth-bot pod     │
│   (hindsight ns)    │                │           (paperclip ns)             │
│                     │                │                                      │
│  consolidation →    │   OpenAI       │  ┌──────────┐    ┌────────────────┐  │
│  /v1/chat/comp ───┐ │  shape         │  │   bot    │    │ ccrotate-serve │  │
│                    \│                │  │ (codex   │    │   (NEW)        │  │
└─────────────────────┘                │  │  re-auth)│    │                │  │
           │                           │  └──────────┘    │   :4001        │  │
           │                           │       │          │                │  │
           ▼                           │       └──┐    ┌──┤  shares PVC    │  │
┌─────────────────────┐                │          ▼    ▼  │ /paperclip/    │  │
│   LiteLLM proxy     │   Anthropic    │       /paperclip/│ .ccrotate/     │  │
│   (litellm ns)      │   shape /      │       .ccrotate/ │ profiles.json  │  │
│                     │   Bearer       │       (shared    │ tier-cache.json│  │
│  config: provider   ├────────────────►       PVC,       │                │  │
│  → api_base=        │   pre-shared   │       advisory   └────────────────┘  │
│  http://ccrotate-   │   bearer       │       lock)               │          │
│  serve.paperclip... │                │                           │ HTTPS    │
└─────────────────────┘                └──────────────────────────────────────┘
                                                                   │
                                                       api.anthropic.com/v1/messages
                                                       Authorization: Bearer <oauth>
                                                       anthropic-beta: oauth-2025-04-20
                                                       (or)
                                                       api.openai.com/v1/chat/completions
                                                       Authorization: Bearer <openai_key>
```

Pod placement: a second container in the existing `Deployment/ccrotate-auth-bot` (single replica, Recreate strategy). Same cephfs PVC (`paperclip-data`), same advisory-lock domain.

## Module responsibilities

All new code lives under `~/src/ccrotate/lib/serve/` plus one CLI entrypoint.

| File | Job | Imports | Exports |
|---|---|---|---|
| `lib/commands/serve.js` | CLI verb. Parses `--port`, `--bind`, `--target`. Registers with `commands` object in `lib/ccrotate.js`. Starts `node:http` server. | `node:http`, `./serve/router.js`, `../state-helpers.js` | `ServeCommand` |
| `lib/serve/router.js` | HTTP request dispatch. Bearer-token auth middleware (env `CCROTATE_SERVE_TOKEN`). Routes `/v1/{messages,chat/completions,embeddings,models}` and `/healthz`. | `node:http`, `./route-rule.js`, `./translator.js`, `./anthropic-client.js`, `./openai-client.js` | `createRouter(ccrotate, deps)` |
| `lib/serve/route-rule.js` | Pure functions. Maps model-name prefix to upstream (`anthropic` or `openai`). Builds `/v1/models` response body from configured backends. | none | `pickUpstream(model)`, `listModels({hasAnthropic, hasOpenai})` |
| `lib/serve/translator.js` | Pure functions. OpenAI chat-completions request → Anthropic messages request; Anthropic response → OpenAI response. Subtleties: system extraction, tool_calls↔tool_use reshape, finish_reason mapping, multimodal content. | none | `openaiToAnthropic(req)`, `anthropicToOpenai(res)` |
| `lib/serve/anthropic-client.js` | Calls `api.anthropic.com`. Classifies response. On `insufficient_quota` → mark exhausted, rotate, replay once. On 401 → refresh; on refresh-fail → pool-walk under lock. Reads `profiles.json` fresh per request. | `node:fetch`, `../state-helpers.js`, ccrotate's `loadProfiles`+`getCurrentAccount`+`next` | `callMessages(payload, opts)` |
| `lib/serve/openai-client.js` | Calls `api.openai.com`. If codex pool probe succeeded at build time: rotate codex profiles on errors. Otherwise: single `OPENAI_API_KEY` env, propagate on failure. | `node:fetch`, ccrotate's codex profile helpers | `callChat(payload, opts)`, `callEmbeddings(payload)` |

Constraints baked in by this layout:
- Translator is pure — testable without HTTP or OAuth.
- Only `anthropic-client` and `openai-client` mutate ccrotate state, both under `withCcrotateLock`.
- `router` does no I/O beyond dispatch + bearer check.
- Reuses `withCcrotateLock` and `markAccountExhausted` from existing `lib/state-helpers.js`. No duplicated lock logic.

## API surface

### Endpoint × upstream matrix

| Endpoint | + anthropic upstream | + openai upstream |
|---|---|---|
| `/v1/messages` | pass-through (with OAuth rotation) | 400 `invalid_request_error` ("requires Claude model") |
| `/v1/chat/completions` | translate request → anthropic-client → translate response | openai-client (no translation) |
| `/v1/embeddings` | 400 (Anthropic does not offer embeddings) | openai-client |
| `/v1/models` | union of advertised models from configured backends | (same) |
| `/healthz` | always 200 | (same) |

### Routing rule (route-rule.js)

```
model starts with "claude-"            → anthropic
model starts with "gpt-", "o1-",
     "text-embedding-", "tts-",
     "whisper-", "davinci-", "babbage-" → openai
anything else                          → 404 model_not_found
```

### `/v1/models` payload (OpenAI-compatible)

A model entry appears in the response iff its backend is configured. Anthropic backend is "configured" iff `profiles.json` has ≥1 non-stale profile. OpenAI backend is "configured" iff a sanity-check call against `api.openai.com/v1/models` at startup returned 200 OR the codex pool probe at startup succeeded.

```json
{"object":"list","data":[
  {"id":"claude-haiku-4-5-20251001","object":"model","owned_by":"anthropic"},
  {"id":"claude-sonnet-4-6","object":"model","owned_by":"anthropic"},
  {"id":"claude-opus-4-7","object":"model","owned_by":"anthropic"},
  {"id":"gpt-4o-mini","object":"model","owned_by":"openai"},
  {"id":"text-embedding-3-small","object":"model","owned_by":"openai"}
]}
```

### Bearer authentication

All `/v1/*` endpoints require `Authorization: Bearer <CCROTATE_SERVE_TOKEN>`. `/healthz` is unauthenticated. Mismatch returns 401.

## Request flow + state machine

### Anthropic request

```
client → router.js
  ├─ bearer check (CCROTATE_SERVE_TOKEN env)
  ├─ parse JSON, extract `model`
  ├─ route-rule.js → "anthropic"
  └→ anthropic-client.callMessages(payload, {attempt: 1})
       │
       │ ① loadProfiles() + getCurrentAccount()
       │ ② tier-cache pre-filter: skip accounts already marked exhausted with future reset
       │ ③ fetch https://api.anthropic.com/v1/messages
       │     headers:
       │       Authorization: Bearer <oauth.accessToken>
       │       anthropic-version: 2023-06-01
       │       anthropic-beta: oauth-2025-04-20
       │       Content-Type: application/json
       │ ④ classify response → continue / rotate / refresh / propagate
       │
       └ state machine below
```

### State machine

```
fetch result
  │
  ├─ 200 OK ──────────────────────────────────────► return response
  │
  ├─ 401 unauthorized
  │     └→ refresh active token (under withCcrotateLock)
  │         ├─ refresh OK  + attempt==1 ─► replay (attempt=2)
  │         ├─ refresh OK  + attempt==2 ─► propagate 401
  │         └─ refresh fail ─────────────► markAccountStale, pool-walk (see below)
  │
  │     "refresh fail" definition: any non-200 from Anthropic's token-refresh
  │     endpoint, network error, or refreshed token immediately 401s on replay.
  │
  ├─ 429 + body.error.type == "rate_limit_error"
  │  AND (tier-cache 7d:100% OR /usage limit|extra usage exhausted/i in body)
  │     └→ markAccountExhausted(profilesDir, email, {reset5h, reset7d})
  │         ├─ attempt==1 ─► next() picks new account, replay (attempt=2)
  │         └─ attempt==2 ─► propagate 429 with X-Ccrotate-Exhausted: true
  │
  ├─ 429 transient (tier-cache shows headroom)
  │     └→ propagate as-is, X-Ccrotate-Pass: transient-429
  │         (LiteLLM's retry layer handles)
  │
  ├─ 5xx
  │     └→ attempt==1 ─► replay (same account) ; attempt==2 ─► propagate
  │
  └─ network error / 15s timeout
        └→ attempt==1 ─► replay (same account) ; attempt==2 ─► propagate 502
```

### Pool walk (refresh-fail only)

When refresh fails on the current account, walk every non-stale, non-exhausted account in the pool. Cap is pool-exhaustion (no fixed N). The tier-cache pre-filter dramatically reduces fan-out: only accounts that the cache says are usable get an upstream call.

```
markAccountStale(profilesDir, email)
  │
  └→ rotateLoop:
       cand ← next() ignoring stale, exhausted, and already-tried-this-request entries
       if no cand → "pool exhausted": propagate the LAST error with X-Ccrotate-Pool-Exhausted: true
                    (definition: no remaining candidates after tier-cache pre-filter
                     AND not already attempted within this request)
       call upstream with cand
       on 200 → return response, X-Ccrotate-Attempts: <n>, X-Ccrotate-Trigger: refresh-fail
       on 401 → markAccountStale → continue loop
       on quota → fold into quota handler, capped at 1 replay
```

### Cap policy summary

| Trigger | Cap | Rationale |
|---|---|---|
| Refresh-fail | pool-exhausted | Cheap; each rotation is one upstream call; bounded by pool size |
| Structural quota | 1 | Replaying through pool doesn't help structural errors |
| 5xx | 1 (same account) | Transient upstream hiccup; LiteLLM handles further retries |
| Transient 429 | 0 (propagate) | LiteLLM's `RateLimitErrorRetries` handles |

### Lock semantics

Only mutating operations take the advisory lock (`withCcrotateLock` against `/paperclip/.ccrotate/.active-files.lock`): `markAccountExhausted`, `markAccountStale`, token-refresh writeback, `next()` triggered switch. Reads (`loadProfiles`, `getCurrentAccount`, `loadTierCache`) are lock-free; torn-write parse errors are caught and retried with 50ms backoff — matches the existing pattern in `state-helpers.js`.

### Request budget

- Per-upstream-call timeout: **15s** via `AbortController`.
- Per-client-request total budget: **120s** (allows pool walk with pre-filter).
- HTTP server `keepAliveTimeout: 60s`, `headersTimeout: 65s` — avoids the minibridge `UND_ERR_HEADERS_TIMEOUT` class of bug.

## OpenAI ↔ Anthropic translation

### Request: OpenAI chat-completions → Anthropic messages

Mapping highlights:

| OpenAI | Anthropic | Notes |
|---|---|---|
| `messages[].role: "system"` | top-level `system: string` | Concatenate if multiple |
| `messages[].role: "user"` / `"assistant"` | `messages[]` with same roles | Pass-through |
| `messages[].role: "tool"` | content-block `{type:"tool_result", tool_use_id, content}` in following user message | Reshape |
| `messages[].tool_calls[]` | content-block `{type:"tool_use", id, name, input}` in assistant message | Reshape (input is parsed JSON, not string) |
| `tools[].function` | `tools[]` (flatter shape, `input_schema`) | Shape diff |
| `temperature`, `top_p`, `stream`, `stop`→`stop_sequences` | same names | Pass-through |
| `max_tokens` absent | default `4096` | Required in Anthropic |
| `logprobs`, `seed`, `logit_bias` | dropped silently | Anthropic ignores |
| `n>1`, `response_format:{type:"json_schema"}` | 400 `unsupported_parameter` | Material differences |
| `content: [{type:"image_url", ...}]` | `{type:"image", source:{...}}` | URL and base64 handled |

### Response: Anthropic message → OpenAI chat-completion

```
Anthropic                              OpenAI
─────────                              ─────────
id: "msg_..."                          id: "chatcmpl-..."  (re-prefixed)
type: "message"                        object: "chat.completion"
                                       created: now()
content: [                             choices: [{
  {type:"text", text:"..."} ───join──→   message: {role:"assistant", content:"..."}
  {type:"tool_use",                      tool_calls:[{
   id, name, input}]    ──reshape──→     id, type:"function",
                                          function:{name, arguments: JSON.stringify(input)}
                                        }]
                                       }]
stop_reason:                           finish_reason:
  end_turn ───────────────────────────► stop
  max_tokens ─────────────────────────► length
  stop_sequence ──────────────────────► stop
  tool_use ───────────────────────────► tool_calls
  refusal ────────────────────────────► content_filter
usage: {input_tokens, output_tokens} ─► usage: {prompt_tokens, completion_tokens, total_tokens}
```

### Translator out of scope for v1

- Streaming (`stream: true`) → 400 `streaming_not_supported_v1`. Defer SSE translation until a non-Hindsight consumer needs it.

## K8s deployment shape

### 1. Patch `Deployment/ccrotate-auth-bot` (add second container)

Add to `spec.template.spec.containers` (alongside the existing `bot` and `tailscale` containers):

```yaml
- name: ccrotate-serve
  image: registry.blockcast.net/ccrotate-serve:<sha>
  imagePullPolicy: IfNotPresent
  args: ["serve", "--port", "4001", "--bind", "0.0.0.0"]
  env:
    - { name: HOME, value: /paperclip }
    - name: CCROTATE_SERVE_TOKEN
      valueFrom: { secretKeyRef: { name: paperclip-ccrotate-serve-secrets, key: serveToken } }
    - name: OPENAI_API_KEY
      valueFrom: { secretKeyRef: { name: paperclip-ccrotate-serve-secrets, key: openaiApiKey, optional: true } }
    - { name: CCROTATE_TARGET,    value: claude }
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

Also add `tmp-serve` to `spec.template.spec.volumes`:

```yaml
- name: tmp-serve
  emptyDir: { medium: Memory, sizeLimit: 64Mi }
```

`HOME=/paperclip` is correct: it matches the `node`-user uid 1000 ownership we observed on `/paperclip/.ccrotate/`. The bot container uses `HOME=/data` with a symlink at `/data/.ccrotate → /paperclip/.ccrotate`; the sidecar shortcuts directly.

### 2. New `Service/ccrotate-serve`

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
    - { name: serve, port: 4001, targetPort: 4001, protocol: TCP }
```

DNS: `ccrotate-serve.paperclip.svc.cluster.local:4001`. ClusterIP only; no Ingress.

### 3. New `Secret/paperclip-ccrotate-serve-secrets`

Created out-of-band via `kubectl create secret generic` (never templated — same pattern as `litellm-secrets` per the `kubectl-apply-clobbers-inline-secrets.md` memory).

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: paperclip-ccrotate-serve-secrets
  namespace: paperclip
type: Opaque
stringData:
  serveToken:   <32-byte random, base64url>
  openaiApiKey: <optional — for /v1/embeddings + fallback>
```

A copy of just `serveToken` lives in `litellm` ns as `litellm-ccrotate-bearer` so LiteLLM can mount it as `CCROTATE_SERVE_TOKEN`.

### 4. New image: `registry.blockcast.net/ccrotate-serve:<sha>`

```dockerfile
FROM node:20-alpine AS build
WORKDIR /src
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY . .
RUN pnpm build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /src/dist /app
USER node
EXPOSE 4001
ENTRYPOINT ["node", "/app/ccrotate.js"]
```

Target image size < 100MB. Built by `.github/workflows/build-serve.yml`, tag = git SHA.

### 5. LiteLLM config patch

Append to `model_list` in `paperclip/litellm/configmap.yaml`:

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
```

Plus fallback chain (so the quota-trap behaviour we just diagnosed never recurs silently):

```yaml
litellm_settings:
  fallbacks:
    - { "gpt-4o-mini": ["claude-haiku-4-5-20251001"] }
    - { "gpt-5.5":     ["claude-sonnet-4-6"] }
```

LiteLLM Deployment patch: add `CCROTATE_SERVE_TOKEN` env via `secretKeyRef: { name: litellm-ccrotate-bearer, key: serveToken }`.

### 6. Source-control layout

```
~/src/ccrotate/
  lib/commands/serve.js
  lib/serve/{router,translator,anthropic-client,openai-client,route-rule}.js
  lib/serve/{router,translator,anthropic-client,openai-client,route-rule}.test.js
  lib/serve/integration.test.js
  lib/serve/fixtures/*.json
  Dockerfile.serve
  .github/workflows/build-serve.yml

~/k8s/paperclip/
  ccrotate-auth-bot.yaml             # patched: +container, +tmp-serve volume
  ccrotate-serve-service.yaml        # new
  ccrotate-serve-secret.example.yaml # new (docs; real secret OOB)
  ccrotate-serve-runbook.md          # new

~/k8s/paperclip/litellm/
  configmap.yaml                     # patched: +claude-* models + fallbacks
  deployment.yaml                    # patched: +CCROTATE_SERVE_TOKEN env
```

## Testing strategy

### Layer 1 — unit (vitest, in-repo)

| File | Tests | Failure caught |
|---|---|---|
| `lib/serve/translator.test.js` | 16 round-trip fixture pairs + 8 negative cases | Wrong field name; tool-call drift; multimodal misroute |
| `lib/serve/route-rule.test.js` | model-prefix matrix (10 prefixes × {present, absent backend}) | Wrong upstream; `/v1/models` lying about availability |
| `lib/serve/anthropic-client.test.js` | Nock-mocked api.anthropic.com: 200, 401, refresh-OK→200, refresh-fail-rotate, 429 quota, 429 transient, 5xx | Rotation drift; replay-once violation; lock contention |
| `lib/serve/openai-client.test.js` | Same shape, codex pool walk | Codex token mishandling |
| `lib/serve/router.test.js` | Bearer, JSON-parse errors, method/path matrix, body size limit | Auth bypass; unbounded body |

Goal: every test <100ms; full suite <5s.

### Layer 2 — integration (vitest + real `node:http`)

`lib/serve/integration.test.js` spawns the sidecar against nock-driven fake upstreams. Five scenarios:

1. OpenAI-in → Anthropic-translated → OpenAI-out: bytes match fixture.
2. Rotate-on-quota: account A returns 429+insufficient_quota; pool has B; B returns 200. Response has `X-Ccrotate-Attempts: 2`.
3. Pool-walk on refresh-fail: 3 accounts, first 2 return 401, third returns 200. tier-cache writes for the 2 failed.
4. Pool-exhausted: every account 401. Response has `X-Ccrotate-Pool-Exhausted: true`, status 502.
5. Concurrent contention: 50 parallel clients hit account A; A returns quota. Lock serializes the `markAccountExhausted` writes (no torn JSON in profiles.json / tier-cache); the active account is rotated exactly once; all 50 clients eventually receive responses from the rotated-to account (or pool-exhausted).

Mocked `withCcrotateLock` uses real flock against in-process tmpdir — same code path as production.

### Layer 3 — production smoke (runbook)

`~/k8s/paperclip/ccrotate-serve-runbook.md` contains curl recipes:

```bash
# Reachability
kubectl -n paperclip exec deploy/ccrotate-auth-bot -c ccrotate-serve -- wget -qO- http://localhost:4001/healthz

# /v1/models reflects backend availability
TOKEN=$(kubectl -n paperclip get secret paperclip-ccrotate-serve-secrets -o jsonpath='{.data.serveToken}' | base64 -d)
kubectl -n paperclip port-forward svc/ccrotate-serve 4001:4001 &
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4001/v1/models | jq .

# Smoke Anthropic
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4001/v1/messages \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":50,"messages":[{"role":"user","content":"ping"}]}' | jq .

# Smoke OpenAI translation
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4001/v1/chat/completions \
  -d '{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"ping"}]}' | jq .

# End-to-end via LiteLLM
LL_KEY=$(kubectl -n litellm get secret litellm-secrets -o jsonpath='{.data.LITELLM_MASTER_KEY}' | base64 -d)
kubectl -n litellm port-forward svc/litellm 4000:4000 &
curl -s -H "Authorization: Bearer $LL_KEY" http://localhost:4000/v1/chat/completions \
  -d '{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"ping"}]}' | jq .

# Hindsight signal: extraction starts working
kubectl -n hindsight logs deploy/hindsight-api --since=2m | grep -iE "extracting|node|fact"
# + the bank-stats recipe from handoff §"First thing to do" step 4
```

## Rollout plan — 7 sequenced gates

Each gate has a clear go/no-go criterion; stop and unblock before the next.

| # | Gate | Action | Pass criterion |
|---|---|---|---|
| 0 | Probe Claude OAuth → api.anthropic.com works May 2026 | Direct curl with one ccrotate accessToken | HTTP 200 with valid response |
| 1 | Probe codex id_token → api.openai.com | Direct curl with one codex profile's id_token | HTTP 200 → codex pool path viable. 401 → ship Anthropic-only v1; OpenAI uses single env key |
| 2 | Build sidecar locally | Implement per writing-plans output; `pnpm test` green | Unit + integration green; translator coverage > 90% |
| 3 | Build + push image | `docker buildx build --push -t registry.blockcast.net/ccrotate-serve:<sha>` | Image pulls; size <100MB |
| 4 | Deploy sidecar | Apply Secret, Service, then Deployment patch | Pod READY 3/3; `/healthz` returns 200 |
| 5 | In-cluster smoke | 5 curl recipes from Layer 3 | All 200 with valid bodies; `/v1/models` correct |
| 6 | LiteLLM cutover | Apply ConfigMap + Deployment patch; rollout-restart | LiteLLM `/v1/models` shows new entries; gpt-4o-mini → claude-haiku fallback works end-to-end |
| 7 | Hindsight unblock | Re-run consolidation on 5 per-agent banks (existing CLI in handoff) | Within 5 min, `total_nodes > 0` on at least one bank |

### Rollback

Per gate:
- Gates 0-3: trivial (delete branch, drop image tag).
- Gate 4: `kubectl rollout undo deployment/ccrotate-auth-bot -n paperclip`. Sidecar disappears; bot stays up.
- Gates 5-6: revert LiteLLM ConfigMap; rollout-restart. Hindsight reverts to consuming OpenAI directly (no worse than today).
- Gate 7: no rollback; extraction either starts or stays at 0 nodes.

## Out of scope / future work

Stub each in `~/src/ccrotate/lib/serve/TODO.md`:

- Streaming (`stream: true`) — SSE translation (Anthropic event types → OpenAI deltas).
- `/v1/audio/*`, `/v1/images/generations`.
- Sticky-account header `X-Ccrotate-Pin-Account: <email>` for debugging.
- Prometheus `/metrics` endpoint.
- Codex pool against `chatgpt.com/backend-api/conversation` if codex→api.openai.com path doesn't work.
- Multi-pool routing (shared vs. private claude pools).

## Open questions

1. **Codex pool feasibility** (Gate 1) — gates the codex rotation feature on a single probe. Pending.
2. **Image registry credentials** — `registry.blockcast.net` is already configured via `imagePullSecrets: registry-blockcast-net-pull` on the auth-bot Deployment. Inherited by sibling container.
3. **CI/CD for ccrotate-serve image** — re-use the auth-bot image's GitHub Actions flow (build → push to registry.blockcast.net) or wire a new workflow? Defer to writing-plans.
