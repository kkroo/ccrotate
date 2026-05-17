---
description: Refresh or inspect ccrotate usage data, avoiding local refresh in cloud mode.
---

# /ccrotate-refresh

Refresh Claude Code account usage data.

Cloud/devbox mode:
If `$HOME/.config/ccrotate-serve/env` exists or `CCROTATE_SERVE_BASE_URL` is set, do not run local `ccrotate refresh` or `ccrotate refresh-one`. The cluster auth bot owns refresh for the cloud pool. Source the env file if needed, then verify:
1. `curl -sS http://127.0.0.1:4001/healthz`
2. `curl -sS -H "Authorization: Bearer $CCROTATE_SERVE_TOKEN" "$CCROTATE_SERVE_BASE_URL/models"`

Report service health and whether the Models API works.

Local mode only:
For a full refresh of all accounts:
  Run `ccrotate refresh` — makes per-account API calls (GET, no tokens consumed).
  After completion, run `ccrotate tier-cache` and `date -u +%s`, then present a summary table
  with the same format as /ccrotate-status (including 5h/7d reset time columns — see that skill for format details).

For a single stale account (cron-friendly):
  Run `ccrotate refresh-one` — refreshes one account with the stalest data.
  Respects API cooldowns. Designed for repeated cron calls (~15min interval).

IMPORTANT:
- Both commands use the /api/oauth/usage GET endpoint (zero Claude tokens consumed)
- If the usage API is rate-limited (org-level ~1 call/hr), accounts fall back to org-level data
- `refresh-one` is preferred for keeping data fresh without hitting rate limits
