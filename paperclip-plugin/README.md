# @kkroo/paperclip-plugin-ccrotate

Paperclip **sandbox provider** plugin that runs agent commands through a
[ccrotate](https://github.com/somersby10ml/ccrotate)-managed Claude or Codex
account pool over SSH. Each lease rotates to a healthy account, and any
command whose output trips a rate-limit pattern is rotated and retried in
place.

## What it does

- Declares an `environmentDriver` of kind `sandbox_provider` with `driverKey:
  "ccrotate"`.
- On `acquireLease`: SSHes to the configured ccrotate host, runs `ccrotate
  next --target <claude|codex> -y`, captures the rotated account email.
- On `realizeWorkspace`: ensures a per-run remote workspace dir exists and
  rsyncs the local workspace path into it.
- On `execute`: runs the command over SSH inside the lease's remote workspace.
  If stdout/stderr matches any configured rate-limit pattern, runs `ccrotate
  next` again and respawns the command (bounded by `midRunRetries`).
- On `releaseLease` / `destroyLease`: cleans up in-process state and removes
  the per-run remote workspace.

The plugin worker itself is stateless beyond an in-memory lease map; all
durable rotation state lives in `~/.ccrotate/` on the configured remote host.

## Installing

This is published as `@kkroo/paperclip-plugin-ccrotate` on npm. To register
it as a bundled plugin in a paperclip server, add it to `BUNDLED_PLUGINS` in
`server/src/index.ts`:

```ts
const BUNDLED_PLUGINS = [
  // ...
  "@kkroo/paperclip-plugin-ccrotate",
];
```

The server's `autoInstallBundledPlugins()` will install it on next boot.

## Configuring an environment

After install, create a Sandbox-kind environment whose `provider` is
`ccrotate`. The driver expects:

```jsonc
{
  "ssh": {
    "host": "devbox.example.com",
    "user": "oramadan",
    "port": 22,
    "identityFile": "/var/secrets/ccrotate-host/id_ed25519",
    "strictHostKeyChecking": true
  },
  "target": "claude",                       // or "codex"
  "remoteWorkspaceRoot": "/home/oramadan/paperclip-runs",
  "midRunRetries": 1,
  "rateLimitPatterns": [
    "You've hit your session limit",
    "You've hit your weekly limit",
    "You're out of extra usage"
  ]
}
```

`identityFile` must be readable by the plugin worker process. In a k8s
deployment, mount the ccrotate host's SSH private key as a Kubernetes secret
and point `identityFile` at the mount path.

`remoteWorkspaceRoot` must already exist (or be creatable by `mkdir -p`) on
the ccrotate host.

## Pre-requisites on the ccrotate host

- `ccrotate >= 1.1.0` on `PATH` (the version that introduced `--target`).
- `~/.ccrotate/profiles-{claude,codex}.json` populated via `ccrotate snap`
  for at least two accounts.
- `~/.claude/.credentials.json` or `~/.codex/auth.json` writable by the SSH
  user (ccrotate atomically replaces these on rotation).
- `rsync` installed (used by `realizeWorkspace`).

## Building from source

```bash
npm install
npm run build
```

## Behavior notes

- **Concurrent leases share global ccrotate state.** Multiple agent runs
  pinned to this driver against the same target rotate the same
  `~/.{claude,codex}` credentials file. Within a single host this is the
  same property the manual `ccrotate next` workflow already has.
- **Mid-run rotation is post-hoc.** The plugin scans the full
  `stdout`/`stderr` of a finished command for rate-limit patterns, then
  rotates and retries. It does not interrupt a streaming process. For
  one-shot agent tool calls this is sufficient; for long-lived sessions
  prefer the rotation-at-acquireLease behavior.
- **No workspace export** of ccrotate profiles is performed — profiles stay
  on the host. If you want to ship a workspace WITH its account credentials
  to a different host, that's a separate (and dangerous) feature.
