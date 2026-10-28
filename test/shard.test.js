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

const { discoverShards } = require('../indexStats.js');

const SHARD_CONFIG = { MAX_TIME_MS: 30000 };

function fakeAdmin(response) {
  return { runCommand(cmd) { this.lastCmd = cmd; return response; } };
}

test('discoverShards turns listShards output into sorted shard records', () => {
  const admin = fakeAdmin({ ok: 1, shards: [
    { _id: 'shardB', host: 'shardB/h3:27017,h4:27017', state: 1 },
    { _id: 'shardA', host: 'shardA/h1:27017,h2:27017', state: 1 },
  ]});
  assert.deepEqual(discoverShards(admin, SHARD_CONFIG), [
    { name: 'shardA', setName: 'shardA', hosts: ['h1:27017', 'h2:27017'], state: 1, draining: false },
    { name: 'shardB', setName: 'shardB', hosts: ['h3:27017', 'h4:27017'], state: 1, draining: false },
  ]);
});

test('discoverShards carries maxTimeMS on the command, like every other server call', () => {
  const admin = fakeAdmin({ ok: 1, shards: [] });
  discoverShards(admin, SHARD_CONFIG);
  assert.equal(admin.lastCmd.maxTimeMS, 30000);
  assert.equal(admin.lastCmd.listShards, 1);
});

test('discoverShards keeps a draining shard, because its indexes still exist', () => {
  const admin = fakeAdmin({ ok: 1, shards: [
    { _id: 'shardA', host: 'shardA/h1:27017', state: 1, draining: true },
  ]});
  const shards = discoverShards(admin, SHARD_CONFIG);
  assert.equal(shards.length, 1);
  assert.equal(shards[0].draining, true);
});

test('discoverShards throws when listShards fails - a sharded run cannot safely degrade', () => {
  const admin = { runCommand() { throw Object.assign(new Error('not authorized'), { codeName: 'Unauthorized' }); } };
  assert.throws(() => discoverShards(admin, SHARD_CONFIG), /not authorized/);
});
