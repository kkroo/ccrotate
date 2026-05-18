---
description: Rotate to the next usable ccrotate account through the correct local or serve path.
---

# /ccrotate:rotate

<!-- ccrotate-serve:cmd=next args=$ARGUMENTS -->

Rotate to the next Claude or Codex account. Optionally pass `claude` or
`codex` to target a specific pool.

## How this command works

ccrotate-serve intercepts the marker and calls its own `next()` directly,
bypassing the model. The new active account is reported back.

## Local mode (no ccrotate-serve)

1. `ccrotate tier-cache` — read cached usage data.
2. Find the first account with `serviceTier: "base"` that is NOT current.
3. If found, `ccrotate switch <email>`.
4. If none, `ccrotate next --wait` and use the `resetEpoch` to schedule a
   wake-up via `delaySeconds = resetEpoch - now + 120`.

## Don't

- Don't run `ccrotate next` without `--wait` — burns tokens.
- Don't run `ccrotate refresh` — use cached data only.
- If tier-cache is empty or >2h stale, run `ccrotate refresh-one` first
  (one API call, zero tokens consumed).
