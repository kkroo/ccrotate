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
import { WhenCommand } from './commands/when.js';
import { RepairCommand } from './commands/repair.js';
import { ExportCommand } from './commands/export.js';
import { ImportCommand } from './commands/import.js';
import { StatusCommand } from './commands/status.js';

const SUPPORTED_TARGETS = new Set(['claude', 'codex']);

class CCRotate {
  constructor() {
    this.profilesDir = path.join(os.homedir(), '.ccrotate');
    this.configFile = path.join(this.profilesDir, 'config.json');
    this.target = this.detectTarget();
    this.profilesFile = this.getProfilesFileForTarget(this.target);
    this.tierCacheFile = this.getTierCacheFileForTarget(this.target);
    this.claudeDir = path.join(os.homedir(), '.claude');
    this.credentialsFile = path.join(this.claudeDir, '.credentials.json');
    this.claudeConfigFile = path.join(os.homedir(), '.claude.json');
    this.codexDir = path.join(os.homedir(), '.codex');
    this.codexAuthFile = path.join(this.codexDir, 'auth.json');
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
      when: new WhenCommand(this),
      repair: new RepairCommand(this),
      export: new ExportCommand(this),
      import: new ImportCommand(this),
      status: new StatusCommand(this)
    };
  }

  normalizeTarget(target) {
    const normalized = String(target || '').trim().toLowerCase();
    return SUPPORTED_TARGETS.has(normalized) ? normalized : null;
  }

  detectTarget() {
    const envTarget = this.detectTargetFromEnv();
    if (envTarget) return envTarget;

    const processTarget = this.detectTargetFromParentProcess();
    if (processTarget) return processTarget;

    return 'claude';
  }

  detectTargetFromEnv(env = process.env) {
    const keys = Object.keys(env);
    if (keys.some(key => key.startsWith('CODEX_')) || env.OPENAI_API_KEY) {
      return 'codex';
    }
    if (keys.some(key => key.startsWith('CLAUDE'))) {
      return 'claude';
    }
    return null;
  }

  detectTargetFromParentProcess() {
    try {
      let pid = process.ppid;
      const visited = new Set();
      while (pid && !visited.has(pid)) {
        visited.add(pid);
        const info = this.readProcessInfo(pid);
        if (!info) break;

        const command = `${info.command} ${info.args}`.toLowerCase();
        if (/\bcodex\b/.test(command)) return 'codex';
        if (/\bclaude\b/.test(command)) return 'claude';

        if (!info.ppid || info.ppid === pid) break;
        pid = info.ppid;
      }
    } catch {
      // Fall back to default target.
    }

    return null;
  }

  readProcessInfo(pid) {
    const platform = os.platform();
    if (platform === 'darwin' || platform === 'linux') {
      const output = execSync(`ps -o ppid=,comm=,args= -p ${pid}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      if (!output) return null;

      const match = output.match(/^\s*(\d+)\s+(\S+)\s*(.*)$/);
      if (!match) return null;

      return {
        ppid: Number(match[1]),
        command: match[2],
        args: match[3] || ''
      };
    }

    return null;
  }

  getProfilesFileForTarget(target) {
    if (target === 'claude') {
      return path.join(this.profilesDir, 'profiles.json');
    }
    return path.join(this.profilesDir, `profiles.${target}.json`);
  }

  getTierCacheFileForTarget(target) {
    if (target === 'claude') {
      return path.join(this.profilesDir, 'tier-cache.json');
    }
    return path.join(this.profilesDir, `tier-cache.${target}.json`);
  }

  isClaudeTarget() {
    return this.target === 'claude';
  }

  isCodexTarget() {
    return this.target === 'codex';
  }

  getTargetName() {
    return this.isClaudeTarget() ? 'Claude Code' : 'Codex';
  }

  ensureClaudeFeature(feature) {
    if (!this.isClaudeTarget()) {
      throw new Error(`${feature} is only available in Claude Code mode. Current target: ${this.getTargetName()}.`);
    }
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
      fs.writeFileSync(this.tierCacheFile, JSON.stringify(cache, null, 2), 'utf8');
    } catch { /* non-fatal */ }
  }

  loadTierCache() {
    if (!fs.existsSync(this.tierCacheFile)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.tierCacheFile, 'utf8'));
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

  readCodexAuth() {
    if (!fs.existsSync(this.codexAuthFile)) {
      return null;
    }

    const content = fs.readFileSync(this.codexAuthFile, 'utf8').trim();
    if (!content) return null;

    try {
      return JSON.parse(content);
    } catch (error) {
      throw new Error(`Failed to parse Codex auth file: ${error.message}`);
    }
  }

  writeCredentials(credentials) {
    // Write to file only — Keychain is managed by Claude Code (/login).
    // ccrotate switch/refresh should NOT touch Keychain to avoid overwriting
    // the user's active login session token.
    const tempFile = this.credentialsFile + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(credentials, null, 2), 'utf8');
    fs.renameSync(tempFile, this.credentialsFile);
  }

  writeCodexAuth(auth) {
    const tempFile = this.codexAuthFile + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(auth, null, 2), 'utf8');
    fs.renameSync(tempFile, this.codexAuthFile);
  }

  decodeJwtPayload(token) {
    if (!token) return null;
    try {
      const [, payload] = token.split('.');
      if (!payload) return null;
      return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Check the status of an access token against /v1/messages (what Claude Code uses).
   * Returns one of:
   *   'usable'      — token works, API call succeeded (HTTP 200)
   *   'rate_limited' — token valid but account out of quota (HTTP 429)
   *   'invalid'     — token rejected (HTTP 401/403)
   *   'unknown'     — network error or unexpected response (don't block)
   */
  async checkTokenStatus(token) {
    if (!token) return 'invalid';
    const { default: https } = await import('https');
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'x' }]
    });
    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
          'x-app': 'cli'
        }
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          if (res.statusCode === 200) resolve('usable');
          else if (res.statusCode === 429) resolve('rate_limited');
          else if (res.statusCode === 401 || res.statusCode === 403) resolve('invalid');
          else resolve('unknown');
        });
      });
      req.on('error', () => resolve('unknown'));
      const t = setTimeout(() => { req.destroy(); resolve('unknown'); }, 8000);
      req.on('close', () => clearTimeout(t));
      req.write(body);
      req.end();
    });
  }

  /**
   * Legacy: returns true if token is accepted (usable OR rate_limited), false if rejected.
   * Kept for callers that only care about "can we keep this token".
   */
  async validateToken(token) {
    const s = await this.checkTokenStatus(token);
    return s === 'usable' || s === 'rate_limited' || s === 'unknown';
  }

  /**
   * Refresh an expired access token using the refresh token.
   * Returns updated credentials, or null on failure.
   * IMPORTANT: OAuth refresh tokens rotate on use — calling this
   * invalidates the old refresh token. Always save the result.
   */
  async refreshAccessToken(credentials) {
    const oauth = credentials?.claudeAiOauth;
    if (!oauth?.refreshToken) return null;

    const { default: https } = await import('https');
    return new Promise((resolve) => {
      const body = JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      });

      const req = https.request({
        hostname: 'platform.claude.com',
        path: '/v1/oauth/token',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) { resolve(null); return; }
          try {
            const resp = JSON.parse(data);
            const updated = { ...credentials, claudeAiOauth: {
              ...oauth,
              accessToken: resp.access_token,
              refreshToken: resp.refresh_token || oauth.refreshToken,
              expiresAt: Date.now() + (resp.expires_in || 3600) * 1000,
            }};
            resolve(updated);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      setTimeout(() => { req.destroy(); resolve(null); }, 10000);
      req.write(body);
      req.end();
    });
  }

  readKeychainRaw() {
    if (process.platform !== 'darwin') return null;
    try {
      const result = execSync(
        'security find-generic-password -s "Claude Code-credentials" -a "$(whoami)" -w',
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      if (result) return JSON.parse(result);
    } catch { /* not in keychain */ }
    return null;
  }

  writeCredentialsToKeychain(credentials) {
    // Only called by explicit user actions (switch) that intend to change the active session.
    if (process.platform !== 'darwin') return;

    // Preserve mcpOAuth from the CURRENT keychain entry. MCP OAuth tokens
    // (Linear, Slack, etc.) are per-server, not per-account — they must
    // survive across account switches.
    const existing = this.readKeychainRaw();
    const merged = { ...credentials };
    if (existing?.mcpOAuth) {
      merged.mcpOAuth = existing.mcpOAuth;
    }

    try {
      execSync('security delete-generic-password -s "Claude Code-credentials" -a "$(whoami)" 2>/dev/null', { stdio: 'pipe' });
    } catch { /* didn't exist */ }
    try {
      const json = JSON.stringify(merged);
      execSync(`security add-generic-password -s "Claude Code-credentials" -a "$(whoami)" -w '${json.replace(/'/g, "'\\''")}'`, { stdio: 'pipe' });
    } catch { /* non-fatal */ }
  }

  getCurrentAccount() {
    if (this.isCodexTarget()) {
      return this.getCurrentCodexAccount();
    }

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

  getCurrentCodexAccount() {
    const auth = this.readCodexAuth();
    if (!auth) {
      throw new Error('No active Codex account found. Please login with Codex first.');
    }

    const tokenClaims = this.decodeJwtPayload(auth.tokens?.id_token);
    const email = tokenClaims?.email || auth.tokens?.account_id;
    if (!email) {
      throw new Error('No account identity found in Codex auth.json.');
    }

    return {
      email,
      name: tokenClaims?.name || null,
      auth,
      accountId: auth.tokens?.account_id || tokenClaims?.sub || null,
      tokenClaims: tokenClaims ? {
        email: tokenClaims.email || null,
        name: tokenClaims.name || null,
        sub: tokenClaims.sub || null,
        exp: tokenClaims.exp || null,
        iss: tokenClaims.iss || null
      } : null
    };
  }

  createProfileFromCurrentAccount(currentAccount) {
    if (this.isCodexTarget()) {
      return {
        provider: 'codex',
        auth: currentAccount.auth,
        accountId: currentAccount.accountId,
        name: currentAccount.name || null,
        tokenClaims: currentAccount.tokenClaims,
        lastUsed: new Date().toISOString()
      };
    }

    return {
      provider: 'claude',
      credentials: currentAccount.credentials,
      userId: currentAccount.userId,
      oauthAccount: currentAccount.oauthAccount,
      lastUsed: new Date().toISOString()
    };
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

  writeCodexFiles(accountData) {
    try {
      this.writeCodexAuth(accountData.auth);
    } catch (error) {
      throw new Error(`Failed to write Codex auth: ${error.message}`);
    }
  }

  writeActiveAccountFiles(accountData) {
    if (this.isCodexTarget()) {
      this.writeCodexFiles(accountData);
      return;
    }

    this.writeClaudeFiles(accountData);
  }

  getProfileExpiry(profile) {
    if (profile?.provider === 'codex' || (this.isCodexTarget() && profile?.auth)) {
      return profile?.tokenClaims?.exp ? profile.tokenClaims.exp * 1000 : null;
    }

    return profile?.credentials?.claudeAiOauth?.expiresAt || null;
  }

  getPostSwitchMessage() {
    if (this.isCodexTarget()) {
      return '  Start a new Codex session if the current process has cached auth.';
    }
    return '  Active session will pick up new credentials automatically.';
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
    if (this.isCodexTarget()) {
      const backup = { auth: null };

      try {
        if (fs.existsSync(this.codexAuthFile)) {
          backup.auth = fs.readFileSync(this.codexAuthFile, 'utf8');
        }
      } catch (error) {
        throw new Error(`Failed to backup current credentials: ${error.message}`);
      }

      return backup;
    }

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
    if (this.isCodexTarget()) {
      try {
        if (backup.auth && fs.existsSync(this.codexAuthFile)) {
          fs.writeFileSync(this.codexAuthFile, backup.auth, 'utf8');
        }
      } catch (error) {
        throw new Error(`Failed to restore credentials: ${error.message}`);
      }
      return;
    }

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
    const reset5hIso = usageData.five_hour?.resets_at;
    const reset7dIso = usageData.seven_day?.resets_at;
    const reset5h = reset5hIso ? Math.floor(new Date(reset5hIso).getTime() / 1000) : null;
    const reset7d = reset7dIso ? Math.floor(new Date(reset7dIso).getTime() / 1000) : null;
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
      rateLimits: {
        utilization5h: u5h,
        utilization7d: u7d,
        reset5h,
        reset7d,
        resetAt: reset7dIso, // backwards compat
        extra
      },
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
          // Note: utilization headers are fractions (0.0–1.0), convert to percentage
          const raw5h = h['anthropic-ratelimit-unified-5h-utilization'] ? parseFloat(h['anthropic-ratelimit-unified-5h-utilization']) : null;
          const raw7d = h['anthropic-ratelimit-unified-7d-utilization'] ? parseFloat(h['anthropic-ratelimit-unified-7d-utilization']) : null;
          const rateLimits = {
            status: h['anthropic-ratelimit-unified-status'] || null,
            utilization5h: raw5h != null ? Math.round(raw5h * 100) : null,
            utilization7d: raw7d != null ? Math.round(raw7d * 100) : null,
            reset5h: h['anthropic-ratelimit-unified-5h-reset'] ? Number(h['anthropic-ratelimit-unified-5h-reset']) : null,
            reset7d: h['anthropic-ratelimit-unified-7d-reset'] ? Number(h['anthropic-ratelimit-unified-7d-reset']) : null,
            overageInUse: h['anthropic-ratelimit-unified-overage-in-use'] === 'true',
            overageStatus: h['anthropic-ratelimit-unified-overage-status'] || null,
          };

          let effectiveTier = 'base';
          if (rateLimits.overageInUse) effectiveTier = 'extra';
          else if (rateLimits.status === 'rejected') effectiveTier = 'exhausted';
          else if (rateLimits.utilization7d >= 100) effectiveTier = 'exhausted';

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
            const pct5h = rateLimits.utilization5h;
            const pct7d = rateLimits.utilization7d;
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
    if (!this.isClaudeTarget()) {
      return false;
    }

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
    this.ensureClaudeFeature('refresh');
    return this.commands.refresh.execute();
  }

  async refreshOne() {
    this.ensureClaudeFeature('refresh-one');
    return this.commands.refreshOne.execute();
  }

  async when() {
    this.ensureClaudeFeature('when');
    return this.commands.when.execute();
  }

  async repair() {
    this.ensureClaudeFeature('repair');
    return this.commands.repair.execute();
  }

  async export() {
    this.ensureClaudeFeature('export');
    return this.commands.export.execute();
  }

  async import(compressedData, options = {}) {
    this.ensureClaudeFeature('import');
    return this.commands.import.execute(compressedData, options);
  }

  async status(options = {}) {
    this.ensureClaudeFeature('status');
    return this.commands.status.execute(options);
  }
}

export default CCRotate;
