const test = require('node:test');
const assert = require('node:assert/strict');
const { mergePeerPayloads, applyAnalysis } = require('../indexStats.js');

const CONFIG = { DROP_MIN_COUNTER_DAYS: 14, LOW_PRESENCE: 0.10 };

function single(host, ops, ageDays, verdict) {
  return {
    meta: { mode: 'single-node', replicaSetName: 'rs0' },
    members: [{ id: 0, host, role: 'primary', hidden: false, delaySecs: 0, votes: 1,
                reachable: true, error: null }],
    gaps: { unreachableMembers: [], skipped: [] },
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
      unreachableMembers: others.map((h) => ({ host: h, error: 'connection refused' })),
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
  assert.deepEqual(merged.gaps.unreachableMembers, []);

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
  assert.deepEqual(merged.gaps.unreachableMembers.map((m) => m.host), ['h3']);

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
