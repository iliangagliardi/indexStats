const test = require('node:test');
const assert = require('node:assert/strict');
const { detectTopology, parseShardHost } = require('../indexStats.js');

test('detectTopology recognises a mongos by its isdbgrid marker', () => {
  assert.equal(detectTopology({ msg: 'isdbgrid', ok: 1 }), 'sharded');
});

test('detectTopology recognises a replica set member by setName', () => {
  assert.equal(detectTopology({ setName: 'rs0', isWritablePrimary: true }), 'replica-set');
});

test('detectTopology falls back to standalone', () => {
  assert.equal(detectTopology({ isWritablePrimary: true }), 'standalone');
});

test('detectTopology treats a missing or empty hello as standalone rather than throwing', () => {
  assert.equal(detectTopology(null), 'standalone');
  assert.equal(detectTopology({}), 'standalone');
});

test('parseShardHost splits a replica-set shard into its name and members', () => {
  assert.deepEqual(parseShardHost('shardA/127.0.0.1:27021,127.0.0.1:27022'),
    { setName: 'shardA', hosts: ['127.0.0.1:27021', '127.0.0.1:27022'] });
});

test('parseShardHost handles a single-member replica-set shard', () => {
  assert.deepEqual(parseShardHost('shardB/127.0.0.1:27031'),
    { setName: 'shardB', hosts: ['127.0.0.1:27031'] });
});

test('parseShardHost handles a bare host with no replica-set prefix', () => {
  assert.deepEqual(parseShardHost('127.0.0.1:27018'),
    { setName: null, hosts: ['127.0.0.1:27018'] });
});

test('parseShardHost trims whitespace around members', () => {
  assert.deepEqual(parseShardHost('shardA/h1:27017, h2:27017'),
    { setName: 'shardA', hosts: ['h1:27017', 'h2:27017'] });
});

test('parseShardHost returns an empty host list for malformed input rather than throwing', () => {
  assert.deepEqual(parseShardHost(''), { setName: null, hosts: [] });
  assert.deepEqual(parseShardHost(null), { setName: null, hosts: [] });
  assert.deepEqual(parseShardHost('shardA/'), { setName: 'shardA', hosts: [] });
});
