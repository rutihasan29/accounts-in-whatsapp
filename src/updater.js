const { execSync, exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

let autoUpdateTimer = null;
let isUpdating = false;

/**
 * Mask sensitive tokens in URLs or strings so they never leak into logs or API responses.
 * @param {string} str
 * @returns {string}
 */
function maskToken(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/(https?:\/\/)([^@/\s]+)@github\.com/gi, '$1***@github.com')
    .replace(/ghp_[A-Za-z0-9_]{20,}/g, 'ghp_***');
}

/**
 * Extract version and update timestamp info from git or package.json fallback.
 * @param {string} cwd
 * @returns {object}
 */
function getServerVersionInfo(cwd = process.cwd()) {
  try {
    const raw = execSync('git log -1 --format="%cd|%h|%H|%s|%an" --date=iso', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000
    }).trim();

    if (raw) {
      const parts = raw.split('|');
      const commitDate = parts[0] || 'Unknown';
      const commitHash = parts[1] || '';
      const fullHash = parts[2] || '';
      const commitMessage = parts[3] || '';
      const author = parts[4] || '';

      let branch = '';
      try {
        branch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 2000
        }).trim();
      } catch {}

      return {
        updateTime: commitDate,
        commitHash,
        fullHash,
        commitMessage,
        author,
        branch: branch || 'master',
        source: 'git'
      };
    }
  } catch {}

  // Fallback if git metadata is not present
  try {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const stat = fs.statSync(pkgPath);
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const d = new Date(stat.mtime);
      const updateTime = d.toISOString().replace('T', ' ').substring(0, 19);
      return {
        updateTime,
        commitHash: pkg.version || 'v1.0.0',
        fullHash: '',
        commitMessage: 'Package release',
        author: 'System',
        branch: 'production',
        source: 'fs'
      };
    }
  } catch {}

  return {
    updateTime: new Date().toISOString().replace('T', ' ').substring(0, 19),
    commitHash: 'unknown',
    fullHash: '',
    commitMessage: 'Initial build',
    author: 'Unknown',
    branch: 'unknown',
    source: 'fallback'
  };
}

/**
 * Get the active git branch name.
 * @param {string} cwd
 * @returns {string}
 */
function getGitBranch(cwd = process.cwd()) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000
    }).trim() || 'master';
  } catch {
    return 'master';
  }
}

/**
 * Resolve target branch to watch or pull from remote.
 * @param {object} opts
 * @returns {string}
 */
function resolveTargetBranch({ cwd = process.cwd(), branch } = {}) {
  if (branch && typeof branch === 'string' && branch.trim()) {
    return branch.trim();
  }
  if (config.AUTO_UPDATE_BRANCH && String(config.AUTO_UPDATE_BRANCH).trim()) {
    return String(config.AUTO_UPDATE_BRANCH).trim();
  }

  const localBranch = getGitBranch(cwd);

  try {
    const remotes = execSync('git branch -r', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000
    });

    if (remotes.includes(`origin/${localBranch}`)) {
      return localBranch;
    }
    if (remotes.includes('origin/master')) {
      return 'master';
    }
    if (remotes.includes('origin/main')) {
      return 'main';
    }
  } catch {}

  return localBranch || 'master';
}

/**
 * Build authenticated remote git URL if token and repo URL are available.
 * @param {object} opts
 * @returns {string|null}
 */
function buildAuthenticatedUrl({ token = config.GITHUB_TOKEN, repoUrl = config.GITHUB_REPO_URL } = {}) {
  if (!token || !repoUrl) return null;
  const cleanUrl = repoUrl.trim();
  const cleanToken = token.trim();

  // If already contains token in https:// URL, return as is
  if (/https?:\/\/[^@/\s]+@github\.com/i.test(cleanUrl)) {
    return cleanUrl;
  }

  // Handle https://github.com/owner/repo.git or git@github.com:owner/repo.git
  const match = cleanUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?/i);
  if (match) {
    const owner = match[1];
    const repo = match[2];
    return `https://${cleanToken}@github.com/${owner}/${repo}.git`;
  }

  return cleanUrl.replace(/^https?:\/\//i, `https://${cleanToken}@`);
}

/**
 * Ensure git origin remote is configured properly with authentication if available.
 * @param {object} opts
 */
