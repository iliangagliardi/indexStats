const test = require('node:test');
const assert = require('node:assert/strict');
const { mergePeerPayloads, applyAnalysis, parsePeerPayloads } = require('../indexStats.js');

const CONFIG = { DROP_MIN_COUNTER_DAYS: 14, LOW_PRESENCE: 0.10 };

function single(host, ops, ageDays, verdict) {
  return {
    meta: { mode: 'single-node', replicaSetName: 'rs0' },
    members: [{ id: 0, host, role: 'primary', hidden: false, delaySecs: 0, votes: 1,
                reachable: true, error: null }],
    gaps: { notAnalyzedMembers: [], skipped: [] },
    namespaces: [{ ns: 'shop.orders', db: 'shop', coll: 'orders', presentOn: [host],
                   hasValidator: false, sample: null }],
    indexes: [{
      ns: 'shop.orders', name: 'a_1', key: { a: 1 }, options: {}, hidden: false,
      perNode: [{ host, present: true, ops, since: null, counterAgeDays: ageDays,
                  sizeBytes: 500, reusableBytes: 0, cacheBytes: 0, error: null }],
      maxOps: ops, minCounterAgeDays: ageDays, clusterSizeBytes: 500, perMemberSizeBytes: 500,
      redundancy: { class: null, coveredBy: null },
      definition: { consistent: true, missingOn: [], variants: [] },
      schema: { checks: [] }, verdict, flags: [], reasons: [],
    }],
  };
}

test('merging peers unions members and per-node vectors', () => {
  const p = mergePeerPayloads(single('h1', 0, 40, 'likely-drop'), [single('h2', 0, 40, 'likely-drop')]);
  assert.deepEqual(p.members.map((m) => m.host), ['h1', 'h2']);
  assert.equal(p.indexes[0].perNode.length, 2);
  assert.equal(p.indexes[0].clusterSizeBytes, 1000);
  assert.equal(p.meta.mode, 'merged-payloads');
});

test('usage on a peer overrides a local unused verdict after re-analysis', () => {
  const merged = mergePeerPayloads(single('h1', 0, 40, 'likely-drop'), [single('h2', 900, 40, 'keep')]);
  assert.equal(merged.indexes[0].maxOps, 900);
  assert.equal(applyAnalysis(merged, CONFIG, []).indexes[0].verdict, 'keep');
});

test('a peer with a young counter drags the merged verdict to inconclusive', () => {
  const merged = mergePeerPayloads(single('h1', 0, 40, 'likely-drop'), [single('h2', 0, 1, 'inconclusive')]);
  assert.equal(merged.indexes[0].minCounterAgeDays, 1);
  assert.equal(applyAnalysis(merged, CONFIG, []).indexes[0].verdict, 'inconclusive');
});

test('re-merging the same host does not double-count its size', () => {
  const p = mergePeerPayloads(single('h1', 0, 40, 'likely-drop'), [single('h1', 0, 40, 'likely-drop')]);
  assert.equal(p.members.length, 1);
  assert.equal(p.indexes[0].clusterSizeBytes, 500);
});

test('an index only a peer has is added, and reported missing on the local member', () => {
  const peer = single('h2', 5, 40, 'keep');
  peer.indexes[0].name = 'b_1';
  const p = mergePeerPayloads(single('h1', 0, 40, 'likely-drop'), [peer]);
  assert.deepEqual(p.indexes.map((i) => i.name).sort(), ['a_1', 'b_1']);
  const b = p.indexes.find((i) => i.name === 'b_1');
  assert.deepEqual(b.definition.missingOn, ['h1']);
  assert.equal(b.definition.consistent, false);
});

test('carried-over peer verdicts are stripped, never trusted', () => {
  const p = mergePeerPayloads(single('h1', 0, 40, 'likely-drop'), [single('h2', 0, 40, 'drop')]);
  assert.equal('verdict' in p.indexes[0], false);
});

