const test = require('node:test');
const assert = require('node:assert/strict');
const { detectTopology, parseShardHost, canonicalObservedHost, canProbeShardsDirectly, demuxShardStats, buildShardRecord } = require('../indexStats.js');

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

// canonicalObservedHost - reconciling the two spellings of one member.
// VERIFIED on a real 8.0.21 sharded cluster (Task 12): listShards reported
// "shardA/127.0.0.1:27031,127.0.0.1:27032" while $collStats/$indexStats tagged
// their documents host "mongo-host-01:27031". Treating those as different
// members discarded the entire indirect payload.

test('buildShardRecord never reports full coverage when a host had to be inferred', () => {
  // The port inference in canonicalObservedHost is sound, but "full coverage"
  // is the single fact that unlocks a droppable verdict, so it may never rest
  // on an inference about which member actually answered.
  const rec = buildShardRecord(SHARD_A, {
    mode: 'indirect', expectedHosts: ['h1:27017', 'h2:27018'],
    observedHosts: ['h1:27017', 'h2:27018'],
    readPref: 'secondaryPreferred', error: null, unattributed: false,
    inferredHosts: true });
  assert.equal(rec.coverage, 'partial');
});

test('buildShardRecord still reports full coverage when every host matched exactly', () => {
  const rec = buildShardRecord(SHARD_A, {
    mode: 'indirect', expectedHosts: ['h1:27017', 'h2:27018'],
    observedHosts: ['h1:27017', 'h2:27018'],
    readPref: 'secondaryPreferred', error: null, unattributed: false,
    inferredHosts: false });
  assert.equal(rec.coverage, 'full');
});

test('canonicalObservedHost keeps a host that already matches a configured member', () => {
  assert.equal(
    canonicalObservedHost('127.0.0.1:27031', ['127.0.0.1:27031', '127.0.0.1:27032']),
    '127.0.0.1:27031');
});

test('canonicalObservedHost maps a differently-spelled host onto the member sharing its port', () => {
  assert.equal(
    canonicalObservedHost('mongo-host-01:27031', ['127.0.0.1:27031', '127.0.0.1:27032']),
    '127.0.0.1:27031');
  assert.equal(
    canonicalObservedHost('mongo-host-01:27032', ['127.0.0.1:27031', '127.0.0.1:27032']),
    '127.0.0.1:27032');
});

test('canonicalObservedHost refuses to guess when several members share the port', () => {
  // The Atlas shape: every member listens on 27017, so the port identifies
  // nothing. Returning the observed host unchanged is what keeps the caller
  // from claiming it observed a configured member it never identified - and
  // therefore from ever reporting full coverage on evidence it does not have.
  const atlas = ['sh-00-00.abc.mongodb.net:27017', 'sh-00-01.abc.mongodb.net:27017',
                 'sh-00-02.abc.mongodb.net:27017'];
  assert.equal(canonicalObservedHost('something-else:27017', atlas), 'something-else:27017');
});

test('canonicalObservedHost still prefers an exact match when the port is ambiguous', () => {
  const atlas = ['sh-00-00.abc.mongodb.net:27017', 'sh-00-01.abc.mongodb.net:27017'];
  assert.equal(canonicalObservedHost('sh-00-01.abc.mongodb.net:27017', atlas),
    'sh-00-01.abc.mongodb.net:27017');
});

test('canonicalObservedHost leaves a host with no port unchanged', () => {
  assert.equal(canonicalObservedHost('bare-hostname', ['127.0.0.1:27031']), 'bare-hostname');
});

test('canonicalObservedHost ignores configured entries that carry no port', () => {
  assert.equal(canonicalObservedHost('mongo-01:27031', ['bare-hostname']), 'mongo-01:27031');
});

test('canonicalObservedHost returns empty, missing or non-string input unchanged', () => {
  assert.equal(canonicalObservedHost('', ['127.0.0.1:27031']), '');
  assert.equal(canonicalObservedHost(null, ['127.0.0.1:27031']), null);
  assert.equal(canonicalObservedHost(undefined, ['127.0.0.1:27031']), undefined);
  assert.equal(canonicalObservedHost(42, ['127.0.0.1:27031']), 42);
});

test('canonicalObservedHost tolerates a missing or empty configured-host list', () => {
  assert.equal(canonicalObservedHost('mongo-01:27031', undefined), 'mongo-01:27031');
  assert.equal(canonicalObservedHost('mongo-01:27031', []), 'mongo-01:27031');
});

