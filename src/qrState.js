const qrcode = require('qrcode');

let currentQr = null;
let currentQrTime = null;
let status = 'OFFLINE'; // 'OFFLINE' | 'QR_READY' | 'AUTHENTICATED' | 'READY' | 'DISCONNECTED'
let lastReadyTime = null;
let userPhone = null;

function setQr(qr) {
  currentQr = qr;
  currentQrTime = new Date().toISOString();
  status = 'QR_READY';
}

function setReady(userInfo) {
  currentQr = null;
  status = 'READY';
  lastReadyTime = new Date().toISOString();
  userPhone = userInfo?.wid?.user || null;
}

function setAuthenticated() {
  currentQr = null;
  status = 'AUTHENTICATED';
}

function setDisconnected(reason) {
  currentQr = null;
  status = 'DISCONNECTED';
}

function resetQrState() {
  currentQr = null;
  currentQrTime = null;
  status = 'OFFLINE';
  lastReadyTime = null;
  userPhone = null;
}

function getQrStatus() {
  return {
    status,
    hasQr: Boolean(currentQr),
    qr: currentQr,
    qrTime: currentQrTime,
    lastReadyTime,
    userPhone
  };
}

async function getQrDataUrl() {
  if (!currentQr) return null;
  try {
    return await qrcode.toDataURL(currentQr, {
      margin: 2,
      scale: 8,
      color: {
        dark: '#111827',
        light: '#ffffff'
      }
    });
  } catch (err) {
    console.error('[QR] Failed to generate data URL:', err.message);
    return null;
  }
}

async function getQrPngBuffer() {
  if (!currentQr) return null;
  try {
    return await qrcode.toBuffer(currentQr, {
      margin: 2,
      scale: 8,
      color: {
        dark: '#111827',
        light: '#ffffff'
      }
    });
  } catch (err) {
    console.error('[QR] Failed to generate PNG buffer:', err.message);
    return null;
  }
}

async function getQrSvg() {
  if (!currentQr) return null;
  try {
    return await qrcode.toString(currentQr, {
      type: 'svg',
      margin: 2
    });
  } catch (err) {
    console.error('[QR] Failed to generate SVG:', err.message);
    return null;
  }
}

module.exports = {
  setQr,
  setReady,
  setAuthenticated,
  setDisconnected,
  resetQrState,
  getQrStatus,
  getQrDataUrl,
  getQrPngBuffer,
  getQrSvg
};
