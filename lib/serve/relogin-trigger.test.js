import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { triggerRelogin, _resetReloginTrigger } from './relogin-trigger.js';

// Process-wide module state — wipe between tests so cooldowns don't leak.
beforeEach(() => { _resetReloginTrigger(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('triggerRelogin', () => {
  it('POSTs /reloginViaSession with {email,target} to the configured URL', async () => {
    const calls = [];
    const fetchSpy = vi.fn(async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response('{}', { status: 200 });
    });
    expect(triggerRelogin('a@x.com', 'claude', {
      url: 'http://auth-bot.svc:7000',
      _fetch: fetchSpy,
    })).toBe(true);
    // fire-and-forget — give the microtask a tick to land
    await new Promise((r) => setImmediate(r));
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('http://auth-bot.svc:7000/reloginViaSession');
    expect(calls[0].body).toEqual({ email: 'a@x.com', target: 'claude' });
  });

  it('strips trailing slash from the configured URL', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    triggerRelogin('a@x.com', 'claude', {
      url: 'http://auth-bot.svc:7000/',
      _fetch: fetchSpy,
    });
    await new Promise((r) => setImmediate(r));
    expect(fetchSpy.mock.calls[0][0]).toBe('http://auth-bot.svc:7000/reloginViaSession');
  });

  it('is disabled (no fetch) when no URL is configured', async () => {
    const fetchSpy = vi.fn();
    expect(triggerRelogin('a@x.com', 'claude', { _fetch: fetchSpy })).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('deduplicates a burst of triggers for the same (email,target) inside the cooldown window', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    const t0 = 1_000_000_000_000;
    expect(triggerRelogin('a@x.com', 'claude', { url: 'http://u', _fetch: fetchSpy, _now: () => t0 })).toBe(true);
    expect(triggerRelogin('a@x.com', 'claude', { url: 'http://u', _fetch: fetchSpy, _now: () => t0 + 10 })).toBe(false);
    expect(triggerRelogin('a@x.com', 'claude', { url: 'http://u', _fetch: fetchSpy, _now: () => t0 + 59_999 })).toBe(false);
    await new Promise((r) => setImmediate(r));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('fires again after the cooldown window passes', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    const t0 = 1_000_000_000_000;
    expect(triggerRelogin('a@x.com', 'claude', { url: 'http://u', _fetch: fetchSpy, _now: () => t0 })).toBe(true);
    expect(triggerRelogin('a@x.com', 'claude', { url: 'http://u', _fetch: fetchSpy, _now: () => t0 + 60_001 })).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('treats different emails as independent dedup keys', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    const t0 = 1_000_000_000_000;
    triggerRelogin('a@x.com', 'claude', { url: 'http://u', _fetch: fetchSpy, _now: () => t0 });
    triggerRelogin('b@x.com', 'claude', { url: 'http://u', _fetch: fetchSpy, _now: () => t0 });
    await new Promise((r) => setImmediate(r));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('swallows fetch errors (does not throw)', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('boom'); });
    // The synchronous call must not throw even though the async POST fails.
    expect(() => triggerRelogin('a@x.com', 'claude', { url: 'http://u', _fetch: fetchSpy })).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns false when email is empty', () => {
    expect(triggerRelogin('', 'claude', { url: 'http://u', _fetch: vi.fn() })).toBe(false);
    expect(triggerRelogin(null, 'claude', { url: 'http://u', _fetch: vi.fn() })).toBe(false);
  });
});
