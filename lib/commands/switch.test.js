import { describe, expect, it, vi } from 'vitest';
import { SwitchCommand } from './switch.js';

describe('SwitchCommand', () => {
  it('relaunches the current session after a successful switch when requested', async () => {
    const ccrotate = {
      isClaudeTarget: () => false,
      isCodexTarget: () => true,
      loadProfiles: () => ({
        'codex@example.com': { auth: { tokens: {} } }
      }),
      getCurrentAccount: () => { throw new Error('no active account'); },
      saveProfiles: vi.fn(),
      writeActiveAccountFiles: vi.fn(),
      getPostSwitchMessage: () => 'Start a new Codex session if the current process has cached auth.',
      relaunchCurrentSession: vi.fn(),
    };

    const command = new SwitchCommand(ccrotate);
    command.trySwitchCodex = vi.fn().mockResolvedValue(true);

    await command.execute('codex@example.com', { relaunch: true });

    expect(command.trySwitchCodex).toHaveBeenCalledWith('codex@example.com', expect.any(Object));
    expect(ccrotate.relaunchCurrentSession).toHaveBeenCalledTimes(1);
  });
});
