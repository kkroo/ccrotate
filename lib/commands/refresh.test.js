import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withInterProbeDelay, INTER_PROBE_DELAY_MS } from './refresh.js';

// T2 fix (see /home/oramadan/src/paperclip/.planning/2026-05-17-active-verify-tier-gate-design.md §0b):
// `ccrotate refresh` fired ~13 testAccount(email) probes back-to-back. The
// trailing Usage API 429 retry-after responses were misclassified as account
// exhaustion in the tier-cache (false-flag cascade → heartbeat tier-gate deadlock).
//
// `withInterProbeDelay` is the surface we test: it returns a wrapped fn that
// (a) passes through the FIRST call immediately (no startup delay), then
// (b) sleeps INTER_PROBE_DELAY_MS before each subsequent invocation.
// Sequentializing the burst keeps refresh from stacking retry-after cooldowns.
// RefreshView's for-loop is already sequential — wrapping the per-account fn
// (rather than the loop driver) is the minimal change.

describe('withInterProbeDelay', () => {
  let sleepCalls;
  let sleepImpl;

  beforeEach(() => {
    sleepCalls = [];
    // Resolve immediately but record the requested ms so we can assert
    // the spacing without actually waiting.
    sleepImpl = vi.fn((ms) => {
      sleepCalls.push(ms);
      return Promise.resolve();
    });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('does NOT delay before the first call', async () => {
    const inner = vi.fn().mockResolvedValue({ status: 'success', response: 'ok' });
    const wrapped = withInterProbeDelay(inner, { sleep: sleepImpl, delayMs: 2000 });

    const result = await wrapped('one@example.com');

    expect(result.status).toBe('success');
    expect(inner).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it('sleeps INTER_PROBE_DELAY_MS between successive calls', async () => {
    const inner = vi.fn().mockResolvedValue({ status: 'success', response: 'ok' });
    const wrapped = withInterProbeDelay(inner, { sleep: sleepImpl, delayMs: 2000 });

    await wrapped('one@example.com');
    await wrapped('two@example.com');
    await wrapped('three@example.com');

    expect(inner).toHaveBeenCalledTimes(3);
    // First call: no sleep. 2nd + 3rd calls: one sleep each.
    expect(sleepImpl).toHaveBeenCalledTimes(2);
    expect(sleepCalls).toEqual([2000, 2000]);
  });

  it('honors per-call delayMs override', async () => {
    const inner = vi.fn().mockResolvedValue({ status: 'success', response: 'ok' });
    const wrapped = withInterProbeDelay(inner, { sleep: sleepImpl, delayMs: 50 });

    await wrapped('a@example.com');
    await wrapped('b@example.com');

    expect(sleepCalls).toEqual([50]);
  });

  it('still invokes inner even if the previous call rejected', async () => {
    const inner = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ status: 'success', response: 'ok' });
    const wrapped = withInterProbeDelay(inner, { sleep: sleepImpl, delayMs: 2000 });

    await expect(wrapped('a@example.com')).rejects.toThrow('boom');
    const second = await wrapped('b@example.com');

    expect(second.status).toBe('success');
    // Sleep should still fire before the second call so a transient error
    // doesn't accidentally let the next probe burst through.
    expect(sleepImpl).toHaveBeenCalledTimes(1);
  });

  it('actually waits in real time when using the default real-timer sleep', async () => {
    // Sanity check: when no sleep impl is injected, the wrapper uses the
    // production setTimeout path. Use a tiny delayMs so the test stays fast.
    const inner = vi.fn().mockResolvedValue({ status: 'success', response: 'ok' });
    const wrapped = withInterProbeDelay(inner, { delayMs: 50 });

    const t0 = Date.now();
    await wrapped('a@example.com');
    await wrapped('b@example.com');
    const elapsed = Date.now() - t0;

    // 50ms configured; allow some scheduler jitter on either side.
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});

describe('INTER_PROBE_DELAY_MS', () => {
  it('defaults to 2000ms', () => {
    // The default applies when CCROTATE_REFRESH_INTER_PROBE_DELAY_MS is unset.
    // In this test environment it's expected to be unset; if a future CI
    // pipeline starts injecting it, this assertion will surface the override.
    if (process.env.CCROTATE_REFRESH_INTER_PROBE_DELAY_MS == null) {
      expect(INTER_PROBE_DELAY_MS).toBe(2000);
    } else {
      expect(INTER_PROBE_DELAY_MS).toBe(Number(process.env.CCROTATE_REFRESH_INTER_PROBE_DELAY_MS));
    }
  });
});
