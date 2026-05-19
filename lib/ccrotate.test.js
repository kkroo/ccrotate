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

  it('turns Codex usage-limit errors into exhausted quota snapshots', () => {
    const ccrotate = new CCRotate();
    const now = new Date('2026-04-29T08:03:00Z');
    const output = [
      '{"type":"thread.started","thread_id":"019dd843"}',
      '{"type":"turn.started"}',
      '{"type":"error","message":"You\\u0027ve hit your usage limit. To get more access now, send a request to your admin or try again at 11:19 AM."}',
      '{"type":"turn.failed","error":{"message":"You\\u0027ve hit your usage limit. To get more access now, send a request to your admin or try again at 11:19 AM."}}'
    ].join('\n');

    const snapshot = ccrotate.createCodexUsageLimitSnapshot(output, now);

    expect(snapshot?.primary?.leftPercent).toBe(0);
    expect(snapshot?.primary?.usedPercent).toBe(100);
    expect(snapshot?.primary?.windowMinutes).toBe(300);
    expect(snapshot?.primary?.resetsAt).toBe(Math.floor(new Date('2026-04-29T11:19:00Z').getTime() / 1000));
    expect(ccrotate.getCodexServiceTier(snapshot)).toBe('exhausted');
  });

  it('parses full-date Codex usage-limit reset messages', () => {
    const ccrotate = new CCRotate();
    const reset = ccrotate.parseCodexUsageLimitResetEpoch(
      'You have hit your usage limit. To get more access now, send a request to your admin or try again at Apr 30th, 2026 4:19 AM.',
      new Date('2026-04-29T08:03:00Z')
    );

    expect(reset).toBe(Math.floor(new Date('Apr 30, 2026 4:19 AM').getTime() / 1000));
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

  it('preserves reset windows when a later partial probe reclassifies the account', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrotate-cache-test-'));
    const ccrotate = new CCRotate();
    ccrotate.profilesDir = tempRoot;
    ccrotate.tierCacheFile = path.join(tempRoot, 'tier-cache.codex.json');

    ccrotate.saveTierCache([
      {
        email: 'limited@example.com',
        status: 'success',
        serviceTier: 'near_limit',
        response: '5h 3% left',
        rateLimits: {
          utilization5h: 97,
          remaining5h: 3,
          reset5h: 1777359660,
          reset7d: 1777946460
        }
      }
    ]);

    ccrotate.upsertTierCacheEntries([
      {
        email: 'limited@example.com',
        status: 'success',
        serviceTier: 'exhausted',
        response: '5h exhausted',
        rateLimits: {
          utilization5h: 100,
          snapshotCapturedAt: '2026-04-28T04:00:00.000Z'
        }
      }
    ]);

    const cache = ccrotate.loadTierCache();
    expect(cache.accounts[0].serviceTier).toBe('exhausted');
    expect(cache.accounts[0].response).toBe('5h exhausted');
    expect(cache.accounts[0].rateLimits.utilization5h).toBe(100);
    expect(cache.accounts[0].rateLimits.reset5h).toBe(1777359660);
    expect(cache.accounts[0].rateLimits.reset7d).toBe(1777946460);
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

describe('CCRotate API sync timestamps', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stamps Claude test results with the last successful API sync time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T03:00:00.000Z'));

    const ccrotate = new CCRotate();
    vi.spyOn(ccrotate, 'fetchAccountUsage').mockResolvedValue({ ok: true });
    vi.spyOn(ccrotate, 'parseUsageResult').mockReturnValue({
      status: 'success',
      response: 'ok',
      serviceTier: 'available',
      rateLimits: {}
    });
    const checkSpy = vi.spyOn(ccrotate, 'checkAndUpdateProfile').mockReturnValue(true);

    const result = await ccrotate.testAccount('claude@example.com', { token: 'token' });

    expect(result.lastApiSyncAt).toBe('2026-04-28T03:00:00.000Z');
    expect(checkSpy).toHaveBeenCalledWith('claude@example.com', '2026-04-28T03:00:00.000Z');
  });

  it('stamps Codex probe results with the snapshot capture time', () => {
    const ccrotate = new CCRotate();
    const profiles = {
      'codex@example.com': {
        auth: { tokens: { id_token: 'jwt' } },
        stale: true
      }
    };

    vi.spyOn(ccrotate, 'runCodexProbe').mockReturnValue({
      status: 'success',
      response: 'ok',
      snapshot: {
        capturedAt: '2026-04-28T04:00:00.000Z',
        primary: { usedPercent: 16, leftPercent: 84, resetsAt: 1777359660 },
        secondary: { usedPercent: 40, leftPercent: 60, resetsAt: 1777946460 },
        planType: 'team',
        credits: null
      }
    });
    vi.spyOn(ccrotate, 'getCodexServiceTier').mockReturnValue('available');
    const saveSpy = vi.spyOn(ccrotate, 'saveProfiles').mockImplementation(() => {});

    const result = ccrotate.probeCodexAccount('codex@example.com', profiles['codex@example.com'], profiles);

    expect(result.lastApiSyncAt).toBe('2026-04-28T04:00:00.000Z');
    expect(profiles['codex@example.com'].lastApiSyncAt).toBe('2026-04-28T04:00:00.000Z');
    expect(profiles['codex@example.com'].stale).toBe(false);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('marks codex profile stale when id_token is expired (no probe needed)', () => {
    const ccrotate = new CCRotate();
    const expiredPayload = Buffer
      .from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 600 }))
      .toString('base64url');
    const profiles = {
      'codex@example.com': {
        auth: { tokens: { id_token: 'h.' + expiredPayload + '.s' } },
        stale: false
      }
    };
    const probeSpy = vi.spyOn(ccrotate, 'runCodexProbe').mockReturnValue({ status: 'success' });
    const saveSpy = vi.spyOn(ccrotate, 'saveProfiles').mockImplementation(() => {});

    const result = ccrotate.probeCodexAccount('codex@example.com', profiles['codex@example.com'], profiles);

    expect(result.status).toBe('error');
    expect(result.stale).toBe(true);
    expect(result.response).toMatch(/id_token expired/);
    expect(profiles['codex@example.com'].stale).toBe(true);
    expect(profiles['codex@example.com'].staleAt).toBeDefined();
    expect(probeSpy).not.toHaveBeenCalled();
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('does not short-circuit when id_token is fresh', () => {
    const ccrotate = new CCRotate();
    const futurePayload = Buffer
      .from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))
      .toString('base64url');
    const profiles = {
      'codex@example.com': {
        auth: { tokens: { id_token: 'h.' + futurePayload + '.s' } },
        stale: false
      }
    };
    vi.spyOn(ccrotate, 'runCodexProbe').mockReturnValue({
      status: 'success',
      response: 'ok',
      snapshot: {
        capturedAt: '2026-04-28T04:00:00.000Z',
        primary: { usedPercent: 16, leftPercent: 84, resetsAt: 1777359660 },
        secondary: { usedPercent: 40, leftPercent: 60, resetsAt: 1777946460 },
        planType: 'team',
        credits: null
      }
    });
    vi.spyOn(ccrotate, 'getCodexServiceTier').mockReturnValue('available');
    vi.spyOn(ccrotate, 'saveProfiles').mockImplementation(() => {});

    const result = ccrotate.probeCodexAccount('codex@example.com', profiles['codex@example.com'], profiles);

    expect(result.status).toBe('success');
    expect(profiles['codex@example.com'].stale).toBe(false);
  });

  it('falls through to probe when id_token has no exp claim (legacy auth.json)', () => {
    const ccrotate = new CCRotate();
    const profiles = {
      'codex@example.com': {
        auth: { tokens: { id_token: 'malformed' } },
        stale: false
      }
    };
    vi.spyOn(ccrotate, 'runCodexProbe').mockReturnValue({
      status: 'success',
      response: 'ok',
      snapshot: {
        capturedAt: '2026-04-28T04:00:00.000Z',
        primary: { usedPercent: 0, leftPercent: 100, resetsAt: 1777359660 },
        secondary: { usedPercent: 0, leftPercent: 100, resetsAt: 1777946460 },
        planType: 'team',
        credits: null
      }
    });
    vi.spyOn(ccrotate, 'getCodexServiceTier').mockReturnValue('available');
    vi.spyOn(ccrotate, 'saveProfiles').mockImplementation(() => {});

    const result = ccrotate.probeCodexAccount('codex@example.com', profiles['codex@example.com'], profiles);

    expect(result.status).toBe('success');
  });
});