function ensureGitRemote({ cwd = process.cwd(), token = config.GITHUB_TOKEN, repoUrl = config.GITHUB_REPO_URL } = {}) {
  try {
    const remotes = execSync('git remote', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000
    }).split(/\r?\n/).map(r => r.trim()).filter(Boolean);

    const authUrl = buildAuthenticatedUrl({ token, repoUrl });

    if (!remotes.includes('origin')) {
      if (authUrl || repoUrl) {
        const targetUrl = authUrl || repoUrl;
        execSync(`git remote add origin "${targetUrl}"`, { cwd, stdio: 'ignore' });
        console.log(`[AUTO-UPDATE] Added git remote 'origin': ${maskToken(targetUrl)}`);
      }
    } else if (authUrl) {
      // Update origin with token if current origin does not have token
      try {
        const currentUrl = execSync('git remote get-url origin', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (!currentUrl.includes(token) && !currentUrl.includes('@github.com')) {
          execSync(`git remote set-url origin "${authUrl}"`, { cwd, stdio: 'ignore' });
          console.log(`[AUTO-UPDATE] Updated git remote 'origin' with authenticated token.`);
        }
      } catch {}
    }
  } catch (err) {
    console.warn(`[AUTO-UPDATE] Warning in ensureGitRemote: ${maskToken(err.message)}`);
  }
}

/**
 * Verify GitHub webhook HMAC-SHA256 signature.
 * @param {string|Buffer} rawBody
 * @param {string} signature - Header 'x-hub-signature-256'
 * @param {string} secret - Secret configured in GitHub webhook settings
 * @returns {boolean}
 */
function verifyGitHubWebhookSignature(rawBody, signature, secret = config.GITHUB_WEBHOOK_SECRET) {
  if (!secret) {
    // If no secret configured, allow requests (or return true)
    return true;
  }
  if (!signature || typeof signature !== 'string') {
    return false;
  }

  try {
    const hmac = crypto.createHmac('sha256', secret);
    const content = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody), 'utf8');
    const digest = 'sha256=' + hmac.update(content).digest('hex');

    const sigBuf = Buffer.from(signature);
    const digBuf = Buffer.from(digest);

    if (sigBuf.length !== digBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(sigBuf, digBuf);
  } catch {
    return false;
  }
}

/**
 * Check if remote has newer commits.
 * @param {object} opts
 * @returns {Promise<{ hasUpdate: boolean, localHash: string, remoteHash: string, branch: string, reason?: string }>}
 */
