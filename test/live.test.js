const test = require('node:test');
const assert = require('node:assert/strict');
const { probeCapabilities, uriFor, discoverMembers, collectFromNode } = require('../indexStats.js');

const CONFIG = { EXCLUDED_DBS: ['admin', 'config', 'local'], MAX_TIME_MS: 30000, INCLUDE_HIDDEN: true };

test('uriFor substitutes the host placeholder', () => {
  assert.equal(uriFor('mongodb://u:p@{host}/?directConnection=true', 'h1:27017'),
    'mongodb://u:p@h1:27017/?directConnection=true');
});

test('uriFor rejects a template without the placeholder', () => {
  assert.throws(() => uriFor('mongodb://h1:27017/', 'h2:27017'), /\{host\}/);
});

const URI_TEMPLATE = 'mongodb://user:pass@{host}/?directConnection=true';

test('probeCapabilities reports false when both probes throw', () => {
  const caps = probeCapabilities({
    requireFn: () => { throw new Error('not available'); },
    MongoCtor: function () { throw new Error('forbidden'); },
    uriTemplate: URI_TEMPLATE,
    seedHost: 'h1:27017',
  });
  assert.deepEqual({ w: caps.canWriteFiles, c: caps.canOpenConnections }, { w: false, c: false });
});

test('probeCapabilities reports true when both succeed', () => {
  const caps = probeCapabilities({
    requireFn: () => ({ writeFileSync() {} }),
    MongoCtor: function () { return {}; },
    uriTemplate: URI_TEMPLATE,
    seedHost: 'h1:27017',
  });
  assert.deepEqual({ w: caps.canWriteFiles, c: caps.canOpenConnections }, { w: true, c: true });
});

// FINDING 5 (final review, important): the probe used to construct
// `new MongoCtor(seedHost)` - a bare host, no credentials, no
// directConnection - so it reported `canOpenConnections: true` even when
// every REAL fan-out connection (built from URI_TEMPLATE) would fail
// authentication. It must probe with the actual template-built URI.
test('probeCapabilities constructs the Mongo connection from the actual URI_TEMPLATE, not a bare host', () => {
  let seenArg = null;
  probeCapabilities({
    requireFn: () => ({ writeFileSync() {} }),
    MongoCtor: function (uri) { seenArg = uri; return {}; },
    uriTemplate: 'mongodb://svc:secret@{host}/?directConnection=true&appName=x',
    seedHost: 'h1:27017',
  });
  assert.equal(seenArg, 'mongodb://svc:secret@h1:27017/?directConnection=true&appName=x');
});

test('probeCapabilities distinguishes "no Mongo constructor" from "template built, but connection failed"', () => {
  const noMongo = probeCapabilities({
    requireFn: () => ({ writeFileSync() {} }),
    MongoCtor: function () { throw new Error('no Mongo'); }, // main()'s own stub for "Mongo is undefined"
    uriTemplate: URI_TEMPLATE,
    seedHost: 'h1:27017',
  });
  assert.equal(noMongo.canOpenConnections, false);
  assert.equal(noMongo.connectionBlockedReason, 'no-mongo-constructor');

  const authFailed = probeCapabilities({
    requireFn: () => ({ writeFileSync() {} }),
    MongoCtor: function () { const e = new Error('Authentication failed.'); e.codeName = 'AuthenticationFailed'; throw e; },
    uriTemplate: URI_TEMPLATE,
    seedHost: 'h1:27017',
  });
  assert.equal(authFailed.canOpenConnections, false);
  assert.equal(authFailed.connectionBlockedReason, 'template-failed');
});

test('probeCapabilities reports an invalid URI_TEMPLATE distinctly, without ever calling MongoCtor', () => {
  let called = false;
  const caps = probeCapabilities({
    requireFn: () => ({ writeFileSync() {} }),
    MongoCtor: function () { called = true; return {}; },
    uriTemplate: 'mongodb://h1:27017/', // no {host}
    seedHost: 'h1:27017',
  });
  assert.equal(called, false);
  assert.equal(caps.canOpenConnections, false);
  assert.equal(caps.connectionBlockedReason, 'template-invalid');
});

// FINDING 6 (final review, important): the project's headline invariant -
// "every server call carries maxTimeMS" - was asserted by no test, because
// every fake below ignored the options/command argument entirely. A future
// edit that dropped maxTimeMS from a real call would have been invisible.
// These fakes now assert it on every command they stand in for.
function fakeAdmin(rsConfig, helloMsg) {
  return {
    runCommand(cmd) {
      if (cmd.hello) {
        assert.equal(cmd.maxTimeMS, CONFIG.MAX_TIME_MS, 'hello must carry maxTimeMS');
        return helloMsg ? { msg: helloMsg } : { ok: 1 };
      }
      if (cmd.replSetGetConfig) {
        assert.equal(cmd.maxTimeMS, CONFIG.MAX_TIME_MS, 'replSetGetConfig must carry maxTimeMS');
        if (!rsConfig) {
          const e = new Error('not running with --replSet');
          e.codeName = 'NoReplicationEnabled';
          throw e;
        }
        return { config: rsConfig };
      }
      throw new Error('unexpected command ' + JSON.stringify(cmd));
    },
  };
}

