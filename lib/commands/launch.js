import chalk from 'chalk';
import { spawn } from 'child_process';

const SUPPORTED_TARGETS = new Set(['claude', 'codex']);

export class LaunchCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute(target, options = {}) {
    const resolvedTarget = this.resolveTarget(target);
    if (!resolvedTarget) {
      throw new Error(
        `Unknown target. Pass 'claude' or 'codex' (got '${target}'). `
          + `Or set CCROTATE_TARGET=claude|codex.`,
      );
    }

    // Re-target ccrotate at the requested binary so rotation/profile lookups
    // use the right account pool. The constructor auto-detects, but we may
    // want to launch the OTHER tool than ccrotate first guessed.
    if (this.ccrotate.target !== resolvedTarget) {
      this.ccrotate.target = resolvedTarget;
      this.ccrotate.profilesFile = this.ccrotate.getProfilesFileForTarget(resolvedTarget);
      this.ccrotate.tierCacheFile = this.ccrotate.getTierCacheFileForTarget(resolvedTarget);
    }

    if (!options.skipRotate) {
      console.log(chalk.dim(`→ Rotating ${resolvedTarget} account...`));
      try {
        await this.ccrotate.next({ yes: !options.deny, deny: !!options.deny });
      } catch (err) {
        // Don't block launch on rotation failure (e.g. only-one-account case).
        // The account on disk is still usable.
        console.log(chalk.yellow(`  Rotation skipped: ${err.message}`));
      }
    }

    const binary = resolvedTarget;
    const passThrough = options.passThrough ?? [];
    console.log(chalk.dim(`→ exec ${[binary, ...passThrough].join(' ')}`));

    // exec semantics: replace this process so the user's terminal is owned
    // by the launched CLI (ctrl-c, suspend, exit codes all flow naturally).
    const child = spawn(binary, passThrough, {
      stdio: 'inherit',
      env: process.env,
    });

    return new Promise((resolve, reject) => {
      child.on('error', (err) => {
        if (err.code === 'ENOENT') {
          reject(new Error(`'${binary}' not found in PATH. Install it first.`));
        } else {
          reject(err);
        }
      });
      child.on('exit', (code, signal) => {
        if (signal) {
          process.kill(process.pid, signal);
          return;
        }
        process.exit(code ?? 0);
      });
    });
  }

  resolveTarget(explicit) {
    if (explicit) {
      const normalized = String(explicit).trim().toLowerCase();
      return SUPPORTED_TARGETS.has(normalized) ? normalized : null;
    }
    return this.ccrotate.target;
  }
}
