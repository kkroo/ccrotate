#!/bin/bash
# ccrotate Stop hook — re-snap credentials only.
# Auto-rotation is DISABLED here because:
# 1. "You're out of extra usage" blocks Claude before this hook fires
# 2. Switching based on tier-cache is unreliable and disruptive
#
# Rotation is handled by: user running `! ccrotate next` or slash commands.

INPUT=$(cat)

# Always re-snap current account to keep refresh tokens fresh
ccrotate snap --force >/dev/null 2>&1

echo "{}"
