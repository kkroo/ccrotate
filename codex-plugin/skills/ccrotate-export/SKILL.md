---
name: ccrotate-export
description: Export local ccrotate profiles, or explain cloud export ownership in ccrotate-serve mode.
---

Export all Claude Code account profiles as a compressed string for transfer to another machine.

Cloud/devbox mode:
If `$HOME/.config/ccrotate-serve/env` exists or `CCROTATE_SERVE_BASE_URL` is set, do not run local `ccrotate export`. The cluster auth bot owns the cloud account pool; exporting local profiles would be the wrong state. Report that cloud export is not exposed by ccrotate-serve yet.

Local mode only:
Run `ccrotate export` and show the output. Remind the user to run `ccrotate import "<string>"` on the target machine.
