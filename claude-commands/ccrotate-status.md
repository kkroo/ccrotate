Show Claude Code account summary with usage tiers.

Steps:
1. Run `ccrotate list` to get accounts and identify the current (starred) one.
2. Run `ccrotate tier-cache` to get cached tier data.
3. Run `ccrotate config` to show the extraUsage policy.
4. Check for background timers: `ps aux | grep 'ccrotate next' | grep -v grep`

Present a summary table: Email, Active, Status, Tier

If cache is missing or stale (>1 hour based on `updatedAt`), run `ccrotate refresh` to update it live.
