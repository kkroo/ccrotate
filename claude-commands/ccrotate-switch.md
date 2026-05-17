# /ccrotate-switch

Switch to a specific Claude Code account by email.

Cloud/devbox mode:
If `$HOME/.config/ccrotate-serve/env` exists or `CCROTATE_SERVE_BASE_URL` is set, do not run local `ccrotate switch`. Cloud requests are routed by ccrotate-serve/auth-bot; switching local credentials does not change the served pool. Report that per-account switching is not exposed by ccrotate-serve yet.

Local mode only:
Ask the user which account to switch to if not specified. Run `ccrotate list` to show available accounts, then run `ccrotate switch <email>`.

Remind the user to restart Claude Code after switching.
