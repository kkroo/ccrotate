# Operator usage cost-reporting (ccrotate serve → paperclip)

`ccrotate serve` can report **operator/human** Claude usage to paperclip as
`cost-events`, so devbox/MacBook CLI traffic that flows through the pool is
visible in paperclip billing alongside cluster agents.

## What it does

For each `/v1/messages` (and `/v1/chat/completions` → anthropic) response, serve
extracts token usage and accumulates it per model. Every `flushMs` it POSTs one
`cost-event` per model to paperclip.

**It reports ONLY traffic that lacks an `x-paperclip-agent-id` header** — i.e.
human/devbox CLI sessions. Cluster paperclip agents send that header and are
already billed by paperclip-server's heartbeat ledger, so reporting them here
would double-count. The gate lives in `shouldReport()` (`lib/serve/cost-report.js`).

Token mapping mirrors the paperclip claude adapter exactly:
`inputTokens=input_tokens`, `cachedInputTokens=cache_read_input_tokens`,
`outputTokens=output_tokens` (cache_creation is dropped). Subscription usage is
recorded with `costCents=0`. Events whose token fields exceed the paperclip int4
column cap (2,147,483,647) are split across multiple events.

## Configuration (env on the `ccrotate-serve` deployment)

All five gate the feature — if any are unset, reporting is a **no-op**.

| Env | Value |
|---|---|
| `CCROTATE_PAPERCLIP_COST_URL` | `https://paperclip.blockcast.net/api` |
| `CCROTATE_PAPERCLIP_COST_TOKEN` | a `pcp_*` bearer that may POST cost-events for the company (from a k8s secret) |
| `CCROTATE_PAPERCLIP_COST_COMPANY` | `aaced805-3491-4ee5-9b14-cdf70cb81d47` (Blockcast) |
| `CCROTATE_PAPERCLIP_COST_AGENT_ID` | `47db8696-47e4-41be-bc4b-ca82a2ab3490` (Operator (devbox) agent) |
| `CCROTATE_PAPERCLIP_COST_FLUSH_MS` | optional, default `60000` |
| `CCROTATE_PAPERCLIP_COST_PROVIDER` | optional, default `anthropic` |
| `CCROTATE_PAPERCLIP_COST_BILLER` | optional, default `ccrotate` |

## Deploy (cluster: `paperclip` ns, deployment `ccrotate-serve`)

The serve image is baked, so the code change ships as a new
`harbor.blockcast.net/ccrotate-serve/ccrotate-serve` image:

1. Commit + push this branch; let CI build & push the new `ccrotate-serve` image tag.
2. Create the token secret (do NOT commit the token):
   ```bash
   kubectl -n paperclip create secret generic ccrotate-paperclip-cost \
     --from-literal=token='pcp_...'
   ```
3. Add env to the `ccrotate-serve` deployment (container `ccrotate-serve`):
   the four required vars, with `CCROTATE_PAPERCLIP_COST_TOKEN` sourced from the
   secret via `valueFrom.secretKeyRef`. Bump the image tag to the new build.
4. Roll out: `kubectl -n paperclip rollout restart deploy/ccrotate-serve` and
   wait for `rollout status`.

Apply the same to `ccrotate-serve-codex` only once a `/v1/responses` usage tap is
added (Codex is not reported in this version).

## Verify

```bash
CID=aaced805-3491-4ee5-9b14-cdf70cb81d47
TOK=$(jq -r '.credentials["https://paperclip.blockcast.net"].token' ~/.paperclip/auth.json)
# Run one devbox Claude Code request, wait one flush interval, then:
curl -s -H "Authorization: Bearer $TOK" \
  "https://paperclip.blockcast.net/api/companies/$CID/costs/by-agent" \
  | jq '.[] | select(.agentId=="47db8696-47e4-41be-bc4b-ca82a2ab3490")'
```
The Operator (devbox) row should increment. A cluster-agent run must NOT create a
duplicate row under this agent (it stays on its own agent via the heartbeat path).
