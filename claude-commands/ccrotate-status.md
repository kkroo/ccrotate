Show Claude Code account summary with usage tiers and schedule auto-switch if needed.

Steps:
1. Run `ccrotate list` to get accounts and identify the current (starred) one.
2. Run `ccrotate tier-cache` to get cached tier data.
3. Run `ccrotate config` to show the extraUsage policy.
4. Use `CronList` to check for existing scheduled ccrotate tasks.

Present a summary table: Email, Active, Tier, Details (utilization + reset countdown)

If cache is missing or stale (>1 hour based on `updatedAt`), run `ccrotate refresh` to update it.

IMPORTANT — Auto-switch scheduling:
If ALL accounts are on "extra" or "exhausted" tier, schedule a one-shot CronCreate task
at the earliest reset time (from rateLimits.reset5h or reset7d in the cache, whichever is sooner).
The cron should fire 2 minutes after the reset epoch. Convert the epoch to local time for the cron expression.
The prompt should be: "The rate limit just reset. Run `ccrotate refresh` to check base usage availability, show the results, and if base tier is available, run `ccrotate next` to switch. Then continue previous work."
Set recurring: false so it fires once.

If any account is already on "base" tier, no scheduling needed — just report status.
