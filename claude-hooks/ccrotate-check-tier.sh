#!/bin/bash
# Check usage tier at session start. If on extra usage, instruct Claude
# to schedule a CronCreate at the reset time for auto-switch.
# Hook: SessionStart

CACHE=~/.ccrotate/tier-cache.json
MARKER=~/.ccrotate/pending-reset.json

# Check pending-reset marker first (written by Stop hook)
if [ -f "$MARKER" ]; then
  RESET_EPOCH=$(jq -r '.resetEpoch // empty' "$MARKER" 2>/dev/null)
  RESET_LABEL=$(jq -r '.resetLabel // "session"' "$MARKER" 2>/dev/null)
  rm -f "$MARKER"  # consume it
  NOW=$(date +%s)
  if [ -n "$RESET_EPOCH" ] && [ "$RESET_EPOCH" -gt "$NOW" ] 2>/dev/null; then
    # Reset hasn't happened yet — schedule cron
    WAIT_MIN=$(( (RESET_EPOCH - NOW) / 60 ))
    CRON_MIN=$(date -r "$((RESET_EPOCH + 120))" "+%-M" 2>/dev/null || date -d "@$((RESET_EPOCH + 120))" "+%-M" 2>/dev/null)
    CRON_HR=$(date -r "$((RESET_EPOCH + 120))" "+%-H" 2>/dev/null || date -d "@$((RESET_EPOCH + 120))" "+%-H" 2>/dev/null)
    CRON_DOM=$(date -r "$((RESET_EPOCH + 120))" "+%-d" 2>/dev/null || date -d "@$((RESET_EPOCH + 120))" "+%-d" 2>/dev/null)
    CRON_MON=$(date -r "$((RESET_EPOCH + 120))" "+%-m" 2>/dev/null || date -d "@$((RESET_EPOCH + 120))" "+%-m" 2>/dev/null)
    CRON_EXPR="${CRON_MIN} ${CRON_HR} ${CRON_DOM} ${CRON_MON} *"
    RESET_TIME=$(date -r "$RESET_EPOCH" "+%-l:%M %p" 2>/dev/null || date -d "@$RESET_EPOCH" "+%-l:%M %p" 2>/dev/null || echo "in ${WAIT_MIN}m")
    echo "{\"systemMessage\":\"Previous session hit rate limit. ${RESET_LABEL} resets at ${RESET_TIME} (${WAIT_MIN}m). Schedule a one-shot CronCreate with cron '${CRON_EXPR}' recurring false and prompt 'Rate limit reset. Run ccrotate refresh to check base usage. If base tier available, run ccrotate next to switch. Show results and continue previous work.'\"}"
    exit 0
  fi
  # Reset already passed — try switching now
  ccrotate next 2>/dev/null
  echo "{\"systemMessage\":\"Previous rate limit reset. Switched to base usage account.\"}"
  exit 0
fi

# No marker — check tier cache
if [ ! -f "$CACHE" ]; then
  echo "{}"
  exit 0
fi

# Identify the ACTIVE account (the one we're actually using), not whichever
# account happened to sort first. Without this, the hook was tied to
# .accounts[0], which produced misleading "no reset time" reports when the
# first cached account had null resets but other pool accounts had usable
# reset windows queued.
CURRENT=~/.ccrotate/current.json
ACTIVE_EMAIL=""
if [ -f "$CURRENT" ]; then
  ACTIVE_EMAIL=$(jq -r '.email // empty' "$CURRENT" 2>/dev/null)
fi

# Active-account tier first — this is what the user actually cares about.
if [ -n "$ACTIVE_EMAIL" ]; then
  TIER=$(jq -r --arg e "$ACTIVE_EMAIL" '.accounts[] | select(.email==$e) | .serviceTier // ""' "$CACHE" 2>/dev/null | head -n 1)
  RESET_5H=$(jq -r --arg e "$ACTIVE_EMAIL" '.accounts[] | select(.email==$e) | .rateLimits.reset5h // empty' "$CACHE" 2>/dev/null | head -n 1)
  RESET_7D=$(jq -r --arg e "$ACTIVE_EMAIL" '.accounts[] | select(.email==$e) | .rateLimits.reset7d // empty' "$CACHE" 2>/dev/null | head -n 1)
else
  TIER=$(jq -r '.accounts[0].serviceTier // ""' "$CACHE" 2>/dev/null)
  RESET_5H=$(jq -r '.accounts[0].rateLimits.reset5h // empty' "$CACHE" 2>/dev/null)
  RESET_7D=$(jq -r '.accounts[0].rateLimits.reset7d // empty' "$CACHE" 2>/dev/null)
fi

if [ "$TIER" = "base" ] || [ -z "$TIER" ]; then
  echo "{}"
  exit 0
fi

# On extra or exhausted — find earliest reset across the WHOLE pool, not
# just the active account. If any sibling account is about to reset sooner
# than ours, the right action is to schedule for that earlier time and
# then `ccrotate next` will pick the freed account up. Falling back to
# "no reset time in cache" when the active account's resets are null was
# wrong — the pool's earliest reset5h is the truth that matters.
NOW=$(date +%s)
RESET_EPOCH=""
RESET_LABEL=""

# Start with the active account's resets so they win ties.
for PAIR in "5h:$RESET_5H" "7d:$RESET_7D"; do
  LABEL="${PAIR%%:*}"
  EPOCH="${PAIR#*:}"
  if [ -n "$EPOCH" ] && [ "$EPOCH" -gt "$NOW" ] 2>/dev/null; then
    if [ -z "$RESET_EPOCH" ] || [ "$EPOCH" -lt "$RESET_EPOCH" ]; then
      RESET_EPOCH=$EPOCH
      RESET_LABEL=$LABEL
    fi
  fi
