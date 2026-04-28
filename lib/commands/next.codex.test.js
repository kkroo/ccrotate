import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextCommand } from './next.js';

function makeCommand(resultsByEmail) {
  const profiles = Object.fromEntries(
    ['current@example.com', ...Object.keys(resultsByEmail)].map(email => [email, { auth: { tokens: {} } }])
  );
  const ccrotate = {
    loadProfiles: () => profiles,
    getCurrentAccount: () => ({ email: 'current@example.com' }),
    probeCodexAccount: (email) => resultsByEmail[email],
    saveTierCache: vi.fn(),
    upsertTierCacheEntries: vi.fn(),
    isCodexServiceTierSwitchable: (serviceTier) => serviceTier === 'available' || serviceTier === 'near_limit',
    relaunchCurrentSession: vi.fn(),
    getPostSwitchMessage: () => 'Start a new Codex session if the current process has cached auth.',
  };
  const command = new NextCommand(ccrotate);
  command.switchTo = vi.fn(async () => true);
  return { command, ccrotate };
}

describe('Codex next rotation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not switch to unknown Codex quota probes', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { command } = makeCommand({
      'unknown@example.com': {
        status: 'success',
        serviceTier: 'unknown',
        response: '',
        rateLimits: {},
      },
      'exhausted@example.com': {
        status: 'success',
        serviceTier: 'exhausted',
        response: '5h 0% left',
        rateLimits: { reset5h: 1777344614 },
      },
    });

    await command.executeCodex();

    expect(command.switchTo).not.toHaveBeenCalled();
  });

  it('switches only to Codex accounts with known remaining quota', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { command } = makeCommand({
      'unknown@example.com': {
        status: 'success',
        serviceTier: 'unknown',
        response: '',
        rateLimits: {},
      },
      'available@example.com': {
        status: 'success',
        serviceTier: 'available',
        response: '5h 80% left',
        rateLimits: { remaining5h: 80, remaining7d: 60 },
      },
    });

    await command.executeCodex();

    expect(command.switchTo).toHaveBeenCalledTimes(1);
    expect(command.switchTo).toHaveBeenCalledWith('available@example.com', expect.any(Object));
  });

  it('relaunches Codex after a successful switch when requested', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { command, ccrotate } = makeCommand({
      'available@example.com': {
        status: 'success',
        serviceTier: 'available',
        response: '5h 80% left',
        rateLimits: { remaining5h: 80, remaining7d: 60 },
      },
    });

    await command.executeCodex({ relaunch: true });

    expect(command.switchTo).toHaveBeenCalledTimes(1);
    expect(ccrotate.relaunchCurrentSession).toHaveBeenCalledTimes(1);
  });
});
