const test = require('node:test');
const assert = require('node:assert/strict');
const { detectTopology, parseShardHost, demuxShardStats, buildShardRecord } = require('../indexStats.js');

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

const SINCE_A = new Date('2026-01-01T00:00:00Z');
const SINCE_B = new Date('2026-02-01T00:00:00Z');

test('demuxShardStats separates storage statistics by shard', () => {
  const out = demuxShardStats([
    { shard: 'shardA', host: 'h1:27017', storageStats: { indexSizes: { _id_: 100, a_1: 50 } } },
    { shard: 'shardB', host: 'h3:27017', storageStats: { indexSizes: { _id_: 200, a_1: 70 } } },
  ], []);
  assert.equal(out.byShard.shardA.storage._id_.sizeBytes, 100);
  assert.equal(out.byShard.shardA.storage.a_1.sizeBytes, 50);
  assert.equal(out.byShard.shardB.storage._id_.sizeBytes, 200);
  assert.equal(out.byShard.shardB.storage.a_1.sizeBytes, 70);
});

test('demuxShardStats separates usage counters by shard and records the answering hosts', () => {
  const out = demuxShardStats([], [
    { shard: 'shardA', host: 'h1:27017', name: 'a_1', key: { a: 1 },
      accesses: { ops: 12, since: SINCE_A }, spec: { name: 'a_1', key: { a: 1 }, v: 2 } },
    { shard: 'shardB', host: 'h3:27017', name: 'a_1', key: { a: 1 },
      accesses: { ops: 0, since: SINCE_B }, spec: { name: 'a_1', key: { a: 1 }, v: 2 } },
  ]);
  assert.equal(out.byShard.shardA.usage.a_1.ops, 12);
  assert.equal(out.byShard.shardB.usage.a_1.ops, 0);
  assert.deepEqual(out.byShard.shardA.hosts, ['h1:27017']);
  assert.deepEqual(out.byShard.shardB.hosts, ['h3:27017']);
});

test('demuxShardStats takes the index spec from $indexStats, since getIndexes via mongos is merged', () => {
  const out = demuxShardStats([], [
    { shard: 'shardA', host: 'h1:27017', name: 'a_1', key: { a: 1 },
      accesses: { ops: 1, since: SINCE_A },
      spec: { name: 'a_1', key: { a: 1 }, v: 2, unique: true } },
  ]);
  assert.deepEqual(out.byShard.shardA.indexes, [{ name: 'a_1', key: { a: 1 }, v: 2, unique: true }]);
});

test('demuxShardStats synthesises a minimal spec when the server omits one', () => {
  const out = demuxShardStats([], [
    { shard: 'shardA', host: 'h1:27017', name: 'a_1', key: { a: 1 },
      accesses: { ops: 1, since: SINCE_A } },
  ]);
  assert.deepEqual(out.byShard.shardA.indexes, [{ name: 'a_1', key: { a: 1 } }]);
});

test('demuxShardStats sums several documents from the same shard and keeps the earliest counter', () => {
  const out = demuxShardStats([], [
    { shard: 'shardA', host: 'h1:27017', name: 'a_1', key: { a: 1 }, accesses: { ops: 5, since: SINCE_B } },
    { shard: 'shardA', host: 'h2:27017', name: 'a_1', key: { a: 1 }, accesses: { ops: 7, since: SINCE_A } },
  ]);
  assert.equal(out.byShard.shardA.usage.a_1.ops, 12);
  assert.deepEqual(out.byShard.shardA.usage.a_1.since, SINCE_A);
  assert.deepEqual(out.byShard.shardA.hosts, ['h1:27017', 'h2:27017']);
});

test('demuxShardStats reads reusable and cache bytes from indexDetails', () => {
  const out = demuxShardStats([
    { shard: 'shardA', host: 'h1:27017', storageStats: {
      indexSizes: { a_1: 50 },
      indexDetails: { a_1: {
        'block-manager': { 'file bytes available for reuse': 16384 },
        cache: { 'bytes currently in the cache': 4096 } } } } },
  ], []);
  assert.equal(out.byShard.shardA.storage.a_1.reusableBytes, 16384);
  assert.equal(out.byShard.shardA.storage.a_1.cacheBytes, 4096);
});