done

# Pool-wide sweep — pick the soonest non-null reset5h across all accounts.
# A sibling reset 1h from now is far more actionable than the active
# account's reset 17h from now. Excludes the active account's already-
# considered entries above to avoid double-counting.
POOL_5H_EARLIEST=$(jq -r '[.accounts[]?.rateLimits.reset5h | numbers] | map(select(.>'"$NOW"')) | min // empty' "$CACHE" 2>/dev/null)
if [ -n "$POOL_5H_EARLIEST" ] && [ "$POOL_5H_EARLIEST" -gt "$NOW" ] 2>/dev/null; then
  if [ -z "$RESET_EPOCH" ] || [ "$POOL_5H_EARLIEST" -lt "$RESET_EPOCH" ]; then
    RESET_EPOCH=$POOL_5H_EARLIEST
    RESET_LABEL="5h (pool)"
  fi
fi
POOL_7D_EARLIEST=$(jq -r '[.accounts[]?.rateLimits.reset7d | numbers] | map(select(.>'"$NOW"')) | min // empty' "$CACHE" 2>/dev/null)
if [ -n "$POOL_7D_EARLIEST" ] && [ "$POOL_7D_EARLIEST" -gt "$NOW" ] 2>/dev/null; then
  if [ -z "$RESET_EPOCH" ] || [ "$POOL_7D_EARLIEST" -lt "$RESET_EPOCH" ]; then
    RESET_EPOCH=$POOL_7D_EARLIEST
    RESET_LABEL="7d (pool)"
  fi
fi

# Last resort: cache `updatedAt`. If the cluster cache itself is hours
# old, the operator should know to refresh before deciding anything.
CACHE_AGE_MIN=""
CACHE_UPDATED_AT=$(jq -r '.updatedAt // empty' "$CACHE" 2>/dev/null)
if [ -n "$CACHE_UPDATED_AT" ]; then
  CACHE_UPDATED_EPOCH=$(date -d "$CACHE_UPDATED_AT" "+%s" 2>/dev/null || echo "0")
  if [ "$CACHE_UPDATED_EPOCH" -gt 0 ] 2>/dev/null; then
    CACHE_AGE_MIN=$(( (NOW - CACHE_UPDATED_EPOCH) / 60 ))
  fi
fi

if [ -n "$RESET_EPOCH" ]; then
  WAIT_MIN=$(( (RESET_EPOCH - NOW) / 60 ))
  # Format reset time
  if command -v date &>/dev/null; then
    RESET_TIME=$(date -r "$RESET_EPOCH" "+%-l:%M %p" 2>/dev/null || date -d "@$RESET_EPOCH" "+%-l:%M %p" 2>/dev/null || echo "in ${WAIT_MIN}m")
  else
    RESET_TIME="in ${WAIT_MIN}m"
  fi

  # Get cron fields: 2 min after reset
  CRON_MIN=$(date -r "$((RESET_EPOCH + 120))" "+%-M" 2>/dev/null || date -d "@$((RESET_EPOCH + 120))" "+%-M" 2>/dev/null || echo "2")
  CRON_HR=$(date -r "$((RESET_EPOCH + 120))" "+%-H" 2>/dev/null || date -d "@$((RESET_EPOCH + 120))" "+%-H" 2>/dev/null || echo "4")
  CRON_DOM=$(date -r "$((RESET_EPOCH + 120))" "+%-d" 2>/dev/null || date -d "@$((RESET_EPOCH + 120))" "+%-d" 2>/dev/null || echo "*")
  CRON_MON=$(date -r "$((RESET_EPOCH + 120))" "+%-m" 2>/dev/null || date -d "@$((RESET_EPOCH + 120))" "+%-m" 2>/dev/null || echo "*")
  CRON_EXPR="${CRON_MIN} ${CRON_HR} ${CRON_DOM} ${CRON_MON} *"

  cat <<EOJSON
{"systemMessage":"Currently on extra usage (${RESET_LABEL} resets at ${RESET_TIME}, ${WAIT_MIN}m). Schedule a one-shot CronCreate with cron '${CRON_EXPR}' recurring false and prompt 'Rate limit reset. Run ccrotate refresh to check base usage. If base tier available, run ccrotate next to switch. Show results and continue previous work.' to auto-resume on base usage."}
EOJSON
else
  # No reset time anywhere in the pool — usually means cluster cache is
  # stale OR the recent refresh-all probe burst false-flagged everyone
  # without populating reset fields. Tell the operator what we know
  # (active account + cache age) and suggest concrete next actions
  # instead of a vague "run /ccrotate-refresh".
  if [ -n "$CACHE_AGE_MIN" ]; then
    AGE_NOTE=" (cache ${CACHE_AGE_MIN}m old)"
  else
    AGE_NOTE=""
  fi
  if [ -n "$ACTIVE_EMAIL" ]; then
    ACTIVE_NOTE=" Active: ${ACTIVE_EMAIL}."
  else
    ACTIVE_NOTE=""
  fi
  echo "{\"systemMessage\":\"On extra usage but pool has no reset windows in tier-cache${AGE_NOTE}.${ACTIVE_NOTE} Either (a) probe a single account to learn fresh state — \`ccrotate refresh-one <email>\` will probe without rotating the rest, or (b) wait for the cluster's ccrotate-refresh cron to populate fresh data, then re-check with \`ccrotate when\`.\"}"
fi
