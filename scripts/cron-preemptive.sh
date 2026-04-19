#!/bin/bash
# ccrotate cron — runs every 10min outside any Claude session.
# 1. Refresh one stale account (round-robin)
# 2. Check if current account is near limit (>90% on 5h or 7d)
# 3. If so, rotate to a base-tier account preemptively

LOG=~/.ccrotate/cron.log
CACHE=~/.ccrotate/tier-cache.json

# Keep log under 200 lines
if [ -f "$LOG" ]; then
  LINES=$(wc -l < "$LOG" 2>/dev/null || echo 0)
  [ "$LINES" -gt 200 ] && tail -100 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

# Step 1: Refresh one account
ccrotate refresh-one >/dev/null 2>&1

# Step 2: Check current account utilization from cache
[ ! -f "$CACHE" ] && exit 0

# Get active account from ccrotate (starred account), not ~/.claude.json (can be stale)
CURRENT_EMAIL=$(ccrotate list 2>/dev/null | grep '★' | awk '{print $3}')
[ -z "$CURRENT_EMAIL" ] && exit 0

SHOULD_ROTATE=$(python3 -c "
import json, sys
try:
    cache = json.load(open('$CACHE'))
    for a in cache.get('accounts', []):
        if a['email'] != '$CURRENT_EMAIL': continue
        rl = a.get('rateLimits') or {}
        u5h = rl.get('utilization5h')
        u7d = rl.get('utilization7d')
        tier = a.get('serviceTier', '')
        if tier == 'exhausted':
            print('yes|exhausted')
        elif u5h is not None and u5h >= 90:
            print(f'yes|5h:{u5h}%')
        elif u7d is not None and u7d >= 90:
            print(f'yes|7d:{u7d}%')
        else:
            print('no')
        sys.exit(0)
    print('no')
except:
    print('no')
" 2>/dev/null)

ROTATE=$(echo "$SHOULD_ROTATE" | cut -d'|' -f1)
REASON=$(echo "$SHOULD_ROTATE" | cut -d'|' -f2)

if [ "$ROTATE" = "yes" ]; then
  RESULT=$(ccrotate next --deny 2>&1)
  if echo "$RESULT" | grep -q "✓ Switched"; then
    NEW=$(echo "$RESULT" | grep "✓ Switched" | sed 's/.*: //' | sed 's/ .*//')
    echo "$(date -Iseconds) ROTATED $CURRENT_EMAIL ($REASON) → $NEW" >> "$LOG"
  else
    echo "$(date -Iseconds) TRIED rotating $CURRENT_EMAIL ($REASON) — no base account available" >> "$LOG"
  fi
fi