// discoverMembers used to refuse a mongos outright. main() now routes on
// detectTopology before it ever gets here, so the refusal is gone and the
// function must simply do its ordinary job on whatever it is handed.
test('discoverMembers no longer refuses a mongos - main() routes on detectTopology first', () => {
  const { members, replicaSetName } = discoverMembers(fakeAdmin({
    _id: 'rs0',
    members: [{ _id: 0, host: 'h1:27017' }],
  }, 'isdbgrid'), CONFIG);
  assert.equal(replicaSetName, 'rs0');
  assert.deepEqual(members.map((m) => m.host), ['h1:27017']);
});

test('drops arbiters and keeps hidden members', () => {
  const { members, replicaSetName, mode } = discoverMembers(fakeAdmin({
    _id: 'rs0',
    members: [
      { _id: 0, host: 'h1:27017' },
      { _id: 1, host: 'h2:27017', hidden: true, priority: 0, secondaryDelaySecs: 60 },
      { _id: 2, host: 'h3:27017', arbiterOnly: true },
    ],
  }), CONFIG);
  assert.equal(replicaSetName, 'rs0');
  assert.equal(mode, 'multi-node');
  assert.deepEqual(members.map((m) => m.host), ['h1:27017', 'h2:27017']);
  assert.equal(members[1].hidden, true);
  assert.equal(members[1].delaySecs, 60);
});

test('excludes hidden members when INCLUDE_HIDDEN is false', () => {
  const { members } = discoverMembers(fakeAdmin({
    _id: 'rs0',
    members: [{ _id: 0, host: 'h1:27017' },
              { _id: 1, host: 'h2:27017', hidden: true, priority: 0 }],
  }), { ...CONFIG, INCLUDE_HIDDEN: false });
  assert.deepEqual(members.map((m) => m.host), ['h1:27017']);
});

// FINDING 4 (final review, important): INCLUDE_HIDDEN=false used to make
// hidden members vanish from the accounting entirely - not in `members`
// (correct, they must never be contacted) but ALSO not recorded anywhere as
// a gap, so a zero-ops index on the visible members looked fully confirmed
// even though the hidden analytics member (the likeliest actual user of
// that index) was never consulted.
test('excluded-by-config hidden members are still reported, as a distinct non-"unreachable" reason', () => {
  const { members, excludedByConfig } = discoverMembers(fakeAdmin({
    _id: 'rs0',
    members: [{ _id: 0, host: 'h1:27017' },
              { _id: 1, host: 'h2:27017', hidden: true, priority: 0 }],
  }), { ...CONFIG, INCLUDE_HIDDEN: false });
  assert.deepEqual(members.map((m) => m.host), ['h1:27017'], 'still never a connection target');
  assert.equal(excludedByConfig.length, 1);
  assert.equal(excludedByConfig[0].host, 'h2:27017');
  assert.equal(excludedByConfig[0].reachable, false);
  assert.match(excludedByConfig[0].error, /INCLUDE_HIDDEN/);
});

test('excludedByConfig is empty when INCLUDE_HIDDEN is true or in single-node mode', () => {
  const multi = discoverMembers(fakeAdmin({
    _id: 'rs0',
    members: [{ _id: 0, host: 'h1:27017' }, { _id: 1, host: 'h2:27017', hidden: true, priority: 0 }],
  }), CONFIG);
  assert.deepEqual(multi.excludedByConfig, []);
  const single = discoverMembers(fakeAdmin(null), { ...CONFIG, SEED_HOST: 'h9:27017' });
  assert.deepEqual(single.excludedByConfig, []);
});

test('falls back to single-node mode when replication is not enabled', () => {
  const { mode, members } = discoverMembers(fakeAdmin(null), { ...CONFIG, SEED_HOST: 'h9:27017' });
  assert.equal(mode, 'single-node');
  assert.deepEqual(members.map((m) => m.host), ['h9:27017']);
});

test('an Unauthorized error from replSetGetConfig throws, not a silent single-node fallback', () => {
  const adminDb = {
    runCommand(cmd) {
      if (cmd.hello) return { ok: 1 };
      if (cmd.replSetGetConfig) {
        const e = new Error('not authorized on admin to execute command');
        e.codeName = 'Unauthorized';
        throw e;
      }
      throw new Error('unexpected command ' + JSON.stringify(cmd));
    },
  };
  assert.throws(() => discoverMembers(adminDb, CONFIG), /not authorized/i);
});

