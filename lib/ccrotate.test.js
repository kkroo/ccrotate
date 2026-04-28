import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CCRotate from './ccrotate.js';

describe('CCRotate Codex snapshot parsing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prefers the latest non-empty rate snapshot over a trailing null snapshot', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrotate-test-'));
    const sessionFile = path.join(tempRoot, 'session.jsonl');

    fs.writeFileSync(sessionFile, [
      JSON.stringify({
        timestamp: '2026-04-28T01:57:08.852Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            limit_id: 'codex',
            plan_type: 'team',
            primary: { used_percent: 100, window_minutes: 300, resets_at: 1777271332 },
            secondary: { used_percent: 16, window_minutes: 10080, resets_at: 1777858132 }
          }
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-28T01:57:19.666Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            limit_id: 'premium',
            plan_type: 'team',
            primary: null,
            secondary: null,
            credits: { has_credits: false, unlimited: false, balance: null }
          }
        }
      })
    ].join('\n'), 'utf8');

    const ccrotate = new CCRotate();
    const snapshot = ccrotate.readLatestCodexRateSnapshotFromSessionFile(sessionFile);

    expect(snapshot?.primary?.leftPercent).toBe(0);
    expect(snapshot?.primary?.windowMinutes).toBe(300);
    expect(snapshot?.secondary?.leftPercent).toBe(84);
    expect(snapshot?.planType).toBe('team');
  });
});
