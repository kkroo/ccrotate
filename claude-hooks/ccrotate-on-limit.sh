#!/bin/bash
# ccrotate Stop hook
# 1. Re-snap current account (keeps refresh tokens fresh)
# 2. On rate limit: write preemptive-switch marker with earliest-reset account
#    The UserPromptSubmit hook reads the marker and switches BEFORE the next API call

INPUT=$(cat)
LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // ""' 2>/dev/null)

# Always re-snap current account to keep refresh tokens fresh
ccrotate snap --force >/dev/null 2>&1

# Only act on actual rate limit signal
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

# Find the account with earliest reset from tier-cache
CACHE=~/.ccrotate/tier-cache.json
if [ ! -f "$CACHE" ]; then
  echo "{}"
  exit 0
fi

# Parse reset times, find earliest future reset for a DIFFERENT account
BEST=$(python3 << 'PYEOF'
import json, time, sys

try:
    cache = json.load(open("CACHE_PATH"))
    current = "CURRENT_EMAIL"
    now = time.time()
    best = None

    for a in cache.get("accounts", []):
        if a["email"] == current:
            continue
        rl = a.get("rateLimits") or {}
        # Skip accounts with no per-account data
        if rl.get("utilization5h") is None and rl.get("utilization7d") is None:
            continue

        # Find earliest reset for this account
        resets = []
        r5 = rl.get("reset5h")
        r7 = rl.get("reset7d")
        if r5: resets.append(r5)
        if r7: resets.append(r7)
        if rl.get("resetAt"):
            try:
                from datetime import datetime
                dt = datetime.fromisoformat(rl["resetAt"].replace("Z","+00:00"))
                resets.append(dt.timestamp())
            except: pass

        # Find the soonest reset (could be past = already reset = usable now!)
        for r in sorted(resets):
            if not best or r < best[1]:
                best = (a["email"], r)
                break

    if best:
        email, epoch = best
        if epoch <= now:
            print(f"READY|{email}|{int(epoch)}")
        else:
            delay = int(epoch - now) + 120
            print(f"WAIT|{email}|{int(epoch)}|{delay}")
except Exception as e:
    print(f"ERROR|{e}", file=sys.stderr)
PYEOF
)

# Replace placeholders
BEST=$(echo "$BEST" | sed "s|CACHE_PATH|$CACHE|g" | sed "s|CURRENT_EMAIL|$CURRENT_EMAIL|g")

# Re-run with actual values
BEST=$(python3 -c "
import json, time, sys
try:
    cache = json.load(open('$CACHE'))
    current = '$CURRENT_EMAIL'
    now = time.time()
    best = None
    for a in cache.get('accounts', []):
        if a['email'] == current: continue
        rl = a.get('rateLimits') or {}
        if rl.get('utilization5h') is None and rl.get('utilization7d') is None: continue
        resets = []
        r5 = rl.get('reset5h')
        r7 = rl.get('reset7d')
        if r5: resets.append(r5)
        if r7: resets.append(r7)
        for r in sorted(resets):
            if not best or r < best[1]:
                best = (a['email'], r)
                break
    if best:
        email, epoch = best
        if epoch <= now:
            print(f'READY|{email}|{int(epoch)}')
        else:
            delay = int(epoch - now) + 120
            print(f'WAIT|{email}|{int(epoch)}|{delay}')
except Exception as e:
    pass
" 2>/dev/null)

ACTION=$(echo "$BEST" | cut -d'|' -f1)
TARGET=$(echo "$BEST" | cut -d'|' -f2)
EPOCH=$(echo "$BEST" | cut -d'|' -f3)
DELAY=$(echo "$BEST" | cut -d'|' -f4)

if [ "$ACTION" = "READY" ]; then
  # Account has already reset — write marker for immediate switch on next message
  echo "{\"target\":\"$TARGET\",\"reason\":\"reset complete\",\"createdAt\":\"$(date -Iseconds)\"}" > ~/.ccrotate/preemptive-switch.json
  echo "$(date -Iseconds) Marker written: $TARGET (already reset)" >> "$LOG"
  echo "{\"outputToUser\":\"Rate limited. $TARGET has reset — will switch on next message.\"}"
elif [ "$ACTION" = "WAIT" ]; then
  # Account hasn't reset yet — write marker with timestamp so UserPromptSubmit
  # hook checks the time before switching
  RESET_TIME=$(date -r "$EPOCH" "+%-l:%M %p" 2>/dev/null || date -d "@$EPOCH" "+%-l:%M %p" 2>/dev/null || echo "soon")
  echo "{\"target\":\"$TARGET\",\"resetEpoch\":$EPOCH,\"reason\":\"waiting for reset at $RESET_TIME\",\"createdAt\":\"$(date -Iseconds)\"}" > ~/.ccrotate/preemptive-switch.json
  echo "$(date -Iseconds) Marker written: $TARGET (resets at $RESET_TIME, ${DELAY}s)" >> "$LOG"
  echo "{\"outputToUser\":\"Rate limited. $TARGET resets at $RESET_TIME — will auto-switch when ready.\"}"
else
  echo "{\"outputToUser\":\"Rate limited. No accounts with reset data available.\"}"
fi
