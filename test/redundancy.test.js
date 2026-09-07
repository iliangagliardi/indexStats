const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalKeyString, classifyRedundancy } = require('../indexStats.js');

const noOps = {};

test('canonicalKeyString preserves key order and direction', () => {
  assert.equal(canonicalKeyString({ a: 1, b: -1 }), '[["a",1],["b",-1]]');
  assert.notEqual(canonicalKeyString({ a: 1, b: 1 }), canonicalKeyString({ b: 1, a: 1 }));
});

test('flags a compound prefix of a wider index', () => {
  const r = classifyRedundancy([
    { name: 'a_1_b_1', key: { a: 1, b: 1 } },
    { name: 'a_1_b_1_c_1', key: { a: 1, b: 1, c: 1 } },
  ], noOps);
  assert.deepEqual(r.get('a_1_b_1'), { class: 'prefix', coveredBy: 'a_1_b_1_c_1' });
  assert.equal(r.has('a_1_b_1_c_1'), false);
});

test('does not flag a prefix whose direction differs', () => {
  const r = classifyRedundancy([
    { name: 'a_1_b_1', key: { a: 1, b: 1 } },
    { name: 'a_1_b_-1_c_1', key: { a: 1, b: -1, c: 1 } },
  ], noOps);
  assert.equal(r.has('a_1_b_1'), false);
});

test('flags a single-field index regardless of direction', () => {
  const r = classifyRedundancy([
    { name: 'a_-1', key: { a: -1 } },
    { name: 'a_1_b_1', key: { a: 1, b: 1 } },
  ], noOps);
  assert.deepEqual(r.get('a_-1'), { class: 'subsumed', coveredBy: 'a_1_b_1' });
});

test('never flags _id_ or indexes with special semantics', () => {
  const specs = [
    { name: '_id_', key: { _id: 1 } },
    { name: 'a_1', key: { a: 1 }, unique: true },
    { name: 'b_1', key: { b: 1 }, expireAfterSeconds: 60 },
    { name: 'c_1', key: { c: 1 }, partialFilterExpression: { c: { $gt: 1 } } },
    { name: 'd_1', key: { d: 1 }, sparse: true },
    { name: 'e_1', key: { e: 1 }, collation: { locale: 'fr' } },
    { name: 'f_text', key: { _fts: 'text', _ftsx: 1 }, weights: { f: 1 } },
    { name: 'g_hashed', key: { g: 'hashed' } },
    { name: 'wide', key: { _id: 1, a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1 } },
  ];
  const r = classifyRedundancy(specs, noOps);
  assert.equal(r.size, 0);
});

test('duplicate keeps the more used index and reports the other', () => {
  const r = classifyRedundancy([
    { name: 'a_1', key: { a: 1 } },
    { name: 'custom_name', key: { a: 1 } },
  ], { a_1: 0, custom_name: 500 });
  assert.deepEqual(r.get('a_1'), { class: 'duplicate', coveredBy: 'custom_name' });
  assert.equal(r.has('custom_name'), false);
});

test('duplicate with equal usage keeps the generated-name index', () => {
  const r = classifyRedundancy([
    { name: 'a_1', key: { a: 1 } },
    { name: 'zzz', key: { a: 1 } },
  ], { a_1: 0, zzz: 0 });
  assert.deepEqual(r.get('zzz'), { class: 'duplicate', coveredBy: 'a_1' });
});

test('an index is reported once, duplicate taking precedence over prefix', () => {
  const r = classifyRedundancy([
    { name: 'a_1', key: { a: 1 } },
    { name: 'dup', key: { a: 1 } },
    { name: 'a_1_b_1', key: { a: 1, b: 1 } },
  ], { a_1: 10, dup: 0, a_1_b_1: 0 });
  assert.equal(r.get('dup').class, 'duplicate');
});
