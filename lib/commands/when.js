import chalk from 'chalk';
import { renderAccountTable } from '../account-table.js';

/**
 * `ccrotate when` — back-compat alias.
 *
 * Pre-kkroo.11 this was a separate view that iterated tier-cache.accounts
 * (and silently dropped any account not in the cache yet). It also
 * implicitly triggered a refresh when the cache was stale, which made
 * a "show me current state" command have side effects on the network
 * and on shared PVC files.
 *
 * Now: a thin wrapper around `renderAccountTable` (same logic as
 * `ccrotate list`). The implicit refresh is removed — callers who want
 * fresh data should `ccrotate refresh` / `refresh-one` explicitly.
 *
 * Will keep accepting the `when` invocation indefinitely; just nudges
 * users toward `list`. No flag-day removal planned.
 */
export class WhenCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute() {
    renderAccountTable(this.ccrotate, { mode: 'when' });
    console.log();
    console.log(chalk.gray('  (`ccrotate when` is now an alias for `ccrotate list` — same data, no implicit refresh.)'));
  }
}
