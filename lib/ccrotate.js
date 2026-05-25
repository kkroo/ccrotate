import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import { spawnSync, spawn, execSync } from 'child_process';

import { SnapCommand } from './commands/snap.js';
import { ListCommand } from './commands/list.js';
import { SwitchCommand } from './commands/switch.js';
import { NextCommand } from './commands/next.js';
import { RemoveCommand } from './commands/remove.js';
import { RefreshCommand } from './commands/refresh.js';
import { RefreshOneCommand } from './commands/refresh-one.js';
import { WhenCommand } from './commands/when.js';
import { RepairCommand } from './commands/repair.js';
import { ExportCommand } from './commands/export.js';
import { ImportCommand } from './commands/import.js';
import { StatusCommand } from './commands/status.js';
import { LaunchCommand } from './commands/launch.js';
import { ServeCommand } from './commands/serve.js';
import { StateServerCommand } from './commands/state-server.js';
import { withCcrotateLock } from './state-helpers.js';
import {
  clearAnthropicRateLimitState as clearAnthropicRateLimitStateData,
  emptyRateLimitState,
} from './serve/rate-limit-state.js';

const SUPPORTED_TARGETS = new Set(['claude', 'codex']);

// Atomic file write via a UNIQUE temp file + rename. A fixed `<file>.tmp`
// name is unsafe when an unlocked writer (saveProfiles on a codex relogin,
// a direct saveTierCache from refresh-one) runs concurrently with a
// lock-protected writer of the same file: both open the same `.tmp`, their
// writes interleave, and whichever renames first publishes a truncated
// file. Observed live 2026-05-19 — intermittent `profiles.codex.json is
// unreadable` 500s from the state-server while the auth-bot was rewriting
// codex profiles. A per-write unique temp name means every writer renames
// its own complete file; a reader only ever sees a fully-written one. The
// rename itself is atomic on the same filesystem (incl. CephFS).
export function atomicWriteFileSync(file, contents) {
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    // fsync before rename so the rename publishes a fully-flushed file,
    // not a possibly-empty inode whose data is still in the page cache.
    // CephFS has been observed (paperclip incident 2026-05-20) to expose
    // 0-byte profiles.json mid-write to a concurrent reader despite the
    // unique-tmp + rename pattern — readers got "Unexpected end of JSON
    // input" from JSON.parse. Open + write + fsync + close walks the
    // bytes to disk before rename hands them to readers.
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, contents, 0, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw error;
  }
}

// Normalize a utilization value to a 0-100 integer percent. The Anthropic
// /api/oauth/usage endpoint has returned this field as both a 0-1 fraction
// (legacy) and a 0-100 percentage (current); a bare value stored verbatim
// renders as either 0-1% or 0-100%. A value < 1 is treated as a fraction
// and scaled. Returns null for null/undefined input.
export function toPercent(utilization) {
  if (utilization == null) return null;
  return Math.min(100, Math.round(utilization < 1 ? utilization * 100 : utilization));
}

// Process-local last-known-good cache of /api/oauth/usage responses, keyed
// by token hash. The endpoint rate-limits per access token (429 → ~1h
// cooldown); without this, a token in cooldown yields `null` and the
// account drops to "unknown" in the tier-cache until the cooldown clears.
// The 5h/7d windows move slowly, so serving the last successful response
// (tagged `__stale`) is far better than no data. Only successful fetches
// populate it; entries are kept until the process restarts.
const usageLkgCache = new Map();

class CCRotate {
  constructor() {
    this.profilesDir = path.join(os.homedir(), '.ccrotate');
    this.configFile = path.join(this.profilesDir, 'config.json');
    this.target = this.detectTarget();
    this.profilesFile = this.getProfilesFileForTarget(this.target);
    this.tierCacheFile = this.getTierCacheFileForTarget(this.target);
    this.claudeDir = path.join(os.homedir(), '.claude');
    this.credentialsFile = path.join(this.claudeDir, '.credentials.json');
    this.claudeConfigFile = path.join(os.homedir(), '.claude.json');
    this.codexDir = path.join(os.homedir(), '.codex');
    this.codexAuthFile = path.join(this.codexDir, 'auth.json');
    this.claudePath = null;
    
    // Initialize commands
    this.commands = {
      snap: new SnapCommand(this),
      list: new ListCommand(this),
      switch: new SwitchCommand(this),
      next: new NextCommand(this),
      remove: new RemoveCommand(this),
      refresh: new RefreshCommand(this),
      refreshOne: new RefreshOneCommand(this),
      when: new WhenCommand(this),
      repair: new RepairCommand(this),
      export: new ExportCommand(this),
      import: new ImportCommand(this),
      status: new StatusCommand(this),
      launch: new LaunchCommand(this),
      serve: new ServeCommand(this),
      stateServer: new StateServerCommand(this)
    };
  }

  normalizeTarget(target) {
    const normalized = String(target || '').trim().toLowerCase();
    return SUPPORTED_TARGETS.has(normalized) ? normalized : null;
  }

  detectTarget() {
    const envTarget = this.detectTargetFromEnv();
    if (envTarget) return envTarget;

    const processTarget = this.detectTargetFromParentProcess();
    if (processTarget) return processTarget;

    return 'claude';
  }

  detectTargetFromEnv(env = process.env) {
    // Explicit override beats every other heuristic. We deliberately re-read this
    // from env (not just argv) so non-launch commands honor it too — `launch` was
    // the only consumer before, which made `CCROTATE_TARGET=codex ccrotate switch`
    // silently fall back to claude mode.
    if (env.CCROTATE_TARGET) {
      const explicit = this.normalizeTarget(env.CCROTATE_TARGET);
      if (explicit) return explicit;
      // Don't crash on a typo — warn and fall through to auto-detection.
      console.error(`⚠️  Ignoring CCROTATE_TARGET='${env.CCROTATE_TARGET}' (use 'claude' or 'codex').`);
    }
    const keys = Object.keys(env);
    // CODEX_* are codex's own runtime vars — a strong, unambiguous signal.
    if (keys.some(key => key.startsWith('CODEX_'))) {
      return 'codex';
    }
    // CLAUDE* (e.g. CLAUDECODE, exported when running inside Claude Code)
    // must outrank a bare OPENAI_API_KEY. Devboxes commonly export
    // OPENAI_API_KEY for unrelated reasons — the local ccrotate-serve env
    // file sets it — so the old `|| env.OPENAI_API_KEY` short-circuit made
    // `ccrotate` invoked from a Claude Code session wrongly detect codex.
    if (keys.some(key => key.startsWith('CLAUDE'))) {
      return 'claude';
    }
    // OPENAI_API_KEY with no claude/codex markers at all: last-resort codex
    // hint, preserving prior behavior for bare codex-only environments.
    if (env.OPENAI_API_KEY) {
      return 'codex';
    }
    return null;
  }

  /**
   * Re-target an already-constructed CCRotate at a different account pool.
   * Used by the global --target CLI flag so commands run after argv parsing
   * pick up the right profiles / tier cache files.
   */
  setTarget(target) {
    const normalized = this.normalizeTarget(target);
    if (!normalized) {
      throw new Error(`Invalid target '${target}'. Use 'claude' or 'codex'.`);
    }
    this.target = normalized;
    this.profilesFile = this.getProfilesFileForTarget(normalized);
    this.tierCacheFile = this.getTierCacheFileForTarget(normalized);
  }

  detectTargetFromParentProcess() {
    try {
      let pid = process.ppid;
      const visited = new Set();
      while (pid && !visited.has(pid)) {
        visited.add(pid);
        const info = this.readProcessInfo(pid);
        if (!info) break;

        const command = `${info.command} ${info.args}`.toLowerCase();
        if (/\bcodex\b/.test(command)) return 'codex';
        if (/\bclaude\b/.test(command)) return 'claude';

        if (!info.ppid || info.ppid === pid) break;
        pid = info.ppid;
      }
    } catch {
      // Fall back to default target.
    }

    return null;
  }

