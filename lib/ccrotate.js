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
    // Try file first, then macOS Keychain
    if (fs.existsSync(this.credentialsFile)) {
      const content = fs.readFileSync(this.credentialsFile, 'utf8').trim();
      if (content) {
        try { return JSON.parse(content); } catch { /* fall through */ }
      }
    }

    // macOS Keychain fallback
    if (process.platform === 'darwin') {
      try {
        const result = execSync(
          'security find-generic-password -s "Claude Code-credentials" -a "$(whoami)" -w',
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        if (result) return JSON.parse(result);
      } catch { /* not in keychain */ }
    }

    return null;
  }

  writeCredentials(credentials) {
    // Write to file
    const tempFile = this.credentialsFile + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(credentials, null, 2), 'utf8');
    fs.renameSync(tempFile, this.credentialsFile);

    // Also update macOS Keychain
    if (process.platform === 'darwin') {
      try {
        execSync('security delete-generic-password -s "Claude Code-credentials" -a "$(whoami)" 2>/dev/null', { stdio: 'pipe' });
      } catch { /* didn't exist */ }
      try {
        const json = JSON.stringify(credentials);
        execSync(`security add-generic-password -s "Claude Code-credentials" -a "$(whoami)" -w '${json.replace(/'/g, "'\\''")}'`, { stdio: 'pipe' });
      } catch { /* non-fatal */ }
    }
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

  async testAccount(email) {
    // Direct API call to platform.claude.com with max_tokens:1.
    // Works inside active Claude Code sessions (no process lock).
    // 429 = base usage exhausted. 200 + service_tier = current tier.
    // Note: utilization % reflects extra usage pool, not base — we don't display it.
    try {
      const creds = this.readCredentials();
      const token = creds?.claudeAiOauth?.accessToken;

      if (!token) {
        return { status: 'error', response: 'No access token', serviceTier: null, credentialsUpdated: false };
      }

      const { default: https } = await import('https');

      const result = await new Promise((resolve) => {
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
            // Parse rate limit headers — these are the real Claude Code usage numbers
            const h = res.headers;
            const rateLimits = {
              status: h['anthropic-ratelimit-unified-status'] || null,
              utilization5h: h['anthropic-ratelimit-unified-5h-utilization'] ? parseFloat(h['anthropic-ratelimit-unified-5h-utilization']) : null,
              utilization7d: h['anthropic-ratelimit-unified-7d-utilization'] ? parseFloat(h['anthropic-ratelimit-unified-7d-utilization']) : null,
              reset5h: h['anthropic-ratelimit-unified-5h-reset'] || null,
              reset7d: h['anthropic-ratelimit-unified-7d-reset'] || null,
              overageInUse: h['anthropic-ratelimit-unified-overage-in-use'] === 'true',
              overageStatus: h['anthropic-ratelimit-unified-overage-status'] || null,
            };

            // Determine effective tier from headers
            let effectiveTier = 'standard';
            if (rateLimits.overageInUse) {
              effectiveTier = 'extra';
            } else if (rateLimits.status === 'rejected') {
              effectiveTier = 'exhausted';
            }

            if (res.statusCode === 429) {
              let errorMsg = 'Rate limited';
              try { errorMsg = JSON.parse(data)?.error?.message || errorMsg; } catch {}
              resolve({ status: 'error', response: errorMsg.substring(0, 150), serviceTier: effectiveTier, rateLimits });
              return;
            }

            try {
              const json = JSON.parse(data);
              if (json.error) {
                resolve({ status: 'error', response: (json.error.message || 'Error').substring(0, 150), serviceTier: effectiveTier, rateLimits });
                return;
              }

              // Build display response
              const pct5h = rateLimits.utilization5h != null ? Math.round(rateLimits.utilization5h * 100) : null;
              const pct7d = rateLimits.utilization7d != null ? Math.round(rateLimits.utilization7d * 100) : null;
              let display = effectiveTier;
              if (pct5h != null) display += ` (5h:${pct5h}%`;
              if (pct7d != null) display += ` 7d:${pct7d}%`;
              if (pct5h != null) display += ')';

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

      const credentialsUpdated = this.checkAndUpdateProfile(email);
      return { ...result, credentialsUpdated };

    } catch (error) {
      return { status: 'error', response: error.message.substring(0, 150), serviceTier: null, credentialsUpdated: false };
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