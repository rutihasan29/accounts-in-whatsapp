const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');

test('config exports Gemini and forwarding contacts', () => {
  assert.ok('GEMINI_API_KEY' in config, 'GEMINI_API_KEY should be defined');
  assert.equal(config.VA2_PHONE, process.env.VA2_PHONE || '8801307760509');
  assert.equal(config.VE3_PHONE, process.env.VE3_PHONE || '8801831366604');
});
