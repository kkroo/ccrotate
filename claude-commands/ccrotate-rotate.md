Smart-rotate to the next Claude Code account that is on standard (base) usage tier.

Run `ccrotate next` which will:
1. Test each candidate account's usage tier via `--output-format json` 
2. Skip accounts that are rate-limited or on extra usage
3. Switch to the first account on standard tier
4. Fall back to extra-usage account only if no standard-tier accounts exist

After rotation, remind the user to restart Claude Code to apply the account change.
