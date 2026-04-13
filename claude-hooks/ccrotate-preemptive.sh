#!/bin/bash
# UserPromptSubmit hook — runs before every API call.
# Two responsibilities:
# 1. Read marker file (set by refresh-one or Stop hook) and switch if reset passed
# 2. Check current token expiry — if stale, try refresh or switch to working account

MARKER=~/.ccrotate/preemptive-switch.json
CREDS=~/.claude/.credentials.json
CACHE=~/.ccrotate/tier-cache.json
PROFILES=~/.ccrotate/profiles.json

# --- Step 1: Check marker file ---
if [ -f "$MARKER" ]; then
  TARGET=$(jq -r '.target // empty' "$MARKER" 2>/dev/null)
  RESET_EPOCH=$(jq -r '.resetEpoch // 0' "$MARKER" 2>/dev/null)
  REASON=$(jq -r '.reason // "scheduled"' "$MARKER" 2>/dev/null)
  NOW=$(date +%s)

  if [ -n "$TARGET" ] && { [ "$RESET_EPOCH" -le 0 ] 2>/dev/null || [ "$RESET_EPOCH" -le "$NOW" ] 2>/dev/null; }; then
    RESULT=$(ccrotate switch "$TARGET" 2>&1)
    rm -f "$MARKER"
    if echo "$RESULT" | grep -q "✓"; then
      echo "{\"outputToUser\":\"Auto-switched to $TARGET ($REASON).\"}"
      exit 0
    fi
  fi
fi

# --- Step 2: Proactive token health check ---
[ ! -f "$CREDS" ] && echo '{}' && exit 0
[ ! -f "$PROFILES" ] && echo '{}' && exit 0

# Is current token expiring in < 1 min?
EXPIRES_AT=$(jq -r '.claudeAiOauth.expiresAt // 0' "$CREDS" 2>/dev/null)
NOW_MS=$(($(date +%s) * 1000))
EXPIRES_IN_MIN=$(( (EXPIRES_AT - NOW_MS) / 60000 ))

if [ "$EXPIRES_IN_MIN" -gt 1 ] 2>/dev/null; then
  # Token still valid, let the session continue
  echo '{}'
  exit 0
fi

# Current token expired — try to recover
CURRENT_EMAIL=$(jq -r '.oauthAccount.emailAddress // ""' ~/.claude.json 2>/dev/null)

# First try: refresh current account's token
if [ -n "$CURRENT_EMAIL" ]; then
  REFRESH_RESULT=$(ccrotate switch "$CURRENT_EMAIL" 2>&1)
  if echo "$REFRESH_RESULT" | grep -q "✓"; then
    echo "{\"outputToUser\":\"Refreshed $CURRENT_EMAIL credentials.\"}"
    exit 0
  fi
fi

# Refresh failed — find another usable account from cache
if [ -f "$CACHE" ]; then
  TARGET=$(python3 -c "
import json, time
try:
    cache = json.load(open('$CACHE'))
    current = '$CURRENT_EMAIL'
    now = time.time()
    for a in sorted(cache.get('accounts', []), key=lambda x: (x.get('rateLimits') or {}).get('utilization5h', 999)):
        if a['email'] == current: continue
        rl = a.get('rateLimits') or {}
        u5h = rl.get('utilization5h')
        u7d = rl.get('utilization7d')
        if u5h is None and u7d is None: continue  # no data
        if a.get('serviceTier') == 'exhausted': continue
        if u5h is not None and u5h >= 95: continue
        if u7d is not None and u7d >= 95: continue
        print(a['email'])
        break
except: pass
" 2>/dev/null)

  if [ -n "$TARGET" ]; then
    SWITCH_RESULT=$(ccrotate switch "$TARGET" 2>&1)
    if echo "$SWITCH_RESULT" | grep -q "✓ Switched"; then
      echo "{\"outputToUser\":\"Current account expired. Switched to $TARGET.\"}"
      exit 0
    fi
  fi
fi

echo '{}'
