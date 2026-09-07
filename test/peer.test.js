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