test('an empty peer list leaves the local payload mode unchanged', () => {
  assert.equal(mergePeerPayloads(single('h1', 0, 40, 'likely-drop'), []).meta.mode, 'single-node');
});

// --- Realistic payload shapes (all replica-set members listed, only the seed
// reachable, placeholder perNode entries for the rest) --------------------
// Reproduces the controller's three-member scenario: this is what a real,
// non-fan-out run on each of h1/h2/h3 actually produces via discoverMembers +
// mergeNodes, NOT the single-member fixtures above.
function realistic(host, members, ops, ageDays) {
  const others = members.filter((h) => h !== host);
  return {
    meta: { mode: 'single-node', replicaSetName: 'rs0' },
    members: [
      { id: 0, host, role: 'primary', hidden: false, delaySecs: 0, votes: 1,
        reachable: true, error: null },
      ...others.map((h, i) => ({ id: i + 1, host: h, role: 'unknown', hidden: false,
        delaySecs: 0, votes: 1, reachable: false, error: 'connection refused' })),
    ],
    gaps: {
      notAnalyzedMembers: others.map((h) => ({ host: h, error: 'connection refused' })),
      skipped: [],
    },
    namespaces: [{ ns: 'shop.orders', db: 'shop', coll: 'orders', presentOn: [host],
                   hasValidator: false, sample: null }],
    indexes: [{
      ns: 'shop.orders', name: 'a_1', key: { a: 1 }, options: {}, hidden: false,
      // mergeNodes only ever emits perNode entries for reachable members -
      // there is no placeholder perNode entry for h2/h3 here.
      perNode: [{ host, present: true, ops, since: null, counterAgeDays: ageDays,
                  sizeBytes: 500, reusableBytes: 0, cacheBytes: 0, error: null }],
      maxOps: ops, minCounterAgeDays: ageDays, clusterSizeBytes: 500, perMemberSizeBytes: 500,
      redundancy: { class: null, coveredBy: null },
      definition: { consistent: false, missingOn: others, variants: [{ key: { a: 1 }, hosts: [host] }] },
      schema: { checks: [] }, verdict: 'inconclusive', flags: [], reasons: [],
    }],
  };
}

test('controller three-member scenario: peer evidence for known-unreachable hosts is accepted', () => {
  const members = ['h1', 'h2', 'h3'];
  const local = realistic('h1', members, 0, 40);
  const peerB = realistic('h2', members, 0, 40);
  const peerC = realistic('h3', members, 9000, 40); // analytics member, heavy usage

  const merged = mergePeerPayloads(local, [peerB, peerC]);
  const idx = merged.indexes[0];

  assert.equal(merged.members.length, 3);
  assert.equal(idx.perNode.length, 3, 'expected perNode entries for all three hosts');
  assert.equal(idx.maxOps, 9000, 'expected h3\'s 9000 ops to be counted');
  assert.equal(idx.clusterSizeBytes, 1500);
  assert.deepEqual(merged.gaps.notAnalyzedMembers, []);

  const reAnalysed = applyAnalysis(merged, CONFIG, []);
  assert.equal(reAnalysed.indexes[0].verdict, 'keep');
});

test('re-pasting the same realistic payload does not double-count or duplicate perNode entries', () => {
  const members = ['h1', 'h2', 'h3'];
  const local = realistic('h1', members, 0, 40);
  const peerB = realistic('h2', members, 5, 40);

  const once = mergePeerPayloads(local, [peerB]);
  const twice = mergePeerPayloads(once, [peerB]);

  assert.equal(twice.members.length, 3);
  assert.equal(twice.indexes[0].perNode.length, 2);
  assert.equal(twice.indexes[0].clusterSizeBytes, 1000);
});

test('a host no payload ever covers stays unreachable and still forces inconclusive', () => {
  const members = ['h1', 'h2', 'h3'];
  const local = realistic('h1', members, 0, 40);
  const peerB = realistic('h2', members, 0, 40);
  // h3 is never covered by any payload.

  const merged = mergePeerPayloads(local, [peerB]);
  assert.deepEqual(merged.gaps.notAnalyzedMembers.map((m) => m.host), ['h3']);

  const reAnalysed = applyAnalysis(merged, CONFIG, []);
  assert.equal(reAnalysed.indexes[0].verdict, 'inconclusive');
});

