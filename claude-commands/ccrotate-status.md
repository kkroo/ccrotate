Show Claude Code account summary with usage tiers and reset timers.

Steps:
1. Run `ccrotate list` to get the account list and identify the current (starred) account.
2. Run `ccrotate tier-cache` to get cached tier data from the last refresh.
3. Run `ccrotate config` to show the extraUsage policy.
4. Check for background timers: `ps aux | grep 'ccrotate next' | grep -v grep`

Present a summary table combining all data:
- Email, Active (star if current), Status, Tier, Notes (rate-limit reset time if available)

IMPORTANT:
- Do NOT run `ccrotate refresh`, `ccrotate status`, or `ccrotate next` — these spawn `claude -p` which conflicts with the active Claude Code session and will timeout/lock.
- Only read cached data via `ccrotate tier-cache` and `ccrotate list`.
- If tier-cache is missing or stale (>1 hour old based on `updatedAt`), tell the user to run `! ccrotate refresh` from the terminal prompt (the `!` prefix runs it outside Claude Code's process lock).
- The cache is populated by running `ccrotate refresh` or `ccrotate next` from OUTSIDE an active session (terminal, hooks, or `!` prefix).
