# 🔄 ccrotate

> **Seamlessly rotate between multiple Claude Code or Codex accounts**

A powerful CLI tool for managing multiple `claude-code` accounts, with Codex account save/switch support built in. Say goodbye to rate limit frustrations! 🚀

[![npm version](https://badge.fury.io/js/ccrotate.svg)](https://badge.fury.io/js/ccrotate)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

## ✨ Features

- 🔀 **Smart Account Rotation** - Switch between accounts with a single command
- 📊 **Usage Tier Detection** - Detects standard vs extra usage tier per account
- 🎯 **Intelligent Switching** - Skips rate-limited and extra-usage accounts automatically
- 📸 **Snapshot Management** - Save your current Claude session instantly
- 💾 **Safe Storage** - Atomic file operations prevent data corruption
- 📦 **Backup & Restore** - Export/import profiles with compression, integrity checking, and sync-aware merging
- 🔄 **Account Testing** - Verify and refresh tokens automatically
- 🎨 **Beautiful CLI** - Colorful, intuitive interface with clear feedback
- ⚡ **Lightning Fast** - Quick account switches without losing context
- 📦 **Optimized Distribution** - Single executable with minimal runtime dependencies
- 🤖 **Codex-Aware Runtime Detection** - Auto-detects Claude Code vs Codex from the runtime environment

## 🚀 Quick Start

### Installation

```bash
npm install -g ccrotate
```

### Basic Usage

1. **Login to your first Claude account** using `claude-code`
2. **Save your account**: `ccrotate snap`
3. **Login to another account** and repeat step 2
4. **Start rotating**: `ccrotate next` or `ccrotate switch user@example.com`

## 🤖 Codex Support

When `ccrotate` is launched from Codex, it auto-detects that runtime from `CODEX_*` environment markers or the parent process chain and switches to Codex mode automatically.

- Active auth source: `~/.codex/auth.json`
- Saved profiles: `~/.ccrotate/profiles.codex.json`
- Supported commands in Codex mode: `snap`, `list`, `switch`, `next`, `remove`, `status`, `refresh`, `refresh-one`, `when`
- `next` in Codex mode probes saved accounts and picks one with remaining quota
- Claude-only commands still require Claude Code mode: `repair`, `tier-cache`
- `export` / `import` work in both Claude Code and Codex mode

## 📖 Commands

### 📸 `ccrotate snap [--force]`
Save your currently active Claude account credentials.

```bash
ccrotate snap              # Save with confirmation prompt
ccrotate snap --force      # Force save without confirmation
```

### 📋 `ccrotate list` (alias: `ls`)
Display all saved accounts with status indicators.

```bash
ccrotate list
# Output:
# Saved Accounts:
# ★ 1. user1@example.com (last used: 1/15/2024)
#   2. user2@example.com (last used: 1/14/2024)
```

### 🔄 `ccrotate switch <email>`
Switch to a specific account by email address.

```bash
ccrotate switch user2@example.com
# ✓ Switched to account: user2@example.com
```

### ⏭️ `ccrotate next [--yes] [--deny]`
Smart-rotate to the next available account. Automatically saves the current account first, then tests each candidate's usage tier and picks the best option:

1. **Standard tier available** → switches immediately
2. **Only extra usage available** → prompts (or auto-allows with `--yes`, blocks with `--deny`)
3. **All rate-limited** → shows reset schedule, offers to wait and auto-switch

```bash
ccrotate next
# 🔍 Finding best account (checking usage tier)...
#   Testing user2@example.com... ✅ standard
# ✓ Switched to account: user2@example.com (standard tier)

ccrotate next --yes          # Auto-allow extra usage (for hooks/scripts)
ccrotate next --deny         # Never use extra, wait for reset instead

# When all accounts are rate-limited:
# ❌ All accounts are rate-limited.
# Reset schedule:
#   user1@example.com: resets in 2h 15m (3:00 AM)
#   user2@example.com: resets in 8h 30m (5:00 PM)
# ? Wait 2h 15m and auto-switch to user1@example.com when it resets? (Y/n)
```

### 🗑️ `ccrotate remove <email>` (alias: `rm`)
Remove a saved account from your rotation.

```bash
ccrotate remove user@example.com
# ? Are you sure you want to remove account user@example.com? No / Yes
```

### 📤 `ccrotate export`
Export all saved profiles for the active target as a compressed, shell-safe string with CRC verification.

```bash
ccrotate export
# ✓ Profiles exported (Shell-Safe compression + CRC verification):
# 3 accounts: 2146 → 1209 chars (-44%)
# CRC32: f7dd8ae3 (data integrity guaranteed)
# 
# "mp-gz-b64:f7dd8ae3:H4sIAAAAAAAAA5XRT..."
```

### 📥 `ccrotate import <data>`
Import profiles from a compressed string with automatic CRC verification.
When an account already exists, `ccrotate` keeps the version with the newer successful API sync timestamp (`lastApiSyncAt`), not the newer import time.

```bash
ccrotate import "mp-gz-b64:f7dd8ae3:H4sIAAAAAAAAA5XRT..."
# ✓ CRC verification passed: f7dd8ae3
# Found 3 accounts to import:
# user1@example.com, user2@example.com, user3@example.com
# ? Do you want to proceed with the import? Yes
# ✓ Successfully imported 3 accounts.
```

### 🔄 `ccrotate refresh` (alias: `rf`)
Test all saved accounts, refresh expired tokens, and show usage tier for each.

```bash
ccrotate refresh
# 🔄 Testing accounts and refreshing tokens...
# #  Email                 Status       Tier            Result
# 1  user1@example.com    ✅ Active    ✅ standard      Hi
# 2  user2@example.com    ❌ Failed    -               You've hit your limit
# 3  user3@example.com    ✅ Active    ⚠️  extended     Hi!
```

### 📊 `ccrotate status` (alias: `st`)
Check if the current account is on standard (base) or extra usage tier.

```bash
ccrotate status
# 🔍 Checking usage tier for user1@example.com...
# ✅ user1@example.com: standard tier (base usage)

ccrotate status --quiet      # JSON output for scripts/hooks
# {"email":"user1@example.com","tier":"standard","status":"ok"}
```

### ⚙️ `ccrotate config [key] [value]`
Get or set persistent configuration.

```bash
ccrotate config                          # Show all settings
ccrotate config extraUsage               # Show current value
ccrotate config extraUsage allow         # Always use extra usage
ccrotate config extraUsage deny          # Never use extra usage
ccrotate config extraUsage prompt        # Ask each time (default)
```

| Setting | Values | Description |
|---------|--------|-------------|
| `extraUsage` | `prompt` (default), `allow`, `deny` | What to do when only extra-usage accounts are available |

## 🪝 Claude Code Hook Integration

Two hooks for automatic account management:

### Stop Hook — Auto-rotate on rate limit

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "bash ~/.claude/hooks/ccrotate-on-limit.sh",
        "timeout": 15,
        "statusMessage": "Checking rate limits..."
      }]
    }]
  }
}
```

When Claude Code hits a rate limit, this hook runs `ccrotate next --yes` to auto-switch to the best available account. Respects your `extraUsage` config setting.

### SessionStart Hook — Downgrade from extra usage

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "bash ~/.claude/hooks/ccrotate-check-tier.sh",
        "timeout": 45,
        "statusMessage": "Checking usage tier..."
      }]
    }]
  }
}
```

