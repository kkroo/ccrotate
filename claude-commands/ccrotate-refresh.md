Refresh Claude Code account usage data.

For a full refresh of all accounts:
  Run `ccrotate refresh` — makes per-account API calls (GET, no tokens consumed).
  After completion, run `ccrotate tier-cache` and present a summary table.

For a single stale account (cron-friendly):
  Run `ccrotate refresh-one` — refreshes one account with the stalest data.
  Respects API cooldowns. Designed for repeated cron calls (~15min interval).

IMPORTANT:
- Both commands use the /api/oauth/usage GET endpoint (zero Claude tokens consumed)
- If the usage API is rate-limited (org-level ~1 call/hr), accounts fall back to org-level data
- `refresh-one` is preferred for keeping data fresh without hitting rate limits
