#!/bin/bash
# Auto-rotate ccrotate account when rate limited.
# Hook: Stop — fires after each Claude response.
#
# Strategy: Always check tier-cache. If current account is exhausted/extra
# and a base account exists, switch to it. No API calls needed.
# Also checks last_assistant_message for rate limit signals.

INPUT=$(cat)
LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // ""' 2>/dev/null)

# Always re-snap current account to keep refresh tokens fresh
ccrotate snap --force >/dev/null 2>&1

LOG=~/.claude/hooks/ccrotate-debug.log
touch "$LOG" 2>/dev/null
LINES=$(wc -l < "$LOG" 2>/dev/null || echo 0)
if [ "$LINES" -gt 100 ]; then : > "$LOG"; fi

# Check 1: Is the last message a rate limit indicator?
RATE_LIMITED=false
if echo "$LAST_MSG" | grep -qiE 'hit.*limit|rate.?limit|usage.?limit|too many|429|quota|exceeded|capacity|out of.*usage'; then
  RATE_LIMITED=true
fi

# Check 2: Is the current account on extra/exhausted in tier-cache?
CACHE=~/.ccrotate/tier-cache.json
CURRENT_EMAIL=""
CURRENT_TIER=""
BEST_BASE=""

if [ -f "$CACHE" ] && command -v jq &>/dev/null; then
  # Get current account email from ~/.claude.json
  CURRENT_EMAIL=$(jq -r '.oauthAccount.emailAddress // ""' ~/.claude.json 2>/dev/null)

  if [ -n "$CURRENT_EMAIL" ]; then
    CURRENT_TIER=$(jq -r --arg e "$CURRENT_EMAIL" '.accounts[] | select(.email == $e) | .serviceTier // ""' "$CACHE" 2>/dev/null)

    # Find first base account that isn't current
    BEST_BASE=$(jq -r --arg e "$CURRENT_EMAIL" '[.accounts[] | select(.serviceTier == "base" and .email != $e)] | .[0].email // ""' "$CACHE" 2>/dev/null)
  fi
fi

echo "$(date -Iseconds) rate_limited=$RATE_LIMITED current=$CURRENT_EMAIL tier=$CURRENT_TIER best_base=$BEST_BASE" >> "$LOG"

# Only act if: rate limited OR current account is not base
SHOULD_SWITCH=false
if [ "$RATE_LIMITED" = "true" ]; then
  SHOULD_SWITCH=true
elif [ "$CURRENT_TIER" = "exhausted" ] || [ "$CURRENT_TIER" = "extra" ]; then
  # Only auto-switch from extra if there's a base account available
  if [ -n "$BEST_BASE" ]; then
    SHOULD_SWITCH=true
  fi
fi

if [ "$SHOULD_SWITCH" = "true" ] && [ -n "$BEST_BASE" ]; then
  # Try switching — ccrotate switch exits non-zero if token refresh fails
  SWITCH_OUTPUT=$(ccrotate switch "$BEST_BASE" 2>&1)
  if echo "$SWITCH_OUTPUT" | grep -q "✓ Switched"; then
    echo "$(date -Iseconds) SWITCHED to $BEST_BASE" >> "$LOG"
    echo "{\"outputToUser\":\"Switched to $BEST_BASE (base tier). Credentials updated automatically.\"}"
    exit 0
  fi

  echo "$(date -Iseconds) switch to $BEST_BASE FAILED: $(echo "$SWITCH_OUTPUT" | head -1)" >> "$LOG"

  # Try remaining base accounts from cache
  if [ -f "$CACHE" ] && command -v jq &>/dev/null; then
    OTHER_BASES=$(jq -r --arg e "$CURRENT_EMAIL" --arg tried "$BEST_BASE" \
      '[.accounts[] | select(.serviceTier == "base" and .email != $e and .email != $tried)] | .[].email' "$CACHE" 2>/dev/null)
    for ALT in $OTHER_BASES; do
      SWITCH_OUTPUT=$(ccrotate switch "$ALT" 2>&1)
      if echo "$SWITCH_OUTPUT" | grep -q "✓ Switched"; then
        echo "$(date -Iseconds) SWITCHED to $ALT (fallback)" >> "$LOG"
        echo "{\"outputToUser\":\"Switched to $ALT (base tier). Credentials updated automatically.\"}"
        exit 0
      fi
      echo "$(date -Iseconds) switch to $ALT FAILED" >> "$LOG"
    done
  fi

  echo "$(date -Iseconds) all base account switches failed" >> "$LOG"
fi

if [ "$RATE_LIMITED" = "true" ] && [ -z "$BEST_BASE" ]; then
  # All accounts exhausted — write pending-reset marker for SessionStart hook
  RESET_EPOCH=""
  if [ -f "$CACHE" ]; then
    RESET_EPOCH=$(jq -r '[.accounts[].rateLimits | (.reset5h // .resetAt // empty)] | map(select(. != null)) | map(if type == "string" then (split("+")[0] + "Z" | fromdateiso8601) else . end) | map(select(. > now)) | min // empty' "$CACHE" 2>/dev/null)
  fi

  if [ -n "$RESET_EPOCH" ]; then
    MARKER=~/.ccrotate/pending-reset.json
    cat > "$MARKER" <<EOMARKER
{"resetEpoch":${RESET_EPOCH},"resetLabel":"auto","createdAt":"$(date -Iseconds)"}
EOMARKER
    echo "$(date -Iseconds) All exhausted, wrote pending-reset marker epoch=$RESET_EPOCH" >> "$LOG"
    echo "{\"outputToUser\":\"All accounts exhausted. Scheduled auto-switch at reset.\"}"
  else
    echo "{}"
  fi
  exit 0
fi

echo "{}"
