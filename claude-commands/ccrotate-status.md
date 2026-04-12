Show Claude Code account summary from cached tier data.

Steps:
1. Run `ccrotate list` to get accounts and identify the current (starred) one.
2. Run `ccrotate tier-cache` to get cached tier data.
3. Run `ccrotate config` to show the extraUsage policy.
4. Check for background timers: `ps aux | grep 'ccrotate next' | grep -v grep`

Present a clean summary table: Email, Active, Status, Tier

IMPORTANT:
- Do NOT run `ccrotate refresh`, `ccrotate status`, `ccrotate next`, or any command that spawns `claude -p`. These WILL timeout inside an active Claude Code session.
- Only read cached data via `ccrotate tier-cache` and `ccrotate list`.
- If tier-cache is missing or stale (>1 hour based on `updatedAt`), tell the user: "Run `ccrotate refresh` from a **separate terminal window** to update."
- Do NOT suggest using `!` prefix — it still runs inside the Claude Code process and will timeout.
