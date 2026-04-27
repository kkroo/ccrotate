# AGENTS.md

This repository builds `ccrotate`, a CLI for saving, switching, and rotating local AI CLI account state.

## Project Overview

- Entry point: `bin/ccrotate.js`
- Core logic: `lib/ccrotate.js`
- Commands: `lib/commands/*.js`
- Ink UI: `lib/components/*.js`

## Runtime Targets

`ccrotate` auto-detects its target runtime from environment markers and the parent process chain:

- Claude Code mode uses `~/.claude/.credentials.json` and `~/.claude.json`
- Codex mode uses `~/.codex/auth.json`

Profiles are stored separately:

- Claude Code: `~/.ccrotate/profiles.json`
- Codex: `~/.ccrotate/profiles.codex.json`

## Command Expectations

- Claude Code supports the full command set, including refresh/tier logic.
- Codex currently supports `snap`, `list`, `switch`, `next`, and `remove`.
- In Codex mode, `next` is round-robin. Claude-only commands should fail clearly instead of guessing behavior.

## Development Notes

- Preserve atomic file writes when touching auth or profile files.
- Keep Claude-specific quota logic isolated from Codex account switching.
- Use `pnpm test --run` for the current test suite.
