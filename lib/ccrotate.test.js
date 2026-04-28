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

  it('recognizes current Codex invalidated-token errors as stale auth', () => {
    const ccrotate = new CCRotate();
    const message = [
      'ERROR codex_models_manager::manager: failed to refresh available models: unexpected status 401 Unauthorized:',
      'Your authentication token has been invalidated. Please try signing in again.',
      'auth error code: token_invalidated',
      'Failed to refresh token: 401 Unauthorized:',
      'Your refresh token has already been used to generate a new access token. Please try signing in again.'
    ].join(' ');

    expect(ccrotate.isRevokedCodexAuthMessage(message)).toBe(true);
  });

  it('preserves existing cache data when a later Codex probe has no rate limits', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrotate-cache-test-'));
    const ccrotate = new CCRotate();
    ccrotate.profilesDir = tempRoot;
    ccrotate.tierCacheFile = path.join(tempRoot, 'tier-cache.codex.json');

    ccrotate.saveTierCache([
      {
        email: 'available@example.com',
        status: 'success',
        serviceTier: 'available',
        response: '5h 68% left',
        rateLimits: {
          remaining5h: 68,
          remaining7d: 95,
          reset5h: 1777359660,
          reset7d: 1777946460
        }
      }
    ]);

    ccrotate.upsertTierCacheEntries([
      {
        email: 'available@example.com',
        status: 'success',
        serviceTier: 'unknown',
        response: 'Codex returned no per-account rate-limit data.',
        rateLimits: {
          remaining5h: null,
          remaining7d: null,
          reset5h: null,
          reset7d: null
        }
      }
    ]);

    const cache = ccrotate.loadTierCache();
    expect(cache.accounts).toHaveLength(1);
    expect(cache.accounts[0].serviceTier).toBe('available');
    expect(cache.accounts[0].response).toBe('5h 68% left');
    expect(cache.accounts[0].rateLimits.remaining5h).toBe(68);
  });

  it('does not fail probes when temporary Codex home cleanup races background files', () => {
    const ccrotate = new CCRotate();
    vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      const error = new Error('ENOTEMPTY: directory not empty, rmdir');
      error.code = 'ENOTEMPTY';
      throw error;
    });

    expect(() => ccrotate.cleanupTempCodexHome('/tmp/ccrotate-cleanup-test')).not.toThrow();
  });
});
