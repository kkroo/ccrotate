Show Claude Code account summary with usage tiers and schedule auto-switch if needed.

Steps:
1. Run `ccrotate list` to get accounts and identify the current (starred) one.
2. Run `ccrotate tier-cache` to get cached tier data.
3. Run `ccrotate config` to show the extraUsage policy.
4. Use `CronList` to check for existing scheduled ccrotate tasks.

Present results:
- Per-account table: Email, Active, Tier
- If data source is [org], show org-level utilization + resets ONCE below the table (not per row)
  because all accounts share the same org-level numbers
- If data source is per-account (no [org] tag), show utilization per row

If cache is missing or stale (>1 hour based on `updatedAt`), run `ccrotate refresh` to update it.

IMPORTANT — Auto-switch scheduling:
If ALL accounts are on "extra" or "exhausted" tier, check CronList for existing ccrotate crons.
If none scheduled, schedule a one-shot CronCreate at the earliest reset time
(from rateLimits.reset5h or reset7d in the cache, whichever is sooner, +2 min).
Prompt: "Rate limit reset. Run ccrotate refresh, show results. If base tier available, run ccrotate next to switch. Continue previous work."
Set recurring: false.