function fakeConn() {
  const coll = () => ({
    aggregate(pipeline, options) {
      if (pipeline[0].$collStats) {
        assert.equal(options && options.maxTimeMS, CONFIG.MAX_TIME_MS, '$collStats must carry maxTimeMS');
        return { toArray: () => [{ storageStats: {
          indexSizes: { _id_: 100, a_1: 200 },
          indexDetails: {
            _id_: { 'block-manager': { 'file bytes available for reuse': 10 },
                    cache: { 'bytes currently in the cache': 5 } },
            a_1: { 'block-manager': { 'file bytes available for reuse': 20 },
                   cache: { 'bytes currently in the cache': 7 } },
          },
        } }] };
      }
      if (pipeline[0].$indexStats) {
        assert.equal(options && options.maxTimeMS, CONFIG.MAX_TIME_MS, '$indexStats must carry maxTimeMS');
        return { toArray: () => [
          { name: '_id_', accesses: { ops: 5, since: new Date('2026-01-01') } },
          { name: 'a_1', accesses: { ops: 0, since: new Date('2026-01-01') } },
        ] };
      }
      throw new Error('unexpected pipeline');
    },
    // R10/finding 6: getIndexes() carries no maxTimeMS - see the code comment
    // at its call site, empirically verified against a real mongod. Nothing
    // to assert here; this is the documented exception, not an oversight.
    getIndexes: () => [{ v: 2, name: '_id_', key: { _id: 1 } }, { v: 2, name: 'a_1', key: { a: 1 } }],
  });
  return {
    host: 'h1:27017',
    setReadPref() { this.readPref = 'set'; },
    getDB: (name) => ({
      // R10/finding 6: getCollectionInfos also carries no working maxTimeMS -
      // same documented exception - but its OTHER two arguments are load-bearing
      // (Task 11 regression: conn.adminCommand doesn't exist; a prior bug called
      // getCollectionInfos with the wrong nameOnly shape). Assert the real call
      // shape instead: ({ type: 'collection' }, true) - a boolean nameOnly, not
      // an options bag.
      getCollectionInfos: (filter, nameOnly) => {
        assert.deepEqual(filter, { type: 'collection' });
        assert.equal(nameOnly, true, 'nameOnly must be passed as a boolean, not an options bag');
        return [{ name: 'orders', type: 'collection' },
                { name: 'system.profile', type: 'collection' }];
      },
      getCollection: coll,
      // Real mongosh Mongo connection objects expose adminCommand only on the
      // Database returned by getDB(), never on the connection itself - this
      // mock must mirror that shape or it will hide the bug it once hid.
      adminCommand: (cmd) => {
        if (cmd.listDatabases) {
          assert.equal(cmd.maxTimeMS, CONFIG.MAX_TIME_MS, 'listDatabases must carry maxTimeMS');
          return { databases: [{ name: 'shop' }, { name: 'admin' }, { name: 'local' }, { name: 'config' }] };
        }
        return { ok: 1 };
      },
    }),
  };
}

// Must-fix minor (final review, finding 6): a dedicated test for the exact
// getCollectionInfos({type:'collection'}, true) boolean-nameOnly call shape -
// a prior real bug (Task 11) passed the wrong shape here and was only ever
// caught end-to-end, never by a unit test.
test('collectFromNode calls getCollectionInfos with a boolean nameOnly, not an options bag', () => {
  let seenArgs = null;
  const conn = fakeConn();
  const realGetDB = conn.getDB;
  conn.getDB = (name) => {
    const dbHandle = realGetDB(name);
    const realGCI = dbHandle.getCollectionInfos;
    dbHandle.getCollectionInfos = (...args) => { seenArgs = args; return realGCI(...args); };
    return dbHandle;
  };
  collectFromNode(conn, CONFIG);
  assert.deepEqual(seenArgs[0], { type: 'collection' });
  assert.equal(seenArgs[1], true);
  assert.equal(typeof seenArgs[1], 'boolean', 'nameOnly must be a boolean, not an options object');
});

test('collects indexes, usage and storage for non-system collections only', () => {
  const r = collectFromNode(fakeConn(), CONFIG);
  assert.deepEqual(r.namespaces, ['shop.orders']);
  const c = r.collections['shop.orders'];
  assert.deepEqual(c.indexes.map((i) => i.name), ['_id_', 'a_1']);
  assert.equal(c.usage._id_.ops, 5);
  assert.equal(c.storage.a_1.sizeBytes, 200);
  assert.equal(c.storage.a_1.reusableBytes, 20);
  assert.equal(c.storage.a_1.cacheBytes, 7);
});

test('excludes admin, local and config databases', () => {
  const r = collectFromNode(fakeConn(), CONFIG);
  assert.equal(r.namespaces.some((ns) => /^(admin|local|config)\./.test(ns)), false);
});

test('sets secondaryPreferred read preference before collecting', () => {
  const conn = fakeConn();
  collectFromNode(conn, CONFIG);
  assert.equal(conn.readPref, 'set');
});

test('a failing collection is skipped, not fatal', () => {
  const conn = fakeConn();
  conn.getDB = (name) => ({
    getCollectionInfos: () => [{ name: 'orders', type: 'collection' }],
    getCollection: () => ({
      aggregate() { const e = new Error('timed out'); e.codeName = 'MaxTimeMSExpired'; throw e; },
      getIndexes() { return []; },
    }),
    adminCommand: (cmd) => (cmd.listDatabases ? { databases: [{ name: 'shop' }] } : { ok: 1 }),
  });
  const r = collectFromNode(conn, CONFIG);
  assert.equal(r.collections['shop.orders'].error, 'MaxTimeMSExpired');
});

// --- Controller ruling R2: explicit host argument wins over conn.host ---

test('collectFromNode uses conn.host as a fallback when no explicit host is given', () => {
  const r = collectFromNode(fakeConn(), CONFIG);
  assert.equal(r.host, 'h1:27017');
});

