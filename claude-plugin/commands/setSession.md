---
description: Paste a fresh claude.ai sessionKey for a pool account and trigger relogin (paperclip v4.13).
---

# /ccrotate:setSession

<!-- ccrotate-serve:cmd=setSession args=$ARGUMENTS -->

Paste a fresh `sessionKey` cookie value for an account that the auth-bot can't
auto-recover via email-magic-link (i.e. anything `GMAIL_REFRESH_TOKEN` can't
read — most accounts that aren't a `@gmail.com` alias of the configured Gmail
identity). Usage:

`/ccrotate:setSession user@example.com sk-ant-sid01-...`

## How this command works

ccrotate-serve intercepts the marker and:

1. POSTs `{email, target:"claude", sessionKey}` to the auth-bot's
   `/setSession` endpoint (persists the cookie under that email's session
   store on the bot's shared cephfs PV).
2. Chains a POST to the bot's `/reloginViaSession` — the bot opens the
   stored sessionKey in Camoufox, drives the OAuth dance, and snaps the
   resulting tokens into `profiles.json`.
3. Returns the snap outcome inline. On success: `✓ <email> relogged in`
   plus the snap stdout. On `SESSIONKEY_IDENTITY_MISMATCH` (paperclip
   v4.13): `✗ sessionKey identity mismatch for <email>. Provided
   sessionKey actually belongs to: <other-email>.` — that's the v4.13
   safety check telling you the cookie you pasted is bound to a
   different account than the email you claimed; tokens were correctly
   written to the other account's profile (useful side effect) but the
   originally-requested account still needs its own sessionKey.

## Where to grab a sessionKey

1. Open `claude.ai` in a real browser logged in as the target account.
2. DevTools → Application → Cookies → `https://claude.ai`.
3. Copy the value of the `sessionKey` cookie (starts with
   `sk-ant-sid01-`, ~70 chars).
4. Paste into the slash command exactly as `email sessionKey` (single
   space separator).

## Local mode (no ccrotate-serve)

This command requires ccrotate-serve interception — there's no local
equivalent. If `$HOME/.config/ccrotate-serve/env` is unset, fall back to
hitting the auth-bot directly:

```bash
kubectl -n paperclip exec deploy/ccrotate-auth-bot -c bot -- bash -c \
  'curl -sS -X POST -H "Content-Type: application/json" \
    http://localhost:7000/setSession \
    -d "{\"email\":\"<email>\",\"target\":\"claude\",\"sessionKey\":\"<sk-ant-sid01-...>\"}"'
kubectl -n paperclip exec deploy/ccrotate-auth-bot -c bot -- bash -c \
  'curl -sS -X POST --max-time 120 -H "Content-Type: application/json" \
    http://localhost:7000/reloginViaSession \
    -d "{\"email\":\"<email>\",\"target\":\"claude\"}"'
```

The kubectl-exec path is what the v4.13 slash command was built to
replace — prefer the slash command when ccrotate-serve is routing
your traffic.
