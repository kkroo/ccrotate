# /ccrotate-status

Show Claude Code account summary with usage tiers and reset timers.

Cloud/devbox mode:
If `$HOME/.config/ccrotate-serve/env` exists or `CCROTATE_SERVE_BASE_URL` is set, source the env file if needed and use ccrotate-serve instead of local `ccrotate`:
1. Run `curl -sS http://127.0.0.1:4001/healthz`.
2. Run `curl -sS -H "Authorization: Bearer $CCROTATE_SERVE_TOKEN" "$CCROTATE_SERVE_BASE_URL/models"`.
3. Optionally make a tiny end-to-end request only if the user asks for a probe:
   - Claude/Anthropic wiring: use `$CCROTATE_SERVE_ANTHROPIC_BASE_URL/v1/messages`.
   - Codex/OpenAI wiring: use `$CCROTATE_SERVE_BASE_URL/responses`.
   - A 429 means the served pool is exhausted, not that routing is broken.

Do not run `ccrotate list`, `ccrotate tier-cache`, `ccrotate refresh`, `ccrotate status`, `ccrotate next`, or scheduling tasks in cloud mode. Local cache can be stale and is not authoritative for the served pool.

Local mode only:
Steps:
1. Run `ccrotate list` to get the account list and identify the current (starred) account.
2. Run `ccrotate tier-cache` to get cached tier data from the last refresh.
3. Run `ccrotate config` to show the extraUsage policy.
4. Run `date -u +%s` to get the current unix timestamp.

Present a summary table combining all data. REQUIRED columns:
- Email, Active (★ if current), Tier, 5h%, 5h resets, 7d%, 7d resets, Extra $

REQUIRED — Reset time columns:
For each account with `reset5h` and `reset7d` values, compute the time relative to now:
- If reset timestamp > now: show "in Xh Ym" and the absolute time, e.g. "in 1h3m (10:00 UTC)"
- If reset timestamp < now: show "Xh Ym ago" e.g. "2h ago"
- If reset timestamp is in the past BUT utilization shows 100%: mark as "(stale!)" — the cache is outdated for that account
- For accounts with null reset values (e.g. org accounts): show "—"

IMPORTANT:
- Do NOT run `ccrotate refresh`, `ccrotate status`, or `ccrotate next` — these spawn `claude -p` which conflicts with the active Claude Code session and will timeout/lock.
- Only read cached data via `ccrotate tier-cache` and `ccrotate list`.
- If tier-cache is missing or stale (>1 hour old based on `updatedAt`), tell the user to run `! ccrotate refresh` from the terminal prompt (the `!` prefix runs it outside Claude Code's process lock).
- The cache is populated by running `ccrotate refresh` or `ccrotate next` from OUTSIDE an active session (terminal, hooks, or `!` prefix).
