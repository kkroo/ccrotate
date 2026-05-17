# /ccrotate-accounts

Quick ccrotate account overview.

Cloud/devbox mode:
If `$HOME/.config/ccrotate-serve/env` exists or `CCROTATE_SERVE_BASE_URL` is set, source the env file if needed and use ccrotate-serve instead of local `ccrotate`:
1. Run `curl -sS http://127.0.0.1:4001/healthz`.
2. Run `curl -sS -H "Authorization: Bearer $CCROTATE_SERVE_TOKEN" "$CCROTATE_SERVE_BASE_URL/models"`.
3. Report ccrotate-serve health and available models. State that account-level list/switch is owned by the cluster auth bot and is not exposed by ccrotate-serve yet.

Local mode only:
Run `ccrotate list` and `ccrotate status --quiet`, then show a compact summary of all accounts with the current one marked. Include the extraUsage config setting from `ccrotate config`.