test('collectFromNode uses the explicit third argument over a differing conn.host', () => {
  const conn = fakeConn();
  assert.equal(conn.host, 'h1:27017');
  const r = collectFromNode(conn, CONFIG, 'explicit-host:27017');
  assert.equal(r.host, 'explicit-host:27017');
});

const { collectFromMongos } = require('../indexStats.js');

const MONGOS_CONFIG = { EXCLUDED_DBS: ['admin', 'config', 'local'], MAX_TIME_MS: 30000 };
const SINCE = new Date('2026-01-01T00:00:00Z');

// A fake mongos connection. getCollectionInfos and the two aggregations are the
// only surfaces collectFromMongos touches.
function fakeMongos({ dbs, colls, collStats, indexStats }) {
  return {
    setReadPref() { throw new Error('collectFromMongos must never set read preference on a mongos'); },
    getDB(name) {
      return {
        adminCommand() { return { databases: dbs.map((d) => ({ name: d })) }; },
        getCollectionInfos() { return (colls[name] ?? []).map((c) => ({ name: c })); },
        getCollection(collName) {
          const ns = name + '.' + collName;
          return {
            aggregate(pipeline) {
              const stage = Object.keys(pipeline[0])[0];
              const docs = stage === '$collStats' ? (collStats[ns] ?? []) : (indexStats[ns] ?? []);
              return { toArray() { return docs; } };
            },
          };
        },
      };
    },
  };
}

test('collectFromMongos produces one node result per shard, shaped like collectFromNode', () => {
  const conn = fakeMongos({
    dbs: ['admin', 'config', 'shop'],
    colls: { shop: ['orders'] },
    collStats: { 'shop.orders': [
      { shard: 'shardA', host: 'h1:27017', storageStats: { indexSizes: { _id_: 100 } } },
      { shard: 'shardB', host: 'h3:27017', storageStats: { indexSizes: { _id_: 200 } } },
    ]},
    indexStats: { 'shop.orders': [
      { shard: 'shardA', host: 'h1:27017', name: '_id_', key: { _id: 1 }, accesses: { ops: 5, since: SINCE } },
      { shard: 'shardB', host: 'h3:27017', name: '_id_', key: { _id: 1 }, accesses: { ops: 0, since: SINCE } },
    ]},
  });
  const out = collectFromMongos(conn, MONGOS_CONFIG, ['shardA', 'shardB']);
  const a = out.nodeResults.find((r) => r.shard === 'shardA');
  const b = out.nodeResults.find((r) => r.shard === 'shardB');
  assert.equal(a.host, 'h1:27017');
  assert.equal(b.host, 'h3:27017');
  assert.deepEqual(a.namespaces, ['shop.orders']);
  assert.equal(a.collections['shop.orders'].usage._id_.ops, 5);
  assert.equal(b.collections['shop.orders'].storage._id_.sizeBytes, 200);
  assert.deepEqual(out.observedByShard.shardA.hosts, ['h1:27017']);
});

test('collectFromMongos excludes admin, config and local', () => {
  const conn = fakeMongos({
    dbs: ['admin', 'config', 'local', 'shop'],
    colls: { shop: ['orders'], admin: ['x'], config: ['chunks'], local: ['y'] },
    collStats: { 'shop.orders': [{ shard: 'shardA', host: 'h1:27017', storageStats: { indexSizes: { _id_: 1 } } }] },
    indexStats: {},
  });
  const out = collectFromMongos(conn, MONGOS_CONFIG, ['shardA']);
  assert.deepEqual(out.nodeResults.find((r) => r.shard === 'shardA').namespaces, ['shop.orders']);
});

test('collectFromMongos records a namespace only on the shards that actually returned data', () => {
  const conn = fakeMongos({
    dbs: ['shop'],
    colls: { shop: ['orders', 'lookup'] },
    // `lookup` is unsharded: it lives only on the primary shard, shardA.
    collStats: {
      'shop.orders': [
        { shard: 'shardA', host: 'h1:27017', storageStats: { indexSizes: { _id_: 10 } } },
        { shard: 'shardB', host: 'h3:27017', storageStats: { indexSizes: { _id_: 10 } } },
      ],
      'shop.lookup': [
        { shard: 'shardA', host: 'h1:27017', storageStats: { indexSizes: { _id_: 10 } } },
      ],
    },
    indexStats: {},
  });
  const out = collectFromMongos(conn, MONGOS_CONFIG, ['shardA', 'shardB']);
  assert.deepEqual(out.nodeResults.find((r) => r.shard === 'shardA').namespaces.sort(),
    ['shop.lookup', 'shop.orders']);
  assert.deepEqual(out.nodeResults.find((r) => r.shard === 'shardB').namespaces, ['shop.orders']);
});

test('collectFromMongos carries maxTimeMS on both aggregations', () => {
  const seen = [];
  const conn = {
    getDB(name) {
      return {
        adminCommand() { return { databases: [{ name: 'shop' }] }; },
        getCollectionInfos() { return name === 'shop' ? [{ name: 'orders' }] : []; },
        getCollection() {
          return { aggregate(pipeline, options) { seen.push(options); return { toArray() { return []; } }; } };
        },
      };
    },
  };
  collectFromMongos(conn, MONGOS_CONFIG, ['shardA']);
  assert.equal(seen.length, 2);
  for (const o of seen) assert.equal(o.maxTimeMS, 30000);
});

