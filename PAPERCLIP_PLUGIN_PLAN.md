# ccrotate paperclip plugin — handoff

## Goal

Replace the chat-plugin "claude runs in pod" architecture with a paperclip
plugin that wraps ccrotate. Plugin lives in this repo (`~/src/ccrotate`) so
it has direct in-process access to the ccrotate API. Published as
`@kkroo/paperclip-plugin-ccrotate` and bundle-installed at server boot.

## Why

- Pod's k8s deploy can't run claude/codex locally — no `~/.claude/.credentials.json`,
  no `~/.codex/auth.json`, no ccrotate.
- All real auth + rotation lives on the SSH host (devbox).
- Existing chat plugin (lucitra/dev) was rewritten to use claude-agent-sdk
  in-process — assumes auth is local. Doesn't fit k8s.
- The right move: a plugin that EXPOSES ccrotate's account/session pool as
  paperclip plugin actions, runs ccrotate over SSH against the devbox, and
  leverages the import/export feature added in lucitra/paperclip commit 508ccab
  to ship ccrotate profiles into the workspace.

## Scope (concrete, ~3-4 hours fresh session)

### 1. Plugin scaffolding (~/src/ccrotate/paperclip-plugin/)

```
paperclip-plugin/
  package.json           # @kkroo/paperclip-plugin-ccrotate
  src/
    manifest.ts          # plugin manifest with actions + UI launcher
    worker.ts            # plugin worker: imports ../lib/ccrotate.js
    ui/index.tsx         # account list panel
    types.ts
  tsconfig.json
```

### 2. Plugin actions (worker.ts)

Wraps the ccrotate Node API directly — no HTTP shelling. Runs the actions
over SSH against the agent's environment so account state stays on the
devbox, not in the pod:

| Action | Maps to | Notes |
|---|---|---|
| `list` | `ccrotate.list()` | Returns saved accounts + current target |
| `when` | `ccrotate.when()` | Returns reset schedule for all accounts |
| `next` | `ccrotate.next({yes,deny})` | Rotates to next available account |
| `switch` | `ccrotate.switch(email)` | Force-switch to a specific account |
| `snap` | `ccrotate.snap()` | Save current ~/.claude or ~/.codex to profiles |
| `status` | `ccrotate.status()` | Current account's tier (base / extra / rate-limited) |
| `set-target` | `ccrotate.setTarget(t)` | Switch between claude / codex pools |

Runs each via `runSshCommand(sshSpec, "CCROTATE_TARGET=<t> ccrotate <action> <args>")` against the agent's environment SSH host.

### 3. Plugin UI panel (src/ui/index.tsx)

- Target selector (claude / codex) at top
- Account list table:
  - Email, current ★, tier, 5h/7d remaining %, reset windows
  - "Switch" button per row
- "Snap current" button (saves whatever's logged in to `~/.{claude,codex}` on the host)
- "Refresh" button to re-run `ccrotate refresh-one --target <t>` (lighter than `refresh`)
- Live updates via `usePluginStream("ccrotate-state")` — worker pushes new state
  after each mutating action

### 4. import/export sync (commit 508ccab in lucitra/paperclip)

Look at what 508ccab introduced and use it to:
- Export ccrotate profiles when packaging a workspace
- Import them back when unpacking a workspace on a different host
- This way a workspace can travel WITH its account credentials (dangerous —
  needs a per-workspace encryption pass; defer if 508ccab doesn't already
  handle that)

### 5. Auto-install

Add `@kkroo/paperclip-plugin-ccrotate` to `BUNDLED_PLUGINS` in
`server/src/index.ts:62` so it auto-installs on every boot. The
internalBootstrapToken bypass (commit 230361b9 on
chore/post-migration-followups) is what makes the loopback POST succeed.

### 6. Build + publish

```bash
cd ~/src/ccrotate/paperclip-plugin
npm install
npm run build
npm version patch
npm publish --access public --scope=kkroo
```

### 7. Deploy

Bump server image (rebuild). Auto-installer pulls the new plugin from npm
on next pod boot.

## Open design questions

1. **SSH target for plugin actions** — does the plugin take a `host` config,
   or auto-discover from the agent's environment? Probably the latter:
   plugin worker calls `ctx.environments.list()`, finds the SSH env, runs
   ccrotate against that host.
2. **Per-workspace encryption for exported profiles** — does 508ccab already
   provide this, or do we need to wrap profiles in a passphrase before
   exporting?
3. **Locking** — when the UI clicks "Switch", we mutate `~/.codex/auth.json`
   on the host. Concurrent agents starting runs could see a torn read.
   ccrotate already writes atomically (file rename) — verify that's enough,
   or wrap the action in a brief advisory lock.

## Pre-requisites already done (this session)

- `chore/post-migration-followups` HEAD = `b54aabb5` on `kkroo/paperclip`
- ccrotate is `kkroo/ccrotate@1.1.0` with `--target` flag and `CCROTATE_TARGET` env
- Image `sha-b54aabb5` pushed; cluster still on `sha-e16b4045`. `helm upgrade`
  to land the env-test/ssh-probe/synthetic-probe work when ready.
- All 4 chat-plugin / linear / codex follow-ups deployed via earlier helm revs.

## Skip path

If 508ccab's import/export turns out not to fit the use case (encryption,
schema mismatch, etc.), drop the sync step and just ship the plugin
without it — the rotation UX alone is the high-value piece.
