---
description: One-shot register-and-login for a brand-new Claude/Codex account into the cluster ccrotate pool.
---

# /ccrotate:register

Add a brand-new account to the cluster ccrotate pool in a single HTTP call.
Skips the kubectl-patch-secret + Deployment rollout dance that used to be
required to introduce a new email to `ACCOUNTS_JSON`. Implemented in
`paperclip/ccrotate-auth-bot` v4.2+ via `POST /register` (see the auth-bot
script `script.mjs` handler) and intentionally bypasses the
pool-membership validation that gates `/setSession` + `/reloginViaSession`.

## Why this exists

Pre-v4.2, adding an account took ~6 manual steps:

1. Edit the `ccrotate-paperclip-config` Secret to extend `ACCOUNTS_JSON`.
2. `kubectl apply` the Secret.
3. Roll the `ccrotate-auth-bot` Deployment so `loadAccounts` picks up the
   new email.
4. Wait for the rollout, then port-forward into the new pod.
5. `POST /setSession` with the operator-grabbed cookie.
6. `POST /reloginViaSession` to drive the Camoufox login + ccrotate snap.

The Secret/rollout step is what makes this slow. Once a profile entry lands
in `/paperclip/.ccrotate/profiles.json` (which is the PVC, durable across
restarts), the email survives reboots even if the Secret never learned
about it — `readProfileAccounts` picks it up. `/register` collapses the
slow path into a single call.

## Operator flow

The handler runs **only** on the auth-bot pod's internal HTTP port (7000),
which is not exposed cluster-wide — so a port-forward is required.

```bash
# 1. Grab a fresh sk-ant-sid02-... cookie from claude.ai while logged in
#    as the target email. (Browser DevTools → Application → Cookies →
#    sessionKey, on https://claude.ai.) The cookie rotates ~30-60d.

# 2. Port-forward into the auth-bot pod.
AB_POD=$(kubectl -n paperclip get pods -l app.kubernetes.io/name=ccrotate-auth-bot \
  -o jsonpath='{.items[0].metadata.name}')
kubectl -n paperclip port-forward "$AB_POD" 17000:7000 &
PF=$!
sleep 2

# 3. Register. target=claude unless registering a Codex/ChatGPT account.
curl -sS -X POST -H "Content-Type: application/json" \
  -d '{
    "email":"newaccount@blockcast.net",
    "target":"claude",
    "sessionKey":"sk-ant-sid02-...PASTE_HERE..."
  }' \
  http://127.0.0.1:17000/register

kill $PF
```

A successful response shape:

```json
{
  "ok": true,
  "email": "newaccount@blockcast.net",
  "target": "claude",
  "registeredAt": "2026-05-19T22:30:00.000Z",
  "relogin": { "...snap stdout..." : "" }
}
```

Confirm the account landed in the pool:

```bash
kubectl -n paperclip exec "$AB_POD" -c bot -- jq -r \
  '.accounts[] | select(.email=="newaccount@blockcast.net") | .email' \
  /paperclip/.ccrotate/tier-cache.json
```

## Validation

- **`email`** — must contain `@`; same shape check as `/setSession`.
- **`target`** — must be `claude` or `codex` (no other pools today).
- **`sessionKey`** — must be a string ≥20 chars (matches the `sk-ant-sid02-`
  cookie envelope length). The handler doesn't probe the key — that
  happens downstream in `reloginViaSession`, which surfaces a 5xx if the
  cookie is invalid or expired.

## When to use `/setSession` + `/reloginViaSession` instead

If the email is **already** a pool member and you're refreshing its
credentials (cookie rotation, recovery from a failed snap, etc.),
`/register` returns 409. Hit `/setSession` + `/reloginViaSession`
directly — those flow through `validate()` and are the correct path
for an existing-pool-member relogin.

## Don't

- Don't expose port 7000 cluster-wide. The handler runs without API
  bearer auth and trusts whoever can reach the port. Port-forward only.
- Don't paste the session cookie into chat / logs. It grants full
  claude.ai session access until rotated.
- Don't call `/register` for an existing pool member — it's a 409. The
  `validate()`-gated relogin path exists for that case.
