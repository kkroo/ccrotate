#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import CCRotate from '../lib/ccrotate.js';
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const version = process.env.CCROTATE_VERSION || packageJson.version || '0.0.0';

const program = new Command();
const ccrotate = new CCRotate();

program
  .name('ccrotate')
  .description('A CLI tool to manage and rotate multiple Claude Code or Codex accounts')
  .version(version, '-v, --version', 'output the version number')
  .option('--target <target>', "Force target ('claude' or 'codex'); overrides auto-detection and CCROTATE_TARGET");

// Apply --target before any subcommand runs so commands like `switch`/`next`
// pick up the right profiles and tier-cache files. Without this, a top-level
// flag would only land after CCRotate has already chosen a target in the constructor.
program.hook('preAction', (thisCmd) => {
  const explicit = thisCmd.opts().target;
  if (!explicit) return;
  try {
    ccrotate.setTarget(explicit);
  } catch (error) {
    console.error(chalk.red(`Error: ${error.message}`));
    process.exit(1);
  }
});

program
  .command('snap')
  .description('Save current account information')
  .option('--force', 'Skip confirmation prompt when overwriting existing account')
  .action(async (options) => {
    try {
      await ccrotate.snap(options.force);
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('list')
  .alias('ls')
  .description('Show saved accounts')
  .action(async () => {
    try {
      await ccrotate.list();
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('switch <email>')
  .description('Switch to specific account')
  .option('--relaunch', 'After switching, start a fresh session so the new auth is picked up')
  .option('--no-refresh', "Skip the implicit token refresh on switch: leave the target's credentials untouched even if the access_token is expired. Useful when the operator wants a true read-only pointer flip and doesn't want to risk a refresh_token desync (the most fragile failure mode — single-use refresh tokens that fail to refresh leave the account marked stale).")
  .action(async (email, options) => {
    try {
      // commander treats --no-refresh as `options.refresh === false`
      await ccrotate.switch(email, {
        relaunch: options.relaunch,
        noRefresh: options.refresh === false,
      });
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('next')
  .description('Rotate to the next account (smart tier-aware in Claude Code)')
  .option('-y, --yes', 'Auto-allow extra usage if no standard accounts')
  .option('--deny', 'Never use extra usage, wait for reset instead')
  .option('--wait', 'Switch to earliest-reset account and output reset epoch (for auto-resume)')
  .option('--relaunch', 'After switching, start a fresh session so the new auth is picked up')
  .action(async (options) => {
    try {
      await ccrotate.next({ yes: options.yes, deny: options.deny, wait: options.wait, relaunch: options.relaunch });
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('launch [target]')
  .description('Rotate to a fresh account, then exec `claude` or `codex` so the new session reads new auth')
  .option('--no-rotate', 'Skip rotation, just exec the target binary')
  .option('--deny', 'During rotation, never auto-accept extra usage')
  .allowUnknownOption(true)
  .action(async (target, options, command) => {
    // Forward any args after `--` (or unknown options) to the launched binary.
    const passThrough = command.args.slice(target ? 1 : 0);
    try {
      await ccrotate.launch(target, {
        skipRotate: options.rotate === false,
        deny: !!options.deny,
        passThrough,
      });
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('remove <email>')
  .alias('rm')
  .description('Remove saved account')
  .action(async (email) => {
    try {
      await ccrotate.remove(email);
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('refresh')
  .alias('rf')
  .description('Test all accounts and refresh tokens')
  .action(async () => {
    try {
      await ccrotate.refresh();
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('when')
  .description('Show when each account will be available (refreshes stale cache first)')
  .action(async () => {
    try { await ccrotate.when(); } catch (error) { console.error(chalk.red(`Error: ${error.message}`)); process.exit(1); }
  });

program
  .command('repair')
  .description('Scan all accounts, mark stale ones, recover recoverable')
  .action(async () => {
    try { await ccrotate.repair(); } catch (error) { console.error(chalk.red(`Error: ${error.message}`)); process.exit(1); }
  });

program
  .command('refresh-one')
  .alias('r1')
  .description('Refresh one stale account (for cron use)')
  .action(async () => {
    try {
      await ccrotate.refreshOne();
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('export')
  .description('Export all profiles as compressed string')
  .action(async () => {
    try {
      await ccrotate.export();
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('import <data>')
  .description('Import profiles from compressed string')
  .option('--force', 'Skip confirmation prompt')
  .action(async (data, options) => {
    try {
      await ccrotate.import(data, { force: options.force });
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('status')
  .alias('st')
  .description('Check current account usage tier (standard vs extra)')
  .option('-q, --quiet', 'Machine-readable JSON output for hooks')
  .action(async (options) => {
    try {
      await ccrotate.status({ quiet: options.quiet });
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('tier-cache')
  .description('Show cached tier data from last refresh/next (JSON)')
  .action(async () => {
    try {
      ccrotate.ensureClaudeFeature('tier-cache');
      const cache = ccrotate.loadTierCache();
      if (!cache) {
        console.log(JSON.stringify({ error: 'No cache. Run ccrotate refresh first.' }));
        return;
      }
      console.log(JSON.stringify(cache, null, 2));
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('config [key] [value]')
  .description('Get/set config (e.g. config extraUsage prompt|allow|deny)')
  .action(async (key, value) => {
    try {
      const config = ccrotate.loadConfig();
      if (!key) {
        console.log(chalk.bold('Current config:'));
        for (const [k, v] of Object.entries(config)) {
          console.log(chalk.gray(`  ${k}: `) + chalk.white(v));
        }
        console.log(chalk.gray(`\nDetected target: ${ccrotate.getTargetName()} (${ccrotate.target})`));
        console.log(chalk.gray('\nSettings:'));
        console.log(chalk.gray('  extraUsage: prompt | allow | deny'));
        return;
      }
      if (!value) {
        console.log(chalk.gray(`${key}: `) + chalk.white(config[key] ?? '(not set)'));
        return;
      }
      if (key === 'extraUsage' && !['prompt', 'allow', 'deny'].includes(value)) {
        console.error(chalk.red('extraUsage must be: prompt, allow, or deny'));
        process.exit(1);
      }
      config[key] = value;
      ccrotate.saveConfig(config);
      console.log(chalk.green(`✓ ${key} = ${value}`));
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('serve')
  .description('Run HTTP server exposing /v1/messages and /v1/chat/completions over the OAuth pool')
  .option('--port <port>', 'TCP port to bind', '4001')
  .option('--bind <host>', 'address to bind', '0.0.0.0')
  .action(async (options) => {
    try {
      await ccrotate.serve(options);
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

program.parse();

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
