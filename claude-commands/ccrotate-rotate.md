Smart-rotate to the next Claude Code account on standard (base) usage tier.

IMPORTANT: This spawns `claude -p` which CANNOT run inside an active Claude Code session.
Tell the user to run from a **separate terminal window**:
```
ccrotate next
```

Options:
- `ccrotate next --yes` — auto-allow extra usage if no standard accounts
- `ccrotate next --deny` — never use extra, wait for reset instead

After running in a separate terminal, restart Claude Code to apply.