test('collectFromMongos records a failing namespace as skipped without aborting the run', () => {
  const conn = {
    getDB(name) {
      return {
        adminCommand() { return { databases: [{ name: 'shop' }] }; },
        getCollectionInfos() { return name === 'shop' ? [{ name: 'orders' }] : []; },
        getCollection() {
          return { aggregate() { throw Object.assign(new Error('nope'), { codeName: 'Unauthorized' }); } };
        },
      };
    },
  };
  const out = collectFromMongos(conn, MONGOS_CONFIG, ['shardA']);
  const node = out.nodeResults.find((r) => r.shard === 'shardA');
  assert.deepEqual(node.skipped, [{ ns: 'shop.orders', reason: 'Unauthorized' }]);
});

test('collectFromMongos keeps a shard that returned nothing, with no observed hosts', () => {
  const conn = fakeMongos({
    dbs: ['shop'], colls: { shop: ['orders'] },
    collStats: { 'shop.orders': [{ shard: 'shardA', host: 'h1:27017', storageStats: { indexSizes: { _id_: 1 } } }] },
    indexStats: {},
  });
  const out = collectFromMongos(conn, MONGOS_CONFIG, ['shardA', 'shardB']);
  assert.deepEqual(out.observedByShard.shardB.hosts, []);
});

const { collectSharded } = require('../indexStats.js');

test('collectSharded uses mongos for every shard when no direct connection can be opened', () => {
  const conn = fakeMongos({
    dbs: ['shop'], colls: { shop: ['orders'] },
    collStats: { 'shop.orders': [
      { shard: 'shardA', host: 'h1:27017', storageStats: { indexSizes: { _id_: 10 } } }] },
    indexStats: { 'shop.orders': [
      { shard: 'shardA', host: 'h1:27017', name: '_id_', key: { _id: 1 },
        accesses: { ops: 0, since: SINCE } }] },
  });
  const out = collectSharded({
    conn, config: MONGOS_CONFIG,
    shards: [{ name: 'shardA', setName: 'shardA', hosts: ['h1:27017', 'h2:27017'], state: 1, draining: false }],
    MongoCtor: function () { throw new Error('no Mongo'); },
    canOpenConnections: false, readPref: 'primary', printFn() {},
  });
  assert.equal(out.shardRecords[0].mode, 'indirect');
  assert.equal(out.shardRecords[0].coverage, 'partial');
  assert.deepEqual(out.shardRecords[0].observedHosts, ['h1:27017']);
  // The member mongos never routed to must appear as unreachable, so the
  // existing coverage gates can see the hole.
  const unseen = out.members.find((m) => m.host === 'h2:27017');
  assert.equal(unseen.reachable, false);
  assert.equal(unseen.shard, 'shardA');
});

test('collectSharded marks every member of an indirect shard with its shard name', () => {
  const conn = fakeMongos({
    dbs: ['shop'], colls: { shop: ['orders'] },
    collStats: { 'shop.orders': [
      { shard: 'shardA', host: 'h1:27017', storageStats: { indexSizes: { _id_: 10 } } }] },
    indexStats: {},
  });
  const out = collectSharded({
    conn, config: MONGOS_CONFIG,
    shards: [{ name: 'shardA', setName: 'shardA', hosts: ['h1:27017', 'h2:27017'], state: 1, draining: false }],
    MongoCtor: function () { throw new Error('no Mongo'); },
    canOpenConnections: false, readPref: 'primary', printFn() {},
  });
  for (const m of out.members) assert.equal(m.shard, 'shardA');
});

// Direct mode is the ONLY path that can produce coverage 'full', and therefore
// the only path that can ever unlock a drop verdict - so it gets its own fakes
// rather than being trusted because it resembles main()'s replica-set loop.
//
// URI_TEMPLATE is the bare '{host}' placeholder so uriFor() returns the host
// unchanged and the fake constructor can dispatch on it directly. (uriFor still
// enforces the placeholder, so this exercises the real substitution.)
const DIRECT_CONFIG = {
  EXCLUDED_DBS: ['admin', 'config', 'local'], MAX_TIME_MS: 30000,
  INCLUDE_HIDDEN: true, URI_TEMPLATE: '{host}',
  // Deliberately the MONGOS's host: if collectSharded ever let discoverMembers'
  // single-node fallback inherit this, a shard member would be labelled with the
  // router's identity.
  SEED_HOST: 'mongos:27017',
};

