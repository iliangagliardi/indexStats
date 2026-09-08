const test = require('node:test');
const assert = require('node:assert/strict');
const { pickSampleMember, sampleNamespace, emit, selectCollectionTargets } = require('../indexStats.js');

const CONFIG = { SAMPLE_SIZE: 100, MAX_TIME_MS: 30000, OUT_FILE: 'indexStats-report.html' };

test('prefers a hidden member for sampling, to spare the primary', () => {
  const m = pickSampleMember([
    { host: 'h1', role: 'primary', hidden: false, reachable: true },
    { host: 'h2', role: 'secondary', hidden: false, reachable: true },
    { host: 'h3', role: 'secondary', hidden: true, reachable: true },
  ]);
  assert.equal(m.host, 'h3');
});

test('falls back to a secondary, then to the primary', () => {
  assert.equal(pickSampleMember([
    { host: 'h1', role: 'primary', hidden: false, reachable: true },
    { host: 'h2', role: 'secondary', hidden: false, reachable: true },
  ]).host, 'h2');
  assert.equal(pickSampleMember([
    { host: 'h1', role: 'primary', hidden: false, reachable: true },
  ]).host, 'h1');
});

test('never picks an unreachable member, and returns null when none are reachable', () => {
  assert.equal(pickSampleMember([{ host: 'h1', role: 'primary', hidden: true, reachable: false }]), null);
});

test('selectCollectionTargets returns every member when fanning out', () => {
  const members = [{ host: 'h1' }, { host: 'h2' }, { host: 'h3' }];
  assert.deepEqual(selectCollectionTargets(members, 'h2', true), members);
});

// Task 11 regression: the seed host is deliberately NOT the first member in
// the list below, so this test can only pass if selection actually filters
// by seedHost instead of grabbing members[0] (the original bug).
test('selectCollectionTargets picks only the seed host when not fanning out', () => {
  const members = [{ host: 'h1' }, { host: 'h2' }, { host: 'h3' }];
  assert.deepEqual(selectCollectionTargets(members, 'h2', false), [{ host: 'h2' }]);
});

test('selectCollectionTargets falls back to the full list when the seed host matches nothing (synthetic seed)', () => {
  const members = [{ host: 'h1' }, { host: 'h2' }];
  assert.deepEqual(selectCollectionTargets(members, 'unmatched-synthetic', false), members);
});

// FINDING 6 (final review, important): assert maxTimeMS on every server call
// these fakes stand in for, so a future edit dropping it is caught here, not
// only by the end-to-end suite against a real cluster.
function sampleConn(docs, validator) {
  return {
    host: 'h1:27017',
    getDB: () => ({
      getCollectionInfos: (filter) => {
        assert.deepEqual(filter, { name: 'orders' });
        return [{ name: 'orders', options: validator ? { validator } : {} }];
      },
      getCollection: () => ({
        aggregate: (pipeline, options) => {
          if (pipeline[0].$sample) {
            assert.equal(options && options.maxTimeMS, CONFIG.MAX_TIME_MS, '$sample must carry maxTimeMS');
            return { toArray: () => docs };
          }
          if (pipeline[0].$listCatalog) {
            assert.equal(options && options.maxTimeMS, CONFIG.MAX_TIME_MS, '$listCatalog must carry maxTimeMS');
            return { toArray: () => [] };
          }
          throw new Error('unexpected pipeline');
        },
      }),
    }),
  };
}

test('profiles sampled documents into path presence', () => {
  const s = sampleNamespace(sampleConn([{ a: 1 }, { a: 2, b: 3 }]), 'shop.orders', CONFIG);
  assert.equal(s.size, 2);
  assert.equal(s.paths.a.count, 2);
  assert.equal(s.paths.b.count, 1);
  assert.equal(s.error, null);
});

test('extracts the collection validator when present', () => {
  const s = sampleNamespace(sampleConn([{ a: 1 }], {
    $jsonSchema: { additionalProperties: false, properties: { a: { bsonType: 'int' } } },
  }), 'shop.orders', CONFIG);
  assert.deepEqual(s.validator, { props: ['a'], closed: true });
});

test('SAMPLE_SIZE of zero skips document sampling but still reads the validator', () => {
  const s = sampleNamespace(sampleConn([{ a: 1 }], { $jsonSchema: { properties: { a: {} } } }),
    'shop.orders', { ...CONFIG, SAMPLE_SIZE: 0 });
  assert.equal(s.size, 0);
  assert.deepEqual(s.paths, {});
  assert.deepEqual(s.validator, { props: ['a'], closed: false });
});

function catalogConn(docs, multikeyPathsPerIndex) {
  return {
    host: 'h1:27017',
    getDB: () => ({
      getCollectionInfos: () => [{ name: 'orders', options: {} }],
      getCollection: () => ({
        aggregate: (pipeline, options) => {
          if (pipeline[0].$sample) {
            assert.equal(options && options.maxTimeMS, CONFIG.MAX_TIME_MS, '$sample must carry maxTimeMS');
            return { toArray: () => docs };
          }
          if (pipeline[0].$listCatalog) {
            assert.equal(options && options.maxTimeMS, CONFIG.MAX_TIME_MS, '$listCatalog must carry maxTimeMS');
            return { toArray: () => [{ md: { indexes: multikeyPathsPerIndex.map(
              (multikeyPaths) => ({ multikeyPaths })) } }] };
          }
          throw new Error('unexpected pipeline');
        },
      }),
    }),
  };
}

