#!/bin/bash
# UserPromptSubmit hook — preemptive account switch.
# Reads marker file. If target account's reset time has passed, switches
# BEFORE the API call. Otherwise no-op.
# <1ms when no marker exists (single stat() call).

MARKER=~/.ccrotate/preemptive-switch.json
[ ! -f "$MARKER" ] && echo '{}' && exit 0

TARGET=$(jq -r '.target // empty' "$MARKER" 2>/dev/null)
RESET_EPOCH=$(jq -r '.resetEpoch // 0' "$MARKER" 2>/dev/null)
REASON=$(jq -r '.reason // "scheduled"' "$MARKER" 2>/dev/null)
[ -z "$TARGET" ] && rm -f "$MARKER" && echo '{}' && exit 0

# Check if reset time has passed (0 = no wait needed, switch immediately)
NOW=$(date +%s)
if [ "$RESET_EPOCH" -gt 0 ] 2>/dev/null && [ "$RESET_EPOCH" -gt "$NOW" ]; then
  # Not yet — keep marker, don't switch
  echo '{}'
  exit 0
fi

# Reset time passed (or no epoch = immediate switch) — do the switch
RESULT=$(ccrotate switch "$TARGET" 2>&1)
if echo "$RESULT" | grep -q "✓ Switched\|✓ Already"; then
  rm -f "$MARKER"
  echo "{\"outputToUser\":\"Auto-switched to $TARGET ($REASON).\"}"
else
  # Switch failed — remove marker to avoid infinite retry
  rm -f "$MARKER"
  echo '{}'
fi
