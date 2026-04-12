#!/bin/bash
# Auto-rotate ccrotate account when rate limited or on extra usage.
# Hook: Stop — fires when Claude Code session ends.
# Schedules account switch at reset time so next session uses base usage.

INPUT=$(cat)
STOP_REASON=$(echo "$INPUT" | jq -r '.stop_reason // ""' 2>/dev/null)

LOG=~/.claude/hooks/ccrotate-debug.log
touch "$LOG" 2>/dev/null
LINES=$(wc -l < "$LOG" 2>/dev/null || echo 0)
if [ "$LINES" -gt 100 ]; then : > "$LOG"; fi
echo "$(date -Iseconds) stop_reason=$STOP_REASON" >> "$LOG"

if echo "$STOP_REASON" | grep -qiE 'hit.*limit|rate.?limit|usage.?limit|too many|429|quota|exceeded|capacity'; then
  # Try switching to a base-usage account
  RESULT=$(ccrotate next 2>/dev/null) || true
  NEW=$(echo "$RESULT" | grep -iE 'switched to' | sed 's/.*account: //' | sed 's/ (.*//')
  [ -z "$NEW" ] && NEW=""

  # Update keychain (macOS)
  if [ -f ~/.claude/.credentials.json ] && command -v security &>/dev/null; then
    security delete-generic-password -s "Claude Code-credentials" -a "$(whoami)" >/dev/null 2>&1
    security add-generic-password -s "Claude Code-credentials" -a "$(whoami)" -w "$(cat ~/.claude/.credentials.json)" >/dev/null 2>&1
  fi

  if [ -n "$NEW" ]; then
    echo "{\"systemMessage\":\"Rate limited. Switched to ${NEW}. Restart Claude Code to apply.\"}"
    exit 0
  fi

  # No base accounts available — schedule switch at reset time
  CACHE=~/.ccrotate/tier-cache.json
  RESET_5H="" ; RESET_7D=""
  if [ -f "$CACHE" ]; then
    RESET_5H=$(jq -r '[.accounts[].rateLimits.reset5h // empty] | map(select(. > 0)) | min // empty' "$CACHE" 2>/dev/null)
    RESET_7D=$(jq -r '[.accounts[].rateLimits.reset7d // empty] | map(select(. > 0)) | min // empty' "$CACHE" 2>/dev/null)
  fi

  NOW=$(date +%s)
  RESET_EPOCH=""
  RESET_LABEL=""
  for E in $RESET_5H $RESET_7D; do
    if [ -n "$E" ] && [ "$E" -gt "$NOW" ] 2>/dev/null; then
      if [ -z "$RESET_EPOCH" ] || [ "$E" -lt "$RESET_EPOCH" ]; then
        RESET_EPOCH=$E
        [ "$E" = "$RESET_5H" ] && RESET_LABEL="5h" || RESET_LABEL="7d"
      fi
    fi
  done

  if [ -n "$RESET_EPOCH" ]; then
    WAIT_MIN=$(( (RESET_EPOCH - NOW) / 60 ))
    RESET_TIME=$(date -r "$RESET_EPOCH" "+%-l:%M %p" 2>/dev/null || date -d "@$RESET_EPOCH" "+%-l:%M %p" 2>/dev/null || echo "?")

    # Write pending reset marker for SessionStart hook to pick up
    MARKER=~/.ccrotate/pending-reset.json
    cat > "$MARKER" <<EOMARKER
{"resetEpoch":${RESET_EPOCH},"resetLabel":"${RESET_LABEL}","createdAt":"$(date -Iseconds)"}
EOMARKER

    echo "$(date -Iseconds) Wrote pending reset marker: ${RESET_LABEL} at ${RESET_TIME} (${WAIT_MIN}m)" >> "$LOG"
    echo "{\"systemMessage\":\"All on extra usage. Reset at ${RESET_TIME} (${RESET_LABEL}, ${WAIT_MIN}m). Next session will auto-schedule switch.\"}"
  else
    echo "{\"systemMessage\":\"All accounts on extra usage. No reset time available.\"}"
  fi
else
  echo "{}"
fi
