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

TIER=$(jq -r '.accounts[0].serviceTier // ""' "$CACHE" 2>/dev/null)
RESET_5H=$(jq -r '.accounts[0].rateLimits.reset5h // empty' "$CACHE" 2>/dev/null)
RESET_7D=$(jq -r '.accounts[0].rateLimits.reset7d // empty' "$CACHE" 2>/dev/null)

if [ "$TIER" = "base" ] || [ -z "$TIER" ]; then
  echo "{}"
  exit 0
fi

# On extra or exhausted — find earliest reset
NOW=$(date +%s)
RESET_EPOCH=""
RESET_LABEL=""
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
  echo "{\"systemMessage\":\"On extra usage. No reset time in cache — run /ccrotate-refresh to update.\"}"
fi
