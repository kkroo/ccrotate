#!/usr/bin/env node
// Installs Claude Code slash commands, hooks, and CLAUDE.md snippet
import fs from 'fs';
import path from 'path';
import os from 'os';

const home = os.homedir();
const claudeDir = path.join(home, '.claude');
const baseDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

// 1. Slash commands → ~/.claude/commands/
const commandsSrc = path.join(baseDir, 'claude-commands');
const commandsDest = path.join(claudeDir, 'commands');
if (fs.existsSync(commandsSrc)) {
  try {
    fs.mkdirSync(commandsDest, { recursive: true });
    for (const file of fs.readdirSync(commandsSrc).filter(f => f.endsWith('.md'))) {
      const dest = path.join(commandsDest, file);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(path.join(commandsSrc, file), dest);
        console.log(`  ✓ Installed /ccrotate ${file.replace('.md', '').replace('ccrotate-', '')}`);
      }
    }
  } catch (e) {
    console.log(`  Note: Could not install slash commands: ${e.message}`);
  }
}

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

// 3. CLAUDE.md snippet — append if marker not already present
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
