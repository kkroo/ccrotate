---
description: Show ccrotate pool status with `ccrotate when` semantics, using ccrotate-serve cloud mode when configured.
---

# /ccrotate-when

Show the ccrotate account pool summary with usage tiers and reset timers.

## Cloud / devbox mode

If `$HOME/.config/ccrotate-serve/env` exists or `CCROTATE_SERVE_BASE_URL` is set,
treat ccrotate-serve as the authoritative router and treat `~/.ccrotate/`
as a read-only mirror (refreshed by `*/5 sync-from-cluster.sh` cron). Do **not**
run `ccrotate refresh`, `ccrotate refresh-one`, `ccrotate snap`, `ccrotate next`,
`ccrotate switch`, `ccrotate status`, or `ccrotate import` here — those mutate
profiles and break cluster sync. Read-only commands (`ccrotate when`,
`ccrotate list`, `ccrotate tier-cache`) are safe.

Steps:

1. Source the env file if `CCROTATE_SERVE_BASE_URL` is unset:
   `source "$HOME/.config/ccrotate-serve/env"`.
2. Probe routing:
   - `curl -sS http://127.0.0.1:4001/healthz`
   - `curl -sS -H "Authorization: Bearer $CCROTATE_SERVE_TOKEN" "$CCROTATE_SERVE_BASE_URL/models"`
3. Render the Claude pool:
   `CCROTATE_TARGET=claude ccrotate when`
4. Render the Codex pool:
   `CCROTATE_TARGET=codex ccrotate when`
5. Run `date -u +%s` only if you need to convert raw epoch values from
   `~/.ccrotate/tier-cache.json` — the CLI already prints human reset times.

Present both pool listings verbatim. The CLI already renders the reset-time
column (`in 2h33m`, `exhausted`, `stale (needs /login + snap)`); don't
re-derive from raw JSON.

Optional end-to-end probe (only if the user explicitly asks):

- Anthropic wiring: POST to `$CCROTATE_SERVE_ANTHROPIC_BASE_URL/v1/messages`
- OpenAI wiring: POST to `$CCROTATE_SERVE_BASE_URL/responses`
- A `429` means the served pool is exhausted, not that routing is broken.

## Local mode (no ccrotate-serve)

Steps:

1. `ccrotate list` — accounts and current (starred) account.
2. `ccrotate tier-cache` — cached tier data from the last refresh.
3. `ccrotate config` — extraUsage policy.
4. `date -u +%s` — current unix timestamp.

Present a summary table with these columns:
Email · Active (★ if current) · Tier · 5h% · 5h resets · 7d% · 7d resets · Extra $

Reset time formatting:

- `reset5h` / `reset7d` > now: show `in Xh Ym` and absolute, e.g. `in 1h3m (10:00 UTC)`
- `reset5h` / `reset7d` < now: show `Xh Ym ago`, e.g. `2h ago`
- past timestamp but utilization shows 100%: append `(stale!)` — cache is outdated
- null reset (org accounts): show `—`

## When the model pool is fully 429ing

This slash command itself requires a model call to render the response —
when every account is `429`, the slash command will hang or fail before any
shell step runs. In that case, drop to a bang-prefix invocation that bypasses
Claude entirely:

- `!CCROTATE_TARGET=claude ccrotate when` (pure shell, no model)
- `!CCROTATE_TARGET=codex ccrotate when`
- `!curl -sS http://127.0.0.1:4001/healthz`

These read `~/.ccrotate/tier-cache.json` (5-min cron mirror of cluster state)
and print the table directly to the terminal. No tokens consumed.

## Don't

- Don't run `ccrotate refresh`, `ccrotate refresh-one`, or `ccrotate snap` in
  cloud mode — they rotate single-use refresh_tokens and break cluster sync.
- Don't run `ccrotate next` or `ccrotate status` from inside an active Claude
  session — they spawn `claude -p` and deadlock on the session's process lock.
  Use the `!` bang prefix from the terminal prompt instead.
- Don't trust `~/.ccrotate/tier-cache.json` if its `updatedAt` is older than
  ~10 minutes — the `*/5` cron may be stuck. Check
  `~/.ccrotate/sync-from-cluster.log` and the underlying port-forward.