test('gaps.skipped is deduped by {member, ns, reason}', () => {
  const members = ['h1', 'h2'];
  const local = realistic('h1', members, 0, 40);
  local.gaps.skipped.push({ member: 'h2', ns: 'shop.widgets', reason: 'Unauthorized' });
  const peerB = realistic('h2', members, 0, 40);
  peerB.gaps.skipped.push({ member: 'h2', ns: 'shop.widgets', reason: 'Unauthorized' });

  const merged = mergePeerPayloads(local, [peerB]);
  assert.equal(merged.gaps.skipped.length, 1);
});

// Task 11 regression: PEER_PAYLOADS entries were never JSON.parse'd before
// reaching mergePeerPayloads, crashing on the first real paste-in.
// FINDING 2 (final review): the two merge paths used to disagree about
// missingOn - mergeNodes excludes a member that errored/was never observed
// for this namespace, mergePeerPayloads used to include it, forcing a
// misleading 'mismatched' verdict instead of finding 1's 'inconclusive'.
// Reproduce the same "one member errored on this collection" cluster state
// through BOTH paths and assert they now agree.
test('finding 2: a peer-merged payload with an errored member agrees with the direct mergeNodes payload (inconclusive, not mismatched)', () => {
  const CONFIG = { DROP_MIN_COUNTER_DAYS: 14, LOW_PRESENCE: 0.10 };
  const members = ['h1', 'h2'];

  // h1's own run: reaches only itself, h2 unreachable-placeholder.
  const local = {
    meta: { mode: 'single-node', replicaSetName: 'rs0' },
    members: [
      { id: 0, host: 'h1', role: 'primary', hidden: false, delaySecs: 0, votes: 1, reachable: true, error: null },
      { id: 1, host: 'h2', role: 'unknown', hidden: false, delaySecs: 0, votes: 1, reachable: false, error: 'connection refused' },
    ],
    gaps: { notAnalyzedMembers: [{ host: 'h2', error: 'connection refused' }], skipped: [] },
    namespaces: [{ ns: 'shop.orders', db: 'shop', coll: 'orders', presentOn: ['h1'], hasValidator: false, sample: null }],
    indexes: [{
      ns: 'shop.orders', name: 'a_1', key: { a: 1 }, options: {}, hidden: false,
      perNode: [{ host: 'h1', present: true, ops: 0, since: null, counterAgeDays: 300,
                  sizeBytes: 500, reusableBytes: 0, cacheBytes: 0, error: null }],
      maxOps: 0, minCounterAgeDays: 300, clusterSizeBytes: 500, perMemberSizeBytes: 500,
      redundancy: { class: null, coveredBy: null },
      definition: { consistent: true, missingOn: [], variants: [{ key: { a: 1 }, hosts: ['h1'] }] },
      schema: { checks: [] },
    }],
  };

  // h2's own run: reaches only itself, and its ONE collection errored -
  // exactly like mergeNodes would produce (perNode present:false + error,
  // excluded from missingOn, per the finding-1 fix in mergeNodes above).
  const peer = {
    meta: { mode: 'single-node', replicaSetName: 'rs0' },
    members: [
      { id: 1, host: 'h2', role: 'primary', hidden: false, delaySecs: 0, votes: 1, reachable: true, error: null },
      { id: 0, host: 'h1', role: 'unknown', hidden: false, delaySecs: 0, votes: 1, reachable: false, error: 'connection refused' },
    ],
    gaps: {
      notAnalyzedMembers: [{ host: 'h1', error: 'connection refused' }],
      skipped: [{ member: 'h2', ns: 'shop.orders', reason: 'MaxTimeMSExpired' }],
    },
    namespaces: [{ ns: 'shop.orders', db: 'shop', coll: 'orders', presentOn: ['h2'], hasValidator: false, sample: null }],
    indexes: [{
      ns: 'shop.orders', name: 'a_1', key: { a: 1 }, options: {}, hidden: false,
      perNode: [{ host: 'h2', present: false, ops: null, since: null, counterAgeDays: null,
                  sizeBytes: 0, reusableBytes: 0, cacheBytes: 0, error: 'MaxTimeMSExpired' }],
      maxOps: 0, minCounterAgeDays: null, clusterSizeBytes: 0, perMemberSizeBytes: 0,
      redundancy: { class: null, coveredBy: null },
      definition: { consistent: true, missingOn: [], variants: [] },
      schema: { checks: [] },
    }],
  };

  const merged = mergePeerPayloads(local, [peer]);
  const idx = merged.indexes[0];
  // missingOn must exclude h2 - it errored, it was not "confirmed absent".
  assert.deepEqual(idx.definition.missingOn, []);
  assert.equal(idx.definition.consistent, true);

  const analysed = applyAnalysis(merged, CONFIG, []);
  assert.equal(analysed.indexes[0].verdict, 'inconclusive');
  assert.notEqual(analysed.indexes[0].verdict, 'mismatched');
  assert.match(analysed.indexes[0].reasons.join(' '), /h2/);
  assert.match(analysed.indexes[0].reasons.join(' '), /MaxTimeMSExpired/);
});

