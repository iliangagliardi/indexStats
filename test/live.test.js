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

test('refuses to run against a mongos', () => {
  assert.throws(() => discoverMembers(fakeAdmin(null, 'isdbgrid'), CONFIG), /sharded/i);
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
