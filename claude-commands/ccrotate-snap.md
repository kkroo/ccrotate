Save the current Claude Code account credentials for rotation.

IMPORTANT: This spawns `claude -p` for verification which CANNOT run inside an active session.
Tell the user to run from a **separate terminal window**:
```
ccrotate snap --force
```

On macOS this reads from Keychain if the credentials file doesn't exist.
