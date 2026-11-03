const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const {
  maskToken,
  getServerVersionInfo,
  getGitBranch,
  resolveTargetBranch,
  buildAuthenticatedUrl,
  verifyGitHubWebhookSignature,
  checkGitRemoteUpdates,
  performUpdate,
  startAutoUpdater,
  stopAutoUpdater
} = require('../src/updater');
const { startWebServer } = require('../src/server');
const { initDb } = require('../src/db');

test('maskToken masks sensitive tokens and credentials', () => {
  assert.equal(maskToken(''), '');
  assert.equal(maskToken(null), '');

  const inputUrl = 'https://ghp_DUMMYTOKENFORTESTING1234567890@github.com/user/repo.git';
  const maskedUrl = maskToken(inputUrl);
  assert.equal(maskedUrl, 'https://***@github.com/user/repo.git');

  const standaloneToken = 'Auth token: ghp_DUMMYTOKENFORTESTING1234567890 found';
  assert.equal(maskToken(standaloneToken), 'Auth token: ghp_*** found');
});

test('getServerVersionInfo returns structured version information', () => {
  const info = getServerVersionInfo();
  assert.ok(info, 'Must return an info object');
  assert.ok(typeof info.updateTime === 'string' && info.updateTime.length > 0, 'updateTime must be non-empty string');
  assert.ok(typeof info.commitHash === 'string', 'commitHash must be a string');
  assert.ok(typeof info.branch === 'string', 'branch must be a string');
  assert.ok(['git', 'fs', 'fallback'].includes(info.source), 'source must be valid');
});

test('getGitBranch returns active branch string', () => {
  const branch = getGitBranch();
  assert.ok(typeof branch === 'string' && branch.length > 0);
});

test('buildAuthenticatedUrl constructs authenticated GitHub HTTPS URL', () => {
  const url1 = buildAuthenticatedUrl({
    token: 'my-token-123',
    repoUrl: 'https://github.com/user/my-repo.git'
  });
  assert.equal(url1, 'https://my-token-123@github.com/user/my-repo.git');

  const url2 = buildAuthenticatedUrl({
    token: 'my-token-123',
    repoUrl: 'git@github.com:user/my-repo.git'
  });
  assert.equal(url2, 'https://my-token-123@github.com/user/my-repo.git');

  assert.equal(buildAuthenticatedUrl({ token: '', repoUrl: 'https://github.com/a/b.git' }), null);
  assert.equal(buildAuthenticatedUrl({ token: 'abc', repoUrl: '' }), null);
});

test('verifyGitHubWebhookSignature validates HMAC SHA-256 signatures', () => {
  const secret = 'webhook_secret_key_456';
  const payload = JSON.stringify({ ref: 'refs/heads/master', after: '1234567' });

  // Compute valid signature
  const hmac = crypto.createHmac('sha256', secret);
  const validSig = 'sha256=' + hmac.update(payload).digest('hex');

  // Valid signature
  assert.equal(verifyGitHubWebhookSignature(payload, validSig, secret), true);

  // Invalid signature
  assert.equal(verifyGitHubWebhookSignature(payload, 'sha256=invalidhash', secret), false);

  // Missing or empty signature
  assert.equal(verifyGitHubWebhookSignature(payload, '', secret), false);
  assert.equal(verifyGitHubWebhookSignature(payload, null, secret), false);

  // No secret configured -> open
  assert.equal(verifyGitHubWebhookSignature(payload, 'any', ''), true);
});

