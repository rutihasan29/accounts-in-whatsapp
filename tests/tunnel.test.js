const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startNgrokTunnel, stopNgrokTunnel } = require('../src/tunnel');

describe('Ngrok Tunnel Manager', () => {
  test('exports startNgrokTunnel and stopNgrokTunnel functions', () => {
    assert.equal(typeof startNgrokTunnel, 'function');
    assert.equal(typeof stopNgrokTunnel, 'function');
  });

  test('startNgrokTunnel returns MISSING_AUTHTOKEN safely without throwing when token is missing', async () => {
    const origToken = process.env.NGROK_AUTHTOKEN;
    delete process.env.NGROK_AUTHTOKEN;

    try {
      const result = await startNgrokTunnel({ port: 3000, authtoken: '' });
      assert.equal(result.success, false);
      assert.equal(result.reason, 'MISSING_AUTHTOKEN');
    } finally {
      if (origToken) process.env.NGROK_AUTHTOKEN = origToken;
    }
  });

  test('stopNgrokTunnel handles null activeListener without throwing', async () => {
    await assert.doesNotReject(async () => {
      await stopNgrokTunnel();
    });
  });
});