// One fake shard member. Surfaces: discoverMembers' replSetGetConfig,
// collectSharded's per-member hello, and everything collectFromNode touches.
// A null rsConfig stands in for a bare standalone shard, where
// replSetGetConfig reports NoReplicationEnabled and discoverMembers takes its
// single-node fallback.
// `stats` overrides what shop.orders reports, for the end-to-end verdict test
// below; it defaults to a single, used _id_ index.
function fakeShardMemberConn(host, rsConfig, stats) {
  const s = stats ?? {
    indexSizes: { _id_: 10 },
    indexStats: [{ name: '_id_', accesses: { ops: 3, since: SINCE } }],
    indexes: [{ name: '_id_', key: { _id: 1 } }],
  };
  return {
    setReadPref() {},
    getDB(name) {
      return {
        runCommand(cmd) {
          if (cmd.hello) {
            assert.equal(cmd.maxTimeMS, DIRECT_CONFIG.MAX_TIME_MS, 'hello must carry maxTimeMS');
            return { isWritablePrimary: !rsConfig || host === rsConfig.members[0].host };
          }
          if (cmd.replSetGetConfig) {
            assert.equal(cmd.maxTimeMS, DIRECT_CONFIG.MAX_TIME_MS,
              'replSetGetConfig must carry maxTimeMS');
            if (!rsConfig) {
              const e = new Error('not running with --replSet');
              e.codeName = 'NoReplicationEnabled';
              throw e;
            }
            return { config: rsConfig };
          }
          throw new Error('unexpected command ' + JSON.stringify(cmd));
        },
        adminCommand(cmd) {
          assert.equal(cmd.maxTimeMS, DIRECT_CONFIG.MAX_TIME_MS, 'listDatabases must carry maxTimeMS');
          return { databases: [{ name: 'admin' }, { name: 'shop' }] };
        },
        getCollectionInfos() { return name === 'shop' ? [{ name: 'orders' }] : []; },
        getCollection() {
          return {
            aggregate(pipeline, options) {
              assert.equal(options.maxTimeMS, DIRECT_CONFIG.MAX_TIME_MS,
                'aggregations must carry maxTimeMS');
              const stage = Object.keys(pipeline[0])[0];
              if (stage === '$collStats') {
                return { toArray() { return [{ storageStats: { indexSizes: s.indexSizes } }]; } };
              }
              return { toArray() { return s.indexStats; } };
            },
            getIndexes() { return s.indexes; },
          };
        },
      };
    },
  };
}

// A mongos connection that must never be touched: collectSharded is forbidden
// from falling back to mongos for a shard it reached directly.
const POISON_MONGOS = {
  getDB() { throw new Error('collectSharded must not fall back to mongos for a direct shard'); },
};

const SHARD_A_RSCONFIG = {
  _id: 'shardA',
  members: [{ _id: 0, host: 'h1:27017' }, { _id: 1, host: 'h2:27017' }],
};
const SHARD_A = { name: 'shardA', setName: 'shardA', hosts: ['h1:27017', 'h2:27017'],
                  state: 1, draining: false };

test('collectSharded collects a fully reachable shard directly, with full coverage', () => {
  const out = collectSharded({
    conn: POISON_MONGOS, config: DIRECT_CONFIG, shards: [SHARD_A],
    MongoCtor: function (host) { return fakeShardMemberConn(host, SHARD_A_RSCONFIG); },
    canOpenConnections: true, readPref: 'primary', printFn() {},
  });

  assert.equal(out.shardRecords.length, 1);
  assert.equal(out.shardRecords[0].mode, 'direct');
  assert.equal(out.shardRecords[0].coverage, 'full');
  assert.deepEqual(out.shardRecords[0].observedHosts, ['h1:27017', 'h2:27017']);
  assert.deepEqual(out.shardRecords[0].expectedHosts, ['h1:27017', 'h2:27017']);
  // Direct collection sets its own read preference, so it reports that, not the
  // router's.
  assert.equal(out.shardRecords[0].readPref, 'secondaryPreferred');
  assert.equal(out.shardRecords[0].error, null);

  assert.deepEqual(out.members.map((m) => m.host), ['h1:27017', 'h2:27017']);
  for (const m of out.members) {
    assert.equal(m.reachable, true);
    assert.equal(m.shard, 'shardA');
    assert.equal(m.error, null);
  }
  assert.deepEqual(out.members.map((m) => m.role), ['primary', 'secondary']);

  // Node results are attributed per member, by the host passed in explicitly -
  // never read off the connection object.
  assert.deepEqual(out.nodeResults.map((r) => r.host), ['h1:27017', 'h2:27017']);
  for (const r of out.nodeResults) {
    assert.equal(r.shard, 'shardA');
    assert.deepEqual(r.namespaces, ['shop.orders']);
  }
});

test('a directly-reached shard whose member fails is partial coverage, never retried through mongos', () => {
  const printed = [];
  const out = collectSharded({
    conn: POISON_MONGOS, config: DIRECT_CONFIG, shards: [SHARD_A],
    MongoCtor: function (host) {
      if (host === 'h2:27017') {
        const e = new Error('connection refused');
        e.codeName = 'HostUnreachable';
        throw e;
      }
      return fakeShardMemberConn(host, SHARD_A_RSCONFIG);
    },
    canOpenConnections: true, readPref: 'primary', printFn(msg) { printed.push(msg); },
  });

  // Exactly one record, still 'direct': a partly-answering direct shard is
  // reported as partial, NOT re-collected through the router.
  assert.equal(out.shardRecords.length, 1);
  assert.equal(out.shardRecords[0].mode, 'direct');
  assert.equal(out.shardRecords[0].coverage, 'partial');
  assert.deepEqual(out.shardRecords[0].observedHosts, ['h1:27017']);
  // The unreachable member still counts towards what full coverage would mean.
  assert.deepEqual(out.shardRecords[0].expectedHosts, ['h1:27017', 'h2:27017']);
  // The shard as a whole did not fail - only one of its members did.
  assert.equal(out.shardRecords[0].error, null);

  const down = out.members.find((m) => m.host === 'h2:27017');
  assert.equal(down.reachable, false);
  assert.equal(down.error, 'HostUnreachable');
  assert.equal(down.shard, 'shardA');
  const up = out.members.find((m) => m.host === 'h1:27017');
  assert.equal(up.reachable, true);

  assert.deepEqual(out.nodeResults.map((r) => r.host), ['h1:27017']);
  assert.ok(printed.some((m) => /h2:27017 unreachable/.test(m)),
    'the unreachable member must be reported to the operator');
});

