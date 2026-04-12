Refresh all Claude Code accounts — test each account's status and usage tier.

Run `ccrotate refresh` and report the results. This uses the platform.claude.com API directly (no claude -p), so it works inside active sessions.

After refresh completes, run `ccrotate tier-cache` and present a clean summary table.