test('demuxShardStats flags documents that carry no shard field', () => {
  const out = demuxShardStats([
    { host: 'h1:27017', storageStats: { indexSizes: { _id_: 100 } } },
  ], []);
  assert.equal(out.unattributed, true);
});

test('demuxShardStats reports unattributed false when every document is tagged', () => {
  const out = demuxShardStats([
    { shard: 'shardA', host: 'h1:27017', storageStats: { indexSizes: { _id_: 100 } } },
  ], []);
  assert.equal(out.unattributed, false);
});

test('demuxShardStats returns an empty result for empty input', () => {
  assert.deepEqual(demuxShardStats([], []), { byShard: {}, unattributed: false });
});

const SHARD_A = { name: 'shardA', setName: 'shardA', hosts: ['h1:27017', 'h2:27017', 'h3:27017'], state: 1, draining: false };

test('buildShardRecord reports full coverage when every expected member was observed', () => {
  const rec = buildShardRecord(SHARD_A, {
    mode: 'direct', expectedHosts: ['h1:27017', 'h2:27017', 'h3:27017'],
    observedHosts: ['h1:27017', 'h2:27017', 'h3:27017'],
    readPref: 'secondaryPreferred', error: null, unattributed: false });
  assert.equal(rec.coverage, 'full');
  assert.equal(rec.mode, 'direct');
  assert.equal(rec.name, 'shardA');
});

test('buildShardRecord reports partial coverage when only some members answered', () => {
  const rec = buildShardRecord(SHARD_A, {
    mode: 'direct', expectedHosts: ['h1:27017', 'h2:27017', 'h3:27017'],
    observedHosts: ['h1:27017', 'h2:27017'],
    readPref: 'secondaryPreferred', error: null, unattributed: false });
  assert.equal(rec.coverage, 'partial');
});

test('buildShardRecord reports partial coverage for the Atlas case: one member via mongos', () => {
  const rec = buildShardRecord(SHARD_A, {
    mode: 'indirect', expectedHosts: ['h1:27017', 'h2:27017', 'h3:27017'],
    observedHosts: ['h1:27017'], readPref: 'primary', error: null, unattributed: false });
  assert.equal(rec.coverage, 'partial');
  assert.equal(rec.mode, 'indirect');
  assert.equal(rec.readPref, 'primary');
});

test('buildShardRecord reports no coverage when the shard answered nothing', () => {
  const rec = buildShardRecord(SHARD_A, {
    mode: 'indirect', expectedHosts: ['h1:27017'], observedHosts: [],
    readPref: 'primary', error: 'Unauthorized', unattributed: false });
  assert.equal(rec.coverage, 'none');
  assert.equal(rec.error, 'Unauthorized');
});

test('buildShardRecord never reports full coverage when a document arrived unattributed', () => {
  const rec = buildShardRecord(SHARD_A, {
    mode: 'indirect', expectedHosts: ['h1:27017'], observedHosts: ['h1:27017'],
    readPref: 'primary', error: null, unattributed: true });
  assert.equal(rec.coverage, 'partial');
});

test('buildShardRecord never reports full coverage when nothing was expected', () => {
  const rec = buildShardRecord(SHARD_A, {
    mode: 'indirect', expectedHosts: [], observedHosts: [],
    readPref: 'primary', error: null, unattributed: false });
  assert.equal(rec.coverage, 'none');
});

test('buildShardRecord never reports full coverage when the expected-host list is empty but a member answered', () => {
  const rec = buildShardRecord(SHARD_A, {
    mode: 'indirect', expectedHosts: [], observedHosts: ['h1:27017'],
    readPref: 'primary', error: null, unattributed: false });
  assert.equal(rec.coverage, 'partial');
});

test('buildShardRecord carries the implicit single shard of a non-sharded deployment', () => {
  const rec = buildShardRecord({ name: null, setName: null, hosts: [], state: 1, draining: false }, {
    mode: 'direct', expectedHosts: ['h1:27017'], observedHosts: ['h1:27017'],
    readPref: 'secondaryPreferred', error: null, unattributed: false });
  assert.equal(rec.name, null);
  assert.equal(rec.coverage, 'full');
});
