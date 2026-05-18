#!/usr/bin/env node
// Installs Claude Code slash commands, hooks, and CLAUDE.md snippet
import fs from 'fs';
import path from 'path';
import os from 'os';

const home = os.homedir();
const claudeDir = path.join(home, '.claude');
const baseDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

// 1. Slash commands are now distributed exclusively via the Claude Code
//    plugin at claude-plugin/commands/ (loaded under the `/ccrotate:` namespace
//    by Claude Code's marketplace system). The legacy `claude-commands/`
//    install path produced long-named commands like `/ccrotate:ccrotate-when`
//    that duplicated the plugin surface — removed.

// 2. Hooks → ~/.claude/hooks/
const hooksSrc = path.join(baseDir, 'claude-hooks');
const hooksDest = path.join(claudeDir, 'hooks');
if (fs.existsSync(hooksSrc)) {
  try {
    fs.mkdirSync(hooksDest, { recursive: true });
    for (const file of fs.readdirSync(hooksSrc).filter(f => f.endsWith('.sh'))) {
      const dest = path.join(hooksDest, file);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(path.join(hooksSrc, file), dest);
        fs.chmodSync(dest, 0o755);
        console.log(`  ✓ Installed hook ${file}`);
      }
    }
  } catch (e) {
    console.log(`  Note: Could not install hooks: ${e.message}`);
  }
}

// 3. Register hooks in settings.json
const settingsFile = path.join(claudeDir, 'settings.json');
try {
  const settings = fs.existsSync(settingsFile)
    ? JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    : {};
  if (!settings.hooks) settings.hooks = {};

  const stopHook = {
    hooks: [{
      type: 'command',
      command: `bash ${path.join(claudeDir, 'hooks', 'ccrotate-on-limit.sh')}`,
      timeout: 15,
      statusMessage: 'Checking rate limits...'
    }]
  };
  const sessionStartHook = {
    hooks: [{
      type: 'command',
      command: `bash ${path.join(claudeDir, 'hooks', 'ccrotate-check-tier.sh')}`,
      timeout: 45,
      statusMessage: 'Checking usage tier...'
    }]
  };

  const preemptiveHook = {
    hooks: [{
      type: 'command',
      command: `bash ${path.join(claudeDir, 'hooks', 'ccrotate-preemptive.sh')}`,
      timeout: 10,
      statusMessage: 'ccrotate check...'
    }]
  };

  const hasStopHook = (settings.hooks.Stop || []).some(h =>
    h.hooks?.some(hh => hh.command?.includes('ccrotate'))
  );
  const hasSessionHook = (settings.hooks.SessionStart || []).some(h =>
    h.hooks?.some(hh => hh.command?.includes('ccrotate'))
  );
  const hasPreemptiveHook = (settings.hooks.UserPromptSubmit || []).some(h =>
    h.hooks?.some(hh => hh.command?.includes('ccrotate-preemptive'))
  );

  let changed = false;
  if (!hasStopHook) {
    if (!settings.hooks.Stop) settings.hooks.Stop = [];
    settings.hooks.Stop.push(stopHook);
    console.log('  ✓ Registered ccrotate Stop hook in settings.json');
    changed = true;
  }
  if (!hasSessionHook) {
    if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
    settings.hooks.SessionStart.push(sessionStartHook);
    console.log('  ✓ Registered ccrotate SessionStart hook in settings.json');
    changed = true;
  }
  if (!hasPreemptiveHook) {
    if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
    settings.hooks.UserPromptSubmit.push(preemptiveHook);
    console.log('  ✓ Registered ccrotate UserPromptSubmit hook in settings.json');
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
  }
} catch (e) {
  console.log(`  Note: Could not update settings.json: ${e.message}`);
}

// 4. CLAUDE.md snippet — append if marker not already present
const snippetFile = path.join(hooksSrc, 'CLAUDE.md.snippet');
const claudeMd = path.join(claudeDir, 'CLAUDE.md');
if (fs.existsSync(snippetFile)) {
  try {
    const snippet = fs.readFileSync(snippetFile, 'utf8');
    const existing = fs.existsSync(claudeMd) ? fs.readFileSync(claudeMd, 'utf8') : '';

    if (existing.includes('CCROTATE:START')) {
      // Replace existing section between markers
      const updated = existing.replace(
        /<!-- CCROTATE:START -->[\s\S]*?<!-- CCROTATE:END -->/,
        snippet.trim()
      );
      fs.writeFileSync(claudeMd, updated);
      console.log('  ✓ Updated ccrotate section in ~/.claude/CLAUDE.md');
    } else {
      // Append new section
      fs.appendFileSync(claudeMd, snippet);
      console.log('  ✓ Added ccrotate auto-rotate instructions to ~/.claude/CLAUDE.md');
    }
  } catch (e) {
    console.log(`  Note: Could not update CLAUDE.md: ${e.message}`);
  }
}
