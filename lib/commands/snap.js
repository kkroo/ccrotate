import chalk from 'chalk';
import prompts from 'prompts';

export class SnapCommand {
  constructor(ccrotate) {
    this.ccrotate = ccrotate;
  }

  async execute(force = false, options = {}) {
    const { email: pinnedEmail = null } = options;

    if (pinnedEmail != null && typeof pinnedEmail !== 'string') {
      throw new Error('snap --email must be a string');
    }

    // `getCurrentAccount()` derives the slot email from the ambient state
    // files (~/.claude.json for claude, id_token JWT for codex). When the
    // caller passes --email, that ambient derivation is the very race
    // we're trying to bypass — but we still need its credentials/userId/
    // oauthAccount payload, since those are what actually get saved.
    //
    // For claude: keep currentAccount.credentials etc., override the
    // .email used as the profile slot key, and rewrite oauthAccount so
    // the saved profile is internally consistent.
    //
    // For codex: id_token-derived email is already authoritative (the
    // JWT is signed by OpenAI). If --email is passed, validate it
    // matches and refuse on mismatch — sanity check, no override.
    const currentAccount = this.ccrotate.getCurrentAccount();

    // Identity guard. For claude, the live identity (the actual /api/oauth/profile
    // response for the token in ~/.claude/.credentials.json) is the source of truth
    // for "whose tokens are these". Without --email this is checked against the
    // ambient-derived currentAccount.email. With --email, it's checked against the
    // explicit slot — that's the whole point of the flag: stop the cross-write
    // even when ambient state has drifted.
    const targetEmail = pinnedEmail ?? currentAccount.email;

    if (this.ccrotate.isClaudeTarget?.()) {
      const liveEmail = await this.ccrotate.readLiveClaudeAuthEmail();
      if (liveEmail && liveEmail !== targetEmail) {
        if (pinnedEmail) {
          throw new Error(
            `snap aborted: --email pinned to '${pinnedEmail}', but live token belongs `
            + `to '${liveEmail}'. The CLI is logged in as the wrong account, or --email `
            + `is incorrect. Refusing to cross-write tokens for '${liveEmail}' under `
            + `the '${pinnedEmail}' slot.`,
          );
        }
        throw new Error(
          `snap aborted: claude auth status reports '${liveEmail}', but the active `
          + `config resolves to '${currentAccount.email}' — a profile switch is likely `
          + `in progress. Retry once it settles.`,
        );
      }
      if (!liveEmail) {
        console.log(chalk.dim('  (skipped claude auth status identity check — not available)'));
      }
    } else if (this.ccrotate.isCodexTarget?.() && pinnedEmail && pinnedEmail !== currentAccount.email) {
      // Codex: id_token is authoritative — if pinnedEmail doesn't match, the
      // CLI isn't logged in as the requested account. Refuse rather than
      // mutate the JWT-derived email field.
      throw new Error(
        `snap aborted: --email pinned to '${pinnedEmail}', but codex auth.json id_token `
        + `decodes to '${currentAccount.email}'. The Codex CLI is logged in as the wrong `
        + `account.`,
      );
    }

    const profiles = this.ccrotate.loadProfiles();

    if (profiles[targetEmail] && !force) {
      const response = await prompts({
        type: 'confirm',
        name: 'overwrite',
        message: `Account ${targetEmail} already exists. Overwrite?`,
        initial: false,
      });

      if (!response.overwrite) {
        console.log(chalk.yellow('Operation cancelled.'));
        return;
      }
    }

    // Save under the targetEmail slot. For claude with --email override,
    // also rewrite oauthAccount.emailAddress so the saved profile is
    // internally consistent (the stored oauthAccount otherwise still
    // reflects ambient ~/.claude.json which we're explicitly overriding).
    const accountForProfile =
      pinnedEmail && this.ccrotate.isClaudeTarget?.()
        ? {
            ...currentAccount,
            email: pinnedEmail,
            oauthAccount: { ...(currentAccount.oauthAccount ?? {}), emailAddress: pinnedEmail },
          }
        : currentAccount;
    const profile = this.ccrotate.createProfileFromCurrentAccount(accountForProfile);
    profiles[targetEmail] = profile;

    if (this.ccrotate.isCodexTarget?.()) {
      this.ccrotate.upsertCodexProfile(targetEmail, profile);
    } else {
      this.ccrotate.saveProfiles(profiles);
    }
    if (this.ccrotate.isClaudeTarget?.() && typeof this.ccrotate.clearAnthropicRateLimitState === 'function') {
      try {
        this.ccrotate.clearAnthropicRateLimitState(targetEmail);
      } catch {
        // Non-fatal cleanup; the profile save above is the authoritative relogin result.
      }
    }
    console.log(chalk.green(`✓ Account ${targetEmail} saved successfully.`));
  }
}