test('canonicalObservedHost handles an IPv6-style host by its last colon', () => {
  assert.equal(canonicalObservedHost('[::1]:27031', ['127.0.0.1:27031']), '127.0.0.1:27031');
});

// canProbeShardsDirectly - which capability may gate direct per-shard collection.
// VERIFIED on the same cluster: the capability probe builds its URI from
// deriveSeedHost, which on a mongos is the ROUTER's own serverStatus().host. A
// router reached over 127.0.0.1 self-reported a bare hostname that failed with
// getaddrinfo ENOTFOUND, so every shard was downgraded to indirect collection
// even though direct shard connections worked from that very shell.

test('canProbeShardsDirectly allows direct collection when the probe succeeded', () => {
  assert.equal(canProbeShardsDirectly({ canOpenConnections: true,
    connectionBlockedReason: null }), true);
});

test('canProbeShardsDirectly allows direct collection when only the router URI failed', () => {
  // template-failed says the ROUTER's address did not work. It says nothing
  // about the shards, which collectSharded probes individually anyway.
  assert.equal(canProbeShardsDirectly({ canOpenConnections: false,
    connectionBlockedReason: 'template-failed' }), true);
});

test('canProbeShardsDirectly blocks direct collection when there is no Mongo constructor', () => {
  // Compass's embedded shell: no connection can be opened to anything.
  assert.equal(canProbeShardsDirectly({ canOpenConnections: false,
    connectionBlockedReason: 'no-mongo-constructor' }), false);
});

test('canProbeShardsDirectly blocks direct collection when the template has no {host}', () => {
  // template-invalid would fail identically for every shard, so trying each
  // one only adds noise to the run.
  assert.equal(canProbeShardsDirectly({ canOpenConnections: false,
    connectionBlockedReason: 'template-invalid' }), false);
});

test('canProbeShardsDirectly is false for a missing capability object rather than throwing', () => {
  assert.equal(canProbeShardsDirectly(null), false);
  assert.equal(canProbeShardsDirectly(undefined), false);
});

// ---------------------------------------------------------------------------
// reconcileShardHosts - FINDING 1 (final whole-branch review, critical).
// The indirect path now keys one node per (shard, host), so reconciliation has
// to happen once per shard, over every host that shard's documents named: it
// is the only place a collision between two inferred hosts can be seen.

const { reconcileShardHosts } = require('../indexStats.js');

test('reconcileShardHosts maps exact matches unchanged and reports no inference', () => {
  const r = reconcileShardHosts(['h1:27017', 'h2:27017'], ['h1:27017', 'h2:27017', 'h3:27017']);
  assert.deepEqual(r.map, { 'h1:27017': 'h1:27017', 'h2:27017': 'h2:27017' });
  assert.equal(r.inferred, false);
});

test('reconcileShardHosts maps a differently-spelled host onto its unique port', () => {
  const r = reconcileShardHosts(['mongo-01:27031'], ['127.0.0.1:27031', '127.0.0.1:27032']);
  assert.deepEqual(r.map, { 'mongo-01:27031': '127.0.0.1:27031' });
  assert.equal(r.inferred, true, 'a port inference must deny full coverage');
});

test('reconcileShardHosts flags a host it could not place at all', () => {
  const r = reconcileShardHosts(['stranger:29999'], ['127.0.0.1:27031', '127.0.0.1:27032']);
  assert.deepEqual(r.map, { 'stranger:29999': 'stranger:29999' });
  assert.equal(r.inferred, true);
});

test('reconcileShardHosts keeps colliding hosts distinct rather than merging their evidence', () => {
  // Two different observed hosts that would both infer onto 127.0.0.1:27031.
  // Collapsing them would lose one member's evidence entirely in mergeNodes'
  // byHost map, which keys one node per host.
  const r = reconcileShardHosts(['mongo-01:27031', 'mongo-02:27031'],
    ['127.0.0.1:27031', '127.0.0.1:27032']);
  assert.deepEqual(r.map,
    { 'mongo-01:27031': 'mongo-01:27031', 'mongo-02:27031': 'mongo-02:27031' });
  assert.equal(r.inferred, true);
  assert.equal(new Set(Object.values(r.map)).size, 2, 'both hosts stay distinct');
});

test('reconcileShardHosts tolerates missing input', () => {
  assert.deepEqual(reconcileShardHosts(undefined, undefined), { map: {}, inferred: false });
  assert.deepEqual(reconcileShardHosts([], ['h1:27017']), { map: {}, inferred: false });
});

