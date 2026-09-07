const test = require('node:test');
const assert = require('node:assert/strict');
const { flattenPaths, profileSample, keyFieldsOf, validatorPaths,
        classifySchemaIssues } = require('../indexStats.js');

const CONFIG = { LOW_PRESENCE: 0.10 };

test('flattenPaths walks nested objects and arrays of objects', () => {
  const p = flattenPaths({ a: 1, b: { c: 'x' }, d: [{ e: true }] });
  assert.deepEqual(Object.keys(p).sort(), ['a', 'b', 'b.c', 'd', 'd.e']);
  assert.equal(p.d.multikey, true);
  assert.deepEqual(p['b.c'].types, ['string']);
});

test('flattenPaths treats dates as scalars, not objects', () => {
  const p = flattenPaths({ at: new Date() });
  assert.deepEqual(Object.keys(p), ['at']);
  assert.deepEqual(p.at.types, ['date']);
});

test('profileSample counts a path once per document', () => {
  const s = profileSample([{ a: [1, 1, 1] }, { b: 2 }]);
  assert.equal(s.size, 2);
  assert.equal(s.paths.a.count, 1);
  assert.equal(s.paths.b.count, 1);
});

test('keyFieldsOf uses weights for text indexes and skips wildcards', () => {
  assert.deepEqual(keyFieldsOf({ name: 'a_1', key: { a: 1 } }), ['a']);
  assert.deepEqual(keyFieldsOf({ name: 't', key: { _fts: 'text', _ftsx: 1 }, weights: { title: 1 } }), ['title']);
  assert.deepEqual(keyFieldsOf({ name: 'w', key: { '$**': 1 } }), []);
});

test('validatorPaths extracts nested properties and detects closed schemas', () => {
  const v = validatorPaths({ $jsonSchema: {
    additionalProperties: false,
    properties: { a: { bsonType: 'int' }, b: { bsonType: 'object', properties: { c: {} } } },
  } });
  assert.deepEqual(v.props.sort(), ['a', 'b', 'b.c']);
  assert.equal(v.closed, true);
});

test('a field absent from every sampled document is flagged, with evidence', () => {
  const sample = { size: 100, paths: { createdAt: { count: 100, types: ['date'], multikey: false } }, validator: null };
  const [issue] = classifySchemaIssues({ name: 'createdAT_1', key: { createdAT: 1 } }, sample, CONFIG);
  assert.equal(issue.issue, 'absent');
  assert.equal(issue.presence, 0);
  assert.match(issue.text, /absent from 100 of 100 sampled documents/);
});

test('a rarely present field is low-presence, not absent', () => {
  const sample = { size: 100, paths: { deletedAt: { count: 4, types: ['date'], multikey: false } }, validator: null };
  const [issue] = classifySchemaIssues({ name: 'deletedAt_1', key: { deletedAt: 1 } }, sample, CONFIG);
  assert.equal(issue.issue, 'low-presence');
});

test('a field present in most documents produces no issue', () => {
  const sample = { size: 100, paths: { a: { count: 99, types: ['int'], multikey: false } }, validator: null };
  assert.deepEqual(classifySchemaIssues({ name: 'a_1', key: { a: 1 } }, sample, CONFIG), []);
});

test('mixed bson types on an indexed field are flagged', () => {
  const sample = { size: 100, paths: { a: { count: 100, types: ['int', 'string'], multikey: false } }, validator: null };
  const issues = classifySchemaIssues({ name: 'a_1', key: { a: 1 } }, sample, CONFIG);
  assert.equal(issues.some((i) => i.issue === 'mixed-types'), true);
});

test('unexpected multikey is flagged', () => {
  const sample = { size: 100, paths: { tags: { count: 100, types: ['array'], multikey: true } }, validator: null };
  const issues = classifySchemaIssues({ name: 'tags_1', key: { tags: 1 } }, sample, CONFIG);
  assert.equal(issues.some((i) => i.issue === 'unexpected-multikey'), true);
});

test('not-in-validator is provable only for a closed schema', () => {
  const closed = { size: 0, paths: {}, validator: { props: ['a'], closed: true } };
  const open = { size: 0, paths: {}, validator: { props: ['a'], closed: false } };
  const spec = { name: 'b_1', key: { b: 1 } };
  assert.equal(classifySchemaIssues(spec, closed, CONFIG)[0].provable, true);
  assert.equal(classifySchemaIssues(spec, open, CONFIG)[0].provable, false);
});

test('no sample and no validator yields no issues', () => {
  const none = { size: 0, paths: {}, validator: null };
  assert.deepEqual(classifySchemaIssues({ name: 'a_1', key: { a: 1 } }, none, CONFIG), []);
});

test('a top-level field absent from a closed validator is provable', () => {
  const closed = { size: 0, paths: {}, validator: { props: ['a'], closed: true } };
  const spec = { name: 'b_1', key: { b: 1 } };
  const issues = classifySchemaIssues(spec, closed, CONFIG);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].issue, 'not-in-validator');
  assert.equal(issues[0].provable, true);
  assert.match(issues[0].text, /forbids additional properties/);
});

test('a nested field absent from a closed validator is not provable', () => {
  const closed = { size: 0, paths: {}, validator: { props: ['address'], closed: true } };
  const spec = { name: 'address_zip_1', key: { 'address.zip': 1 } };
  const issues = classifySchemaIssues(spec, closed, CONFIG);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].issue, 'not-in-validator');
  assert.equal(issues[0].provable, false);
  assert.match(issues[0].text, /nested level is unverified/);
});

test('a field absent from an open validator is not provable', () => {
  const open = { size: 0, paths: {}, validator: { props: ['a'], closed: false } };
  const spec = { name: 'b_1', key: { b: 1 } };
  const issues = classifySchemaIssues(spec, open, CONFIG);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].issue, 'not-in-validator');
  assert.equal(issues[0].provable, false);
  assert.match(issues[0].text, /permits additional properties/);
});