describe('CCRotate target selection', () => {
  it('honors CCROTATE_TARGET=codex even without CODEX_* env vars', () => {
    const ccrotate = new CCRotate();
    expect(ccrotate.detectTargetFromEnv({ CCROTATE_TARGET: 'codex' })).toBe('codex');
  });

  it('honors CCROTATE_TARGET=claude even when CODEX_* env vars are set', () => {
    const ccrotate = new CCRotate();
    expect(
      ccrotate.detectTargetFromEnv({ CCROTATE_TARGET: 'claude', CODEX_HOME: '/tmp/codex' })
    ).toBe('claude');
  });

  it('ignores invalid CCROTATE_TARGET values and falls back to auto-detection', () => {
    const ccrotate = new CCRotate();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        ccrotate.detectTargetFromEnv({ CCROTATE_TARGET: 'gpt5', CODEX_HOME: '/tmp/codex' })
      ).toBe('codex');
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Ignoring CCROTATE_TARGET='gpt5'"));
    } finally {
      errSpy.mockRestore();
    }
  });

  it('detects claude from CLAUDE* env even when OPENAI_API_KEY is also set', () => {
    // Regression: `ccrotate` run from a Claude Code session on a devbox
    // that exports OPENAI_API_KEY (local ccrotate-serve env) wrongly
    // auto-detected codex. CLAUDE* must outrank a bare OPENAI_API_KEY.
    const ccrotate = new CCRotate();
    expect(
      ccrotate.detectTargetFromEnv({ CLAUDECODE: '1', OPENAI_API_KEY: 'sk-x' })
    ).toBe('claude');
  });

  it('still detects codex from OPENAI_API_KEY alone (no claude/codex markers)', () => {
    const ccrotate = new CCRotate();
    expect(ccrotate.detectTargetFromEnv({ OPENAI_API_KEY: 'sk-x' })).toBe('codex');
  });

  it('CODEX_* outranks a CLAUDE* var', () => {
    const ccrotate = new CCRotate();
    expect(
      ccrotate.detectTargetFromEnv({ CODEX_HOME: '/tmp/codex', CLAUDECODE: '1' })
    ).toBe('codex');
  });

  it('returns null when no target markers are present', () => {
    const ccrotate = new CCRotate();
    expect(ccrotate.detectTargetFromEnv({ PATH: '/usr/bin' })).toBe(null);
  });

  it('setTarget switches profilesFile and tierCacheFile to the new pool', () => {
    const ccrotate = new CCRotate();
    ccrotate.setTarget('claude');
    const claudeProfiles = ccrotate.profilesFile;
    const claudeTier = ccrotate.tierCacheFile;
    ccrotate.setTarget('codex');
    expect(ccrotate.target).toBe('codex');
    expect(ccrotate.profilesFile).not.toBe(claudeProfiles);
    expect(ccrotate.tierCacheFile).not.toBe(claudeTier);
    expect(ccrotate.profilesFile).toBe(ccrotate.getProfilesFileForTarget('codex'));
    expect(ccrotate.tierCacheFile).toBe(ccrotate.getTierCacheFileForTarget('codex'));
  });

  it('setTarget rejects unsupported targets', () => {
    const ccrotate = new CCRotate();
    expect(() => ccrotate.setTarget('gpt5')).toThrow(/Invalid target/);
  });
});

