const { describe, it } = require('node:test');
const assert = require('node:assert');
const { toStandardNumber, parseMessage } = require('../src/parser');

describe('Parser Module', () => {
  describe('toStandardNumber', () => {
    it('converts Bengali digits to standard number', () => {
      assert.strictEqual(toStandardNumber('৩০'), 30);
      assert.strictEqual(toStandardNumber('৪০০'), 400);
      assert.strictEqual(toStandardNumber('৫৬.৫০'), 56.5);
    });

    it('parses English digits', () => {
      assert.strictEqual(toStandardNumber('30'), 30);
      assert.strictEqual(toStandardNumber('400'), 400);
      assert.strictEqual(toStandardNumber('120.75'), 120.75);
    });

    it('handles mixed Bengali and English digits', () => {
      assert.strictEqual(toStandardNumber('১00'), 100);
      assert.strictEqual(toStandardNumber('4০'), 40);
    });

    it('returns null for invalid string or non-string inputs', () => {
      assert.strictEqual(toStandardNumber('abc'), null);
      assert.strictEqual(toStandardNumber('12abc'), null);
      assert.strictEqual(toStandardNumber(''), null);
      assert.strictEqual(toStandardNumber('   '), null);
      assert.strictEqual(toStandardNumber(null), null);
      assert.strictEqual(toStandardNumber(undefined), null);
      assert.strictEqual(toStandardNumber(123), null);
    });
  });

  describe('parseMessage', () => {
    it('parses Bengali bill message', () => {
      const res = parseMessage('বিল ৩০ টাকা');
      assert.deepStrictEqual(res, { type: 'BILL', amount: 30, rawText: 'বিল ৩০ টাকা' });
    });

    it('parses English bill message with extra spaces', () => {
      const res = parseMessage('বিল   ৪০০   টাকা');
      assert.deepStrictEqual(res, { type: 'BILL', amount: 400, rawText: 'বিল   ৪০০   টাকা' });
    });

    it('parses decimal bill amount', () => {
      const res = parseMessage('বিল ১২০.৫০ টাকা');
      assert.deepStrictEqual(res, { type: 'BILL', amount: 120.5, rawText: 'বিল ১২০.৫০ টাকা' });
    });

    it('parses payment message with Bengali numerals and comma', () => {
      const res = parseMessage('৫৬ টাকা পেয়েছি, ধন্যবাদ');
      assert.deepStrictEqual(res, { type: 'PAYMENT', amount: 56, rawText: '৫৬ টাকা পেয়েছি, ধন্যবাদ' });
    });

    it('parses payment message without comma', () => {
      const res = parseMessage('৫৬ টাকা পেয়েছি ধন্যবাদ');
      assert.deepStrictEqual(res, { type: 'PAYMENT', amount: 56, rawText: '৫৬ টাকা পেয়েছি ধন্যবাদ' });
    });

    it('parses payment message with English numerals', () => {
      const res = parseMessage('56 টাকা পেয়েছি, ধন্যবাদ');
      assert.deepStrictEqual(res, { type: 'PAYMENT', amount: 56, rawText: '56 টাকা পেয়েছি, ধন্যবাদ' });
    });

    it('parses decimal payment message', () => {
      const res = parseMessage('১০০.৫০ টাকা পেয়েছি, ধন্যবাদ');
      assert.deepStrictEqual(res, { type: 'PAYMENT', amount: 100.5, rawText: '১০০.৫০ টাকা পেয়েছি, ধন্যবাদ' });
    });

    it('parses self-chat !due command', () => {
      const res = parseMessage('!due');
      assert.deepStrictEqual(res, { type: 'COMMAND_DUE', rawText: '!due' });
    });

    it('parses !DUE command case-insensitively', () => {
      const res = parseMessage('!DUE');
      assert.deepStrictEqual(res, { type: 'COMMAND_DUE', rawText: '!DUE' });
    });

    it('handles leading and trailing whitespace around messages', () => {
      const res = parseMessage('   বিল ৩০ টাকা   ');
      assert.deepStrictEqual(res, { type: 'BILL', amount: 30, rawText: 'বিল ৩০ টাকা' });
    });

    it('rejects zero or negative amounts', () => {
      assert.strictEqual(parseMessage('বিল ০ টাকা'), null);
      assert.strictEqual(parseMessage('০ টাকা পেয়েছি, ধন্যবাদ'), null);
    });

    it('ignores general or conversational messages', () => {
      assert.strictEqual(parseMessage('বিল কত টাকা?'), null);
      assert.strictEqual(parseMessage('টাকা পেয়েছি'), null);
      assert.strictEqual(parseMessage('অনেক ধন্যবাদ'), null);
      assert.strictEqual(parseMessage('হ্যালো ভাই'), null);
      assert.strictEqual(parseMessage('বিল ১০০'), null);
      assert.strictEqual(parseMessage('১০০ টাকা দিয়েছি'), null);
      assert.strictEqual(parseMessage(''), null);
      assert.strictEqual(parseMessage(null), null);
      assert.strictEqual(parseMessage(undefined), null);
    });
  });
});
