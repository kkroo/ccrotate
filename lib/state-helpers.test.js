import { afterEach, describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { withCcrotateLock, markAccountExhausted, clearAccountExhausted } from './state-helpers.js';

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

    it('serializes concurrent RMW transactions without lost updates', async () => {
      // Regression contract for the cross-process advisory lock: 5 concurrent
      // callers each read counter.json, busy-wait ~25ms inside the critical
      // section, increment, and atomic-rename. If the lock didn't serialize
      // them, the final counter would be <5 (lost updates).
      const dir = tmpDir();
      const file = path.join(dir, 'counter.json');
      fs.writeFileSync(file, JSON.stringify({ n: 0 }));
      const run = () =>
        new Promise((resolve, reject) => {
          // Schedule each runner on its own microtask so they actually
          // contend for the lock instead of running sequentially in the
          // same call frame.
          setImmediate(() => {
            try {
              withCcrotateLock(dir, () => {
                const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
                const until = Date.now() + 25;
                while (Date.now() < until) { /* spin inside critical section */ }
                obj.n += 1;
                const tmp = file + '.tmp';
                fs.writeFileSync(tmp, JSON.stringify(obj));
                fs.renameSync(tmp, file);
              }, { timeout: 5000 });
              resolve();
            } catch (e) {
              reject(e);
            }
          });
        });
      await Promise.all([run(), run(), run(), run(), run()]);
      const final = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(final.n).toBe(5);
    });

    it('recovers when an existing lockfile is older than staleMs', () => {
      // Regression contract for stale-lock cleanup: a crashed prior holder
      // leaves a lockfile that's mtime-older than staleMs; the next caller
      // must unlink it and acquire fresh. Without this, a single SIGKILL
      // during a write would deadlock every subsequent ccrotate / writer
      // for the lifetime of the PVC.
      const dir = tmpDir();
      const lockPath = path.join(dir, '.active-files.lock');
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999, at: Date.now() - 60_000 }));
      fs.utimesSync(lockPath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
      let ran = false;
      withCcrotateLock(dir, () => { ran = true; }, { staleMs: 5_000 });
      expect(ran).toBe(true);
      // Lock cleaned up after the fn returned.
      expect(fs.existsSync(lockPath)).toBe(false);
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

    it('can mark runtime exhaustion for a specific model', () => {
      const dir = tmpDir();
      markAccountExhausted(dir, 'a@example.com', {
        reset5h: Math.floor(Date.now() / 1000) + 3600,
        model: 'claude-opus-4-7',
      });

      const cache = JSON.parse(fs.readFileSync(path.join(dir, 'tier-cache.json'), 'utf8'));
      const entry = cache.accounts[0];
      expect(entry.serviceTier).toBe('exhausted');
      expect(entry.exhaustedModel).toBe('claude-opus-4-7');
      expect(entry.rateLimits.exhaustedModel).toBe('claude-opus-4-7');
    });

    it('rebases a relative reset duration onto an absolute epoch', () => {
      // A caller passing a retry-after style duration (seconds-until-reset)
      // instead of an absolute epoch must be normalized — stored verbatim,
      // 1760 renders as "resets at 1970-..." and breaks pickNextCandidate's
      // reset-elapsed filter.
      const dir = tmpDir();
      const before = Math.floor(Date.now() / 1000);
      markAccountExhausted(dir, 'a@example.com', { reset5h: 1760 });
      const after = Math.floor(Date.now() / 1000);

      const entry = JSON.parse(
        fs.readFileSync(path.join(dir, 'tier-cache.json'), 'utf8'),
      ).accounts[0];
      expect(entry.rateLimits.reset5h).toBeGreaterThanOrEqual(before + 1760);
      expect(entry.rateLimits.reset5h).toBeLessThanOrEqual(after + 1760);
      // fallback response string reflects a real near-future date, not 1970
      expect(entry.response).toMatch(/resets at 20\d\d-/);
      expect(entry.response).not.toContain('1970');
    });

    it('leaves an absolute epoch reset window untouched', () => {
      const dir = tmpDir();
      const epoch = Math.floor(Date.now() / 1000) + 3600;
      markAccountExhausted(dir, 'a@example.com', { reset5h: epoch, reset7d: epoch + 86400 });

      const entry = JSON.parse(
        fs.readFileSync(path.join(dir, 'tier-cache.json'), 'utf8'),
      ).accounts[0];
      expect(entry.rateLimits.reset5h).toBe(epoch);
      expect(entry.rateLimits.reset7d).toBe(epoch + 86400);
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

    it('refuses to mark exhausted when fresh utilization shows both windows below cap', () => {
      // Regression: paperclip-server's quota-writeback fires on any 429-like
      // outcome, including overage-credits-out and transient concurrent-limit
      // rejections. If the existing cache says utilization is well below cap
      // and the snapshot is fresh, the burn isn't from a real cap — don't park
      // a usable account behind a 5h wait.
      const dir = tmpDir();
      const tierCachePath = path.join(dir, 'tier-cache.json');
      fs.writeFileSync(tierCachePath, JSON.stringify({
        updatedAt: new Date().toISOString(),
        accounts: [{
          email: 'usable@example.com',
          status: 'success',
          serviceTier: 'base',
          response: 'base (5h:6% 7d:1%)',
          rateLimits: {
            utilization5h: 6,
            utilization7d: 1,
            snapshotCapturedAt: new Date().toISOString(),
          },
        }],
      }));

      const result = markAccountExhausted(dir, 'usable@example.com', { reset5h: 12345 });

      expect(result).toMatchObject({ skipped: true, reason: 'utilization below cap on fresh data' });

      // Cache entry untouched
      const cache = JSON.parse(fs.readFileSync(tierCachePath, 'utf8'));
      const entry = cache.accounts[0];
      expect(entry.serviceTier).toBe('base');
      expect(entry.rateLimits.reset5h).toBeUndefined();
    });

    it('still marks exhausted when utilization data is stale even if percentages are low', () => {
      // The freshness guard must not lock out a legitimate burn when the
      // cache snapshot is older than the freshness window. Otherwise a
      // long-running pool with stale probes would suppress real exhaustion.
      const dir = tmpDir();
      const tierCachePath = path.join(dir, 'tier-cache.json');
      const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h old
      fs.writeFileSync(tierCachePath, JSON.stringify({
        updatedAt: stale,
        accounts: [{
          email: 'stale@example.com',
          status: 'success',
          serviceTier: 'base',
          rateLimits: {
            utilization5h: 6,
            utilization7d: 1,
            snapshotCapturedAt: stale,
          },
        }],
      }));

      const reset5h = Math.floor(Date.now() / 1000) + 1800;
      const result = markAccountExhausted(dir, 'stale@example.com', { reset5h });

      expect(result).toMatchObject({ skipped: false });
      const cache = JSON.parse(fs.readFileSync(tierCachePath, 'utf8'));
      expect(cache.accounts[0].serviceTier).toBe('exhausted');
      expect(cache.accounts[0].rateLimits.reset5h).toBe(reset5h);
    });

    it('still marks exhausted when utilization is at or above cap on fresh data', () => {
      // The guard should NOT shadow a real cap hit. If u7d >= 95 (or u5h),
      // the burn is consistent with a real cap and we should mark exhausted.
      const dir = tmpDir();
      const tierCachePath = path.join(dir, 'tier-cache.json');
      fs.writeFileSync(tierCachePath, JSON.stringify({
        updatedAt: new Date().toISOString(),
        accounts: [{
          email: 'real-cap@example.com',
          status: 'success',
          serviceTier: 'base',
          rateLimits: {
            utilization5h: 5,
            utilization7d: 99,
            snapshotCapturedAt: new Date().toISOString(),
          },
        }],
      }));

      const result = markAccountExhausted(dir, 'real-cap@example.com', { reset7d: 7777777 });
      expect(result).toMatchObject({ skipped: false });
      const cache = JSON.parse(fs.readFileSync(tierCachePath, 'utf8'));
      expect(cache.accounts[0].serviceTier).toBe('exhausted');
    });
  });

  describe('clearAccountExhausted', () => {
    // Self-healing path that closes the stale-exhausted-label deadlock:
    //   1. A burst-probe, transient 429, or claude-local writeback flips an
    //      account to `serviceTier: exhausted`.
    //   2. The Usage API for that account enters its 1hr per-token cooldown.
    //   3. testAccount with `usageApiOnly: false` then returns
    //      status='unknown' because the /v1/messages fallback is gated to
    //      `extra`-mode accounts only.
    //   4. upsertTierCacheEntries' anti-clobber rule preserves the stale
    //      `exhausted` label indefinitely.
    //   5. Meanwhile, real callMessages traffic against the SAME account is
    //      returning 200 OK — definitive proof the account is currently
    //      usable. clearAccountExhausted is the symmetric helper that
    //      teaches the self-heal step back to the cache.

    it('clears the exhausted serviceTier on an existing entry', () => {
      const dir = tmpDir();
      const tierCachePath = path.join(dir, 'tier-cache.json');
      fs.writeFileSync(tierCachePath, JSON.stringify({
        updatedAt: '2026-05-01T00:00:00Z',
        accounts: [{
          email: 'a@example.com',
          status: 'success',
          serviceTier: 'exhausted',
          response: 'quota exhausted',
          rateLimits: { reset5h: 123, snapshotCapturedAt: '2026-05-01T00:00:00Z' },
        }],
      }));

      const result = clearAccountExhausted(dir, 'a@example.com');
      expect(result).toMatchObject({ changed: true, email: 'a@example.com' });

      const cache = JSON.parse(fs.readFileSync(tierCachePath, 'utf8'));
      const entry = cache.accounts.find(x => x.email === 'a@example.com');
      expect(entry.serviceTier).toBeNull();
      expect(cache.updatedAt).not.toBe('2026-05-01T00:00:00Z');
    });

    it('preserves rate-limit utilization data on clear (only drops exhaustedModel)', () => {
      // The next freshness-loop probe / pickNextCandidate decision still
      // benefits from knowing the most recent utilization snapshot. We're
      // dropping the wrong-positive label, not the underlying numbers.
      const dir = tmpDir();
      const tierCachePath = path.join(dir, 'tier-cache.json');
      fs.writeFileSync(tierCachePath, JSON.stringify({
        updatedAt: '2026-05-01T00:00:00Z',
        accounts: [{
          email: 'a@example.com',
          status: 'success',
          serviceTier: 'exhausted',
          exhaustedModel: 'claude-opus-4-7',
          rateLimits: {
            utilization5h: 87,
            utilization7d: 42,
            reset5h: 555,
            exhaustedModel: 'claude-opus-4-7',
            snapshotCapturedAt: '2026-05-01T00:00:00Z',
          },
        }],
      }));

      clearAccountExhausted(dir, 'a@example.com');

      const entry = JSON.parse(fs.readFileSync(tierCachePath, 'utf8')).accounts[0];
      expect(entry.serviceTier).toBeNull();
      expect(entry.exhaustedModel).toBeUndefined();
      expect(entry.rateLimits.exhaustedModel).toBeUndefined();
      // Preserved
      expect(entry.rateLimits.utilization5h).toBe(87);
      expect(entry.rateLimits.utilization7d).toBe(42);
      expect(entry.rateLimits.reset5h).toBe(555);
    });

    it('is a no-op when the entry is not labeled exhausted', () => {
      const dir = tmpDir();
      const tierCachePath = path.join(dir, 'tier-cache.json');
      fs.writeFileSync(tierCachePath, JSON.stringify({
        updatedAt: '2026-05-01T00:00:00Z',
        accounts: [{
          email: 'a@example.com',
          status: 'success',
          serviceTier: 'base',
          rateLimits: { utilization5h: 10 },
        }],
      }));

      const result = clearAccountExhausted(dir, 'a@example.com');
      expect(result).toMatchObject({ changed: false, reason: 'not exhausted' });

      const cache = JSON.parse(fs.readFileSync(tierCachePath, 'utf8'));
      expect(cache.accounts[0].serviceTier).toBe('base');
      expect(cache.updatedAt).toBe('2026-05-01T00:00:00Z');
    });

    it('is a no-op when no entry for the email exists', () => {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, 'tier-cache.json'), JSON.stringify({
        updatedAt: '2026-05-01T00:00:00Z',
        accounts: [{ email: 'other@example.com', serviceTier: 'base' }],
      }));
      const result = clearAccountExhausted(dir, 'missing@example.com');
      expect(result).toMatchObject({ changed: false, reason: 'no entry for email' });
    });

    it('is a no-op when the tier-cache file does not exist', () => {
      const dir = tmpDir();
      // No tier-cache.json — fresh dir.
      const result = clearAccountExhausted(dir, 'a@example.com');
      expect(result).toMatchObject({ changed: false, reason: 'no cache file' });
      // Helper does NOT create the cache file on a no-op clear.
      expect(fs.existsSync(path.join(dir, 'tier-cache.json'))).toBe(false);
    });

    it('preserves the label when exhaustedModel does not match the success model', () => {
      // Per-model quotas are independent. A successful haiku call does NOT
      // prove that opus quota has recovered. Only clear when the success
      // model matches the recorded exhausted model (or when no model gate).
      const dir = tmpDir();
      const tierCachePath = path.join(dir, 'tier-cache.json');
      fs.writeFileSync(tierCachePath, JSON.stringify({
        updatedAt: '2026-05-01T00:00:00Z',
        accounts: [{
          email: 'a@example.com',
          status: 'success',
          serviceTier: 'exhausted',
          exhaustedModel: 'claude-opus-4-7',
          rateLimits: { exhaustedModel: 'claude-opus-4-7' },
        }],
      }));

      const result = clearAccountExhausted(dir, 'a@example.com', {
        model: 'claude-haiku-4-5-20251001',
      });
      expect(result).toMatchObject({
        changed: false,
        reason: 'exhaustedModel mismatch',
        entryModel: 'claude-opus-4-7',
        successModel: 'claude-haiku-4-5-20251001',
      });

      const entry = JSON.parse(fs.readFileSync(tierCachePath, 'utf8')).accounts[0];
      expect(entry.serviceTier).toBe('exhausted');
      expect(entry.exhaustedModel).toBe('claude-opus-4-7');
    });

    it('clears when exhaustedModel matches the success model', () => {
      const dir = tmpDir();
      const tierCachePath = path.join(dir, 'tier-cache.json');
      fs.writeFileSync(tierCachePath, JSON.stringify({
        updatedAt: '2026-05-01T00:00:00Z',
        accounts: [{
          email: 'a@example.com',
          status: 'success',
          serviceTier: 'exhausted',
          exhaustedModel: 'claude-opus-4-7',
          rateLimits: { exhaustedModel: 'claude-opus-4-7' },
        }],
      }));

      const result = clearAccountExhausted(dir, 'a@example.com', {
        model: 'claude-opus-4-7',
      });
      expect(result).toMatchObject({ changed: true, clearedExhaustedModel: 'claude-opus-4-7' });
      expect(JSON.parse(fs.readFileSync(tierCachePath, 'utf8')).accounts[0].serviceTier).toBeNull();
    });

    it('clears when exhaustedModel was tracked but no model passed to clearer', () => {
      // Operator path: when the caller doesn't pass a model gate, we
      // unconditionally clear. (clearAccountExhausted called from an
      // operator/admin path rather than a model-specific success.)
      const dir = tmpDir();
      const tierCachePath = path.join(dir, 'tier-cache.json');
      fs.writeFileSync(tierCachePath, JSON.stringify({
        updatedAt: '2026-05-01T00:00:00Z',
        accounts: [{
          email: 'a@example.com',
          status: 'success',
          serviceTier: 'exhausted',
          exhaustedModel: 'claude-opus-4-7',
        }],
      }));

      clearAccountExhausted(dir, 'a@example.com');
      expect(JSON.parse(fs.readFileSync(tierCachePath, 'utf8')).accounts[0].serviceTier).toBeNull();
    });

    it('does not touch other accounts in the cache', () => {
      const dir = tmpDir();
      const tierCachePath = path.join(dir, 'tier-cache.json');
      fs.writeFileSync(tierCachePath, JSON.stringify({
        updatedAt: '2026-05-01T00:00:00Z',
        accounts: [
          { email: 'a@example.com', serviceTier: 'exhausted', rateLimits: { utilization5h: 100 } },
          { email: 'b@example.com', serviceTier: 'exhausted', rateLimits: { utilization5h: 100 } },
          { email: 'c@example.com', serviceTier: 'base',      rateLimits: { utilization5h: 10 } },
        ],
      }));

      clearAccountExhausted(dir, 'a@example.com');

      const cache = JSON.parse(fs.readFileSync(tierCachePath, 'utf8'));
      const byEmail = Object.fromEntries(cache.accounts.map(a => [a.email, a]));
      expect(byEmail['a@example.com'].serviceTier).toBeNull();
      expect(byEmail['b@example.com'].serviceTier).toBe('exhausted'); // untouched
      expect(byEmail['c@example.com'].serviceTier).toBe('base');      // untouched
    });

    it('writes atomically (no temp file left behind on success)', () => {
      const dir = tmpDir();
      const tierCachePath = path.join(dir, 'tier-cache.json');
      fs.writeFileSync(tierCachePath, JSON.stringify({
        updatedAt: '2026-05-01T00:00:00Z',
        accounts: [{ email: 'a@example.com', serviceTier: 'exhausted', rateLimits: {} }],
      }));
      clearAccountExhausted(dir, 'a@example.com');
      expect(fs.existsSync(tierCachePath + '.tmp')).toBe(false);
    });
  });
});
