import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, execSync } from 'child_process';
import { SnapCommand } from './commands/snap.js';
import { ListCommand } from './commands/list.js';
import { SwitchCommand } from './commands/switch.js';
import { NextCommand } from './commands/next.js';
import { RemoveCommand } from './commands/remove.js';
import { RefreshCommand } from './commands/refresh.js';
import { RefreshOneCommand } from './commands/refresh-one.js';
import { ExportCommand } from './commands/export.js';
import { ImportCommand } from './commands/import.js';
import { StatusCommand } from './commands/status.js';

class CCRotate {
  constructor() {
    this.profilesDir = path.join(os.homedir(), '.ccrotate');
    this.profilesFile = path.join(this.profilesDir, 'profiles.json');
    this.configFile = path.join(this.profilesDir, 'config.json');
    this.claudeDir = path.join(os.homedir(), '.claude');
    this.credentialsFile = path.join(this.claudeDir, '.credentials.json');
    this.claudeConfigFile = path.join(os.homedir(), '.claude.json');
    this.claudePath = null;
    
    // Initialize commands
    this.commands = {
      snap: new SnapCommand(this),
      list: new ListCommand(this),
      switch: new SwitchCommand(this),
      next: new NextCommand(this),
      remove: new RemoveCommand(this),
      refresh: new RefreshCommand(this),
      refreshOne: new RefreshOneCommand(this),
      export: new ExportCommand(this),
      import: new ImportCommand(this),
      status: new StatusCommand(this)
    };
  }

  findClaudePath() {
    if (this.claudePath) {
      return this.claudePath;
    }

    // Step 1: Check common installation paths directly
    const commonPaths = [
      path.join(os.homedir(), '.claude/local/claude'),  // Official installation path
      '/usr/local/bin/claude',                          // macOS Homebrew
      '/opt/homebrew/bin/claude',                       // macOS ARM Homebrew  
      path.join(os.homedir(), 'bin/claude'),            // User bin
      '/usr/bin/claude'                                 // System-wide
    ];
    
    for (const claudePath of commonPaths) {
      try {
        if (fs.existsSync(claudePath) && fs.statSync(claudePath).mode & 0o111) {
          this.claudePath = claudePath;
          return claudePath;
        }
      } catch (error) {
        // Continue checking other paths
        continue;
      }
    }

    // Step 2: Try to find claude using user's shell environment
    try {
      const userShell = process.env.SHELL || '/bin/bash';
      const shellConfig = userShell.includes('zsh') ? '~/.zshrc' : 
                         userShell.includes('bash') ? '~/.bashrc' : 
                         '~/.profile';
      
      const platform = os.platform();
      const whichCommand = platform === 'win32' ? 'where claude' : 'which claude';
      
      const result = execSync(`source ${shellConfig} && ${whichCommand}`, {
        encoding: 'utf8',
        shell: userShell,
        env: process.env,
        timeout: 5000
      }).trim();
      
      if (result) {
        // Parse "claude: aliased to /path/to/claude" format
        const aliasMatch = result.match(/aliased to (.+)$/);
        if (aliasMatch) {
          const claudePath = aliasMatch[1].trim();
          if (fs.existsSync(claudePath)) {
            this.claudePath = claudePath;
            return claudePath;
          }
        }
        
        // Handle direct path result
        const directPath = result.split('\n')[0].trim();
        if (directPath && fs.existsSync(directPath)) {
          this.claudePath = directPath;
          return directPath;
        }
      }
    } catch (error) {
      // Continue to step 3
    }

    // Step 3: Check environment variable fallback
    if (process.env.CLAUDE_PATH) {
      const envPath = process.env.CLAUDE_PATH;
      try {
        if (fs.existsSync(envPath) && fs.statSync(envPath).mode & 0o111) {
          this.claudePath = envPath;
          return envPath;
        }
      } catch (error) {
        // Continue to error
      }
    }

    // Final fallback with helpful error message
    throw new Error(`Claude executable not found. Please try:
1. Reinstall claude-code: npm install -g @anthropic/claude-code
2. Set custom path: export CLAUDE_PATH="/path/to/claude"
3. Check installation: which claude`);
  }


  ensureProfilesDir() {
    if (!fs.existsSync(this.profilesDir)) {
      fs.mkdirSync(this.profilesDir, { recursive: true });
    }
  }