  readProcessInfo(pid) {
    const platform = os.platform();
    if (platform === 'darwin' || platform === 'linux') {
      const output = execSync(`ps -o ppid=,comm=,args= -p ${pid}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      if (!output) return null;

      const match = output.match(/^\s*(\d+)\s+(\S+)\s*(.*)$/);
      if (!match) return null;

      return {
        ppid: Number(match[1]),
        command: match[2],
        args: match[3] || ''
      };
    }

    return null;
  }

  getProfilesFileForTarget(target) {
    if (target === 'claude') {
      return path.join(this.profilesDir, 'profiles.json');
    }
    return path.join(this.profilesDir, `profiles.${target}.json`);
  }

  getTierCacheFileForTarget(target) {
    if (target === 'claude') {
      return path.join(this.profilesDir, 'tier-cache.json');
    }
    return path.join(this.profilesDir, `tier-cache.${target}.json`);
  }

  /**
   * Look up whether the cached tier-cache entry for `email` reports
   * extra_usage.is_enabled === true. Used by testAccount to decide
   * whether the /v1/messages org-level fallback would carry useful
   * (overage-status) information for this seat. If the cache file
   * is missing, malformed, or has no entry for this email, returns
   * false — when in doubt, skip the fallback rather than show
   * org-shared numbers.
   */
  cachedExtraUsageEnabled(email) {
    try {
      const file = this.getTierCacheFileForTarget(this.target);
      const raw = fs.readFileSync(file, 'utf8');
      const cache = JSON.parse(raw);
      const entry = (cache.accounts || []).find((a) => a.email === email);
      return entry?.rateLimits?.extra?.is_enabled === true;
    } catch {
      return false;
    }
  }

  isClaudeTarget() {
    return this.target === 'claude';
  }

  isCodexTarget() {
    return this.target === 'codex';
  }

  getTargetName() {
    return this.isClaudeTarget() ? 'Claude Code' : 'Codex';
  }

  ensureClaudeFeature(feature) {
    if (!this.isClaudeTarget()) {
      throw new Error(`${feature} is only available in Claude Code mode. Current target: ${this.getTargetName()}.`);
    }
  }

  findClaudePath() {
    if (this.claudePath) {
      return this.claudePath;
    }

    // Step 1: Check common installation paths directly
    const commonPaths = [
      path.join(os.homedir(), '.claude/local/claude'),  // Official installation path
      '/usr/local/bin/claude',                          // macOS Homebrew
      '/opt/homebrew/bin/claude',                       // macOS ARM Homebrew  
      path.join(os.homedir(), 'bin/claude'),            // User bin
      '/usr/bin/claude'                                 // System-wide
    ];
    
    for (const claudePath of commonPaths) {
      try {
        if (fs.existsSync(claudePath) && fs.statSync(claudePath).mode & 0o111) {
          this.claudePath = claudePath;
          return claudePath;
        }
      } catch (error) {
        // Continue checking other paths
        continue;
      }
    }

    // Step 2: Try to find claude using user's shell environment
    try {
      const userShell = process.env.SHELL || '/bin/bash';
      const shellConfig = userShell.includes('zsh') ? '~/.zshrc' : 
                         userShell.includes('bash') ? '~/.bashrc' : 
                         '~/.profile';
      
      const platform = os.platform();
      const whichCommand = platform === 'win32' ? 'where claude' : 'which claude';
      
      const result = execSync(`source ${shellConfig} && ${whichCommand}`, {
        encoding: 'utf8',
        shell: userShell,
        env: process.env,
        timeout: 5000
      }).trim();
      
      if (result) {
        // Parse "claude: aliased to /path/to/claude" format
        const aliasMatch = result.match(/aliased to (.+)$/);
        if (aliasMatch) {
          const claudePath = aliasMatch[1].trim();
          if (fs.existsSync(claudePath)) {
            this.claudePath = claudePath;
            return claudePath;
          }
        }
        
        // Handle direct path result
        const directPath = result.split('\n')[0].trim();
        if (directPath && fs.existsSync(directPath)) {
          this.claudePath = directPath;
          return directPath;
        }
      }
    } catch (error) {
      // Continue to step 3
    }

    // Step 3: Check environment variable fallback
    if (process.env.CLAUDE_PATH) {
      const envPath = process.env.CLAUDE_PATH;
      try {
        if (fs.existsSync(envPath) && fs.statSync(envPath).mode & 0o111) {
          this.claudePath = envPath;
          return envPath;
        }
      } catch (error) {
        // Continue to error
      }
    }

    // Final fallback with helpful error message
    throw new Error(`Claude executable not found. Please try:
1. Reinstall claude-code: npm install -g @anthropic/claude-code
2. Set custom path: export CLAUDE_PATH="/path/to/claude"
3. Check installation: which claude`);
  }


  ensureProfilesDir() {
    if (!fs.existsSync(this.profilesDir)) {
      fs.mkdirSync(this.profilesDir, { recursive: true });
    }
  }

  loadProfiles() {
    if (!fs.existsSync(this.profilesFile)) {
      return {};
    }
    // Single-retry on empty/truncated reads. paperclip 2026-05-20: snap
    // intermittently saw 0-byte reads from a profiles.json that had been
    // freshly atomic-written by a concurrent ccrotate refresh. CephFS
    // metadata propagation can lag the rename by a few ms; a single
    // 100ms retry covers the window without papering over real corruption
    // (a second empty read indicates the file genuinely IS empty).
    const readOnce = () => {
      const data = fs.readFileSync(this.profilesFile, 'utf8');
      if (!data || data.trim() === '') {
        const err = new Error('profiles.json read returned empty string');
        err.code = 'EMPTY_READ';
        throw err;
      }
      return JSON.parse(data);
    };
    try {
      return readOnce();
    } catch (error) {
      const isTransient =
        error?.code === 'EMPTY_READ' ||
        /Unexpected end of JSON input|Unexpected token.*JSON/.test(error?.message ?? '');
      if (!isTransient) {
        throw new Error(`Failed to parse profiles.json: ${error.message}`);
      }
      const start = Date.now();
      while (Date.now() - start < 250) {
        const waitMs = 50;
        const waitUntil = Date.now() + waitMs;
        while (Date.now() < waitUntil) { /* busy-wait — sync path, no setTimeout available */ }
        try { return readOnce(); } catch { /* still empty; loop */ }
      }
      throw new Error(`Failed to parse profiles.json after retry: ${error.message}`);
    }
  }

  saveProfiles(profiles) {
    this.ensureProfilesDir();
    try {
      atomicWriteFileSync(this.profilesFile, JSON.stringify(profiles, null, 2));
    } catch (error) {
      throw new Error(`Failed to save profiles: ${error.message}`);
    }
  }

  clearAnthropicRateLimitState(email, opts = {}) {
    if (!email) return { email, cleared: false };
    this.ensureProfilesDir();
    const file = path.join(this.profilesDir, 'rate-limit-state.json');
    let result = { email, cleared: false };
    withCcrotateLock(this.profilesDir, () => {
      let state = emptyRateLimitState();
      try {
        state = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        // Missing or corrupt state is safe to rebuild from future headers.
      }
      const before = JSON.stringify(state?.anthropic?.accounts?.[email] ?? null);
      const updated = clearAnthropicRateLimitStateData(state, {
        email,
        model: opts.model ?? null,
        modelGroup: opts.modelGroup ?? null,
      });
      const after = JSON.stringify(updated?.anthropic?.accounts?.[email] ?? null);
      const cleared = before !== after;
      if (cleared) {
        atomicWriteFileSync(file, JSON.stringify(updated, null, 2));
      }
      result = { email, cleared };
    });
    return result;
  }

  saveTierCache(results) {
    this.ensureProfilesDir();
    const updatedAt = new Date().toISOString();
    const cache = {
      updatedAt,
      accounts: results.map(r => this.createTierCacheEntry(r, updatedAt))
    };
    // Atomic write: unique-tmpfile + rename. Without this, a concurrent
    // reader on CephFS could observe a truncated file mid-write, and a
    // concurrent writer sharing the tmp path could publish a truncated
    // file. The lock-around-RMW pattern in upsertTierCacheEntries also
    // depends on this being atomic from outside its own critical section
    // (e.g. refresh-one.js's direct, unlocked saveTierCache call), so we
    // always atomic-rename even when called inside the lock.
    try {
      atomicWriteFileSync(this.tierCacheFile, JSON.stringify(cache, null, 2));
    } catch { /* non-fatal */ }
  }

  createTierCacheEntry(result, fallbackSyncedAt = null) {
    const rateLimits = result.rateLimits || null;
    // Pass through the model-scoped `exhausted` map when the caller built it
    // explicitly (e.g. an in-process markAccountExhausted that bypasses the
    // state-helpers writer). Fresh probes from testAccount don't populate
    // this — mergeTierCacheEntry carries it forward from the existing entry
    // when the next entry still classifies as exhausted. Without this
    // passthrough, every saveTierCache writeback (called by refresh /
    // refresh-one / upsertTierCacheEntries) stripped the map and forced the
    // read-side fallback in readExhaustion to reconstruct it from the
    // `response: "quota exhausted; resets at <epoch>"` heuristic.
    const exhausted =
      result.exhausted && typeof result.exhausted === 'object' ? result.exhausted : null;
    return {
      email: result.email,
      status: result.status,
      serviceTier: result.serviceTier || null,
      response: result.result || result.response || '',
      ...(exhausted ? { exhausted } : {}),
      rateLimits,
      syncedAt: result.syncedAt
        || result.lastApiSyncAt
        || rateLimits?.snapshotCapturedAt
        || rateLimits?.capturedAt
        || fallbackSyncedAt
        || null,
    };
  }

  tierCacheEntryHasRateLimitData(entry) {
    const rateLimits = entry?.rateLimits || null;
    if (!rateLimits) return false;
    // Reset epochs and an `exhausted` serviceTier ALSO count as meaningful
    // data — they're the signal that an external observer (claude-local
    // writeback, auth-bot) captured a runtime quota burn. Without this,
    // a refresh that hits Usage API cooldown returns status='unknown' and
    // the upsert merge clobbers the exhausted entry, sending it back
    // into the rotation pool.
    if (entry.serviceTier === 'exhausted') return true;
    return rateLimits.utilization5h != null
      || rateLimits.utilization7d != null
      || rateLimits.remaining5h != null
      || rateLimits.remaining7d != null
      || rateLimits.reset5h != null
      || rateLimits.reset7d != null;
  }

  mergeTierCacheEntry(existingEntry, nextEntry) {
    if (!existingEntry) return nextEntry;

    const existingRateLimits = existingEntry.rateLimits || null;
    const nextRateLimits = nextEntry.rateLimits || null;
    if (!existingRateLimits || !nextRateLimits) return nextEntry;

    const mergedRateLimits = { ...existingRateLimits, ...nextRateLimits };

    // A newer probe can legitimately know less than the older snapshot:
    // Usage API cooldown, /v1/messages fallback, and runtime writeback paths
    // may classify an account without returning rolling-window reset epochs.
    // Preserve those epochs unless the new probe supplies replacements.
    for (const key of ['reset5h', 'reset7d', 'resetAt']) {
      if (nextRateLimits[key] == null && existingRateLimits[key] != null) {
        mergedRateLimits[key] = existingRateLimits[key];
      }
    }

    const merged = {
      ...nextEntry,
      rateLimits: mergedRateLimits,
    };

    // Carry forward the model-scoped `exhausted` map ONLY when the fresh
    // probe still classifies the account as exhausted. A usable serviceTier
    // (e.g. 'base' / 'extra' / 'available') from a fresh probe is treated as
    // an implicit clearExhausted (mirrors the freshness-loop's recovery
    // convention — see state-helpers.clearAccountExhausted). Without this
    // carry-forward, a saveTierCache writeback during ongoing exhaustion
    // strips the map (createTierCacheEntry-side); the read-side fallback
    // in readExhaustion then has to reconstruct it from the response/
    // reset5h heuristic. This closes that bug on the write side.
    if (nextEntry.serviceTier === 'exhausted' && !nextEntry.exhausted && existingEntry.exhausted) {
      merged.exhausted = existingEntry.exhausted;
    }

    return merged;
  }

  upsertTierCacheEntries(results) {
    if (!Array.isArray(results) || results.length === 0) return;

    // Lock around the entire read-modify-write. Without this, two
    // ccrotate-serve replicas running freshness-loop probes (or any other
    // upserter) can race: both read existing (e.g. 13 accounts), each
    // modifies a different entry, last writer wins — but if any read
    // returned a partially-written or truncated cache from a concurrent
    // writer, the loser's "merged" snapshot has FEWER entries than the
    // disk truth, and its saveTierCache shrinks the on-disk file. Observed
    // live 2026-05-18 during a ccrotate-serve rollout: tier-cache.json went
    // from 13 accounts to 3 across replicas writing in parallel without
    // serialization. withCcrotateLock is the SAME advisory lockfile used
    // by markAccountExhausted / clearAccountExhausted, so the four tier-
    // cache mutator paths all serialize on one POSIX lock.
    this.ensureProfilesDir();
    withCcrotateLock(this.profilesDir, () => {
      let existing;
      try {
        existing = this.loadTierCache();
      } catch (e) {
        if (e?.code === 'TIER_CACHE_UNPARSEABLE') {
          // Refuse to overwrite a corrupt cache with our 1..N upsert
          // entries — that's how a 15-account file collapses to N. The
          // next mutation cycle (a few seconds away) will see the file
          // recovered (or whoever next reads gets the same error and
          // also aborts, which is the right preserve-existing posture).
          console.warn(
            `[upsertTierCacheEntries] tier-cache unparseable; skipping write to preserve existing file. error=${e.message}`,
          );
          return;
        }
        throw e;
      }
      const merged = new Map(
        Array.isArray(existing?.accounts)
          ? existing.accounts.map(account => [account.email, account])
          : []
      );

      for (const result of results) {
        if (!result?.email) continue;
        const nextEntry = this.createTierCacheEntry(result);
        const existingEntry = merged.get(result.email);
        if (
          this.tierCacheEntryHasRateLimitData(existingEntry) &&
          !this.tierCacheEntryHasRateLimitData(nextEntry)
        ) {
          continue;
        }
        merged.set(result.email, this.mergeTierCacheEntry(existingEntry, nextEntry));
      }

      this.saveTierCache(Array.from(merged.values()));
    });
  }

  // Distinguishes file-missing (safe to treat as empty / fresh install)
  // from file-exists-but-unparseable (transient corruption — must NOT
  // be silently fallen-back to empty, or callers will write back a
  // shrunken cache and atomically nuke the populated file. Live incident
  // 2026-05-21T01:19Z: tier-cache.json hit a transient cephfs rename
  // race; markAccountExhausted's parse-error swallow at state-helpers.js
  // shrunk the cache from 15 to 1 entries on the very next 429).
  //
  // Callers that should ABORT on corruption: upsertTierCacheEntries,
  // markAccountExhausted, clearAccountExhausted, applyImport — anything
  // that read-modify-writes the cache. Read-only callers (CLI display)
  // can still treat corruption as "no data" by catching this.
  loadTierCache() {
    if (!fs.existsSync(this.tierCacheFile)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.tierCacheFile, 'utf8'));
    } catch (e) {
      if (e?.code === 'ENOENT') return null;
      const err = new Error(
        `tier-cache parse failed at ${this.tierCacheFile}: ${e?.message ?? e}`,
      );
      err.code = 'TIER_CACHE_UNPARSEABLE';
      throw err;
    }
  }

  loadConfig() {
    if (!fs.existsSync(this.configFile)) {
      return { extraUsage: 'prompt' }; // default: prompt, allow, deny
    }
    try {
      return JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
    } catch {
      return { extraUsage: 'prompt' };
    }
  }

  saveConfig(config) {
    this.ensureProfilesDir();
    fs.writeFileSync(this.configFile, JSON.stringify(config, null, 2), 'utf8');
  }

  readCredentials() {
    // macOS: Keychain first (Claude Code writes active token there after /login)
    // File is a stale cache from ccrotate switch/writeCredentials — Keychain is truth.
    if (process.platform === 'darwin') {
      try {
        const result = execSync(
          'security find-generic-password -s "Claude Code-credentials" -a "$(whoami)" -w',
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        if (result) return JSON.parse(result);
      } catch { /* not in keychain */ }
    }

    // File fallback (Linux, or macOS without Keychain entry)
    if (fs.existsSync(this.credentialsFile)) {
      const content = fs.readFileSync(this.credentialsFile, 'utf8').trim();
      if (content) {
        try { return JSON.parse(content); } catch { /* fall through */ }
      }
    }

    return null;
  }

  readCodexAuth() {
    if (!fs.existsSync(this.codexAuthFile)) {
      return null;
    }

    const content = fs.readFileSync(this.codexAuthFile, 'utf8').trim();
    if (!content) return null;

    try {
      return JSON.parse(content);
    } catch (error) {
      throw new Error(`Failed to parse Codex auth file: ${error.message}`);
    }
  }

  /**
   * Cross-process advisory lock around active-account file writes
   * (~/.claude/.credentials.json + ~/.claude.json, or ~/.codex/auth.json).
   * Multiple agent Job pods sharing the cephfs RWX /paperclip PVC can call
   * `ccrotate next` concurrently; without serialization, two writers can
   * interleave their credentials + config publishes and a reader (or even
   * a snap on the same race) sees a mismatched pair, then commits the
   * mismatch into a profile labeled with the wrong account
   * (see memory/feedback_ccrotate_snap_clobber.md in the k8s repo).
   *
   * Implementation: O_CREAT | O_EXCL (atomic on POSIX, including cephfs)
   * with busy-retry. Stale lockfiles older than `staleMs` are reclaimed
   * — a crashed holder won't deadlock the next caller. Synchronous so
   * callers (writeClaudeFiles / writeCodexFiles) don't need to be
   * promoted to async; the busy-wait loop only blocks the calling
   * subprocess (ccrotate is a short-lived CLI), not paperclip-server.
   */
  withActiveFilesLock(fn, opts = {}) {
    const lockPath = path.join(this.profilesDir, '.active-files.lock');
    const timeout = opts.timeout ?? 10000;
    const staleMs = opts.staleMs ?? 30000;
    const sleepMs = 50;
    const start = Date.now();
    let fd;

    // Ensure profilesDir exists — first-ever run before any profile write.
    try { fs.mkdirSync(this.profilesDir, { recursive: true }); } catch {}

    for (;;) {
      try {
        fd = fs.openSync(lockPath, 'wx');
        try {
          fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
        } catch {
          // best-effort metadata; lock is still held by virtue of the FD
        }
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      // Stale-lock reclaim: if the lockfile mtime is older than staleMs,
      // assume the previous holder crashed before unlinking.
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          try { fs.unlinkSync(lockPath); } catch {}
          continue;
        }
      } catch {
        // file disappeared between EEXIST and stat — race with another
        // holder releasing. Just retry.
      }
      if (Date.now() - start > timeout) {
        throw new Error(`ccrotate: timed out waiting for ${lockPath} after ${timeout}ms`);
      }
      // Synchronous sleep — busy-wait. ~50ms granularity is fine since
      // contention should be sub-second under normal use.
      const sleepUntil = Date.now() + sleepMs;
      while (Date.now() < sleepUntil) { /* spin */ }
    }

    try {
      return fn();
    } finally {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }

  writeCredentials(credentials) {
    // Write to file only — Keychain is managed by Claude Code (/login).
    // ccrotate switch/refresh should NOT touch Keychain to avoid overwriting
    // the user's active login session token.
    if (!credentials) {
      throw new Error('writeCredentials called with empty credentials');
    }
    const tempFile = this.credentialsFile + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(credentials, null, 2), 'utf8');
    fs.renameSync(tempFile, this.credentialsFile);
  }

  writeCodexAuth(auth) {
    if (!auth) {
      throw new Error('writeCodexAuth called with empty auth');
    }
    const tempFile = this.codexAuthFile + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(auth, null, 2), 'utf8');
    fs.renameSync(tempFile, this.codexAuthFile);
  }

  decodeJwtPayload(token) {
    if (!token) return null;
    try {
      const [, payload] = token.split('.');
      if (!payload) return null;
      return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Check the status of an access token against /v1/messages (what Claude Code uses).
   * Returns one of:
   *   'usable'      — token works, API call succeeded (HTTP 200)
   *   'rate_limited' — token valid but account out of quota (HTTP 429)
   *   'invalid'     — token rejected (HTTP 401/403)
   *   'unknown'     — network error or unexpected response (don't block)
   */
  async checkTokenStatus(token) {
    if (!token) return 'invalid';
    const { default: https } = await import('https');
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'x' }]
    });
    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
          'x-app': 'cli'
        }
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          if (res.statusCode === 200) resolve('usable');
          else if (res.statusCode === 429) resolve('rate_limited');
          else if (res.statusCode === 401 || res.statusCode === 403) resolve('invalid');
          else resolve('unknown');
        });
      });
      req.on('error', () => resolve('unknown'));
      const t = setTimeout(() => { req.destroy(); resolve('unknown'); }, 8000);
      req.on('close', () => clearTimeout(t));
      req.write(body);
      req.end();
    });
  }

  /**
   * Legacy: returns true if token is accepted (usable OR rate_limited), false if rejected.
   * Kept for callers that only care about "can we keep this token".
   */
  async validateToken(token) {
    const s = await this.checkTokenStatus(token);
    return s === 'usable' || s === 'rate_limited' || s === 'unknown';
  }

  /**
   * Refresh an expired access token using the refresh token.
   * Returns updated credentials, or null on failure.
   * IMPORTANT: OAuth refresh tokens rotate on use — calling this
   * invalidates the old refresh token. Always save the result.
   */
  async refreshAccessToken(credentials) {
    const result = await this.refreshAccessTokenDetailed(credentials);
    return result.ok ? result.credentials : null;
  }

  /**
   * Refresh the OAuth access token and report the failure kind on errors.
   *
   * Returns one of:
   *   { ok: true, credentials }                     — refresh succeeded
   *   { ok: false, kind: 'no_refresh_token' }       — no refresh_token to use
   *   { ok: false, kind: 'invalid_grant', statusCode, body }
   *                                                  — definitive auth failure
   *                                                    (refresh_token was rotated
   *                                                     elsewhere, account revoked,
   *                                                     etc). Caller may treat this
   *                                                     as a permanent stale state.
   *   { ok: false, kind: 'transient', statusCode?, message }
   *                                                  — network blip, timeout,
   *                                                    5xx, 429, parse error.
   *                                                    Caller MUST NOT mark
   *                                                    state as stale; retry later.
   *
   * IMPORTANT: OAuth refresh tokens rotate on use — calling this
   * invalidates the old refresh token. Always persist the new credentials
   * on success (and treat transient failures as no-op so the old token
   * is preserved for retry).
   */
  async refreshAccessTokenDetailed(credentials) {
    const oauth = credentials?.claudeAiOauth;
    if (!oauth?.refreshToken) return { ok: false, kind: 'no_refresh_token' };

    const { default: https } = await import('https');
    return new Promise((resolve) => {
      const body = JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      });

      const finishTransient = (msg, statusCode) =>
        resolve({ ok: false, kind: 'transient', statusCode, message: msg });

      const req = https.request({
        hostname: 'platform.claude.com',
        path: '/v1/oauth/token',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          const statusCode = res.statusCode;
          if (statusCode === 200) {
            try {
              const resp = JSON.parse(data);
              const updated = { ...credentials, claudeAiOauth: {
                ...oauth,
                accessToken: resp.access_token,
                refreshToken: resp.refresh_token || oauth.refreshToken,
                expiresAt: Date.now() + (resp.expires_in || 3600) * 1000,
              }};
              resolve({ ok: true, credentials: updated });
            } catch (e) {
              finishTransient(`200 but JSON parse failed: ${e.message}`, statusCode);
            }
            return;
          }

          // Distinguish definitive auth failure from transient errors.
          // RFC 6749: invalid_grant is the canonical "this refresh_token
          // is dead" signal. 401 with no body or with other error codes
          // (e.g. invalid_client, unauthorized_client) is also definitive
          // for our purposes since retrying won't recover.
          let body = {};
          try { body = JSON.parse(data); } catch { /* non-JSON body */ }
          const errCode = (body.error || '').toLowerCase();

          if (errCode === 'invalid_grant'
              || errCode === 'invalid_client'
              || errCode === 'unauthorized_client') {
            resolve({ ok: false, kind: 'invalid_grant', statusCode, body });
            return;
          }

          // 4xx without a clear auth-error code: assume definitive
          // (likely a 400 with malformed body, or a 403 we can't
          // recover from). Skip 401 here since some servers return
          // 401 for transient rate-limit; require explicit auth-error
          // body to mark as definitive.
          if (statusCode && statusCode >= 400 && statusCode < 500
              && statusCode !== 401 && statusCode !== 408 && statusCode !== 429) {
            resolve({ ok: false, kind: 'invalid_grant', statusCode, body });
            return;
          }

          // 401 (no body), 408, 429, 5xx, anything else → transient
          finishTransient(
            `HTTP ${statusCode}${errCode ? ` ${errCode}` : ''}`,
            statusCode,
          );
        });
      });
      req.on('error', (e) => finishTransient(`network error: ${e.message}`));
      setTimeout(() => {
        req.destroy();
        finishTransient('refresh request timed out after 10s');
      }, 10000);
      req.write(body);
      req.end();
    });
  }

  readKeychainRaw() {
    if (process.platform !== 'darwin') return null;
    try {
      const result = execSync(
        'security find-generic-password -s "Claude Code-credentials" -a "$(whoami)" -w',
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      if (result) return JSON.parse(result);
    } catch { /* not in keychain */ }
    return null;
  }

  writeCredentialsToKeychain(credentials) {
    // Only called by explicit user actions (switch) that intend to change the active session.
    if (process.platform !== 'darwin') return;

    // Preserve mcpOAuth from the CURRENT keychain entry. MCP OAuth tokens
    // (Linear, Slack, etc.) are per-server, not per-account — they must
    // survive across account switches.
    const existing = this.readKeychainRaw();
    const merged = { ...credentials };
    if (existing?.mcpOAuth) {
      merged.mcpOAuth = existing.mcpOAuth;
    }

    try {
      execSync('security delete-generic-password -s "Claude Code-credentials" -a "$(whoami)" 2>/dev/null', { stdio: 'pipe' });
    } catch { /* didn't exist */ }
    try {
      const json = JSON.stringify(merged);
      execSync(`security add-generic-password -s "Claude Code-credentials" -a "$(whoami)" -w '${json.replace(/'/g, "'\\''")}'`, { stdio: 'pipe' });
    } catch { /* non-fatal */ }
  }

  getCurrentAccount() {
    if (this.isCodexTarget()) {
      return this.getCurrentCodexAccount();
    }

    const credentials = this.readCredentials();
    if (!credentials) {
      throw new Error('No active Claude account found. Please login with claude-code first.');
    }

    if (!fs.existsSync(this.claudeConfigFile)) {
      throw new Error('Claude config file not found. Please login with claude-code first.');
    }

    try {
      const config = JSON.parse(fs.readFileSync(this.claudeConfigFile, 'utf8'));

      if (!config.oauthAccount || !config.oauthAccount.emailAddress) {
        throw new Error('No OAuth account information found in Claude config.');
      }

      return {
        email: config.oauthAccount.emailAddress,
        credentials,
        userId: config.userId,
        oauthAccount: config.oauthAccount
      };
    } catch (error) {
      throw new Error(`Failed to read current account: ${error.message}`);
    }
  }

  getCurrentCodexAccount() {
    const auth = this.readCodexAuth();
    if (!auth) {
      throw new Error('No active Codex account found. Please login with Codex first.');
    }

    const tokenClaims = this.decodeJwtPayload(auth.tokens?.id_token);
    const email = tokenClaims?.email || auth.tokens?.account_id;
    if (!email) {
      throw new Error('No account identity found in Codex auth.json.');
    }

    return {
      email,
      name: tokenClaims?.name || null,
      auth,
      accountId: auth.tokens?.account_id || tokenClaims?.sub || null,
      tokenClaims: tokenClaims ? {
        email: tokenClaims.email || null,
        name: tokenClaims.name || null,
        sub: tokenClaims.sub || null,
        exp: tokenClaims.exp || null,
        iss: tokenClaims.iss || null
      } : null
    };
  }

  createProfileFromCurrentAccount(currentAccount) {
    if (this.isCodexTarget()) {
      return this.createCodexProfileFromAuth(currentAccount.auth, {
        lastUsed: new Date().toISOString()
      });
    }

    const now = new Date().toISOString();
    return {
      provider: 'claude',
      credentials: currentAccount.credentials,
      userId: currentAccount.userId,
      oauthAccount: currentAccount.oauthAccount,
      lastUsed: now,
      // 2026-05-17: snap stamps lastApiSyncAt + clears stale because the snap
      // operation requires fresh credentials — the operator either just
      // logged in, or the auto-snap loop just persisted the live active
      // account. Without these two fields, accounts that go through snap
      // but never independently hit the Usage API stay marked 🔴 stale
      // in `ccrotate when` forever. Same rationale as the testAccount
      // success path which now also clears stale (see checkAndUpdateProfile).
      lastApiSyncAt: now,
      stale: false,
    };
  }

  createCodexProfileFromAuth(auth, overrides = {}) {
    const tokenClaims = this.decodeJwtPayload(auth?.tokens?.id_token);
    return {
      provider: 'codex',
      auth,
      accountId: auth?.tokens?.account_id || tokenClaims?.sub || null,
      name: tokenClaims?.name || overrides.name || null,
      tokenClaims: tokenClaims ? {
        email: tokenClaims.email || null,
        name: tokenClaims.name || null,
        sub: tokenClaims.sub || null,
        exp: tokenClaims.exp || null,
        iss: tokenClaims.iss || null
      } : (overrides.tokenClaims || null),
      lastUsed: overrides.lastUsed || new Date().toISOString()
    };
  }

  writeClaudeFiles(accountData) {
    try {
      if (!accountData.credentials) {
        throw new Error('writeClaudeFiles called with empty credentials');
      }

      // Hold the cross-process active-files lock so concurrent Job pods on
      // the cephfs PVC serialize their credentials+config publishes. See
      // withActiveFilesLock for the lockfile semantics. Inside the lock we
      // also stage both tmp files before either rename — defense in depth:
      // even if a non-locking caller exists somewhere, the rename pair is
      // a single syscall apart.
      this.withActiveFilesLock(() => {
        const currentConfig = fs.existsSync(this.claudeConfigFile)
          ? JSON.parse(fs.readFileSync(this.claudeConfigFile, 'utf8'))
          : {};
        const newConfig = {
          ...currentConfig,
          userId: accountData.userId,
          oauthAccount: accountData.oauthAccount,
        };
        const credsTmp = this.credentialsFile + '.tmp';
        const configTmp = this.claudeConfigFile + '.tmp';
        fs.writeFileSync(credsTmp, JSON.stringify(accountData.credentials, null, 2), 'utf8');
        fs.writeFileSync(configTmp, JSON.stringify(newConfig, null, 2), 'utf8');
        fs.renameSync(credsTmp, this.credentialsFile);
        fs.renameSync(configTmp, this.claudeConfigFile);
      });
    } catch (error) {
      throw new Error(`Failed to write account files: ${error.message}`);
    }
  }

  writeCodexFiles(accountData) {
    try {
      // Same active-files lock the claude path uses — concurrent Job pods
      // calling `ccrotate next --target codex` would otherwise race on the
      // single auth.json publish, and a concurrent snap reading mid-write
      // could still see torn data on filesystems that don't guarantee
      // single-file atomicity (cephfs is generally fine but the lock is
      // cheap insurance + matches the claude path).
      this.withActiveFilesLock(() => {
        this.writeCodexAuth(accountData.auth);
      });
    } catch (error) {
      throw new Error(`Failed to write Codex auth: ${error.message}`);
    }
  }

  writeActiveAccountFiles(accountData) {
    if (this.isCodexTarget()) {
      this.writeCodexFiles(accountData);
      return;
    }

    this.writeClaudeFiles(accountData);
  }

  getProfileExpiry(profile) {
    if (profile?.provider === 'codex' || (this.isCodexTarget() && profile?.auth)) {
      return profile?.tokenClaims?.exp ? profile.tokenClaims.exp * 1000 : null;
    }

    return profile?.credentials?.claudeAiOauth?.expiresAt || null;
  }

  getPostSwitchMessage() {
    if (this.isCodexTarget()) {
      return '  Start a new Codex session if the current process has cached auth.';
    }
    return '  Active session will pick up new credentials automatically.';
  }

  getCodexSessionsRoot(codexHome = this.codexDir) {
    return path.join(codexHome, 'sessions');
  }

  listCodexSessionFiles(codexHome = this.codexDir) {
    const root = this.getCodexSessionsRoot(codexHome);
    if (!fs.existsSync(root)) return [];

    const files = [];
    const stack = [root];

    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const stat = fs.statSync(fullPath);
          files.push({ path: fullPath, mtimeMs: stat.mtimeMs });
        }
      }
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files;
  }

  findCodexSessionFileByThreadId(threadId, codexHome = this.codexDir) {
    if (!threadId) return null;
    return this.listCodexSessionFiles(codexHome).find(file => file.path.includes(threadId)) || null;
  }

  readLatestCodexRateSnapshotFromSessionFile(sessionFile) {
    if (!sessionFile || !fs.existsSync(sessionFile)) return null;

    const lines = fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);
    let fallbackSnapshot = null;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const entry = JSON.parse(lines[index]);
        const rateLimits = entry?.payload?.rate_limits;
        if (entry?.type === 'event_msg' && entry?.payload?.type === 'token_count' && rateLimits) {
          const snapshot = this.normalizeCodexRateSnapshot(rateLimits, entry.timestamp);
          if (snapshot?.primary || snapshot?.secondary) {
            return snapshot;
          }
          fallbackSnapshot ||= snapshot;
        }
      } catch {
        // Ignore malformed lines and keep scanning older entries.
      }
    }

    return fallbackSnapshot;
  }

  normalizeCodexRateSnapshot(rateLimits, timestamp = null) {
    if (!rateLimits) return null;

    const windows = [rateLimits.primary, rateLimits.secondary]
      .filter(Boolean)
      .map(window => ({
        usedPercent: Number(window.used_percent ?? 0),
        windowMinutes: Number(window.window_minutes ?? 0),
        resetsAt: Number(window.resets_at ?? 0) || null
      }))
      .sort((a, b) => a.windowMinutes - b.windowMinutes);

    let shortWindow = windows.find(window => window.windowMinutes === 300) || null;
    let longWindow = windows.find(window => window.windowMinutes === 10080) || null;

    if (!shortWindow && !longWindow && windows.length === 1) {
      const [onlyWindow] = windows;
      if (onlyWindow.windowMinutes <= 300) {
        shortWindow = onlyWindow;
      } else {
        longWindow = onlyWindow;
      }
    }

    if (!shortWindow && !longWindow && windows.length > 0) {
      shortWindow = windows[0];
      longWindow = windows.length > 1 ? windows[windows.length - 1] : null;
    }

    const withRemaining = (window) => {
      if (!window) return null;
      return {
        ...window,
        leftPercent: Math.max(0, Math.round((100 - window.usedPercent) * 10) / 10)
      };
    };

    const primaryWindow = withRemaining(shortWindow);
    const secondaryWindow = withRemaining(longWindow);

    return {
      capturedAt: timestamp || new Date().toISOString(),
      limitId: rateLimits.limit_id || null,
      planType: rateLimits.plan_type || null,
      credits: rateLimits.credits || null,
      primary: primaryWindow,
      secondary: secondaryWindow,
      raw: rateLimits
    };
  }

  getCodexServiceTier(snapshot) {
    const primary = snapshot?.primary;
    const secondary = snapshot?.secondary;

    if (!primary && !secondary) return 'unknown';
    if ((primary && primary.leftPercent <= 0) || (secondary && secondary.leftPercent <= 0)) {
      return 'exhausted';
    }
    if ((primary && primary.leftPercent <= 10) || (secondary && secondary.leftPercent <= 10)) {
      return 'near_limit';
    }
    return 'available';
  }

  isCodexServiceTierSwitchable(serviceTier) {
    // BLO-4474: 'near_limit' (≤10% remaining) is still usable for codex —
    // unlike claude's 7d cap, codex doesn't hard-stop at the threshold, and
    // excluding these accounts starved the pool down to 1 viable account.
    return serviceTier === 'available' || serviceTier === 'near_limit';
  }

  formatCodexReset(epochSeconds, windowMinutes) {
    if (!epochSeconds) return 'unknown';

    const date = new Date(epochSeconds * 1000);
    if (Number.isNaN(date.getTime())) return 'unknown';

    if (windowMinutes === 300) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    }

    return date.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }

  formatCodexWindowLabel(windowMinutes) {
    if (windowMinutes === 300) return '5h';
    if (windowMinutes === 10080) return '7d';
    if (!windowMinutes) return 'usage';
    if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
    if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
    return `${windowMinutes}m`;
  }

  formatCodexUsageSummary(snapshot) {
    const primary = snapshot?.primary;
    const secondary = snapshot?.secondary;

    const parts = [];
    if (primary) {
      parts.push(`${this.formatCodexWindowLabel(primary.windowMinutes)} ${primary.leftPercent}% left (resets ${this.formatCodexReset(primary.resetsAt, primary.windowMinutes)})`);
    }
    if (secondary) {
      parts.push(`${this.formatCodexWindowLabel(secondary.windowMinutes)} ${secondary.leftPercent}% left (resets ${this.formatCodexReset(secondary.resetsAt, secondary.windowMinutes)})`);
    }
    if (parts.length > 0) return parts.join(', ');
    return 'Codex returned no per-account rate-limit data.';
  }

  getCodexProbeModel() {
    try {
      const configFile = path.join(this.codexDir, 'config.toml');
      if (!fs.existsSync(configFile)) return 'gpt-5.4';

      const content = fs.readFileSync(configFile, 'utf8');
      const match = content.match(/^\s*model\s*=\s*"([^"]+)"/m);
      return match?.[1] || 'gpt-5.4';
    } catch {
      return 'gpt-5.4';
    }
  }

  createTempCodexHome(auth) {
    const tempRoot = path.join(this.profilesDir, 'tmp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const tempHome = fs.mkdtempSync(path.join(tempRoot, 'codex-home-'));
    fs.mkdirSync(path.join(tempHome, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(tempHome, 'auth.json'), JSON.stringify(auth, null, 2), 'utf8');
    return tempHome;
  }

  cleanupTempCodexHome(tempCodexHome) {
    try {
      fs.rmSync(tempCodexHome, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100
      });
    } catch {
      // Cleanup failures should not turn a successful quota probe into a failed account.
    }
  }

  waitForCodexSessionSnapshot(threadId, codexHome, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const sessionFile = this.findCodexSessionFileByThreadId(threadId, codexHome)?.path || null;
      const snapshot = sessionFile ? this.readLatestCodexRateSnapshotFromSessionFile(sessionFile) : null;
      if (snapshot) {
        return { sessionFile, snapshot };
      }

      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }

    return { sessionFile: null, snapshot: null };
  }

  isRevokedCodexAuthMessage(message = '') {
    const text = String(message || '').toLowerCase();
    return text.includes('refresh token was already used')
      || text.includes('refresh token has already been used')
      || text.includes('refresh_token_reused')
      || text.includes('token_invalidated')
      || text.includes('token_revoked')
      || text.includes('authentication token has been invalidated')
      || text.includes('your authentication token has been invalidated')
      || text.includes('invalidated oauth token');
  }

  extractCodexErrorMessage(output = '') {
    const lines = String(output || '').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (entry?.type === 'error' && typeof entry.message === 'string') {
          return entry.message;
        }
        if (entry?.type === 'turn.failed' && typeof entry.error?.message === 'string') {
          return entry.error.message;
        }
      } catch {
        // Ignore non-JSON output from Codex stderr/stdout.
      }
    }
    return String(output || '').trim();
  }

  isCodexUsageLimitMessage(message = '') {
    const text = String(message || '').toLowerCase();
    return text.includes('hit your usage limit')
      || text.includes('out of usage')
      || (text.includes('usage limit') && text.includes('try again'))
      || (text.includes('rate limit') && text.includes('try again'));
  }

  parseCodexUsageLimitResetEpoch(message = '', now = new Date()) {
    const text = String(message || '');
    const fullDateMatch = text.match(/try again at\s+([A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM))/i);
    if (fullDateMatch) {
      const normalized = fullDateMatch[1].replace(/(\d{1,2})(st|nd|rd|th)/i, '$1');
      const parsed = new Date(normalized);
      if (!Number.isNaN(parsed.getTime())) return Math.floor(parsed.getTime() / 1000);
    }

    const timeMatch = text.match(/try again at\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
    if (!timeMatch) return null;

    let hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2] || 0);
    const ampm = timeMatch[3].toLowerCase();
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    const reset = new Date(now);
    reset.setHours(hour, minute, 0, 0);
    if (reset <= now) reset.setDate(reset.getDate() + 1);
    return Math.floor(reset.getTime() / 1000);
  }

  createCodexUsageLimitSnapshot(output = '', now = new Date()) {
    const message = this.extractCodexErrorMessage(output);
    if (!this.isCodexUsageLimitMessage(message)) return null;

    const resetEpoch = this.parseCodexUsageLimitResetEpoch(message, now);
    const resetMs = resetEpoch ? resetEpoch * 1000 : null;
    const windowMinutes = resetMs && resetMs - now.getTime() > 6 * 60 * 60 * 1000 ? 10080 : 300;

    return {
      capturedAt: now.toISOString(),
      limitId: 'codex-cli-usage-limit',
      planType: null,
      credits: null,
      primary: {
        usedPercent: 100,
        windowMinutes,
        resetsAt: resetEpoch,
        leftPercent: 0
      },
      secondary: null,
      raw: { message }
    };
  }

  runCodexProbe(auth, prompt = 'Reply with exactly OK.') {
    const tempCodexHome = this.createTempCodexHome(auth);
    const model = this.getCodexProbeModel();

    try {
      const result = spawnSync('codex', [
        'exec',
        '--skip-git-repo-check',
        '--ignore-user-config',
        '-m',
        model,
        '-C',
        os.tmpdir(),
        '--dangerously-bypass-approvals-and-sandbox',
        '--json',
        prompt
      ], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        input: '',
        timeout: 60000,
        env: {
          ...process.env,
          CODEX_HOME: tempCodexHome
        }
      });

      const combinedOutput = [result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n')
        .trim();

      if (result.error) {
        return {
          status: 'error',
          response: result.error.message
        };
      }

      if (result.status !== 0) {
        const usageLimitSnapshot = this.createCodexUsageLimitSnapshot(combinedOutput);
        if (usageLimitSnapshot) {
          return {
            status: 'success',
            snapshot: usageLimitSnapshot,
            sessionFile: null,
            response: this.formatCodexUsageSummary(usageLimitSnapshot)
          };
        }

        return {
          status: 'error',
          response: (combinedOutput || `codex exec exited with code ${result.status}`).trim()
        };
      }

      const threadId = (result.stdout || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find(entry => entry?.type === 'thread.started')
        ?.thread_id || null;

      const { sessionFile, snapshot } = this.waitForCodexSessionSnapshot(threadId, tempCodexHome);

      if (snapshot) {
        return {
          status: 'success',
          snapshot,
          sessionFile,
          response: this.formatCodexUsageSummary(snapshot)
        };
      }

      return {
        status: 'error',
        response: 'Codex probe completed but no rate-limit snapshot was found.'
      };
    } finally {
      this.cleanupTempCodexHome(tempCodexHome);
    }
  }

  /**
   * Async sibling of runCodexProbe. Uses child_process.spawn + Promise
   * instead of spawnSync so the caller's event loop stays free during
   * the probe. Used by ccrotate-serve's freshness-loop (via
   * probeCodexAccountAsync) — sync spawnSync there blocks 3-60s per
   * tick, starving concurrent /v1/messages traffic. The CLI callers
   * (refresh/refresh-one/status/next) still use runCodexProbe — they
   * don't share an event loop with live traffic.
   *
   * Post-processing logic is intentionally duplicated from
   * runCodexProbe (rather than extracted into a shared helper) to
   * keep this PR's blast radius small; a follow-up swaps the
   * subprocess implementation for a direct HTTPS+SSE probe to
   * chatgpt.com/backend-api/codex/responses, at which point the two
   * functions diverge anyway.
   */
  runCodexProbeAsync(auth, prompt = 'Reply with exactly OK.') {
    const tempCodexHome = this.createTempCodexHome(auth);
    const model = this.getCodexProbeModel();

    return new Promise((resolve) => {
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        this.cleanupTempCodexHome(tempCodexHome);
        resolve(value);
      };

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      let child;
      try {
        child = spawn('codex', [
          'exec',
          '--skip-git-repo-check',
          '--ignore-user-config',
          '-m',
          model,
          '-C',
          os.tmpdir(),
          '--dangerously-bypass-approvals-and-sandbox',
          '--json',
          prompt
        ], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            CODEX_HOME: tempCodexHome
          }
        });
      } catch (e) {
        settle({ status: 'error', response: e?.message ?? String(e) });
        return;
      }

      // Close stdin immediately (we have no input to send).
      child.stdin.end();

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch {}
      }, 60000);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });

      child.on('error', (err) => {
        clearTimeout(timer);
        settle({ status: 'error', response: err?.message ?? String(err) });
      });

      child.on('close', (code) => {
        clearTimeout(timer);

        if (timedOut) {
          settle({
            status: 'error',
            response: 'codex exec timed out after 60s'
          });
          return;
        }

        const combinedOutput = [stdout, stderr]
          .filter(Boolean)
          .join('\n')
          .trim();

        if (code !== 0) {
          const usageLimitSnapshot = this.createCodexUsageLimitSnapshot(combinedOutput);
          if (usageLimitSnapshot) {
            settle({
              status: 'success',
              snapshot: usageLimitSnapshot,
              sessionFile: null,
              response: this.formatCodexUsageSummary(usageLimitSnapshot)
            });
            return;
          }

          settle({
            status: 'error',
            response: (combinedOutput || `codex exec exited with code ${code}`).trim()
          });
          return;
        }

        const threadId = (stdout || '')
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean)
          .map(line => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .find(entry => entry?.type === 'thread.started')
          ?.thread_id || null;

        const { sessionFile, snapshot } = this.waitForCodexSessionSnapshot(threadId, tempCodexHome);

        if (snapshot) {
          settle({
            status: 'success',
            snapshot,
            sessionFile,
            response: this.formatCodexUsageSummary(snapshot)
          });
          return;
        }

        settle({
          status: 'error',
          response: 'Codex probe completed but no rate-limit snapshot was found.'
        });
      });
    });
  }

  /**
   * Thin pass-through to `https.request` so unit tests can mock the
   * HTTPS layer at the method boundary instead of trying to spy on
   * the imported module (which doesn't propagate through Node's
   * ESM/CJS interop reliably). Override via vi.spyOn in tests.
   */
  _codexResponsesHttpsRequest(options, callback) {
    return https.request(options, callback);
  }

  /**
   * Parses the `x-codex-*` response-header family from
   * chatgpt.com/backend-api/codex/responses into the rate-limit
   * snapshot shape that `normalizeCodexRateSnapshot` consumes. Same
   * field layout as parse_default_rate_limit() in
   * github.com/openai/codex codex-rs/codex-api/src/rate_limits.rs:
   *   x-codex-primary-used-percent      (float, "12")
   *   x-codex-primary-window-minutes    (int,   "300")
   *   x-codex-primary-reset-at          (int,   "1779461353")
   *   x-codex-secondary-* (mirror)
   *   x-codex-plan-type                 (string, "pro" / "free")
   *   x-codex-limit-name                (string)
   *
   * Returns null when no rate-limit headers are present (e.g.,
   * non-2xx responses, or account variants we haven't seen). Callers
   * should fall back to the subprocess probe in that case.
   *
   * Note: empirically observed 2026-05-22 against ally@blockcast.net
   * (premium / pro plan) — all six rate-limit headers + plan-type
   * arrive with the response head, before any SSE body bytes. The
   * SSE responses-API stream itself does NOT emit a
   * `codex.rate_limits` event; that event is in the WebSocket
   * protocol (responses_websocket.rs in codex-rs).
   */
  _parseCodexRateLimitsFromHeaders(headers) {
    const parseFloatHeader = (name) => {
      const v = headers[name.toLowerCase()];
      if (v === undefined || v === null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const primaryUsed = parseFloatHeader('x-codex-primary-used-percent');
    const secondaryUsed = parseFloatHeader('x-codex-secondary-used-percent');
    if (primaryUsed === null && secondaryUsed === null) return null;
    return {
      primary: primaryUsed !== null ? {
        used_percent: primaryUsed,
        window_minutes: parseFloatHeader('x-codex-primary-window-minutes'),
        resets_at: parseFloatHeader('x-codex-primary-reset-at'),
      } : null,
      secondary: secondaryUsed !== null ? {
        used_percent: secondaryUsed,
        window_minutes: parseFloatHeader('x-codex-secondary-window-minutes'),
        resets_at: parseFloatHeader('x-codex-secondary-reset-at'),
      } : null,
      limit_id: headers['x-codex-limit-name'] || null,
      plan_type: headers['x-codex-plan-type'] || null,
    };
  }

  /**
   * Direct-HTTPS codex rate-limit probe. POSTs a minimal request to
   * chatgpt.com/backend-api/codex/responses, reads the `x-codex-*`
   * response-header family from the response head, and immediately
   * aborts the connection — without consuming the SSE body at all.
   *
   * Cost: ~500ms wall time vs. 3-10s for runCodexProbeAsync
   * (subprocess). Same token cost — the server starts the model
   * before sending response head, so 1 chat completion is billed
   * either way.
   *
   * Returns the same shape runCodexProbeAsync returns:
   *   { status: 'success', snapshot, sessionFile: null, response }
   *   { status: 'error', response }
   *
   * Returns error when (a) auth lacks access_token or account_id,
   * (b) HTTP status is non-2xx, (c) response head lacks
   * `x-codex-*-used-percent` headers (some account variants don't
   * populate them — caller should fall back to subprocess).
   */
  fetchCodexRateLimitsViaHttp(auth) {
    const accessToken = auth?.tokens?.access_token;
    const accountId = auth?.tokens?.account_id;
    if (!accessToken || !accountId) {
      return Promise.resolve({
        status: 'error',
        response: 'codex auth missing access_token or account_id',
      });
    }

    const reqBody = JSON.stringify({
      model: this.getCodexProbeModel(),
      instructions: 'Reply with exactly OK.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'ok' }] }],
      stream: true,
      store: false,
    });

    return new Promise((resolve) => {
      let settled = false;
      let req;

      const settle = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { req?.destroy?.(); } catch {}
        resolve(value);
      };

      // 10s deadline — the live cluster spike landed in ~500ms; this
      // is generous for network blips. The connection is aborted as
      // soon as we've parsed headers, well before the model finishes
      // generating tokens.
      const timer = setTimeout(() => {
        settle({ status: 'error', response: 'codex HTTPS probe timed out after 10s' });
      }, 10000);

      req = this._codexResponsesHttpsRequest(
        {
          hostname: 'chatgpt.com',
          path: '/backend-api/codex/responses',
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + accessToken,
            'chatgpt-account-id': accountId,
            'OpenAI-Beta': 'responses=experimental',
            'Content-Type': 'application/json',
            'User-Agent': 'codex_cli_rs/0.133.0',
            'Originator': 'codex_cli_rs',
            'Accept': 'text/event-stream',
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            let errBody = '';
            res.on('data', (c) => { errBody += c.toString(); });
            res.on('end', () => {
              settle({
                status: 'error',
                response: `codex responses HTTP ${res.statusCode}: ${errBody.slice(0, 200)}`,
              });
            });
            res.on('error', (err) => {
              settle({ status: 'error', response: `HTTPS error: ${err?.message ?? err}` });
            });
            return;
          }

          const headerSnapshot = this._parseCodexRateLimitsFromHeaders(res.headers);
          if (!headerSnapshot) {
            settle({
              status: 'error',
              response: 'codex responses HTTP 200 but no x-codex-*-used-percent headers (likely an unseen account variant)',
            });
            return;
          }

          const snapshot = this.normalizeCodexRateSnapshot({
            primary: headerSnapshot.primary,
            secondary: headerSnapshot.secondary,
            limit_id: headerSnapshot.limit_id || 'codex',
            plan_type: headerSnapshot.plan_type,
            credits: null,
          });
          settle({
            status: 'success',
            snapshot,
            sessionFile: null,
            response: this.formatCodexUsageSummary(snapshot),
          });
        },
      );

      req.on('error', (err) => {
        settle({ status: 'error', response: `HTTPS request error: ${err?.message ?? err}` });
      });

      req.write(reqBody);
      req.end();
    });
  }

  /**
   * Decode the `exp` claim from a codex id_token without verifying signature.
   * Used to short-circuit probes for accounts whose tokens are clearly
   * expired — running a real `codex exec` against an expired token costs
   * ~3s per attempt and leaves the codex CLI's tempdir behind on every
   * failed probe.
   */
  decodeCodexTokenExp(auth) {
    const idToken = auth?.tokens?.id_token;
    if (typeof idToken !== 'string' || !idToken.includes('.')) return null;
    try {
      const part = idToken.split('.')[1];
      const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(part.length + ((4 - (part.length % 4)) % 4), '=');
      const claims = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      return typeof claims.exp === 'number' ? claims.exp : null;
    } catch {
      return null;
    }
  }

  probeCodexAccount(email, accountData, profiles = null) {
    const auth = accountData?.auth || null;
    if (!auth) {
      return {
        status: 'error',
        response: `No saved Codex auth found for ${email}.`
      };
    }

    // Short-circuit: if the id_token is past expiry, the access_token is
    // also dead (OpenAI scopes them to the same window). Mark stale so the
    // ccrotate-auth-bot stale-poller picks the account up for relogin via
    // `codex login --device-auth`. Without this, `executeCodex` runs a
    // full `codex exec` probe that ALSO fails with a 401, but the error
    // message doesn't always match `isRevokedCodexAuthMessage` cleanly
    // (varies by codex CLI version, network, sandbox flag) — and the
    // account stays in rotation, every opencode_k8s pod that lands on
    // it 401s.
    const exp = this.decodeCodexTokenExp(auth);
    const nowSec = Math.floor(Date.now() / 1000);
    if (exp != null && exp <= nowSec) {
      if (profiles?.[email] && profiles[email].stale !== true) {
        profiles[email].stale = true;
        profiles[email].staleAt = new Date().toISOString();
        try {
          this.saveProfiles(profiles);
        } catch {
          // Best effort: even if persistence fails, the in-memory `stale`
          // flag still propagates back to the caller via the error result.
        }
      }
      return {
        status: 'error',
        response: `Codex id_token expired ${Math.round((nowSec - exp) / 60)}m ago — needs reauth via auth-bot or \`codex login --device-auth\`.`,
        stale: true
      };
    }

    const probe = this.runCodexProbe(auth);

    if (probe.status !== 'success') {
      if (this.isRevokedCodexAuthMessage(probe.response)) {
        if (profiles?.[email]) {
          profiles[email].stale = true;
          profiles[email].staleAt = new Date().toISOString();
          this.saveProfiles(profiles);
        }
        return {
          status: 'error',
          response: 'Saved Codex login is stale. Log into this account again and run `ccrotate snap`.',
          stale: true
        };
      }
      return probe;
    }

    const lastApiSyncAt = probe.snapshot?.capturedAt || new Date().toISOString();
    if (profiles?.[email]?.stale) {
      profiles[email].stale = false;
    }
    if (profiles?.[email]) {
      profiles[email].lastApiSyncAt = lastApiSyncAt;
      this.saveProfiles(profiles);
    }

    return {
      status: 'success',
      response: probe.response,
      serviceTier: this.getCodexServiceTier(probe.snapshot),
      lastApiSyncAt,
      rateLimits: {
        utilization5h: probe.snapshot.primary?.usedPercent ?? null,
        utilization7d: probe.snapshot.secondary?.usedPercent ?? null,
        remaining5h: probe.snapshot.primary?.leftPercent ?? null,
        remaining7d: probe.snapshot.secondary?.leftPercent ?? null,
        reset5h: probe.snapshot.primary?.resetsAt ?? null,
        reset7d: probe.snapshot.secondary?.resetsAt ?? null,
        planType: probe.snapshot.planType,
        credits: probe.snapshot.credits,
        snapshotCapturedAt: probe.snapshot.capturedAt
      },
      codexSnapshot: probe.snapshot
    };
  }

  /**
   * Async sibling of probeCodexAccount — same shape, same semantics,
   * but awaits runCodexProbeAsync so the caller's event loop stays
   * free during the probe. Used by ccrotate-serve's freshness-loop
   * for target=codex. probeCodexAccount (sync) stays for CLI callers
   * (refresh/refresh-one/status/next).
   *
   * Implementation note: the body is intentionally a near-clone of
   * probeCodexAccount with `await this.runCodexProbeAsync(auth)`
   * instead of `this.runCodexProbe(auth)`. A follow-up PR swaps the
   * subprocess implementation underneath for a direct HTTPS+SSE
   * probe; at that point we'll likely consolidate by extracting the
   * shared post-processing helper.
   */
  async probeCodexAccountAsync(email, accountData, profiles = null) {
    const auth = accountData?.auth || null;
    if (!auth) {
      return {
        status: 'error',
        response: `No saved Codex auth found for ${email}.`
      };
    }

    // Short-circuit on expired id_token (same fast-fail as the sync
    // variant — see probeCodexAccount for the full rationale).
    const exp = this.decodeCodexTokenExp(auth);
    const nowSec = Math.floor(Date.now() / 1000);
    if (exp != null && exp <= nowSec) {
      if (profiles?.[email] && profiles[email].stale !== true) {
        profiles[email].stale = true;
        profiles[email].staleAt = new Date().toISOString();
        try {
          this.saveProfiles(profiles);
        } catch {
          // Best-effort persistence.
        }
      }
      return {
        status: 'error',
        response: `Codex id_token expired ${Math.round((nowSec - exp) / 60)}m ago — needs reauth via auth-bot or \`codex login --device-auth\`.`,
        stale: true
      };
    }

    // Fast path: direct HTTPS to /backend-api/codex/responses,
    // headers-only. Empirically ~500ms vs ~3-10s for the subprocess.
    // Falls back to runCodexProbeAsync when HTTPS returns error
    // (auth missing, non-2xx response, or response head doesn't
    // include the x-codex-*-used-percent headers — some account
    // variants don't populate them; the subprocess path runs codex
    // CLI which parses richer state via its session JSONL).
    let probe = await this.fetchCodexRateLimitsViaHttp(auth);
    if (probe.status !== 'success') {
      probe = await this.runCodexProbeAsync(auth);
    }

    if (probe.status !== 'success') {
      if (this.isRevokedCodexAuthMessage(probe.response)) {
        if (profiles?.[email]) {
          profiles[email].stale = true;
          profiles[email].staleAt = new Date().toISOString();
          this.saveProfiles(profiles);
        }
        return {
          status: 'error',
          response: 'Saved Codex login is stale. Log into this account again and run `ccrotate snap`.',
          stale: true
        };
      }
      return probe;
    }

    const lastApiSyncAt = probe.snapshot?.capturedAt || new Date().toISOString();
    if (profiles?.[email]?.stale) {
      profiles[email].stale = false;
    }
    if (profiles?.[email]) {
      profiles[email].lastApiSyncAt = lastApiSyncAt;
      this.saveProfiles(profiles);
    }

    return {
      status: 'success',
      response: probe.response,
      serviceTier: this.getCodexServiceTier(probe.snapshot),
      lastApiSyncAt,
      rateLimits: {
        utilization5h: probe.snapshot.primary?.usedPercent ?? null,
        utilization7d: probe.snapshot.secondary?.usedPercent ?? null,
        remaining5h: probe.snapshot.primary?.leftPercent ?? null,
        remaining7d: probe.snapshot.secondary?.leftPercent ?? null,
        reset5h: probe.snapshot.primary?.resetsAt ?? null,
        reset7d: probe.snapshot.secondary?.resetsAt ?? null,
        planType: probe.snapshot.planType,
        credits: probe.snapshot.credits,
        snapshotCapturedAt: probe.snapshot.capturedAt
      },
      codexSnapshot: probe.snapshot
    };
  }

  async snap(force = false, options = {}) {
    return this.commands.snap.execute(force, options);
  }

  async list() {
    return this.commands.list.execute();
  }

  async switch(email, options = {}) {
    return this.commands.switch.execute(email, options);
  }

  async next(options = {}) {
    return this.commands.next.execute(options);
  }

  async launch(target, options = {}) {
    return this.commands.launch.execute(target, options);
  }

  async relaunchCurrentSession() {
    return this.launch(this.target, { skipRotate: true });
  }

  async remove(email) {
    return this.commands.remove.execute(email);
  }

  backupCurrentCredentials() {
    if (this.isCodexTarget()) {
      const backup = { auth: null };

      try {
        if (fs.existsSync(this.codexAuthFile)) {
          backup.auth = fs.readFileSync(this.codexAuthFile, 'utf8');
        }
      } catch (error) {
        throw new Error(`Failed to backup current credentials: ${error.message}`);
      }

      return backup;
    }

    const backup = {
      credentials: null,
      config: null
    };

    try {
      if (fs.existsSync(this.credentialsFile)) {
        backup.credentials = fs.readFileSync(this.credentialsFile, 'utf8');
      }
      if (fs.existsSync(this.claudeConfigFile)) {
        backup.config = fs.readFileSync(this.claudeConfigFile, 'utf8');
      }
    } catch (error) {
      throw new Error(`Failed to backup current credentials: ${error.message}`);
    }

    return backup;
  }

  restoreCredentials(backup) {
    if (this.isCodexTarget()) {
      try {
        if (backup.auth && fs.existsSync(this.codexAuthFile)) {
          fs.writeFileSync(this.codexAuthFile, backup.auth, 'utf8');
        }
      } catch (error) {
        throw new Error(`Failed to restore credentials: ${error.message}`);
      }
      return;
    }

    try {
      if (backup.credentials && fs.existsSync(this.credentialsFile)) {
        fs.writeFileSync(this.credentialsFile, backup.credentials, 'utf8');
      }
      if (backup.config && fs.existsSync(this.claudeConfigFile)) {
        fs.writeFileSync(this.claudeConfigFile, backup.config, 'utf8');
      }
    } catch (error) {
      throw new Error(`Failed to restore credentials: ${error.message}`);
    }
  }

  /** Clear ALL usage API cooldown cache entries (active + expired). Use sparingly:
   * if the Usage API asked this token to retry later, clearing the cache will
   * just re-trigger 429s on the next refresh cycle. Prefer clearExpiredCooldowns. */
  clearCooldowns() {
    const cacheFile = path.join(this.profilesDir, 'usage-api-cooldowns.json');
    try { fs.unlinkSync(cacheFile); } catch { /* didn't exist */ }
  }

  /** Clear only EXPIRED cooldown entries, preserving active ones. Used by the
   * periodic refresh path so we honor Anthropic's retry-after window instead of
   * re-hammering the Usage API and re-triggering avoidable 429s. */
  clearExpiredCooldowns() {
    const cacheFile = path.join(this.profilesDir, 'usage-api-cooldowns.json');
    let cooldowns = {};
    try { cooldowns = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { return; }
    const now = Date.now();
    const kept = Object.fromEntries(Object.entries(cooldowns).filter(([, until]) => until > now));
    if (Object.keys(kept).length === 0) {
      try { fs.unlinkSync(cacheFile); } catch { /* fine */ }
    } else if (Object.keys(kept).length !== Object.keys(cooldowns).length) {
      try { fs.writeFileSync(cacheFile, JSON.stringify(kept)); } catch { /* fine */ }
    }
  }

  /**
   * Fetch per-account usage via /api/oauth/usage.
   * Rate-limited to ~1 call/hour per token. Caches 429s to avoid
   * retriggering cooldowns on every refresh.
   */
  async fetchAccountUsage(token) {
    // Check if this token is on cooldown
    const cacheFile = path.join(this.profilesDir, 'usage-api-cooldowns.json');
    let cooldowns = {};
    try { cooldowns = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}

    // Use hash of token as cache key (tokens in same org can share suffixes)
    const { createHash } = await import('crypto');
    const tokenKey = createHash('sha256').update(token).digest('hex').slice(0, 16);
    const cooldownUntil = cooldowns[tokenKey];
    if (cooldownUntil && Date.now() < cooldownUntil) {
      // On cooldown — serve last-known-good rather than dropping to "unknown".
      const lkg = usageLkgCache.get(tokenKey);
      return lkg ? { ...lkg, __stale: true } : null;
    }

    const { default: https } = await import('https');
    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/api/oauth/usage',
        method: 'GET',
        headers: {
          'Authorization': 'Bearer ' + token,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'claude-code/1.0.38',
          'x-app': 'cli'
        }
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode === 429) {
            // Cache cooldown: retry-after header or default 1 hour
            const retryAfter = parseInt(res.headers['retry-after'] || '3600', 10);
            cooldowns[tokenKey] = Date.now() + (retryAfter > 0 ? retryAfter : 3600) * 1000;
            try { fs.writeFileSync(cacheFile, JSON.stringify(cooldowns)); } catch {}
            // Serve last-known-good for this token instead of nothing.
            const lkg = usageLkgCache.get(tokenKey);
            resolve(lkg ? { ...lkg, __stale: true } : null);
            return;
          }
          if (res.statusCode !== 200) { resolve(null); return; }
          // Success — clear cooldown and refresh the last-known-good cache.
          delete cooldowns[tokenKey];
          try { fs.writeFileSync(cacheFile, JSON.stringify(cooldowns)); } catch {}
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { parsed = null; }
          if (parsed) usageLkgCache.set(tokenKey, parsed);
          resolve(parsed);
        });
      });
      req.on('error', () => resolve(null));
      const t = setTimeout(() => { req.destroy(); resolve(null); }, 8000);
      req.on('close', () => clearTimeout(t));
      req.end();
    });
  }

  /** Parse /api/oauth/usage response into standard result format. */
  parseUsageResult(usageData) {
    const u7d = toPercent(usageData.seven_day?.utilization);
    const u5h = toPercent(usageData.five_hour?.utilization);
    const extra = usageData.extra_usage || {};
    const reset5hIso = usageData.five_hour?.resets_at;
    const reset7dIso = usageData.seven_day?.resets_at;
    const reset5h = reset5hIso ? Math.floor(new Date(reset5hIso).getTime() / 1000) : null;
    const reset7d = reset7dIso ? Math.floor(new Date(reset7dIso).getTime() / 1000) : null;
    const usedCredits = extra.used_credits || 0;
    const monthlyLimit = extra.monthly_limit || 0;

    // 2026-05-20 classification fix (B11): "extra" tier means the seat is
    // ACTIVELY OPERATING in overage mode (base allotment depleted, extras
    // budget being consumed). Pre-fix, any seat with `extra.is_enabled =
    // true` AND any positive `used_credits` got labeled `extra` — but
    // `is_enabled` is the org capability flag (does the org allow overage
    // billing at all?), not a per-seat overage-active signal. A Team
    // seat in Blockcast org showed `is_enabled: true, monthly_limit: 0,
    // used_credits: 16` (16¢ of accumulated metered usage from some prior
    // window) and got labeled `extra` even though Anthropic's user-facing
    // UI clearly showed it as plain base Team usage.
    //
    // Correct signal: `monthly_limit > 0` means the seat has a positive
    // overage budget configured AND `used_credits > 0` means some has
    // been spent. Both required for "actively in extras mode". With
    // `monthly_limit: 0` the seat literally CAN'T consume overage even
    // if is_enabled is flipped on at the org level.
    let effectiveTier = 'base';
    if (u7d != null && u7d >= 100) effectiveTier = 'exhausted';
    else if (extra.is_enabled && monthlyLimit > 0 && usedCredits > 0) effectiveTier = 'extra';

    const parts = [];
    if (u5h != null) parts.push(`5h:${Math.round(u5h)}%`);
    if (u7d != null) parts.push(`7d:${Math.round(u7d)}%`);
    if (usedCredits > 0) parts.push(`extra:$${(usedCredits / 100).toFixed(2)}`);
    // `__stale` is set when fetchAccountUsage served a last-known-good
    // response because the token's Usage API is on cooldown.
    const stale = usageData.__stale === true;
    const display = effectiveTier
      + (parts.length ? ` (${parts.join(' ')})` : '')
      + (stale ? ' (cached)' : '');

    return {
      status: 'success',
      response: display,
      serviceTier: effectiveTier,
      ...(stale ? { stale: true } : {}),
      rateLimits: {
        utilization5h: u5h,
        utilization7d: u7d,
        reset5h,
        reset7d,
        resetAt: reset7dIso, // backwards compat
        extra
      },
    };
  }

  /**
   * Test account via /v1/messages headers (org-level, always available).
   * Uses max_tokens:1 Haiku call — ~2s, minimal cost.
   */
  async testAccountViaMessages(token) {
    const { default: https } = await import('https');
    return new Promise((resolve) => {
      const body = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'x' }]
      });

      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': token,
          'anthropic-version': '2023-06-01',
          'x-app': 'cli'
        }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          const h = res.headers;
          // Note: utilization headers are fractions (0.0–1.0), convert to percentage
          const raw5h = h['anthropic-ratelimit-unified-5h-utilization'] ? parseFloat(h['anthropic-ratelimit-unified-5h-utilization']) : null;
          const raw7d = h['anthropic-ratelimit-unified-7d-utilization'] ? parseFloat(h['anthropic-ratelimit-unified-7d-utilization']) : null;
          const rateLimits = {
            status: h['anthropic-ratelimit-unified-status'] || null,
            utilization5h: raw5h != null ? Math.round(raw5h * 100) : null,
            utilization7d: raw7d != null ? Math.round(raw7d * 100) : null,
            reset5h: h['anthropic-ratelimit-unified-5h-reset'] ? Number(h['anthropic-ratelimit-unified-5h-reset']) : null,
            reset7d: h['anthropic-ratelimit-unified-7d-reset'] ? Number(h['anthropic-ratelimit-unified-7d-reset']) : null,
            overageInUse: h['anthropic-ratelimit-unified-overage-in-use'] === 'true',
            overageStatus: h['anthropic-ratelimit-unified-overage-status'] || null,
          };

          let effectiveTier = 'base';
          if (rateLimits.overageInUse) {
            effectiveTier = 'extra';
          } else if (rateLimits.utilization7d >= 100) {
            effectiveTier = 'exhausted';
          } else if (rateLimits.status === 'rejected') {
            // 'rejected' status alone is NOT enough to classify exhausted.
            // Anthropic returns rejected for several non-cap conditions:
            //   - overage credits exhausted (account still usable on base tier)
            //   - transient concurrent-request limit
            //   - request shape / content rejected
            // Only treat as exhausted when one of the rolling windows is
            // actually at the cap. Without this guard, accounts that had
            // a momentary overage-credits-out moment get parked for the
            // entire 5h/7d window despite low real utilization. Seen in
            // prod: ramadan@blockcast.net classified exhausted at
            // 5h:6% 7d:1% (2026-05-13).
            const u5h = rateLimits.utilization5h;
            const u7d = rateLimits.utilization7d;
            if ((u5h != null && u5h >= 95) || (u7d != null && u7d >= 95)) {
              effectiveTier = 'exhausted';
            }
            // Otherwise leave as 'base' (account is still usable).
          }

          // Format reset countdown
          const now = Date.now() / 1000;
          const fmtReset = (epoch) => {
            if (!epoch) return null;
            const d = epoch - now;
            if (d <= 0) return 'now';
            const m = Math.floor(d / 60);
            if (m < 60) return `${m}m`;
            const hr = Math.floor(m / 60);
            const rm = m % 60;
            return rm > 0 ? `${hr}h${rm}m` : `${hr}h`;
          };

          if (res.statusCode === 429) {
            let errorMsg = 'Rate limited';
            try { errorMsg = JSON.parse(data)?.error?.message || errorMsg; } catch {}
            resolve({ status: 'error', response: errorMsg.substring(0, 150), serviceTier: effectiveTier, rateLimits });
            return;
          }

          try {
            JSON.parse(data); // validate response
            const pct5h = rateLimits.utilization5h;
            const pct7d = rateLimits.utilization7d;
            const parts = [];
            if (pct5h != null) {
              let s = `5h:${pct5h}%`;
              if (pct5h >= 90) { const r = fmtReset(rateLimits.reset5h); if (r) s += `→${r}`; }
              parts.push(s);
            }
            if (pct7d != null) {
              let s = `7d:${pct7d}%`;
              if (pct7d >= 90) { const r = fmtReset(rateLimits.reset7d); if (r) s += `→${r}`; }
              parts.push(s);
            }
            const display = effectiveTier + ' [org]' + (parts.length ? ` (${parts.join(' ')})` : '');

            resolve({ status: 'success', response: display, serviceTier: effectiveTier, rateLimits });
          } catch {
            resolve({ status: 'error', response: `HTTP ${res.statusCode}`, serviceTier: null, rateLimits });
          }
        });
      });

      req.on('error', (e) => {
        resolve({ status: 'error', response: e.message.substring(0, 150), serviceTier: null });
      });

      const timeout = setTimeout(() => {
        req.destroy();
        resolve({ status: 'error', response: 'Timeout after 10s', serviceTier: null });
      }, 10000);

      req.on('close', () => clearTimeout(timeout));
      req.write(body);
      req.end();
    });
  }

  /**
   * Test one account. Tries /api/oauth/usage if usageApiAvailable is true,
   * otherwise goes straight to /v1/messages fallback.
   * Returns { status, response, serviceTier, rateLimits, credentialsUpdated, usageApiWorked }
   */
  /**
   * Resolve which Anthropic identity the LIVE access token in
   * ~/.claude/.credentials.json actually belongs to. Used by SnapCommand
   * as the cross-write guard — confirms the credential we're about to
   * save matches the email key we're saving it under.
   *
   * Strategy change (2026-05-19): the previous implementation shelled
   * `claude auth status --json` and read its `email` field. Claude CLI
   * ≥2.x emits `email: null` in that JSON (the CLI no longer queries
   * Anthropic for the identity in `auth status`). With email always
   * null, SnapCommand's "null skips the check" fallback silently
   * disabled the guard, and ~9 of 15 profiles in the production
   * paperclip pool ended up holding tokens for the wrong identity.
   *
   * The fix probes Anthropic's `/api/oauth/profile` directly with the
   * live access token. That endpoint requires the `user:profile`
   * OAuth scope (already in every ccrotate-managed token) and returns
   * `{account: {email, uuid, full_name, ...}}` — the authoritative
   * identity for the bearer.
   *
   * Returns the live session email, or null when it can't be
   * determined (no credentials file, no access token, network /
   * timeout failure, 4xx response, malformed body). Null still
   * routes to the "skipped" path in SnapCommand for back-compat with
   * environments that don't have the credentials file (tests).
   */
  async readLiveClaudeAuthEmail() {
    try {
      const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
      let creds;
      try { creds = JSON.parse(fs.readFileSync(credsPath, 'utf8')); } catch { return null; }
      const accessToken = creds?.claudeAiOauth?.accessToken;
      if (typeof accessToken !== 'string' || !accessToken) return null;
      return await this._fetchOauthProfileEmail(accessToken);
    } catch {
      return null;
    }
  }

  /** Probe /api/oauth/profile with the given bearer. Exposed as its own
   * method so tests can stub the network without monkey-patching fs. */
  _extractOauthProfileEmail(parsed) {
    const email =
      parsed?.email ??
      parsed?.email_address ??
      parsed?.account?.email ??
      parsed?.account?.email_address;
    return typeof email === 'string' && email ? email : null;
  }

  async _fetchOauthProfileEmail(accessToken, { timeoutMs = 8000 } = {}) {
    const { default: https } = await import('https');
    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/api/oauth/profile',
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'claude-code/1.0.38',
          'x-app': 'cli',
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) { resolve(null); return; }
          let parsed;
          try { parsed = JSON.parse(data); } catch { resolve(null); return; }
          resolve(this._extractOauthProfileEmail(parsed));
        });
      });
      req.on('error', () => resolve(null));
      const timer = setTimeout(() => { req.destroy(); resolve(null); }, timeoutMs);
      req.on('close', () => clearTimeout(timer));
      req.end();
    });
  }

  async testAccount(email, { tryUsageApi = true, usageApiOnly = false, token: explicitToken } = {}) {
    try {
      const token = explicitToken || this.readCredentials()?.claudeAiOauth?.accessToken;

      if (!token) {
        return { status: 'error', response: 'No access token', serviceTier: null, credentialsUpdated: false, usageApiWorked: false };
      }

      // Always try per-account usage API first (per-token 1hr cooldown)
      if (tryUsageApi) {
        const usageData = await this.fetchAccountUsage(token);
        if (usageData) {
          const result = this.parseUsageResult(usageData);
          const lastApiSyncAt = new Date().toISOString();
          const credentialsUpdated = this.checkAndUpdateProfile(email, lastApiSyncAt);
          return { ...result, credentialsUpdated, usageApiWorked: true, lastApiSyncAt };
        }
      }

      // usageApiOnly: skip /v1/messages fallback (used by `next` to avoid burning tokens)
      if (usageApiOnly) {
        return { status: 'unknown', response: 'Usage API unavailable', serviceTier: null, credentialsUpdated: false, usageApiWorked: false };
      }

      // CLI-driven /usage fallback — valid only for the currently-active
      // account, since the `claude` /usage panel reflects whatever ~/.claude
      // points at (it does not switch profiles). Unlike the org-scoped
      // /v1/messages headers below, this yields real per-account windows.
      try {
        const activeEmail = this.getCurrentAccount()?.email ?? null;
        if (activeEmail && activeEmail === email) {
          const { fetchClaudeCliUsageResult } = await import('./claude-cli-usage.js');
          const result = await fetchClaudeCliUsageResult(email);
          const lastApiSyncAt = new Date().toISOString();
          const credentialsUpdated = this.checkAndUpdateProfile(email, lastApiSyncAt);
          return { ...result, credentialsUpdated, usageApiWorked: false, lastApiSyncAt };
        }
      } catch {
        // No active session, or the CLI probe failed — fall through to the
        // existing /v1/messages path / unknown.
      }

      // Skip /v1/messages fallback unless we already know this account is in
      // extra/overage mode. The fallback returns Anthropic's
      // anthropic-ratelimit-unified-* headers, which are org-scoped — every
      // seat in the same org gets identical numbers. Showing those as if
      // they were per-seat made multiple sibling accounts look like dupes
      // and led to bad rotation decisions. Only when extra_usage is enabled
      // for this account does the org-level overage signal carry useful
      // per-account information (overageInUse / overageStatus). Otherwise
      // we'd rather surface "unknown" than misleading shared utilization.
      if (!this.cachedExtraUsageEnabled(email)) {
        return { status: 'unknown', response: 'Usage API on cooldown — shared fallback skipped (no extra usage)', serviceTier: null, credentialsUpdated: false, usageApiWorked: false };
      }

      // Fallback: /v1/messages (org-level) — only reached when this account
      // is in extra/overage mode and the per-seat /api/oauth/usage endpoint
      // is on cooldown.
      const result = await this.testAccountViaMessages(token);
      const lastApiSyncAt = new Date().toISOString();
      const credentialsUpdated = this.checkAndUpdateProfile(email, lastApiSyncAt);
      return { ...result, credentialsUpdated, usageApiWorked: false, lastApiSyncAt };

    } catch (error) {
      return { status: 'error', response: error.message.substring(0, 150), serviceTier: null, credentialsUpdated: false, usageApiWorked: false };
    }
  }

  checkAndUpdateProfile(email, lastApiSyncAt = null) {
    if (!this.isClaudeTarget()) {
      return false;
    }

    try {
      const profiles = this.loadProfiles();
      if (!profiles[email]) {
        return false;
      }

      // Get current credentials from Claude files
      const currentCredentials = JSON.parse(fs.readFileSync(this.credentialsFile, 'utf8'));
      const currentConfig = JSON.parse(fs.readFileSync(this.claudeConfigFile, 'utf8'));

      const storedProfile = profiles[email];
      const syncAt = lastApiSyncAt || new Date().toISOString();

      // Hard guard: refuse to copy active-session credentials into a profile
      // labeled with a different account. testAccount/probe loops write a
      // candidate's credentials to disk, call the API, and then call this
      // function — but on parallel/error paths the active credentials may
      // belong to a different label. Without this check, the wrong creds
      // get persisted under this email's profile, fusing two distinct
      // Anthropic accounts into one ccrotate label and producing duplicate
      // accountUuid rows that confuse `ccrotate when` / pool views.
      const activeAccountUuid = currentConfig?.oauthAccount?.accountUuid || null;
      const storedAccountUuid = storedProfile?.oauthAccount?.accountUuid || null;
      if (storedAccountUuid && activeAccountUuid && storedAccountUuid !== activeAccountUuid) {
        // Active session is for a different Anthropic account — don't
        // overwrite this profile with it. Still record syncAt so
        // refresh-one round-robin doesn't keep retargeting this email.
        profiles[email] = { ...storedProfile, lastApiSyncAt: syncAt };
        this.saveProfiles(profiles);
        return false;
      }

      // Compare credentials to check for updates
      const credentialsChanged = JSON.stringify(storedProfile.credentials) !== JSON.stringify(currentCredentials);
      const configChanged = JSON.stringify(storedProfile.oauthAccount) !== JSON.stringify(currentConfig.oauthAccount) ||
                           storedProfile.userId !== currentConfig.userId;

      profiles[email] = {
        ...storedProfile,
        ...(credentialsChanged || configChanged ? {
          credentials: currentCredentials,
          userId: currentConfig.userId,
          oauthAccount: currentConfig.oauthAccount,
          lastUsed: syncAt
        } : {}),
        lastApiSyncAt: syncAt,
        // 2026-05-17: clear stale flag — successful Usage API sync proves
        // the account is healthy. Codex's runCodexProbe at line 1437
        // already does this for codex profiles; the Claude path was missing
        // the equivalent clear, so accounts marked stale by switch/repair
        // (or earlier codex-only paths) never came back even after a clean
        // probe. Only write the field when it was actually set to avoid
        // bloating profiles.json for accounts that never had it.
        ...(storedProfile.stale ? { stale: false } : {}),
      };

      this.saveProfiles(profiles);
      if (credentialsChanged || configChanged) {
        return true;
      }

      return false;
    } catch (error) {
      console.error(`Error checking profile update for ${email}:`, error.message);
      return false;
    }
  }

  async refresh() {
    return this.commands.refresh.execute();
  }

  async refreshOne() {
    // refresh-one now supports both targets — RefreshOneCommand.execute
    // dispatches to executeCodex when target=codex (probes one codex account
    // via probeCodexAccount + upsertTierCacheEntries). Pre-fix this errored
    // on codex active runs ("refresh-one is only available in Claude Code
    // mode") and any postRunCmd wired to `ccrotate --target codex
    // refresh-one` produced stderr noise on every codex postRun.
    return this.commands.refreshOne.execute();
  }

  async when() {
    return this.commands.when.execute();
  }

  async repair() {
    this.ensureClaudeFeature('repair');
    return this.commands.repair.execute();
  }

  async export() {
    return this.commands.export.execute();
  }

  async import(compressedData, options = {}) {
    return this.commands.import.execute(compressedData, options);
  }

  async status(options = {}) {
    return this.commands.status.execute(options);
  }

  async serve(options = {}) {
    return this.commands.serve.execute(options);
  }

  async stateServer(options = {}) {
    return this.commands.stateServer.execute(options);
  }
}

export default CCRotate;
