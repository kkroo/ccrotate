import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhenCommand } from './when.js';

describe('WhenCommand', () => {
  let logSpy;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.useRealTimers();
  });

  it('shows Codex cache availability using saved reset windows', async () => {
    const command = new WhenCommand({
      isCodexTarget: () => true,
      loadTierCache: () => ({
        updatedAt: '2025-12-31T23:30:00Z',
        accounts: [
          {
            email: 'current@example.com',
            serviceTier: 'available',
            rateLimits: {
              remaining5h: 42,
              remaining7d: 70,
              reset5h: Math.floor(new Date('2026-01-01T03:00:00Z').getTime() / 1000),
              reset7d: Math.floor(new Date('2026-01-05T00:00:00Z').getTime() / 1000)
            }
          },
          {
            email: 'waiting@example.com',
            serviceTier: 'exhausted',
            rateLimits: {
              remaining5h: 0,
              remaining7d: 65,
              reset5h: Math.floor(new Date('2026-01-01T02:00:00Z').getTime() / 1000),
              reset7d: Math.floor(new Date('2026-01-06T00:00:00Z').getTime() / 1000)
            }
          }
        ]
      }),
      loadProfiles: () => ({
        'current@example.com': { auth: { tokens: {} } },
        'waiting@example.com': { auth: { tokens: {} } }
      }),
      getCurrentAccount: () => ({ email: 'current@example.com' })
    });

    await command.execute();

    const output = logSpy.mock.calls.map(([line = '']) => line);
    expect(output).toContain('Cache: 30min old');
    expect(output.some(line => line.includes('current@example.com') && line.includes('usable now'))).toBe(true);
    expect(output.some(line => line.includes('waiting@example.com') && line.includes('in 2h0m'))).toBe(true);
  });

  it('refreshes a stale Codex cache before rendering', async () => {
    const refresh = vi.fn().mockResolvedValue();
    const loadTierCache = vi.fn()
      .mockReturnValueOnce({
        updatedAt: '2025-12-31T20:00:00Z',
        accounts: [
          {
            email: 'codex@example.com',
            status: 'success',
            serviceTier: 'available',
            rateLimits: {
              remaining5h: 42,
              remaining7d: 69,
              reset5h: Math.floor(new Date('2026-01-01T03:00:00Z').getTime() / 1000),
              reset7d: Math.floor(new Date('2026-01-05T00:00:00Z').getTime() / 1000)
            }
          }
        ]
      })
      .mockReturnValueOnce({
        updatedAt: '2026-01-01T00:00:00Z',
        accounts: [
          {
            email: 'codex@example.com',
            status: 'success',
            serviceTier: 'available',
            rateLimits: {
              remaining5h: 42,
              remaining7d: 69,
              reset5h: Math.floor(new Date('2026-01-01T03:00:00Z').getTime() / 1000),
              reset7d: Math.floor(new Date('2026-01-05T00:00:00Z').getTime() / 1000)
            }
          }
        ]
      });

    const command = new WhenCommand({
      isCodexTarget: () => true,
      refresh,
      loadTierCache,
      loadProfiles: () => ({
        'codex@example.com': { auth: { tokens: {} } }
      }),
      getCurrentAccount: () => ({ email: 'codex@example.com' })
    });

    await command.execute();

    const output = logSpy.mock.calls.map(([line = '']) => line);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(output).toContain('Cache: 0min old');
    expect(output.some(line => line.includes('codex@example.com') && line.includes('usable now'))).toBe(true);
  });

  it('refreshes a stale Claude cache before rendering', async () => {
    const refresh = vi.fn().mockResolvedValue();
    const loadTierCache = vi.fn()
      .mockReturnValueOnce({
        updatedAt: '2025-12-31T20:00:00Z',
        accounts: [
          {
            email: 'claude@example.com',
            serviceTier: 'standard',
            rateLimits: {
              utilization5h: 42,
              utilization7d: 69,
              reset5h: Math.floor(new Date('2026-01-01T03:00:00Z').getTime() / 1000),
              reset7d: Math.floor(new Date('2026-01-05T00:00:00Z').getTime() / 1000)
            }
          }
        ]
      })
      .mockReturnValueOnce({
        updatedAt: '2026-01-01T00:00:00Z',
        accounts: [
          {
            email: 'claude@example.com',
            serviceTier: 'standard',
            rateLimits: {
              utilization5h: 42,
              utilization7d: 69,
              reset5h: Math.floor(new Date('2026-01-01T03:00:00Z').getTime() / 1000),
              reset7d: Math.floor(new Date('2026-01-05T00:00:00Z').getTime() / 1000)
            }
          }
        ]
      });

    const command = new WhenCommand({
      isCodexTarget: () => false,
      refresh,
      loadTierCache,
      loadProfiles: () => ({
        'claude@example.com': { credentials: { claudeAiOauth: { accessToken: 'token' } } }
      }),
      getCurrentAccount: () => ({ email: 'claude@example.com' })
    });

    await command.execute();

    const output = logSpy.mock.calls.map(([line = '']) => line);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(output).toContain('Cache: 0min old');
    expect(output.some(line => line.includes('claude@example.com') && line.includes('usable now'))).toBe(true);
  });

  it('prints a Codex-specific cache hint when no cache is available', async () => {
    const command = new WhenCommand({
      isCodexTarget: () => true,
      loadTierCache: () => null
    });

    await command.execute();

    expect(logSpy).toHaveBeenCalledWith(
      'No tier-cache data. Run `ccrotate status`, `ccrotate refresh`, or `ccrotate next` first.'
    );
  });

  it('does not claim refresh is needed after a Codex probe returned no per-account data', async () => {
    const command = new WhenCommand({
      isCodexTarget: () => true,
      loadTierCache: () => ({
        updatedAt: '2026-01-01T00:00:00Z',
        accounts: [
          {
            email: 'unknown@example.com',
            status: 'success',
            serviceTier: 'unknown',
            rateLimits: {
              remaining5h: null,
              remaining7d: null,
              reset5h: null,
              reset7d: null
            }
          }
        ]
      }),
      loadProfiles: () => ({
        'unknown@example.com': { auth: { tokens: {} } }
      }),
      getCurrentAccount: () => ({ email: 'unknown@example.com' })
    });

    await command.execute();

    const output = logSpy.mock.calls.map(([line = '']) => line);
    expect(output.some(line => line.includes('unknown@example.com') && line.includes('no per-account data'))).toBe(true);
  });
});