test('parsePeerPayloads parses raw JSON string entries', () => {
  const parsed = parsePeerPayloads(['{"a":1}', '{"b":2}']);
  assert.deepEqual(parsed, [{ a: 1 }, { b: 2 }]);
});

test('parsePeerPayloads accepts entries that are already parsed objects', () => {
  const parsed = parsePeerPayloads([{ a: 1 }, '{"b":2}']);
  assert.deepEqual(parsed, [{ a: 1 }, { b: 2 }]);
});

test('parsePeerPayloads returns an empty array for empty/undefined input', () => {
  assert.deepEqual(parsePeerPayloads([]), []);
  assert.deepEqual(parsePeerPayloads(undefined), []);
});

test('parsePeerPayloads throws a clear error naming the offending index for invalid JSON', () => {
  assert.throws(
    () => parsePeerPayloads(['{"a":1}', '{not valid json']),
    /PEER_PAYLOADS\[1\]/,
  );
});

test('parsePeerPayloads throws a clear error naming the offending index for a non-string/object entry', () => {
  assert.throws(
    () => parsePeerPayloads([{ a: 1 }, 42]),
    /PEER_PAYLOADS\[1\]/,
  );
});

// --- Task 9, Part 1: union shards[] by name -------------------------------

const SHARD_LOCAL = { name: 'shardA', setName: 'shardA', hosts: ['h1:27017', 'h2:27017'],
  state: 1, draining: false, mode: 'direct', coverage: 'partial',
  expectedHosts: ['h1:27017', 'h2:27017'], observedHosts: ['h1:27017'],
  readPref: 'secondaryPreferred', error: null };

function payloadWithShards(shards, members) {
  return { members, shards, namespaces: [], indexes: [],
           gaps: { notAnalyzedMembers: [], skipped: [] },
           meta: { mode: 'single-node' } };
}

test('mergePeerPayloads unions shard records by name', () => {
  const local = payloadWithShards([SHARD_LOCAL],
    [{ host: 'h1:27017', shard: 'shardA', reachable: true, hidden: false }]);
  const peer = payloadWithShards([{ ...SHARD_LOCAL, name: 'shardB', observedHosts: ['h3:27017'],
    expectedHosts: ['h3:27017'], coverage: 'full' }],
    [{ host: 'h3:27017', shard: 'shardB', reachable: true, hidden: false }]);
  const out = mergePeerPayloads(local, [peer]);
  assert.deepEqual(out.shards.map((s) => s.name).sort(), ['shardA', 'shardB']);
});