// ---------------------------------------------------------------------------
// buildShardRecord: ambiguous hosts (evidence no one member can be credited
// with) are informational, never observed, and on their own deny 'full'.

test('buildShardRecord never reports full coverage while any host is ambiguous', () => {
  const rec = buildShardRecord({ name: 'shardA', hosts: ['h1:27017', 'h2:27017'] }, {
    mode: 'indirect', expectedHosts: ['h1:27017', 'h2:27017'],
    observedHosts: ['h1:27017', 'h2:27017'], ambiguousHosts: ['h3:27017'],
    readPref: 'nearest',
  });
  assert.equal(rec.coverage, 'partial');
  assert.deepEqual(rec.ambiguousHosts, ['h3:27017']);
});

test('buildShardRecord defaults ambiguousHosts to an empty list', () => {
  const rec = buildShardRecord({ name: 'shardA', hosts: ['h1:27017'] }, {
    mode: 'direct', expectedHosts: ['h1:27017'], observedHosts: ['h1:27017'],
  });
  assert.deepEqual(rec.ambiguousHosts, []);
  assert.equal(rec.coverage, 'full');
});

// ---------------------------------------------------------------------------
// probeUriFor - FINDING 4 (final whole-branch review, important). MAX_TIME_MS
// cannot bound `new Mongo(uri)`; only the driver's server-selection timeout
// can, and the shipped template sets none. The PROBE gets a short one; the
// user's template is never rewritten for the real collection connections.

const { probeUriFor, PROBE_SELECTION_TIMEOUT_MS, URI_TEMPLATE } = require('../indexStats.js');

test('probeUriFor appends the timeout with & when the template already has a query string', () => {
  assert.equal(
    probeUriFor('mongodb://user:pass@{host}/?directConnection=true&appName=indexStats',
      'h1:27017', 2000),
    'mongodb://user:pass@h1:27017/?directConnection=true&appName=indexStats'
      + '&serverSelectionTimeoutMS=2000');
});

test('probeUriFor inserts the missing path separator when the template has no query string', () => {
  assert.equal(probeUriFor('mongodb://{host}', 'h1:27017', 2000),
    'mongodb://h1:27017/?serverSelectionTimeoutMS=2000');
});

test('probeUriFor does not add a second slash when the template already ends in one', () => {
  assert.equal(probeUriFor('mongodb://{host}/', 'h1:27017', 2000),
    'mongodb://h1:27017/?serverSelectionTimeoutMS=2000');
});

test('probeUriFor leaves a template that already sets the timeout alone', () => {
  const t = 'mongodb://{host}/?serverSelectionTimeoutMS=500';
  assert.equal(probeUriFor(t, 'h1:27017', 2000), 'mongodb://h1:27017/?serverSelectionTimeoutMS=500');
});

test('probeUriFor still enforces the {host} placeholder', () => {
  assert.throws(() => probeUriFor('mongodb://fixed:27017/', 'h1:27017', 2000),
    /URI_TEMPLATE must contain \{host\}/);
});

test('probeUriFor applied to the shipped URI_TEMPLATE produces one well-formed query string', () => {
  const uri = probeUriFor(URI_TEMPLATE, 'h1:27017', PROBE_SELECTION_TIMEOUT_MS);
  assert.equal(uri.split('?').length, 2, 'exactly one question mark');
  assert.match(uri, /&serverSelectionTimeoutMS=2000$/);
});

test('the probe timeout never makes the probe slower than the shell would on its own', () => {
  // MEASURED, mongosh 2.13.0: with no option in the URI, a stalled connection
  // failed with "Server selection timed out after 2000 ms" - mongosh does NOT
  // use the Node driver's documented 30s default. A probe bound ABOVE that
  // would slow the common case down in the name of speeding it up, which is
  // the mistake this pin exists to catch.
  assert.ok(PROBE_SELECTION_TIMEOUT_MS > 0 && PROBE_SELECTION_TIMEOUT_MS <= 2000,
    'must not exceed mongosh 2.13.0 own 2000ms server-selection default');
});

test('the shipped URI_TEMPLATE itself carries no server-selection timeout', () => {
  // The fix is scoped to the probe. Rewriting the shipped template would
  // change replica-set timing, which this change must leave untouched.
  assert.equal(URI_TEMPLATE.includes('serverSelectionTimeoutMS'), false);
});
