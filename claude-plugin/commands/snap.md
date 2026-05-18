---
description: Snapshot the current Claude or Codex account into ccrotate.
---

# /ccrotate:snap

Save the current Claude Code account credentials for rotation.

Cloud/devbox mode:
If `$HOME/.config/ccrotate-serve/env` exists or `CCROTATE_SERVE_BASE_URL` is set, do not run local `ccrotate snap`. Cloud account capture is owned by the cluster auth bot. Report that snapping must be done through the auth-bot/cloud workflow.

Local mode only:
Run `ccrotate snap --force` to save without prompting. On macOS this reads from Keychain if the credentials file doesn't exist.