test('a peer that observed more members of the same shard improves its coverage', () => {
  const local = payloadWithShards([SHARD_LOCAL],
    [{ host: 'h1:27017', shard: 'shardA', reachable: true, hidden: false }]);
  const peer = payloadWithShards([{ ...SHARD_LOCAL, coverage: 'full',
    observedHosts: ['h1:27017', 'h2:27017'] }],
    [{ host: 'h2:27017', shard: 'shardA', reachable: true, hidden: false }]);
  const out = mergePeerPayloads(local, [peer]);
  const a = out.shards.find((s) => s.name === 'shardA');
  assert.equal(a.coverage, 'full');
  assert.deepEqual(a.observedHosts.sort(), ['h1:27017', 'h2:27017']);
});

test('a peer with worse coverage never degrades a shard already fully observed', () => {
  const local = payloadWithShards([{ ...SHARD_LOCAL, coverage: 'full',
    observedHosts: ['h1:27017', 'h2:27017'] }],
    [{ host: 'h1:27017', shard: 'shardA', reachable: true, hidden: false }]);
  const peer = payloadWithShards([{ ...SHARD_LOCAL, coverage: 'none', observedHosts: [] }], []);
  const out = mergePeerPayloads(local, [peer]);
  assert.equal(out.shards.find((s) => s.name === 'shardA').coverage, 'full');
});

test('merging the same sharded peer twice is a no-op', () => {
  const local = payloadWithShards([SHARD_LOCAL],
    [{ host: 'h1:27017', shard: 'shardA', reachable: true, hidden: false }]);
  const peer = payloadWithShards([{ ...SHARD_LOCAL, coverage: 'full',
    observedHosts: ['h1:27017', 'h2:27017'] }],
    [{ host: 'h2:27017', shard: 'shardA', reachable: true, hidden: false }]);
  const once = mergePeerPayloads(local, [peer]);
  const twice = mergePeerPayloads(local, [peer, peer]);
  assert.deepEqual(twice.shards, once.shards);
});

test('mergePeerPayloads still works on payloads with no shards at all', () => {
  const local = { members: [{ host: 'h1:27017', reachable: true, hidden: false }],
    namespaces: [], indexes: [], gaps: { notAnalyzedMembers: [], skipped: [] },
    meta: { mode: 'single-node' } };
  const peer = { members: [{ host: 'h2:27017', reachable: true, hidden: false }],
    namespaces: [], indexes: [], gaps: { notAnalyzedMembers: [], skipped: [] },
    meta: { mode: 'single-node' } };
  const out = mergePeerPayloads(local, [peer]);
  assert.deepEqual(out.shards ?? [], []);
});

// --- Task 9, Part 2: recompute perShard/clusterSizeBytes/sizeEstimated ----
// from the unioned perNode entries, mirroring mergeNodes' own arithmetic,
// instead of a raw per-member sum (the Task 7 under-reporting bug).

function shardedLocalPayload() {
  return {
    meta: { mode: 'single-node' },
    members: [
      { id: 0, host: 'h1:27017', role: 'primary', hidden: false, delaySecs: 0, votes: 1,
        reachable: true, error: null, shard: 'shardA' },
    ],
    shards: [{ name: 'shardA', setName: 'shardA', hosts: ['h1:27017', 'h2:27017'],
      state: 1, draining: false, mode: 'direct', coverage: 'partial',
      expectedHosts: ['h1:27017', 'h2:27017'], observedHosts: ['h1:27017'],
      readPref: 'secondaryPreferred', error: null }],
    gaps: { notAnalyzedMembers: [], skipped: [] },
    namespaces: [{ ns: 'shop.orders', db: 'shop', coll: 'orders', presentOn: ['h1:27017'],
      shards: ['shardA'], hasValidator: false, sample: null }],
    indexes: [{
      ns: 'shop.orders', name: 'a_1', key: { a: 1 }, options: {}, hidden: false,
      perNode: [{ host: 'h1:27017', shard: 'shardA', present: true, ops: 5, since: null,
                  counterAgeDays: 40, sizeBytes: 1000, reusableBytes: 0, cacheBytes: 0, error: null }],
      maxOps: 5, minCounterAgeDays: 40, clusterSizeBytes: 1000, perMemberSizeBytes: 1000,
      perShard: [{ shard: 'shardA', ops: 5, observedSizeBytes: 1000, observedNodes: 1,
                   present: true, sizeBytes: 1000 }],
      // Deliberately false in the input fixture: if the recompute block were
      // missing or dead, this stale value would survive the merge's
      // JSON.parse(JSON.stringify(local)) clone untouched, and the assertion
      // below would pass for the wrong reason. Only a genuine recompute flips
      // it to true.
      sizeEstimated: false,
      redundancy: { class: null, coveredBy: null },
      definition: { consistent: true, missingOn: [], notHosting: [],
                    variants: [{ key: { a: 1 }, hosts: ['h1:27017'] }] },
      schema: { checks: [] },
    }],
  };
}