When starting a new session, checks if you're on extra usage and a standard-tier account is available — auto-switches if so.

## 🏗️ How It Works

ccrotate manages your Claude accounts by:

1. **Reading** current credentials from `~/.claude/.credentials.json` and `~/.claude.json`
2. **Storing** account profiles in `~/.ccrotate/profiles.json`
3. **Switching** accounts using atomic file operations for safety
4. **Identifying** accounts by email from `oauthAccount.emailAddress`
5. **Compressing** data using MessagePack + Gzip + Base64 for efficient backup/restore

### Data Structure

```json
{
  "user1@example.com": {
    "credentials": { /* Full credentials.json content */ },
    "userId": "user-id-here",
    "oauthAccount": { 
      "emailAddress": "user1@example.com",
      /* Other OAuth info */
    },
    "lastUsed": "2024-01-15T10:30:00.000Z"
  }
}
```

## 🔧 Requirements

- **Node.js** 18.0.0 or higher
- **claude-code** CLI tool installed and configured
- **Cross-platform** support (Windows, Linux, macOS)

## ⚠️ Important Notes

- **Account Safety**: This tool works with session-based tokens. Please be mindful of Claude's terms of service.
- **Data Security**: Credentials are stored in plain text, consistent with `claude-code`'s approach.
- **Backup Recommended**: Consider backing up your `~/.ccrotate/` directory.

## 🛠️ Development

```bash
# Clone and install
git clone https://github.com/somersby10ml/ccrotate.git
cd ccrotate
pnpm install

# Development build with sourcemap
pnpm run build:dev

# Production build (minified)
pnpm run build

# Test locally with source
node bin/ccrotate.js --help

# Test built CLI
./dist/cli.js --help

# Package testing (dry-run)
pnpm run publish:dist:dry

# Publish to npm
pnpm run publish:dist
```

### 🏗️ Build System

ccrotate uses **esbuild** for optimized distribution:

- **Source**: `bin/ccrotate.js` + `lib/` directory  
- **Output**: Single `dist/cli.js` executable with external runtime dependencies
- **Optimized dependencies**: Only core libraries (React Ink, Commander, Chalk) are installed
- **Package size**: ~15KB unpacked, ~5KB compressed (excluding dependencies)

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🌟 Support

If ccrotate helps you manage your Claude accounts better, consider:
- ⭐ Starring this repository
- 🐛 Reporting issues on [GitHub](https://github.com/somersby10ml/ccrotate/issues)
- 💡 Suggesting new features

---

<div align="center">
  <strong>Made with ❤️ for the Claude community</strong>
</div>