async function checkGitRemoteUpdates({
  cwd = process.cwd(),
  branch,
  token = config.GITHUB_TOKEN,
  repoUrl = config.GITHUB_REPO_URL,
  execFn
} = {}) {
  const runner = execFn || ((cmd, options) => new Promise((resolve, reject) => {
    exec(cmd, options, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  }));

  ensureGitRemote({ cwd, token, repoUrl });
  const targetBranch = resolveTargetBranch({ cwd, branch });

  try {
    // Fetch latest commits for target branch
    await runner(`git fetch origin ${targetBranch}`, { cwd, timeout: 30000 });

    const localRes = await runner('git rev-parse HEAD', { cwd, timeout: 5000 });
    const localHash = localRes.stdout.trim();

    const remoteRes = await runner(`git rev-parse origin/${targetBranch}`, { cwd, timeout: 5000 });
    const remoteHash = remoteRes.stdout.trim();

    let hasUpdate = false;
    if (localHash && remoteHash && localHash !== remoteHash) {
      try {
        await runner(`git merge-base --is-ancestor HEAD origin/${targetBranch}`, { cwd, timeout: 5000 });
        hasUpdate = true;
      } catch {
        hasUpdate = false;
      }
    }

    return {
      hasUpdate,
      localHash,
      remoteHash,
      branch: targetBranch
    };
  } catch (err) {
    const safeError = maskToken(err.message);
    return {
      hasUpdate: false,
      localHash: '',
      remoteHash: '',
      branch: targetBranch,
      reason: safeError
    };
  }
}

/**
 * Pull updates, reinstall dependencies if package.json changed, and invoke restart callback.
 * @param {object} opts
 * @returns {Promise<{ success: boolean, newVersion?: object, error?: string }>}
 */
async function performUpdate({
  cwd = process.cwd(),
  branch,
  token = config.GITHUB_TOKEN,
  repoUrl = config.GITHUB_REPO_URL,
  reason = 'AUTOMATED_PULL',
  onRestart,
  execFn
} = {}) {
  if (isUpdating) {
    console.log('[AUTO-UPDATE] Update already in progress. Skipping duplicate invocation.');
    return { success: false, error: 'UPDATE_IN_PROGRESS' };
  }

  isUpdating = true;
  const runner = execFn || ((cmd, options) => new Promise((resolve, reject) => {
    exec(cmd, options, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  }));

  try {
    ensureGitRemote({ cwd, token, repoUrl });
    const targetBranch = resolveTargetBranch({ cwd, branch });

    console.log(`\n====================================================`);
    console.log(`🔄 [AUTO-UPDATE] Triggered (${reason}) for branch 'origin/${targetBranch}'`);
    console.log(`====================================================`);

    // Fetch latest commits
    await runner(`git fetch origin ${targetBranch}`, { cwd, timeout: 30000 });

    const localRes = await runner('git rev-parse HEAD', { cwd, timeout: 5000 });
    const localHash = localRes.stdout.trim();

    const remoteRes = await runner(`git rev-parse origin/${targetBranch}`, { cwd, timeout: 5000 });
    const remoteHash = remoteRes.stdout.trim();

    if (localHash === remoteHash) {
      console.log(`[AUTO-UPDATE] Already at latest commit (${remoteHash.slice(0, 7)}). No code changes to apply.`);
      isUpdating = false;
      return { success: true, alreadyUpToDate: true };
    }

    // Verify remote is actually ahead before resetting
    try {
      await runner(`git merge-base --is-ancestor HEAD origin/${targetBranch}`, { cwd, timeout: 5000 });
    } catch {
      console.log(`[AUTO-UPDATE] Local commit (${localHash.slice(0, 7)}) is ahead of or diverged from origin/${targetBranch} (${remoteHash.slice(0, 7)}). Skipping reset.`);
      isUpdating = false;
      return { success: true, localAhead: true };
    }

    // Check if package.json or package-lock.json changed
    let depsChanged = false;
    try {
      const diffRes = await runner(`git diff --name-only HEAD origin/${targetBranch}`, { cwd, timeout: 10000 });
      const changedFiles = diffRes.stdout.split(/\r?\n/);
      depsChanged = changedFiles.some(f => f.trim() === 'package.json' || f.trim() === 'package-lock.json');
    } catch {}

    // Clean reset to remote branch
    console.log(`[AUTO-UPDATE] Resetting working directory to origin/${targetBranch} (${remoteHash.slice(0, 7)})...`);
    await runner(`git reset --hard origin/${targetBranch}`, { cwd, timeout: 20000 });

    if (depsChanged) {
      console.log('[AUTO-UPDATE] Dependencies changed in package.json. Running npm install...');
      try {
        await runner('npm install --omit=dev', { cwd, timeout: 120000 });
        console.log('[AUTO-UPDATE] npm install completed successfully.');
      } catch (npmErr) {
        console.warn(`[AUTO-UPDATE] npm install had non-fatal warning: ${maskToken(npmErr.message)}`);
      }
    }

    const newVersion = getServerVersionInfo(cwd);
    console.log(`✅ [AUTO-UPDATE] Successfully updated to: ${newVersion.commitHash} (${newVersion.updateTime})`);
    console.log(`   Message: "${newVersion.commitMessage}"`);

    // Trigger restart
    if (typeof onRestart === 'function') {
      console.log('🚀 [AUTO-UPDATE] Invoking server restart sequence...');
      const restartTimer = setTimeout(() => {
        try {
          onRestart();
        } catch (err) {
          console.error('[AUTO-UPDATE] Error in onRestart callback:', err.message);
        }
      }, 500);
      if (restartTimer && restartTimer.unref) {
        restartTimer.unref();
      }
    }

    isUpdating = false;
    return { success: true, newVersion };
  } catch (err) {
    isUpdating = false;
    const safeError = maskToken(err.message);
    console.error(`❌ [AUTO-UPDATE] Failed applying update: ${safeError}`);
    return { success: false, error: safeError };
  }
}

/**
 * Start periodic background polling for GitHub updates.
 * @param {object} opts
 * @returns {NodeJS.Timeout|null}
 */
function startAutoUpdater({
  intervalMs = config.AUTO_UPDATE_INTERVAL_MS || 60000,
  branch = config.AUTO_UPDATE_BRANCH,
  token = config.GITHUB_TOKEN,
  repoUrl = config.GITHUB_REPO_URL,
  onRestart,
  execFn
} = {}) {
  if (autoUpdateTimer) {
    clearInterval(autoUpdateTimer);
    autoUpdateTimer = null;
  }

  if (config.AUTO_UPDATE_ENABLED === false) {
    console.log('[AUTO-UPDATE] Background auto-update disabled via config.');
    return null;
  }

  const pollInterval = Math.max(10000, intervalMs); // Minimum 10 seconds to avoid spamming
  console.log(`🔄 [AUTO-UPDATE] Background polling active (checking GitHub every ${Math.round(pollInterval / 1000)}s)`);

  const pollRoutine = async () => {
    try {
      const check = await checkGitRemoteUpdates({ branch, token, repoUrl, execFn });
      if (check.hasUpdate) {
        console.log(`[AUTO-UPDATE] New commit detected on GitHub: ${check.remoteHash.slice(0, 7)} (current: ${check.localHash.slice(0, 7)}). Updating...`);
        await performUpdate({ branch, token, repoUrl, reason: 'GITHUB_POLL_DETECTED', onRestart, execFn });
      }
    } catch (err) {
      console.warn(`[AUTO-UPDATE] Error during periodic check: ${maskToken(err.message)}`);
    }
  };

  // Schedule first check after 10s delay to allow initial server startup to settle
  setTimeout(pollRoutine, 10000);

  autoUpdateTimer = setInterval(pollRoutine, pollInterval);
  if (autoUpdateTimer.unref) {
    autoUpdateTimer.unref();
  }

  return autoUpdateTimer;
}

/**
 * Stop background polling.
 */
function stopAutoUpdater() {
  if (autoUpdateTimer) {
    clearInterval(autoUpdateTimer);
    autoUpdateTimer = null;
    console.log('[AUTO-UPDATE] Background auto-update stopped.');
  }
}

/**
 * Execute graceful shutdown and process reboot.
 * Works seamlessly whether running under PM2, Docker, systemd, or standalone node.
 * @param {object} opts
 */
async function restartServer({
  client,
  db,
  server,
  onBeforeExit,
  spawnFn
} = {}) {
  console.log('\n====================================================');
  console.log('🔄 Server is restarting to apply updates...');
  console.log('====================================================\n');

  stopAutoUpdater();

  if (typeof onBeforeExit === 'function') {
    try {
      await onBeforeExit();
    } catch {}
  }

  if (server && typeof server.close === 'function') {
    try {
      server.close();
    } catch {}
  }

  if (client && typeof client.destroy === 'function') {
    try {
      await client.destroy();
    } catch {}
  }

  if (db && typeof db.close === 'function') {
    try {
      db.close();
    } catch {}
  }

  // If running under PM2 or Docker/systemd with autorestart, exiting with code 0 triggers instant restart
  const isPm2 = process.env.pm_id !== undefined || process.env.PM2_HOME !== undefined;

  if (isPm2) {
    console.log('[RESTART] Running under PM2. Exiting process for PM2 reload...');
    process.exit(0);
    return;
  }

  // Standalone node process: spawn detached child process and exit
  console.log('[RESTART] Spawning fresh Node process...');
  const spawner = spawnFn || spawn;
  const child = spawner(process.argv[0], process.argv.slice(1), {
    cwd: process.cwd(),
    detached: true,
    stdio: 'inherit',
    env: process.env
  });

  if (child && typeof child.unref === 'function') {
    child.unref();
  }

  setTimeout(() => {
    process.exit(0);
  }, 300);
}

module.exports = {
  maskToken,
  getServerVersionInfo,
  getGitBranch,
  resolveTargetBranch,
  buildAuthenticatedUrl,
  ensureGitRemote,
  verifyGitHubWebhookSignature,
  checkGitRemoteUpdates,
  performUpdate,
  startAutoUpdater,
  stopAutoUpdater,
  restartServer
};
