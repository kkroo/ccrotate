Smart-rotate to the next Claude Code account on base usage tier using cached data (zero API calls).

Steps:
1. Run `ccrotate tier-cache` to read cached usage data
2. Find the first account with `serviceTier: "base"` that is NOT the current account
3. If found, run `ccrotate switch <email>` to switch (picked up automatically, no restart)
4. If no base accounts in cache, run `ccrotate next --wait` to switch to earliest-reset account and output the reset epoch
5. If `--wait` outputs JSON with `resetEpoch`, compute `delaySeconds = resetEpoch - now + 120` and use ScheduleWakeup

IMPORTANT:
- Do NOT run `ccrotate next` without `--wait` — it makes API calls that burn tokens
- Do NOT run `ccrotate refresh` — use cached data only
- `ccrotate switch` updates credentials on disk; the running session picks them up automatically (no restart needed)
- If tier-cache is empty or very stale (>2hrs), run `ccrotate refresh-one` first (one API call, no tokens consumed)
