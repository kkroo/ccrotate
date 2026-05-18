---
description: Switch ccrotate accounts through the correct local or serve path.
---

# /ccrotate:switch

<!-- ccrotate-serve:cmd=switch args=$ARGUMENTS -->

Switch to a specific account by email. Pass the email as the argument:
`/ccrotate:switch user@example.com`.

## How this command works

ccrotate-serve intercepts the marker, validates the email, and calls
`switch(email)` on the in-process pool. Confirmation is returned without a
model call.

## Local mode (no ccrotate-serve)

If the user didn't specify, run `ccrotate list` to show options, then
`ccrotate switch <email>`. Remind the user that the running session picks up
the new credentials automatically — no restart needed.
