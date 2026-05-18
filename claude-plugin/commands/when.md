---
description: Show ccrotate pool status with `ccrotate when` semantics, using ccrotate-serve cloud mode when configured.
---

# /ccrotate:when

<!-- ccrotate-serve:cmd=when -->

Show the ccrotate account pool summary with usage tiers and reset timers.

## How this command works

If routed through ccrotate-serve (cloud/devbox mode), the server intercepts the
marker above and returns the pool table directly — **zero tokens consumed** and
works even when every account in the pool is `429`. No further steps needed:
just print the response verbatim.

If routed directly to Anthropic/OpenAI (no ccrotate-serve in the path), the
marker is invisible and the model receives the human prose below.

## Cloud / devbox fallback (when interception is unavailable)

If `$HOME/.config/ccrotate-serve/env` exists or `CCROTATE_SERVE_BASE_URL` is set
but interception isn't returning data, source the env and probe:

1. `curl -sS http://127.0.0.1:4001/healthz`
2. `curl -sS -H "Authorization: Bearer $CCROTATE_SERVE_TOKEN" "$CCROTATE_SERVE_BASE_URL/models"`
3. `CCROTATE_TARGET=claude ccrotate when`
4. `CCROTATE_TARGET=codex ccrotate when`

Do **not** run `ccrotate refresh`, `ccrotate refresh-one`, `ccrotate snap`,
`ccrotate next`, `ccrotate switch`, `ccrotate status`, or `ccrotate import` —
those mutate profiles and break cluster sync.

## Local mode (no ccrotate-serve)

Steps:

1. `ccrotate list`
2. `ccrotate tier-cache`
3. `ccrotate config`
4. `date -u +%s`

Render columns: Email · Active (★) · Tier · 5h% · 5h resets · 7d% · 7d resets · Extra $.

Reset times: `in Xh Ym (HH:MM UTC)` if future, `Xh Ym ago` if past,
`(stale!)` if past-but-100%, `—` if null.

## When the model pool is fully 429ing

Bang-prefix path bypasses the model entirely:

- `!CCROTATE_TARGET=claude ccrotate when`
- `!CCROTATE_TARGET=codex ccrotate when`
- `!curl -sS http://127.0.0.1:4001/healthz`