test('checkGitRemoteUpdates detects when remote has new commits', async () => {
  let commandsRun = [];
  const mockExec = async (cmd) => {
    commandsRun.push(cmd);
    if (cmd.includes('git rev-parse HEAD')) {
      return { stdout: 'commit_local_111\n', stderr: '' };
    }
    if (cmd.includes('git rev-parse origin/')) {
      return { stdout: 'commit_remote_222\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  const check = await checkGitRemoteUpdates({
    branch: 'master',
    execFn: mockExec
  });

  assert.equal(check.hasUpdate, true);
  assert.equal(check.localHash, 'commit_local_111');
  assert.equal(check.remoteHash, 'commit_remote_222');
  assert.equal(check.branch, 'master');
  assert.ok(commandsRun.some(c => c.includes('git fetch origin master')));
});

test('checkGitRemoteUpdates detects when already up-to-date', async () => {
  const mockExec = async (cmd) => {
    if (cmd.includes('git rev-parse HEAD') || cmd.includes('git rev-parse origin/')) {
      return { stdout: 'same_commit_123\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  const check = await checkGitRemoteUpdates({
    branch: 'master',
    execFn: mockExec
  });

  assert.equal(check.hasUpdate, false);
  assert.equal(check.localHash, 'same_commit_123');
  assert.equal(check.remoteHash, 'same_commit_123');
});

test('performUpdate resets to origin and invokes restart callback', async () => {
  let restartCalled = false;
  let commandsRun = [];

  const mockExec = async (cmd) => {
    commandsRun.push(cmd);
    if (cmd.includes('git rev-parse HEAD')) {
      return { stdout: 'old_commit_000\n', stderr: '' };
    }
    if (cmd.includes('git rev-parse origin/')) {
      return { stdout: 'new_commit_999\n', stderr: '' };
    }
    if (cmd.includes('git diff --name-only')) {
      return { stdout: 'src/bot.js\npackage.json\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  const res = await performUpdate({
    branch: 'master',
    reason: 'TEST_TRIGGER',
    onRestart: () => {
      restartCalled = true;
    },
    execFn: mockExec
  });

  assert.equal(res.success, true);
  assert.ok(commandsRun.some(c => c.includes('git reset --hard origin/master')));
  assert.ok(commandsRun.some(c => c.includes('npm install --omit=dev')));

  // Wait briefly for restart timeout to fire
  await new Promise(r => setTimeout(r, 600));
  assert.equal(restartCalled, true);
});

test('startAutoUpdater and stopAutoUpdater manage polling lifecycle cleanly', () => {
  const mockExec = async () => ({ stdout: 'hash\n', stderr: '' });

  const timer = startAutoUpdater({
    intervalMs: 15000,
    branch: 'master',
    execFn: mockExec
  });

  assert.ok(timer, 'Timer must be created when auto-update is enabled');

  stopAutoUpdater();
});

test('Web Server exposes /api/server/version and GitHub webhook endpoint', async () => {
  const db = initDb(':memory:');
  let restartTriggered = false;

  const server = startWebServer({
    db,
    port: 3999,
    onRestart: () => {
      restartTriggered = true;
    }
  });

  try {
    // 1. GET /api/server/version
    const versionRes = await new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:3999/api/server/version', (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, data: JSON.parse(data) }));
      }).on('error', reject);
    });

    assert.equal(versionRes.statusCode, 200);
    assert.equal(versionRes.data.status, 'ok');
    assert.ok(versionRes.data.version.updateTime);

    // 2. GET /api/bot-status includes serverVersion
    const statusRes = await new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:3999/api/bot-status', (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, data: JSON.parse(data) }));
      }).on('error', reject);
    });

    assert.equal(statusRes.statusCode, 200);
    assert.ok(statusRes.data.serverVersion);
    assert.ok(statusRes.data.serverVersion.updateTime);

    // 3. POST /api/webhook/github (ping event)
    const pingRes = await new Promise((resolve, reject) => {
      const req = http.request('http://127.0.0.1:3999/api/webhook/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'ping'
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, data: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.write(JSON.stringify({ zen: 'Keep it logically awesome.' }));
      req.end();
    });

    assert.equal(pingRes.statusCode, 200);
    assert.equal(pingRes.data.status, 'ok');

  } finally {
    server.close();
    db.close();
  }
});
