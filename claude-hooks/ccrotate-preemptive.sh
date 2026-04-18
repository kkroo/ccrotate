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

# Track last validation — don't re-check on every message (too slow)
VALIDATION_CACHE=~/.ccrotate/last-validation.txt
NOW=$(date +%s)
LAST_VALIDATED=0
if [ -f "$VALIDATION_CACHE" ]; then
  LAST_VALIDATED=$(cat "$VALIDATION_CACHE" 2>/dev/null || echo 0)
fi
VALIDATION_AGE=$((NOW - LAST_VALIDATED))

EXPIRES_AT=$(jq -r '.claudeAiOauth.expiresAt // 0' "$CREDS" 2>/dev/null)
NOW_MS=$((NOW * 1000))
EXPIRES_IN_MIN=$(( (EXPIRES_AT - NOW_MS) / 60000 ))

# If token is fresh-ish and validated recently, skip the check
if [ "$EXPIRES_IN_MIN" -gt 5 ] 2>/dev/null && [ "$VALIDATION_AGE" -lt 300 ] 2>/dev/null; then
  echo '{}'
  exit 0
fi

# Validate current token against /v1/messages (what Claude Code actually uses)
# /api/oauth/usage has different validation — a token passing it can still 401 here
TOKEN=$(jq -r '.claudeAiOauth.accessToken // empty' "$CREDS" 2>/dev/null)
if [ -n "$TOKEN" ]; then
  HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
    -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: oauth-2025-04-20" \
    -H "x-app: cli" \
    -d '{"model":"claude-haiku-4-5-20251001","max_tokens":1,"messages":[{"role":"user","content":"x"}]}' \
    "https://api.anthropic.com/v1/messages" 2>/dev/null)

  # Token valid — all good
  if [ "$HTTP_CODE" = "200" ]; then
    echo "$NOW" > "$VALIDATION_CACHE"
    echo '{}'
    exit 0
  fi

  # 429 — rate limited. Proactively switch before Claude hits the wall.
  if [ "$HTTP_CODE" = "429" ]; then
    echo "$NOW" > "$VALIDATION_CACHE"
    CURRENT_EMAIL=$(jq -r '.oauthAccount.emailAddress // ""' ~/.claude.json 2>/dev/null)
    # Try ccrotate next (non-interactive, deny extra)
    SWITCH_RESULT=$(ccrotate next --deny 2>&1)
    if echo "$SWITCH_RESULT" | grep -q "✓ Switched"; then
      NEW_EMAIL=$(echo "$SWITCH_RESULT" | grep -oP 'Switched to account: \K[^ ]+')
      echo "{\"outputToUser\":\"Proactive switch: $CURRENT_EMAIL rate-limited → $NEW_EMAIL\"}"
      exit 0
    fi
    # No account available — let it fail naturally
    echo '{}'
    exit 0
  fi

  # 401/403 — token is rejected. Fall through to recovery.
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