function noOpShardedPeer() {
  return {
    meta: { mode: 'single-node' },
    members: [],
    shards: [{ name: 'shardA', setName: 'shardA', hosts: ['h1:27017', 'h2:27017'],
      state: 1, draining: false, mode: 'direct', coverage: 'partial',
      expectedHosts: ['h1:27017', 'h2:27017'], observedHosts: ['h1:27017'],
      readPref: 'secondaryPreferred', error: null }],
    gaps: { notAnalyzedMembers: [], skipped: [] },
    namespaces: [],
    indexes: [],
  };
}

test('a shard observed on fewer members than expected scales clusterSizeBytes and flags sizeEstimated', () => {
  const merged = mergePeerPayloads(shardedLocalPayload(), [noOpShardedPeer()]);
  const idx = merged.indexes[0];
  // observed average per member (1000, from the one observed member) scaled
  // up to the shard's two expectedHosts, same arithmetic as mergeNodes.
  assert.equal(idx.clusterSizeBytes, 2000);
  assert.equal(idx.sizeEstimated, true);
});

test('merged non-sharded payload has unchanged aggregates and no sizeEstimated flag', () => {
  const p = mergePeerPayloads(single('h1', 0, 40, 'likely-drop'), [single('h2', 0, 40, 'likely-drop')]);
  assert.equal(p.indexes[0].clusterSizeBytes, 1000);
  assert.equal(p.indexes[0].perMemberSizeBytes, 500);
  assert.equal(p.indexes[0].sizeEstimated, false);
});

// ---------------------------------------------------------------------------
// FINDING 2 (final whole-branch review, important): mergePeerPayloads
// recomputed definition.missingOn without excluding definition.notHosting,
// which mergeNodes is careful to keep separate. Every member of a shard that
// never held the namespace was therefore recomputed INTO missingOn on merge,
// flipping definition.consistent to false and the verdict from likely-drop to
// mismatched - a member blamed for lacking an index it was never supposed to
// have. Invisible until now because every fixture in this file used
// `notHosting: []`.

