const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../indexStats.js');

// These assertions read the SHIPPED module-level constants through the
// exported `api` object - not values re-declared in this test file, and not
// a config object injected into deriveVerdict/applyAnalysis. Every other test
// in this suite injects its own CONFIG, so none of them would catch a wrong
// default landing in indexStats.js itself. This file is the only thing that
// pins what actually ships.

test('SCRIPT_VERSION is 3.0.0', () => {
  assert.equal(api.SCRIPT_VERSION, '3.0.0');
});

test('DROP_MIN_COUNTER_DAYS is 14 (two-week safety threshold)', () => {
  assert.equal(api.DROP_MIN_COUNTER_DAYS, 14);
});

test('SAMPLE_SIZE is 100', () => {
  assert.equal(api.SAMPLE_SIZE, 100);
});

test('MAX_TIME_MS is 30000', () => {
  assert.equal(api.MAX_TIME_MS, 30000);
});

test('OUT_FILE is indexStats-report.html', () => {
  assert.equal(api.OUT_FILE, 'indexStats-report.html');
});

test('INCLUDE_HIDDEN is true', () => {
  assert.equal(api.INCLUDE_HIDDEN, true);
});

test('LOW_PRESENCE is 0.10', () => {
  assert.equal(api.LOW_PRESENCE, 0.10);
});

test('EXCLUDED_DBS covers exactly admin/config/local', () => {
  assert.deepEqual(new Set(api.EXCLUDED_DBS), new Set(['admin', 'config', 'local']));
});

test('URI_TEMPLATE contains {host} and directConnection=true', () => {
  assert.ok(api.URI_TEMPLATE.includes('{host}'));
  assert.ok(api.URI_TEMPLATE.includes('directConnection=true'));
});

test('PEER_PAYLOADS defaults to an empty array', () => {
  assert.deepEqual(api.PEER_PAYLOADS, []);
});
