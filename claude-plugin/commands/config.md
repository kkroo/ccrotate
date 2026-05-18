---
description: Inspect ccrotate configuration and ccrotate-serve wiring without printing secrets.
---

# /ccrotate:config

<!-- ccrotate-serve:cmd=config -->

Show or update ccrotate configuration.

## How this command works

If routed through ccrotate-serve, the server intercepts the marker and shows
the served pool's view of config (env wiring + extraUsage policy). Local
execution only happens when no ccrotate-serve is in the path.

Cloud/devbox mode:
If `$HOME/.config/ccrotate-serve/env` exists or `CCROTATE_SERVE_BASE_URL` is set, source the env file if needed and show the ccrotate-serve endpoint configuration from environment:
- `CCROTATE_SERVE_BASE_URL`
- `CCROTATE_SERVE_ANTHROPIC_BASE_URL`
- `OPENAI_BASE_URL`
- `ANTHROPIC_BASE_URL`

Then verify `curl -sS http://127.0.0.1:4001/healthz`. Do not run `ccrotate config` or mutate local account config in cloud mode unless the user explicitly asks for local mode.

Local mode only:
Run `ccrotate config` to show current settings. If the user wants to change a setting, run `ccrotate config <key> <value>`.

Available settings:
- extraUsage: prompt (default) | allow | deny — controls behavior when only extra-usage accounts are available during rotation
