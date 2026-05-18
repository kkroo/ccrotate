---
description: Show ccrotate account pool details using ccrotate-serve cloud mode when configured.
---

# /ccrotate:accounts

<!-- ccrotate-serve:cmd=accounts -->

Quick ccrotate account overview.

## How this command works

If routed through ccrotate-serve, the server intercepts the marker and renders
both pools directly from in-process state. Zero tokens, works under any pool
load.

## Cloud / devbox fallback

Source `$HOME/.config/ccrotate-serve/env` if needed, then:

1. `curl -sS http://127.0.0.1:4001/healthz`
2. `CCROTATE_TARGET=claude ccrotate when`
3. `CCROTATE_TARGET=codex ccrotate when`

## Local mode

`ccrotate list` and `ccrotate status --quiet`. Show a compact summary with the
current account marked. Include the extraUsage config setting from
`ccrotate config`.
