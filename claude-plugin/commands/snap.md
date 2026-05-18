---
description: Snapshot the current Claude or Codex account into ccrotate.
---

# /ccrotate:snap

<!-- ccrotate-serve:cmd=snap -->

Capture the currently-logged-in Claude or Codex account into the ccrotate
pool.

## How this command works

ccrotate-serve cannot snap on behalf of a client — the credentials it needs
live on the user's machine (in `~/.claude.json` or the Codex equivalent), not
in the server's memory. So the marker triggers an informational response that
tells the user to run snap locally.

For a local snap (bang prefix bypasses the model entirely):

- `!ccrotate snap` — capture currently active account
- `!ccrotate snap --force` — overwrite existing profile

On macOS this reads from Keychain if the credentials file doesn't exist.

## Cluster snap path

For pool-managed accounts, snapping is handled by the cluster auth-bot's
`/reloginViaSession` recovery hook — operators don't run `ccrotate snap`
against the cluster pool directly.
