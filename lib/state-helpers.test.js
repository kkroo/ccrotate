import { afterEach, describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { withCcrotateLock, markAccountExhausted } from './state-helpers.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccrotate-helpers-'));
}

describe('state-helpers', () => {
  afterEach(() => {});

  describe('withCcrotateLock', () => {
    it('runs the function under a created lockfile and removes it after', () => {
      const dir = tmpDir();
      let observedLock = false;
      withCcrotateLock(dir, () => {
        observedLock = fs.existsSync(path.join(dir, '.active-files.lock'));
      });
      expect(observedLock).toBe(true);
      expect(fs.existsSync(path.join(dir, '.active-files.lock'))).toBe(false);
    });

    it('reclaims a stale lockfile older than staleMs', () => {
      const dir = tmpDir();
      const lockPath = path.join(dir, '.active-files.lock');
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999, at: 0 }));
      fs.utimesSync(lockPath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
      let ran = false;
      withCcrotateLock(dir, () => { ran = true; }, { staleMs: 1000, timeout: 500 });
      expect(ran).toBe(true);
    });

    it('times out if the lock is held and not stale', () => {
      const dir = tmpDir();
      const lockPath = path.join(dir, '.active-files.lock');
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
      expect(() => withCcrotateLock(dir, () => {}, { staleMs: 60000, timeout: 100 }))
        .toThrow(/timed out/);
      try { fs.unlinkSync(lockPath); } catch {}
    });

    it('removes lockfile even if function throws', () => {
      const dir = tmpDir();
      expect(() => withCcrotateLock(dir, () => { throw new Error('boom'); })).toThrow('boom');
      expect(fs.existsSync(path.join(dir, '.active-files.lock'))).toBe(false);
    });
  });

  describe('markAccountExhausted', () => {
    it('writes a fresh tier-cache entry when none existed', () => {
      const dir = tmpDir();
      const reset5h = Math.floor(Date.now() / 1000) + 3600;
      markAccountExhausted(dir, 'a@example.com', { reset5h, response: "out of extra usage · resets 4pm" });

      const cache = JSON.parse(fs.readFileSync(path.join(dir, 'tier-cache.json'), 'utf8'));
      expect(cache.accounts).toHaveLength(1);
      const entry = cache.accounts[0];
      expect(entry.email).toBe('a@example.com');
      expect(entry.serviceTier).toBe('exhausted');
      expect(entry.rateLimits.reset5h).toBe(reset5h);
      expect(entry.rateLimits.snapshotCapturedAt).toBeTruthy();
      expect(cache.updatedAt).toBeTruthy();
    });

    it('upserts an existing entry, preserving prior rateLimits fields and replacing only what we know', () => {
      const dir = tmpDir();
      const tierCachePath = path.join(dir, 'tier-cache.json');
      fs.writeFileSync(tierCachePath, JSON.stringify({
        updatedAt: '2026-05-01T00:00:00Z',
        accounts: [{
          email: 'a@example.com',
          status: 'success',
          serviceTier: 'base',
          response: '5h:30% 7d:60%',
          rateLimits: { utilization5h: 30, utilization7d: 60, reset7d: 999, snapshotCapturedAt: '2026-05-01T00:00:00Z' },
        }, {
          email: 'b@example.com',
          status: 'success',
          serviceTier: 'base',
          rateLimits: { utilization5h: 5 },
        }],
      }));
      const reset5h = 1234567890;
      markAccountExhausted(dir, 'a@example.com', { reset5h });

      const cache = JSON.parse(fs.readFileSync(tierCachePath, 'utf8'));
      const a = cache.accounts.find(x => x.email === 'a@example.com');
      const b = cache.accounts.find(x => x.email === 'b@example.com');
      expect(a.serviceTier).toBe('exhausted');
      expect(a.rateLimits.reset5h).toBe(reset5h);
      // Prior reset7d preserved (we didn't pass it)
      expect(a.rateLimits.reset7d).toBe(999);
      // Prior utilization preserved
      expect(a.rateLimits.utilization5h).toBe(30);
      // Other accounts untouched
      expect(b.rateLimits.utilization5h).toBe(5);
      expect(b.serviceTier).toBe('base');
    });

    it('writes atomically (no partial file visible mid-write)', () => {
      // Smoke test: temp file should not exist after successful write.
      const dir = tmpDir();
      markAccountExhausted(dir, 'a@example.com', { reset5h: 123 });
      expect(fs.existsSync(path.join(dir, 'tier-cache.json.tmp'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'tier-cache.json'))).toBe(true);
    });

    it('takes the same lock as withCcrotateLock — observed via lockfile presence', () => {
      const dir = tmpDir();
      const lockPath = path.join(dir, '.active-files.lock');
      // markAccountExhausted writes via the lock; at exit the lock is gone
      // and a fresh withCcrotateLock can succeed.
      markAccountExhausted(dir, 'a@example.com', { reset5h: 100 });
      expect(fs.existsSync(lockPath)).toBe(false);
      let ran = false;
      withCcrotateLock(dir, () => { ran = true; }, { timeout: 200 });
      expect(ran).toBe(true);
    });
  });
});
