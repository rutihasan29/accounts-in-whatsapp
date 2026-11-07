const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const {
  setQr,
  setReady,
  setAuthenticated,
  setDisconnected,
  resetQrState,
  getQrStatus,
  getQrDataUrl,
  getQrPngBuffer,
  getQrSvg
} = require('../src/qrState');
const { initDb } = require('../src/db');
const { startWebServer } = require('../src/server');
const { setupBotHandlers } = require('../src/bot');

function makeRequest(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          raw,
          body: raw.toString('utf8')
        });
      });
    }).on('error', reject);
  });
}

describe('QR State & Scanner Endpoints', () => {
  beforeEach(() => {
    resetQrState();
  });

  describe('qrState unit tests', () => {
    it('initial state is OFFLINE with no QR', () => {
      const status = getQrStatus();
      assert.strictEqual(status.status, 'OFFLINE');
      assert.strictEqual(status.hasQr, false);
      assert.strictEqual(status.qr, null);
      assert.strictEqual(status.userPhone, null);
    });

    it('setQr stores QR code string and updates status to QR_READY', async () => {
      const sampleQr = '2@ABC123xyz,ref_sample_token,test==';
      setQr(sampleQr);

      const status = getQrStatus();
      assert.strictEqual(status.status, 'QR_READY');
      assert.strictEqual(status.hasQr, true);
      assert.strictEqual(status.qr, sampleQr);
      assert.ok(status.qrTime);

      const dataUrl = await getQrDataUrl();
      assert.ok(dataUrl && dataUrl.startsWith('data:image/png;base64,'));

      const pngBuf = await getQrPngBuffer();
      assert.ok(Buffer.isBuffer(pngBuf));
      assert.strictEqual(pngBuf.slice(1, 4).toString('ascii'), 'PNG');

      const svg = await getQrSvg();
      assert.ok(svg && svg.includes('<svg'));
    });

    it('setAuthenticated clears active QR code', () => {
      setQr('temp-qr-code');
      assert.strictEqual(getQrStatus().hasQr, true);

      setAuthenticated();
      const status = getQrStatus();
      assert.strictEqual(status.status, 'AUTHENTICATED');
      assert.strictEqual(status.hasQr, false);
      assert.strictEqual(status.qr, null);
    });

    it('setReady sets status to READY, clears QR, and records user phone', () => {
      setQr('temp-qr-code');
      setReady({ wid: { user: '8801340517587' } });

      const status = getQrStatus();
      assert.strictEqual(status.status, 'READY');
      assert.strictEqual(status.hasQr, false);
      assert.strictEqual(status.qr, null);
      assert.strictEqual(status.userPhone, '8801340517587');
      assert.ok(status.lastReadyTime);
    });

    it('setDisconnected sets status to DISCONNECTED and clears QR', () => {
      setQr('temp-qr-code');
      setDisconnected('NAVIGATION');

      const status = getQrStatus();
      assert.strictEqual(status.status, 'DISCONNECTED');
      assert.strictEqual(status.hasQr, false);
      assert.strictEqual(status.qr, null);
    });
  });

  describe('Server HTTP endpoints (/qr, /api/qr, /qr.png)', () => {
    let server;
    let db;
    let baseUrl;
    const testPort = 3099;

    before(() => {
      db = initDb(':memory:');
      const mockClient = {
        on: () => {},
        info: null
      };
      server = startWebServer({ db, client: mockClient, port: testPort });
      baseUrl = `http://localhost:${testPort}`;
    });

    after(async () => {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      if (db) db.close();
    });

    it('GET /api/qr returns current status and QR data URL when QR is active', async () => {
      setQr('2@TEST_QR_STRING_FOR_SERVER');

      const res = await makeRequest(`${baseUrl}/api/qr`);
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.headers['content-type'].includes('application/json'));

      const json = JSON.parse(res.body);
      assert.strictEqual(json.status, 'QR_READY');
      assert.strictEqual(json.hasQr, true);
      assert.strictEqual(json.qr, '2@TEST_QR_STRING_FOR_SERVER');
      assert.ok(json.qrImage && json.qrImage.startsWith('data:image/png;base64,'));
    });

    it('GET /qr.png serves raw binary image/png when QR is active', async () => {
      setQr('2@TEST_QR_STRING_FOR_SERVER');

      const res = await makeRequest(`${baseUrl}/qr.png`);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'image/png');
      assert.strictEqual(res.raw.slice(1, 4).toString('ascii'), 'PNG');
    });

    it('GET /qr returns 200 with HTML page containing QR scanner view', async () => {
      const res = await makeRequest(`${baseUrl}/qr`);
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.headers['content-type'].includes('text/html'));
      assert.ok(res.body.includes('WhatsApp'));
      assert.ok(res.body.includes('/api/qr'));
    });

    it('GET /api/qr returns connected state when bot is ready', async () => {
      setReady({ wid: { user: '8801999999999' } });

      const res = await makeRequest(`${baseUrl}/api/qr`);
      assert.strictEqual(res.statusCode, 200);

      const json = JSON.parse(res.body);
      assert.strictEqual(json.status, 'READY');
      assert.strictEqual(json.hasQr, false);
      assert.strictEqual(json.qrImage, null);
      assert.strictEqual(json.userPhone, '8801999999999');
    });
  });

  describe('Bot event handlers integration', () => {
    it('setupBotHandlers wires client events to qrState', () => {
      const listeners = {};
      const mockClient = {
        on: (event, cb) => { listeners[event] = cb; },
        info: { wid: { user: '8801700000000' } }
      };
      const mockDb = initDb(':memory:');

      setupBotHandlers({ client: mockClient, db: mockDb });

      assert.strictEqual(typeof listeners['qr'], 'function');
      assert.strictEqual(typeof listeners['ready'], 'function');
      assert.strictEqual(typeof listeners['authenticated'], 'function');
      assert.strictEqual(typeof listeners['disconnected'], 'function');

      // Test qr event
      listeners['qr']('sample-event-qr');
      assert.strictEqual(getQrStatus().status, 'QR_READY');
      assert.strictEqual(getQrStatus().qr, 'sample-event-qr');

      // Test authenticated event
      listeners['authenticated']();
      assert.strictEqual(getQrStatus().status, 'AUTHENTICATED');
      assert.strictEqual(getQrStatus().hasQr, false);

      // Test disconnected event
      listeners['disconnected']('TEST_DISCONNECT');
      assert.strictEqual(getQrStatus().status, 'DISCONNECTED');

      mockDb.close();
    });
  });
});
