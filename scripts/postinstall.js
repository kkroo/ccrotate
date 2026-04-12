#!/usr/bin/env node
// Copies Claude Code slash commands to ~/.claude/commands/
import fs from 'fs';
import path from 'path';
import os from 'os';

const commandsDir = path.join(os.homedir(), '.claude', 'commands');
const sourceDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'claude-commands');

if (!fs.existsSync(sourceDir)) process.exit(0);

try {
  fs.mkdirSync(commandsDir, { recursive: true });

  const files = fs.readdirSync(sourceDir).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const dest = path.join(commandsDir, file);
    // Don't overwrite user customizations
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(path.join(sourceDir, file), dest);
      console.log(`  ✓ Installed /ccrotate ${file.replace('.md', '').replace('ccrotate-', '')}`);
    }
  }
} catch (e) {
  // Non-fatal — slash commands are optional
  console.log(`  Note: Could not install slash commands: ${e.message}`);
}
