const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../indexStats.js');

test('requiring the script under node does not execute the shell run', () => {
  assert.equal(typeof S, 'object');
});

test('exports the script version', () => {
  assert.equal(S.SCRIPT_VERSION, '3.0.0');
});

test('exports isPlain as a pure function', () => {
  assert.equal(typeof S.isPlain, 'function');
  assert.equal(S.isPlain({ name: 'a_1', key: { a: 1 } }), true);
  assert.equal(S.isPlain({ name: '_id_', key: { _id: 1 } }), false);
});
