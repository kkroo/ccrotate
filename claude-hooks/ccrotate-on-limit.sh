#!/bin/bash
# ccrotate Stop hook
# 1. Re-snap current account (keeps refresh tokens fresh)
# 2. Auto-switch ONLY when last_assistant_message contains rate limit text
#    NEVER switch based on tier-cache alone (stale data causes false switches)

INPUT=$(cat)
LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // ""' 2>/dev/null)

# Always re-snap current account to keep refresh tokens fresh
ccrotate snap --force >/dev/null 2>&1

# Only auto-switch on actual rate limit signal in Claude's response
if ! echo "$LAST_MSG" | grep -qiE 'hit.*limit|out of.*usage|rate.?limit|exceeded.*quota'; then
  echo "{}"
  exit 0
fi

LOG=~/.claude/hooks/ccrotate-debug.log
touch "$LOG" 2>/dev/null
LINES=$(wc -l < "$LOG" 2>/dev/null || echo 0)
if [ "$LINES" -gt 100 ]; then : > "$LOG"; fi

CURRENT_EMAIL=$(jq -r '.oauthAccount.emailAddress // ""' ~/.claude.json 2>/dev/null)
echo "$(date -Iseconds) RATE LIMITED on $CURRENT_EMAIL" >> "$LOG"

# Try all other accounts from profiles (not tier-cache — profiles have tokens)
PROFILES=~/.ccrotate/profiles.json
if [ ! -f "$PROFILES" ]; then
  echo "{}"
  exit 0
fi

CANDIDATES=$(jq -r --arg cur "$CURRENT_EMAIL" 'keys[] | select(. != $cur)' "$PROFILES" 2>/dev/null)

for EMAIL in $CANDIDATES; do
  SWITCH_OUTPUT=$(ccrotate switch "$EMAIL" 2>&1)
  if echo "$SWITCH_OUTPUT" | grep -q "✓ Switched\|✓ Already"; then
    echo "$(date -Iseconds) SWITCHED to $EMAIL" >> "$LOG"
    echo "{\"outputToUser\":\"Rate limited. Switched to $EMAIL.\"}"
    exit 0
  fi
  echo "$(date -Iseconds) switch to $EMAIL failed" >> "$LOG"
done

echo "$(date -Iseconds) all switches failed" >> "$LOG"
echo "{\"outputToUser\":\"Rate limited. All account switches failed — run /login + ccrotate snap --force.\"}"