test('Task 11 regression: a real-server Binary bitset multikeyPaths only flags '
  + 'paths whose byte is non-zero, not every key present', () => {
  // $listCatalog's md.indexes[].multikeyPaths includes a key for every field of the
  // index regardless of whether that field is actually multikey - the flag is a BSON
  // Binary one-byte bitset (0x00 = not multikey). Object.keys() alone (the original,
  // buggy behaviour) would flag every field; only 'tags' should end up flagged here.
  const conn = catalogConn([{ status: 'open', tags: ['a', 'b'] }], [
    { status: { buffer: [0] }, tags: { buffer: [1] } },
  ]);
  const s = sampleNamespace(conn, 'shop.orders', CONFIG);
  assert.deepEqual(s.multikeyPaths, ['tags']);
  assert.equal(s.paths.status.multikey, false);
  assert.equal(s.paths.tags.multikey, true);
});

test('Task 11 regression: an older-server array-of-subpaths multikeyPaths shape '
  + 'is still honoured (non-empty array = multikey)', () => {
  const conn = catalogConn([{ status: 'open', tags: ['a', 'b'] }], [
    { status: [], tags: ['tags'] },
  ]);
  const s = sampleNamespace(conn, 'shop.orders', CONFIG);
  assert.deepEqual(s.multikeyPaths, ['tags']);
  assert.equal(s.paths.status.multikey, false);
  assert.equal(s.paths.tags.multikey, true);
});

test('a failed sample degrades that namespace only', () => {
  const conn = { host: 'h1:27017', getDB: () => ({
    getCollectionInfos: () => [{ name: 'orders', options: {} }],
    getCollection: () => ({
      aggregate() { const e = new Error('nope'); e.codeName = 'MaxTimeMSExpired'; throw e; },
    }),
  }) };
  const s = sampleNamespace(conn, 'shop.orders', CONFIG);
  assert.equal(s.error, 'MaxTimeMSExpired');
  assert.equal(s.size, 0);
});

test('Controller ruling R2: an explicit host argument wins over conn.host', () => {
  const s = sampleNamespace(sampleConn([{ a: 1 }]), 'shop.orders', CONFIG, 'explicit-host:27017');
  assert.equal(s.member, 'explicit-host:27017');
});

test('emit writes the file when the runtime allows it', () => {
  const writes = [];
  const prints = [];
  const r = emit('<html></html>', { indexes: [] }, { canWriteFiles: true }, CONFIG,
    { writeFileSync: (p, c) => writes.push([p, c]), printFn: (s) => prints.push(s) });
  assert.equal(r.written, true);
  assert.equal(writes[0][0], 'indexStats-report.html');
  assert.match(prints.join('\n'), /indexStats-report\.html/);
});

test('emit prints the html when files are unavailable', () => {
  const prints = [];
  const r = emit('<html>x</html>', { indexes: [] }, { canWriteFiles: false }, CONFIG,
    { writeFileSync: null, printFn: (s) => prints.push(s) });
  assert.equal(r.written, false);
  assert.equal(prints.join('\n').includes('<html>x</html>'), true);
});

test('emit falls back to printing when the write throws', () => {
  const prints = [];
  const r = emit('<html>y</html>', { indexes: [] }, { canWriteFiles: true }, CONFIG,
    { writeFileSync: () => { throw new Error('EACCES'); }, printFn: (s) => prints.push(s) });
  assert.equal(r.written, false);
  assert.match(prints.join('\n'), /EACCES/);
  assert.equal(prints.join('\n').includes('<html>y</html>'), true);
});

const { deriveSeedHost } = require('../indexStats.js');

test('deriveSeedHost prefers hello.me (replSetGetConfig-compatible host:port)', () => {
  const adminDb = { runCommand: (cmd) => {
    assert.equal(cmd.maxTimeMS, 30000, 'hello must carry maxTimeMS');
    return { me: 'h1.example.com:27017' };
  } };
  const dbHandle = { serverStatus: () => { throw new Error('should not be called'); } };
  const r = deriveSeedHost(adminDb, dbHandle, { MAX_TIME_MS: 30000 });
  assert.deepEqual(r, { host: 'h1.example.com:27017', synthetic: false });
});

test('deriveSeedHost falls back to serverStatus().host when hello has no me (verified real output)', () => {
  const adminDb = { runCommand: () => ({}) };
  const dbHandle = { serverStatus: (options) => {
    assert.equal(options && options.maxTimeMS, 30000, 'serverStatus must carry maxTimeMS');
    return { host: 'M-CJ7P325Q7J:27099' };
  } };
  const r = deriveSeedHost(adminDb, dbHandle, { MAX_TIME_MS: 30000 });
  assert.deepEqual(r, { host: 'M-CJ7P325Q7J:27099', synthetic: false });
});

test('deriveSeedHost falls through a privilege error to the next source rather than aborting', () => {
  const adminDb = { runCommand: () => { const e = new Error('not authorized'); e.codeName = 'Unauthorized'; throw e; } };
  const dbHandle = { serverStatus: () => ({ host: 'fallback:27017' }) };
  const r = deriveSeedHost(adminDb, dbHandle, { MAX_TIME_MS: 30000 });
  assert.deepEqual(r, { host: 'fallback:27017', synthetic: false });
});

test('deriveSeedHost returns a synthetic, flagged literal only as a last resort', () => {
  const adminDb = { runCommand: () => { throw new Error('nope'); } };
  const dbHandle = { serverStatus: () => { throw new Error('nope'); } };
  const r = deriveSeedHost(adminDb, dbHandle, { MAX_TIME_MS: 30000 });
  assert.equal(r.synthetic, true);
  assert.equal(typeof r.host, 'string');
});