// Regression for the mislabelling fix: a standalone (non-replica-set) shard
// takes discoverMembers' single-node fallback, which names its member from
// SEED_HOST. That must be the SHARD's host, not the mongos the run connected
// to - otherwise buildShardRecord compares a fabricated identity against itself
// and reports coverage 'full' for a shard nobody correctly identified.
test('a standalone shard is identified by its own host, never by the mongos SEED_HOST', () => {
  const standalone = { name: 'shardS', setName: null, hosts: ['s1:27017'],
                       state: 1, draining: false };
  const out = collectSharded({
    conn: POISON_MONGOS, config: DIRECT_CONFIG, shards: [standalone],
    MongoCtor: function (host) { return fakeShardMemberConn(host, null); },
    canOpenConnections: true, readPref: 'primary', printFn() {},
  });

  assert.deepEqual(out.members.map((m) => m.host), ['s1:27017']);
  assert.notEqual(out.members[0].host, DIRECT_CONFIG.SEED_HOST);
  assert.deepEqual(out.shardRecords[0].expectedHosts, ['s1:27017']);
  assert.deepEqual(out.shardRecords[0].observedHosts, ['s1:27017']);
  assert.deepEqual(out.nodeResults.map((r) => r.host), ['s1:27017']);
});

// FINDING 1 (review, critical): a direct shard that fails WHOLESALE - seed
// connection refused, or discoverMembers re-throwing Unauthorized because the
// shard credentials in URI_TEMPLATE differ from the mongos session - used to
// contribute no member entries at all, so it reached none of the safety gates.
const SHARD_B = { name: 'shardB', setName: 'shardB', hosts: ['b1:27017', 'b2:27017'],
                  state: 1, draining: false };

// The realistic wholesale failure: the connection OPENS - so the probe succeeds
// and the shard is legitimately chosen for DIRECT collection - but
// discoverMembers' replSetGetConfig is refused, because the credentials in
// URI_TEMPLATE do not carry the shard privileges the mongos session had.
// discoverMembers deliberately re-throws anything that is not
// NoReplicationEnabled/NotYetInitialized rather than silently degrading, so the
// whole shard fails after the mode decision was already made.
//
// (A shard whose probe itself fails is a different case entirely: it is routed
// to the mongos by design, and is covered by the indirect tests above.)
function unauthorizedShardConn() {
  return {
    setReadPref() {},
    getDB() {
      return {
        runCommand() {
          const e = new Error('command replSetGetConfig requires authentication');
          e.codeName = 'Unauthorized';
          throw e;
        },
      };
    },
  };
}

test('a direct shard that fails wholesale still reports its hosts as unreachable members', () => {
  const printed = [];
  const out = collectSharded({
    conn: POISON_MONGOS, config: DIRECT_CONFIG, shards: [SHARD_B],
    MongoCtor: function () { return unauthorizedShardConn(); },
    canOpenConnections: true, readPref: 'primary', printFn(m) { printed.push(m); },
  });

  // The shard must not vanish: every configured host is accounted for.
  assert.deepEqual(out.members.map((m) => m.host), ['b1:27017', 'b2:27017']);
  for (const m of out.members) {
    assert.equal(m.reachable, false);
    assert.equal(m.shard, 'shardB');
    assert.equal(m.error, 'Unauthorized');
  }
  assert.equal(out.shardRecords.length, 1);
  assert.equal(out.shardRecords[0].mode, 'direct');
  assert.notEqual(out.shardRecords[0].coverage, 'full');
  assert.equal(out.shardRecords[0].coverage, 'none');
  assert.deepEqual(out.shardRecords[0].expectedHosts, ['b1:27017', 'b2:27017']);
  assert.deepEqual(out.shardRecords[0].observedHosts, []);
  assert.equal(out.shardRecords[0].error, 'Unauthorized');
  assert.deepEqual(out.nodeResults, []);
  assert.ok(printed.some((m) => /shardB: direct collection failed/.test(m)));
});

// The assertion that actually matters: the end-to-end consequence. A wholly
// failed shard must hold back a verdict that would otherwise be droppable.
const { mergeNodes, applyAnalysis } = require('../indexStats.js');