function notHostingLocalPayload() {
  return {
    meta: { mode: 'single-node' },
    members: [
      { id: 0, host: 'h1:27017', role: 'primary', hidden: false, delaySecs: 0, votes: 1,
        reachable: true, error: null, shard: 'shardA' },
      // Reachable, fully observed - and on a shard that simply does not hold
      // shop.lookup.
      { id: 0, host: 'h3:27017', role: 'primary', hidden: false, delaySecs: 0, votes: 1,
        reachable: true, error: null, shard: 'shardB' },
    ],
    shards: [
      { name: 'shardA', setName: 'shardA', hosts: ['h1:27017'], state: 1, draining: false,
        mode: 'direct', coverage: 'full', expectedHosts: ['h1:27017'],
        observedHosts: ['h1:27017'], ambiguousHosts: [], readPref: 'primary', error: null },
      { name: 'shardB', setName: 'shardB', hosts: ['h3:27017'], state: 1, draining: false,
        mode: 'direct', coverage: 'full', expectedHosts: ['h3:27017'],
        observedHosts: ['h3:27017'], ambiguousHosts: [], readPref: 'primary', error: null },
    ],
    gaps: { notAnalyzedMembers: [], skipped: [] },
    namespaces: [{ ns: 'shop.lookup', db: 'shop', coll: 'lookup', presentOn: ['h1:27017'],
      shards: ['shardA'], hasValidator: false, sample: null }],
    indexes: [{
      ns: 'shop.lookup', name: 'code_1', key: { code: 1 }, options: {}, hidden: false,
      perNode: [{ host: 'h1:27017', shard: 'shardA', present: true, ops: 0, since: null,
                  counterAgeDays: 40, sizeBytes: 1000, reusableBytes: 0, cacheBytes: 0,
                  error: null }],
      maxOps: 0, minCounterAgeDays: 40, clusterSizeBytes: 1000, perMemberSizeBytes: 1000,
      perShard: [{ shard: 'shardA', ops: 0, observedSizeBytes: 1000, observedNodes: 1,
                   present: true, sizeBytes: 1000 }],
      sizeEstimated: false,
      redundancy: { class: null, coveredBy: null },
      definition: { consistent: true, missingOn: [], notHosting: ['h3:27017'],
                    variants: [{ key: { code: 1 }, hosts: ['h1:27017'] }] },
      schema: { checks: [] },
    }],
  };
}

// A peer that contributes no member evidence at all, so the ONLY thing under
// test is the post-merge recomputation.
function emptyPeer() {
  return {
    meta: { mode: 'single-node' },
    members: [],
    shards: [],
    gaps: { notAnalyzedMembers: [], skipped: [] },
    namespaces: [],
    indexes: [],
  };
}

test('control: before merging, a not-hosting member is not a missing definition', () => {
  const p = applyAnalysis(notHostingLocalPayload(), CONFIG, []);
  assert.equal(p.indexes[0].definition.consistent, true);
  assert.equal(p.indexes[0].verdict, 'likely-drop');
});

test('merging keeps a not-hosting member out of the recomputed missingOn', () => {
  const merged = mergePeerPayloads(notHostingLocalPayload(), [emptyPeer()]);
  const idx = merged.indexes[0];
  assert.deepEqual(idx.definition.missingOn, [],
    'a shard that does not hold the collection is not missing the index');
  assert.equal(idx.definition.consistent, true);
  assert.deepEqual(idx.definition.notHosting, ['h3:27017'], 'notHosting survives the merge');

  const p = applyAnalysis(merged, CONFIG, []);
  assert.equal(p.indexes[0].verdict, 'likely-drop',
    'the merge must not turn a clean verdict into mismatched');
});

test('merging still records a genuinely missing definition on a hosting member', () => {
  // The positive control: the exclusion must be exactly notHosting, not a
  // blanket disabling of the recomputation. h2 is on the shard that DOES hold
  // the namespace and never reported the index, so it is genuinely missing it.
  const local = notHostingLocalPayload();
  local.members.push({ id: 1, host: 'h2:27017', role: 'secondary', hidden: false,
    delaySecs: 0, votes: 1, reachable: true, error: null, shard: 'shardA' });
  local.shards[0].hosts.push('h2:27017');
  local.shards[0].expectedHosts.push('h2:27017');
  local.shards[0].observedHosts.push('h2:27017');

  const merged = mergePeerPayloads(local, [emptyPeer()]);
  assert.deepEqual(merged.indexes[0].definition.missingOn, ['h2:27017']);
  assert.equal(merged.indexes[0].definition.consistent, false);
  assert.equal(applyAnalysis(merged, CONFIG, []).indexes[0].verdict, 'mismatched');
});

test('merging tolerates an index record with no notHosting field at all', () => {
  // A payload pasted from an older build of the script.
  const local = notHostingLocalPayload();
  delete local.indexes[0].definition.notHosting;
  const merged = mergePeerPayloads(local, [emptyPeer()]);
  assert.deepEqual(merged.indexes[0].definition.missingOn, ['h3:27017'],
    'with nothing recorded as not-hosting, the old reading is all there is');
});
