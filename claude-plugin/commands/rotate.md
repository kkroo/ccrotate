---
description: Rotate to the next usable ccrotate account through the correct local or serve path.
---

# /ccrotate:rotate

Smart-rotate to the next Claude Code account on base usage tier using cached data (zero API calls).

Cloud/devbox mode:
If `$HOME/.config/ccrotate-serve/env` exists or `CCROTATE_SERVE_BASE_URL` is set, do not run local `ccrotate next` or `ccrotate switch`. Cloud rotation happens inside ccrotate-serve/auth-bot. Source the env file if needed, verify `curl -sS http://127.0.0.1:4001/healthz`, and tell the user to retry their Claude/Codex request through ccrotate-serve. If it still returns 429, report that the served pool is exhausted.

Local mode only:
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
