---
description: Export ccrotate account state safely, preferring ccrotate-serve in cloud mode.
---

# /ccrotate:export

<!-- ccrotate-serve:cmd=export -->

Export all Claude Code account profiles as a compressed string for transfer to another machine.

## How this command works

If routed through ccrotate-serve, the server intercepts and returns an
informational message — server-side export would leak credentials across
multi-tenant pool callers. Must run locally.

Cloud/devbox mode:
If `$HOME/.config/ccrotate-serve/env` exists or `CCROTATE_SERVE_BASE_URL` is set, do not run local `ccrotate export`. The cluster auth bot owns the cloud account pool; exporting local profiles would be the wrong state. Report that cloud export is not exposed by ccrotate-serve yet.

Local mode only:
Run `ccrotate export` and show the output. Remind the user to run `ccrotate import "<string>"` on the target machine.
