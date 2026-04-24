#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import CCRotate from '../lib/ccrotate.js';
const version = process.env.CCROTATE_VERSION || '1.0.12';

const program = new Command();
const ccrotate = new CCRotate();

program
  .name('ccrotate')
  .description('A simple CLI tool to manage and rotate multiple Claude Code accounts, helping you bypass rate limits')
  .version(version, '-v, --version', 'output the version number');

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
  .action(async (email) => {
    try {
      await ccrotate.switch(email);
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('next')
  .description('Smart-rotate to next standard-tier account')
  .option('-y, --yes', 'Auto-allow extra usage if no standard accounts')
  .option('--deny', 'Never use extra usage, wait for reset instead')
  .option('--wait', 'Switch to earliest-reset account and output reset epoch (for auto-resume)')
  .action(async (options) => {
    try {
      await ccrotate.next({ yes: options.yes, deny: options.deny, wait: options.wait });
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
  .description('Show when each account will be available (reads cache only)')
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

program.parse();

if (!process.argv.slice(2).length) {
  program.outputHelp();
}