#!/bin/bash
# UserPromptSubmit hook — preemptive account switch.
# Checks for a marker file written by refresh-one when the current
# account is near exhaustion. Switches BEFORE the API call.
# No-op (<1ms) when no marker exists.

MARKER=~/.ccrotate/preemptive-switch.json
[ ! -f "$MARKER" ] && echo '{}' && exit 0

TARGET=$(jq -r '.target // empty' "$MARKER" 2>/dev/null)
REASON=$(jq -r '.reason // "near limit"' "$MARKER" 2>/dev/null)
[ -z "$TARGET" ] && rm -f "$MARKER" && echo '{}' && exit 0

# Switch and delete marker
RESULT=$(ccrotate switch "$TARGET" 2>&1)
if echo "$RESULT" | grep -q "✓ Switched"; then
  rm -f "$MARKER"
  echo "{\"outputToUser\":\"Auto-switched to $TARGET ($REASON). Continuing seamlessly.\"}"
else
  # Switch failed — try removing marker so we don't loop
  rm -f "$MARKER"
  echo "{}"
fi