  loadProfiles() {
    if (!fs.existsSync(this.profilesFile)) {
      return {};
    }
    
    try {
      const data = fs.readFileSync(this.profilesFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      throw new Error(`Failed to parse profiles.json: ${error.message}`);
    }
  }

  saveProfiles(profiles) {
    this.ensureProfilesDir();
    
    try {
      const tempFile = this.profilesFile + '.tmp';
      fs.writeFileSync(tempFile, JSON.stringify(profiles, null, 2), 'utf8');
      fs.renameSync(tempFile, this.profilesFile);
    } catch (error) {
      throw new Error(`Failed to save profiles: ${error.message}`);
    }
  }

  saveTierCache(results) {
    this.ensureProfilesDir();
    const cache = {
      updatedAt: new Date().toISOString(),
      accounts: results.map(r => ({
        email: r.email,
        status: r.status,
        serviceTier: r.serviceTier || null,
        response: r.result || r.response || '',
        rateLimits: r.rateLimits || null,
      }))
    };
    try {
      fs.writeFileSync(
        path.join(this.profilesDir, 'tier-cache.json'),
        JSON.stringify(cache, null, 2),
        'utf8'
      );
    } catch { /* non-fatal */ }
  }

  loadTierCache() {
    const cacheFile = path.join(this.profilesDir, 'tier-cache.json');
    if (!fs.existsSync(cacheFile)) return null;
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {
      return null;
    }
  }

  loadConfig() {
    if (!fs.existsSync(this.configFile)) {
      return { extraUsage: 'prompt' }; // default: prompt, allow, deny
    }
    try {
      return JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
    } catch {
      return { extraUsage: 'prompt' };
    }
  }

  saveConfig(config) {
    this.ensureProfilesDir();
    fs.writeFileSync(this.configFile, JSON.stringify(config, null, 2), 'utf8');
  }

  readCredentials() {
    // macOS: Keychain first (Claude Code writes active token there after /login)
    // File is a stale cache from ccrotate switch/writeCredentials — Keychain is truth.
    if (process.platform === 'darwin') {
      try {
        const result = execSync(
          'security find-generic-password -s "Claude Code-credentials" -a "$(whoami)" -w',
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        if (result) return JSON.parse(result);
      } catch { /* not in keychain */ }
    }

    // File fallback (Linux, or macOS without Keychain entry)
    if (fs.existsSync(this.credentialsFile)) {
      const content = fs.readFileSync(this.credentialsFile, 'utf8').trim();
      if (content) {
        try { return JSON.parse(content); } catch { /* fall through */ }
      }
    }

    return null;
  }

  writeCredentials(credentials) {
    // Write to file only — Keychain is managed by Claude Code (/login).
    // ccrotate switch/refresh should NOT touch Keychain to avoid overwriting
    // the user's active login session token.
    const tempFile = this.credentialsFile + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(credentials, null, 2), 'utf8');
    fs.renameSync(tempFile, this.credentialsFile);
  }

  writeCredentialsToKeychain(credentials) {
    // Only called by explicit user actions (switch) that intend to change the active session.
    if (process.platform !== 'darwin') return;
    try {
      execSync('security delete-generic-password -s "Claude Code-credentials" -a "$(whoami)" 2>/dev/null', { stdio: 'pipe' });
    } catch { /* didn't exist */ }
    try {
      const json = JSON.stringify(credentials);
      execSync(`security add-generic-password -s "Claude Code-credentials" -a "$(whoami)" -w '${json.replace(/'/g, "'\\''")}'`, { stdio: 'pipe' });
    } catch { /* non-fatal */ }
  }

  getCurrentAccount() {
    const credentials = this.readCredentials();
    if (!credentials) {
      throw new Error('No active Claude account found. Please login with claude-code first.');
    }

    if (!fs.existsSync(this.claudeConfigFile)) {
      throw new Error('Claude config file not found. Please login with claude-code first.');
    }

    try {
      const config = JSON.parse(fs.readFileSync(this.claudeConfigFile, 'utf8'));

      if (!config.oauthAccount || !config.oauthAccount.emailAddress) {
        throw new Error('No OAuth account information found in Claude config.');
      }

      return {
        email: config.oauthAccount.emailAddress,
        credentials,
        userId: config.userId,
        oauthAccount: config.oauthAccount
      };
    } catch (error) {
      throw new Error(`Failed to read current account: ${error.message}`);
    }
  }

  writeClaudeFiles(accountData) {
    try {
      // Write credentials (file + Keychain)
      this.writeCredentials(accountData.credentials);

      // Write config
      const configTemp = this.claudeConfigFile + '.tmp';
      const currentConfig = fs.existsSync(this.claudeConfigFile)
        ? JSON.parse(fs.readFileSync(this.claudeConfigFile, 'utf8'))
        : {};

      const newConfig = {
        ...currentConfig,
        userId: accountData.userId,
        oauthAccount: accountData.oauthAccount
      };

      fs.writeFileSync(configTemp, JSON.stringify(newConfig, null, 2), 'utf8');
      fs.renameSync(configTemp, this.claudeConfigFile);
    } catch (error) {
      throw new Error(`Failed to write account files: ${error.message}`);
    }
  }

  async snap(force = false) {
    return this.commands.snap.execute(force);
  }

  async list() {
    return this.commands.list.execute();
  }

  async switch(email) {
    return this.commands.switch.execute(email);
  }

  async next(options = {}) {
    return this.commands.next.execute(options);
  }

  async remove(email) {
    return this.commands.remove.execute(email);
  }

  backupCurrentCredentials() {
    const backup = {
      credentials: null,
      config: null
    };

    try {
      if (fs.existsSync(this.credentialsFile)) {
        backup.credentials = fs.readFileSync(this.credentialsFile, 'utf8');
      }
      if (fs.existsSync(this.claudeConfigFile)) {
        backup.config = fs.readFileSync(this.claudeConfigFile, 'utf8');
      }
    } catch (error) {
      throw new Error(`Failed to backup current credentials: ${error.message}`);
    }

    return backup;
  }

  restoreCredentials(backup) {
    try {
      if (backup.credentials && fs.existsSync(this.credentialsFile)) {
        fs.writeFileSync(this.credentialsFile, backup.credentials, 'utf8');
      }
      if (backup.config && fs.existsSync(this.claudeConfigFile)) {
        fs.writeFileSync(this.claudeConfigFile, backup.config, 'utf8');
      }
    } catch (error) {
      throw new Error(`Failed to restore credentials: ${error.message}`);
    }
  }

  /** Clear usage API cooldown cache. Called by refresh to force fresh probes. */
  clearCooldowns() {
    const cacheFile = path.join(this.profilesDir, 'usage-api-cooldowns.json');
    try { fs.unlinkSync(cacheFile); } catch { /* didn't exist */ }
  }

  /**
   * Fetch per-account usage via /api/oauth/usage.
   * Rate-limited to ~1 call/hour per token. Caches 429s to avoid
   * retriggering cooldowns on every refresh.
   */
  async fetchAccountUsage(token) {
    // Check if this token is on cooldown
    const cacheFile = path.join(this.profilesDir, 'usage-api-cooldowns.json');
    let cooldowns = {};
    try { cooldowns = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}

    // Use hash of token as cache key (tokens in same org can share suffixes)
    const { createHash } = await import('crypto');
    const tokenKey = createHash('sha256').update(token).digest('hex').slice(0, 16);
    const cooldownUntil = cooldowns[tokenKey];
    if (cooldownUntil && Date.now() < cooldownUntil) {
      return null; // still on cooldown, skip
    }

    const { default: https } = await import('https');
    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/api/oauth/usage',
        method: 'GET',
        headers: {
          'Authorization': 'Bearer ' + token,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'claude-code/1.0.38',
          'x-app': 'cli'
        }
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode === 429) {
            // Cache cooldown: retry-after header or default 1 hour
            const retryAfter = parseInt(res.headers['retry-after'] || '3600', 10);
            cooldowns[tokenKey] = Date.now() + (retryAfter > 0 ? retryAfter : 3600) * 1000;
            try { fs.writeFileSync(cacheFile, JSON.stringify(cooldowns)); } catch {}
            resolve(null);
            return;
          }
          if (res.statusCode !== 200) { resolve(null); return; }
          // Success — clear cooldown
          delete cooldowns[tokenKey];
          try { fs.writeFileSync(cacheFile, JSON.stringify(cooldowns)); } catch {}
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      const t = setTimeout(() => { req.destroy(); resolve(null); }, 8000);
      req.on('close', () => clearTimeout(t));
      req.end();
    });
  }

  /** Parse /api/oauth/usage response into standard result format. */
  parseUsageResult(usageData, email) {
    const u7d = usageData.seven_day?.utilization;
    const u5h = usageData.five_hour?.utilization;
    const extra = usageData.extra_usage || {};
    const resetAt = usageData.seven_day?.resets_at;
    const usedCredits = extra.used_credits || 0;

    let effectiveTier = 'base';
    if (u7d != null && u7d >= 100) effectiveTier = 'exhausted';
    else if (extra.is_enabled && usedCredits > 0) effectiveTier = 'extra';

    const parts = [];
    if (u5h != null) parts.push(`5h:${Math.round(u5h)}%`);
    if (u7d != null) parts.push(`7d:${Math.round(u7d)}%`);
    if (usedCredits > 0) parts.push(`extra:$${(usedCredits / 100).toFixed(2)}`);
    const display = effectiveTier + (parts.length ? ` (${parts.join(' ')})` : '');

    return {
      status: 'success',
      response: display,
      serviceTier: effectiveTier,
      rateLimits: { utilization5h: u5h, utilization7d: u7d, resetAt, extra },
    };
  }

  /**
   * Test account via /v1/messages headers (org-level, always available).
   * Uses max_tokens:1 Haiku call — ~2s, minimal cost.
   */
  async testAccountViaMessages(token) {
    const { default: https } = await import('https');
    return new Promise((resolve) => {
      const body = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'x' }]
      });

      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': token,
          'anthropic-version': '2023-06-01',
          'x-app': 'cli'
        }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          const h = res.headers;
          const rateLimits = {
            status: h['anthropic-ratelimit-unified-status'] || null,
            utilization5h: h['anthropic-ratelimit-unified-5h-utilization'] ? parseFloat(h['anthropic-ratelimit-unified-5h-utilization']) : null,
            utilization7d: h['anthropic-ratelimit-unified-7d-utilization'] ? parseFloat(h['anthropic-ratelimit-unified-7d-utilization']) : null,
            reset5h: h['anthropic-ratelimit-unified-5h-reset'] ? Number(h['anthropic-ratelimit-unified-5h-reset']) : null,
            reset7d: h['anthropic-ratelimit-unified-7d-reset'] ? Number(h['anthropic-ratelimit-unified-7d-reset']) : null,
            overageInUse: h['anthropic-ratelimit-unified-overage-in-use'] === 'true',
            overageStatus: h['anthropic-ratelimit-unified-overage-status'] || null,
          };

          let effectiveTier = 'base';
          if (rateLimits.overageInUse) effectiveTier = 'extra';
          else if (rateLimits.status === 'rejected') effectiveTier = 'exhausted';

          // Format reset countdown
          const now = Date.now() / 1000;
          const fmtReset = (epoch) => {
            if (!epoch) return null;
            const d = epoch - now;
            if (d <= 0) return 'now';
            const m = Math.floor(d / 60);
            if (m < 60) return `${m}m`;
            const hr = Math.floor(m / 60);
            const rm = m % 60;
            return rm > 0 ? `${hr}h${rm}m` : `${hr}h`;
          };

          if (res.statusCode === 429) {
            let errorMsg = 'Rate limited';
            try { errorMsg = JSON.parse(data)?.error?.message || errorMsg; } catch {}
            resolve({ status: 'error', response: errorMsg.substring(0, 150), serviceTier: effectiveTier, rateLimits });
            return;
          }

          try {
            JSON.parse(data); // validate response
            const pct5h = rateLimits.utilization5h != null ? Math.round(rateLimits.utilization5h * 100) : null;
            const pct7d = rateLimits.utilization7d != null ? Math.round(rateLimits.utilization7d * 100) : null;
            const parts = [];
            if (pct5h != null) {
              let s = `5h:${pct5h}%`;
              if (pct5h >= 90) { const r = fmtReset(rateLimits.reset5h); if (r) s += `→${r}`; }
              parts.push(s);
            }
            if (pct7d != null) {
              let s = `7d:${pct7d}%`;
              if (pct7d >= 90) { const r = fmtReset(rateLimits.reset7d); if (r) s += `→${r}`; }
              parts.push(s);
            }
            const display = effectiveTier + ' [org]' + (parts.length ? ` (${parts.join(' ')})` : '');

            resolve({ status: 'success', response: display, serviceTier: effectiveTier, rateLimits });
          } catch {
            resolve({ status: 'error', response: `HTTP ${res.statusCode}`, serviceTier: null, rateLimits });
          }
        });
      });

      req.on('error', (e) => {
        resolve({ status: 'error', response: e.message.substring(0, 150), serviceTier: null });
      });

      const timeout = setTimeout(() => {
        req.destroy();
        resolve({ status: 'error', response: 'Timeout after 10s', serviceTier: null });
      }, 10000);

      req.on('close', () => clearTimeout(timeout));
      req.write(body);
      req.end();
    });
  }

  /**
   * Test one account. Tries /api/oauth/usage if usageApiAvailable is true,
   * otherwise goes straight to /v1/messages fallback.
   * Returns { status, response, serviceTier, rateLimits, credentialsUpdated, usageApiWorked }
   */
  async testAccount(email, { tryUsageApi = true, usageApiOnly = false, token: explicitToken } = {}) {
    try {
      const token = explicitToken || this.readCredentials()?.claudeAiOauth?.accessToken;

      if (!token) {
        return { status: 'error', response: 'No access token', serviceTier: null, credentialsUpdated: false, usageApiWorked: false };
      }

      // Always try per-account usage API first (per-token 1hr cooldown)
      if (tryUsageApi) {
        const usageData = await this.fetchAccountUsage(token);
        if (usageData) {
          const result = this.parseUsageResult(usageData, email);
          const credentialsUpdated = this.checkAndUpdateProfile(email);
          return { ...result, credentialsUpdated, usageApiWorked: true };
        }
      }

      // usageApiOnly: skip /v1/messages fallback (used by `next` to avoid burning tokens)
      if (usageApiOnly) {
        return { status: 'unknown', response: 'Usage API unavailable', serviceTier: null, credentialsUpdated: false, usageApiWorked: false };
      }

      // Fallback: /v1/messages (org-level)
      const result = await this.testAccountViaMessages(token);
      const credentialsUpdated = this.checkAndUpdateProfile(email);
      return { ...result, credentialsUpdated, usageApiWorked: false };

    } catch (error) {
      return { status: 'error', response: error.message.substring(0, 150), serviceTier: null, credentialsUpdated: false, usageApiWorked: false };
    }
  }

  checkAndUpdateProfile(email) {
    try {
      const profiles = this.loadProfiles();
      if (!profiles[email]) {
        return false;
      }

      // Get current credentials from Claude files
      const currentCredentials = JSON.parse(fs.readFileSync(this.credentialsFile, 'utf8'));
      const currentConfig = JSON.parse(fs.readFileSync(this.claudeConfigFile, 'utf8'));

      const storedProfile = profiles[email];
      
      // Compare credentials to check for updates
      const credentialsChanged = JSON.stringify(storedProfile.credentials) !== JSON.stringify(currentCredentials);
      const configChanged = JSON.stringify(storedProfile.oauthAccount) !== JSON.stringify(currentConfig.oauthAccount) ||
                           storedProfile.userId !== currentConfig.userId;

      if (credentialsChanged || configChanged) {
        // Update the profile with new credentials
        profiles[email] = {
          ...storedProfile,
          credentials: currentCredentials,
          userId: currentConfig.userId,
          oauthAccount: currentConfig.oauthAccount,
          lastUsed: new Date().toISOString()
        };

        this.saveProfiles(profiles);
        return true;
      }

      return false;
    } catch (error) {
      console.error(`Error checking profile update for ${email}:`, error.message);
      return false;
    }
  }

  async refresh() {
    return this.commands.refresh.execute();
  }

  async refreshOne() {
    return this.commands.refreshOne.execute();
  }

  async export() {
    return this.commands.export.execute();
  }

  async import(compressedData) {
    return this.commands.import.execute(compressedData);
  }

  async status(options = {}) {
    return this.commands.status.execute(options);
  }
}

export default CCRotate;