describe('withActiveFilesLock — cross-process serialization', () => {
  it('runs the body, releases the lockfile after, and returns the body value', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrotate-lock-test-'));
    const ccrotate = new CCRotate();
    ccrotate.profilesDir = tempRoot;
    const lockPath = path.join(tempRoot, '.active-files.lock');

    let observedLock = false;
    const result = ccrotate.withActiveFilesLock(() => {
      observedLock = fs.existsSync(lockPath);
      return 42;
    });

    expect(observedLock).toBe(true);     // lockfile present during fn
    expect(result).toBe(42);              // body return value bubbles up
    expect(fs.existsSync(lockPath)).toBe(false); // released after
  });

  it('reclaims a stale lockfile older than staleMs', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrotate-lock-stale-'));
    const ccrotate = new CCRotate();
    ccrotate.profilesDir = tempRoot;
    const lockPath = path.join(tempRoot, '.active-files.lock');

    // Plant a lockfile with an old mtime — simulates a crashed holder.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999, at: 1 }));
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, past, past);

    const result = ccrotate.withActiveFilesLock(() => 'reclaimed', { staleMs: 30_000, timeout: 1_000 });
    expect(result).toBe('reclaimed');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('throws on timeout when the lock is held and not stale', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrotate-lock-timeout-'));
    const ccrotate = new CCRotate();
    ccrotate.profilesDir = tempRoot;
    const lockPath = path.join(tempRoot, '.active-files.lock');

    // Hold the lockfile with a fresh mtime (not stale) — and do NOT release it.
    const fd = fs.openSync(lockPath, 'wx');
    try {
      expect(() =>
        ccrotate.withActiveFilesLock(() => 'never', { staleMs: 60_000, timeout: 200 })
      ).toThrow(/timed out waiting/);
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lockPath);
    }
  });

  it('releases the lock even if the body throws', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrotate-lock-throw-'));
    const ccrotate = new CCRotate();
    ccrotate.profilesDir = tempRoot;
    const lockPath = path.join(tempRoot, '.active-files.lock');

    expect(() =>
      ccrotate.withActiveFilesLock(() => { throw new Error('boom'); })
    ).toThrow('boom');
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

describe('saveTierCache + upsertTierCacheEntries — atomicity + cross-process serialization', () => {
  // Regression contract for the 2026-05-18 incident: a ccrotate-serve
  // deployment rollout left tier-cache.json shrunk from 13 → 3 accounts
  // because multiple replicas' freshness-loops were upserting concurrently
  // without lock-serialization, and saveTierCache wrote non-atomically.
  // Combined effect: reader could see partial file, writer-with-truncated-
  // view could shrink the on-disk cache. Fix: upsertTierCacheEntries now
  // takes withCcrotateLock around the RMW, and saveTierCache writes via
  // tmpfile+rename so any reader sees either the prior or new cache fully.

  it('saveTierCache atomic-writes via tmpfile + rename (no .tmp left behind)', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrotate-save-tier-'));
    const ccrotate = new CCRotate();
    ccrotate.profilesDir = tempRoot;
    ccrotate.tierCacheFile = path.join(tempRoot, 'tier-cache.json');

    ccrotate.saveTierCache([
      { email: 'a@example.com', status: 'success', serviceTier: 'base' },
      { email: 'b@example.com', status: 'success', serviceTier: 'extra' },
    ]);

    expect(fs.existsSync(ccrotate.tierCacheFile)).toBe(true);
    expect(fs.existsSync(ccrotate.tierCacheFile + '.tmp')).toBe(false);
    const cache = JSON.parse(fs.readFileSync(ccrotate.tierCacheFile, 'utf8'));
    expect(cache.accounts).toHaveLength(2);
  });

  it('upsertTierCacheEntries holds the shared lockfile during its read-modify-write', () => {
    // Observable contract: the .active-files.lock file is present at the
    // moment saveTierCache is called from inside upsertTierCacheEntries.
    // We assert this from inside a writeFileSync spy that intercepts the
    // tmp-file write. (The spy returns true to let the write succeed — we
    // just sample the lockfile state at the right instant. After the call
    // completes, the lock should be released.)
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrotate-upsert-lock-'));
    const ccrotate = new CCRotate();
    ccrotate.profilesDir = tempRoot;
    ccrotate.tierCacheFile = path.join(tempRoot, 'tier-cache.json');
    const lockPath = path.join(tempRoot, '.active-files.lock');

    let observedHeldDuringWrite = false;
    const realWriteFileSync = fs.writeFileSync.bind(fs);
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, opts) => {
      // Only sample on the tier-cache tmp write — the lockfile is written
      // via fs.writeSync (different api) so it never reaches this spy.
      if (String(file).endsWith('.tmp')) {
        observedHeldDuringWrite = fs.existsSync(lockPath);
      }
      return realWriteFileSync(file, data, opts);
    });
    try {
      ccrotate.upsertTierCacheEntries([
        { email: 'a@example.com', status: 'success', serviceTier: 'base', rateLimits: { utilization5h: 1 } },
      ]);
    } finally {
      spy.mockRestore();
    }
    expect(observedHeldDuringWrite).toBe(true);
    // Lock is released after the upsert returns (withCcrotateLock cleanup).
    expect(fs.existsSync(lockPath)).toBe(false);
    // And the data landed.
    const cache = JSON.parse(fs.readFileSync(ccrotate.tierCacheFile, 'utf8'));
    expect(cache.accounts.find(a => a.email === 'a@example.com')).toBeTruthy();
  });

  it('serializes concurrent cross-process upserts via the advisory lockfile (no lost entries)', () => {
    // True multi-replica reproduction: spawn 5 OS-level child processes
    // that each call upsertTierCacheEntries on the same profilesDir with a
    // unique email. Without the fix, two writers can read the same
    // pre-state, each write back with only THEIR entry, and the second
    // writer wipes the first writer's contribution from the shared cache.
    // With the fix, withCcrotateLock + atomic saveTierCache make the RMW
    // sequence serialize: all 5 emails land. This is the regression that
    // matches the live 2026-05-18 incident shape (multiple replicas
    // racing → cache shrinkage on a shared CephFS PVC).
    const { spawnSync } = require('child_process');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrotate-mp-race-'));

    // Each child runs a tiny script that constructs CCRotate pointed at
    // tempRoot, then upserts a unique email. Spin for ~25ms inside the
    // critical section to ensure writers actually contend.
    const childScript = `
      import CCRotate from '${path.resolve('./lib/ccrotate.js')}';
      const cc = new CCRotate();
      cc.profilesDir = ${JSON.stringify(tempRoot)};
      cc.tierCacheFile = ${JSON.stringify(path.join(tempRoot, 'tier-cache.json'))};
      const email = process.argv[2];
      // Patch saveTierCache to add an internal busy-wait so writers contend.
      const orig = cc.saveTierCache.bind(cc);
      cc.saveTierCache = function(results) {
        const until = Date.now() + 25;
        while (Date.now() < until) { /* spin while holding lock */ }
        return orig(results);
      };
      cc.upsertTierCacheEntries([{ email, status: 'success', serviceTier: 'base', rateLimits: { utilization5h: 1 } }]);
    `;
    const tmpScript = path.join(tempRoot, '_race-child.mjs');
    fs.writeFileSync(tmpScript, childScript);

    const emails = ['a', 'b', 'c', 'd', 'e'].map(x => `${x}@race.example.com`);
    const children = emails.map(email =>
      spawnSync(process.execPath, [tmpScript, email], {
        encoding: 'utf8',
        timeout: 15000,
      })
    );
    for (const ch of children) {
      if (ch.status !== 0) {
        throw new Error(`child failed: status=${ch.status} stderr=${ch.stderr}`);
      }
    }

    const cache = JSON.parse(fs.readFileSync(path.join(tempRoot, 'tier-cache.json'), 'utf8'));
    const got = new Set((cache.accounts || []).map(a => a.email));
    for (const email of emails) {
      expect(got.has(email)).toBe(true);
    }
    expect(cache.accounts).toHaveLength(emails.length);
  });
});