const NOW = new Date('2026-01-01T00:00:00Z');
const OLD_SINCE = new Date('2025-01-01T00:00:00Z'); // 365 days - well past the 14-day threshold
const DROPPABLE_STATS = {
  indexSizes: { _id_: 10, status_1: 5000 },
  indexStats: [
    { name: '_id_', accesses: { ops: 5, since: OLD_SINCE } },
    { name: 'status_1', accesses: { ops: 0, since: OLD_SINCE } },
  ],
  indexes: [{ name: '_id_', key: { _id: 1 } }, { name: 'status_1', key: { status: 1 } }],
};

function analyse(shards, MongoCtor) {
  const out = collectSharded({
    conn: POISON_MONGOS, config: DIRECT_CONFIG, shards,
    MongoCtor, canOpenConnections: true, readPref: 'primary', printFn() {},
  });
  const payload = mergeNodes({
    members: out.members, nodeResults: out.nodeResults, samples: [],
    now: NOW, shards: out.shardRecords,
  });
  return applyAnalysis(payload, { DROP_MIN_COUNTER_DAYS: 14 }, []);
}

// Control: with only the healthy shard, this index really is droppable. Without
// this, the guarded case below could pass for an unrelated reason.
test('control: a zero-ops index on a fully observed shard is droppable', () => {
  const payload = analyse([SHARD_A], function (host) {
    return fakeShardMemberConn(host, SHARD_A_RSCONFIG, DROPPABLE_STATS);
  });
  const idx = payload.indexes.find((i) => i.name === 'status_1');
  assert.equal(idx.verdict, 'likely-drop');
});

test('a wholly-failed direct shard holds back an otherwise-droppable index', () => {
  const payload = analyse([SHARD_A, SHARD_B], function (host) {
    if (host.startsWith('b')) return unauthorizedShardConn();
    return fakeShardMemberConn(host, SHARD_A_RSCONFIG, DROPPABLE_STATS);
  });

  // The failed shard's members reached the gap accounting at all - this is the
  // mechanism the verdict below depends on.
  assert.deepEqual(payload.gaps.unreachableMembers.map((m) => m.host),
    ['b1:27017', 'b2:27017']);

  const idx = payload.indexes.find((i) => i.name === 'status_1');
  assert.notEqual(idx.verdict, 'drop');
  assert.notEqual(idx.verdict, 'likely-drop');
  assert.equal(idx.verdict, 'inconclusive');
  assert.match(idx.reasons.join(' '), /b1:27017, b2:27017 could not be reached/);
});

// FINDING 2 (review, important): collectFromMongos' first statement is an
// unguarded listDatabases through the router. A throw used to propagate out of
// main() to the bottom gate, printing FATAL and emitting no report at all -
// discarding every shard already collected successfully.
test('a failing mongos call degrades to a gap instead of aborting the whole run', () => {
  const brokenMongos = {
    getDB() {
      const e = new Error('not authorized on admin to execute listDatabases');
      e.codeName = 'Unauthorized';
      throw e;
    },
  };
  const printed = [];
  let out;
  assert.doesNotThrow(() => {
    out = collectSharded({
      conn: brokenMongos, config: MONGOS_CONFIG,
      shards: [{ name: 'shardA', setName: 'shardA', hosts: ['h1:27017', 'h2:27017'],
                 state: 1, draining: false }],
      MongoCtor: function () { throw new Error('no Mongo'); },
      canOpenConnections: false, readPref: 'primary', printFn(m) { printed.push(m); },
    });
  });

  assert.equal(out.shardRecords.length, 1);
  assert.equal(out.shardRecords[0].mode, 'indirect');
  assert.equal(out.shardRecords[0].coverage, 'none');
  assert.equal(out.shardRecords[0].error, 'Unauthorized');
  assert.deepEqual(out.shardRecords[0].observedHosts, []);
  assert.deepEqual(out.nodeResults, []);
  // Both configured hosts are still accounted for, so the gates can see them.
  assert.deepEqual(out.members.map((m) => m.host), ['h1:27017', 'h2:27017']);
  for (const m of out.members) {
    assert.equal(m.reachable, false);
    assert.match(m.error, /collection through mongos failed \(Unauthorized\)/);
  }
  assert.ok(printed.some((m) => /collection through mongos failed/.test(m)));
});

test('a shard collected successfully is not discarded when a later mongos call fails', () => {
  // shardA is reachable directly; shardB can only go through the router, which
  // fails. The direct shard's evidence must survive.
  const brokenMongos = { getDB() { throw new Error('router down'); } };
  const out = collectSharded({
    conn: brokenMongos, config: DIRECT_CONFIG, shards: [SHARD_A, SHARD_B],
    MongoCtor: function (host) {
      if (host.startsWith('b')) throw new Error('refused'); // forces shardB indirect
      return fakeShardMemberConn(host, SHARD_A_RSCONFIG);
    },
    canOpenConnections: true, readPref: 'primary', printFn() {},
  });

  const a = out.shardRecords.find((s) => s.name === 'shardA');
  assert.equal(a.mode, 'direct');
  assert.equal(a.coverage, 'full');
  assert.deepEqual(out.nodeResults.map((r) => r.host), ['h1:27017', 'h2:27017']);

  const b = out.shardRecords.find((s) => s.name === 'shardB');
  assert.equal(b.mode, 'indirect');
  assert.equal(b.coverage, 'none');
  assert.equal(b.error, 'router down');
});
