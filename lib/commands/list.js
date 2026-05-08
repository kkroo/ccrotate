import { renderAccountTable } from '../account-table.js';

/**
 * `ccrotate list` — rich account table.
 *
 * Iterates profiles.json (full set, including freshly snapped accounts
 * not yet in tier-cache) and overlays whatever tier data exists. Shows
 * #, ★, token / availability glyphs, email, tier, 5h/7d utilization,
 * status (usable now / in Xh / stale / no data), and expires-at.
 *
 * Pre-kkroo.11 there were two views — `list` (saved accounts +
 * expires-at) and `when` (cache.accounts + tier/usage). They were 90%
 * overlapping and `when` silently dropped any account not yet probed.
 * One view now; `ccrotate when` is a thin alias for back-compat.
 *
 * No probing: probing belongs to `refresh` / `refresh-one`.
 */
export class ListCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute() {
    renderAccountTable(this.ccrotate, { mode: 'rich' });
  }
}
