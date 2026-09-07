const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveVerdict, applyAnalysis } = require('../indexStats.js');

const CONFIG = { DROP_MIN_COUNTER_DAYS: 14, LOW_PRESENCE: 0.10 };
const CTX = { config: CONFIG, hiddenHosts: [], unreachableHosts: [] };

function idx(over = {}) {
  return {
    ns: 'shop.orders', name: 'a_1', key: { a: 1 }, hidden: false,
    maxOps: 0, minCounterAgeDays: 40, clusterSizeBytes: 1000,
    perNode: [{ host: 'h1', present: true, ops: 0 }],
    redundancy: { class: null, coveredBy: null },
    definition: { consistent: true, missingOn: [], variants: [] },
    schema: { checks: [] },
    ...over,
  };
}

test('unused everywhere with old counters and no redundancy is likely-drop', () => {
  assert.equal(deriveVerdict(idx(), CTX).verdict, 'likely-drop');
});

test('unused everywhere plus redundancy is a drop recommendation', () => {
  const v = deriveVerdict(idx({ redundancy: { class: 'prefix', coveredBy: 'a_1_b_1' } }), CTX);
  assert.equal(v.verdict, 'drop');
  assert.equal(v.flags.includes('redundant:prefix'), true);
});

test('a young counter downgrades to inconclusive even when unused', () => {
  const v = deriveVerdict(idx({ minCounterAgeDays: 2 }), CTX);
  assert.equal(v.verdict, 'inconclusive');
  assert.match(v.reasons.join(' '), /2.*days.*14/);
});

test('a counter exactly at the threshold still permits a recommendation', () => {
  assert.equal(deriveVerdict(idx({ minCounterAgeDays: 14 }), CTX).verdict, 'likely-drop');
});

test('an unreachable member downgrades every unused index to inconclusive', () => {
  const ctx = { ...CTX, unreachableHosts: ['h3'] };
  const v = deriveVerdict(idx({ redundancy: { class: 'prefix', coveredBy: 'x' } }), ctx);
  assert.equal(v.verdict, 'inconclusive');
  assert.match(v.reasons.join(' '), /h3/);
});

test('usage anywhere means keep', () => {
  assert.equal(deriveVerdict(idx({ maxOps: 5, perNode: [{ host: 'h1', present: true, ops: 5 }] }), CTX).verdict, 'keep');
});

test('usage plus redundancy means review, not keep', () => {
  const v = deriveVerdict(idx({ maxOps: 5, perNode: [{ host: 'h1', present: true, ops: 5 }],
    redundancy: { class: 'prefix', coveredBy: 'a_1_b_1' } }), CTX);
  assert.equal(v.verdict, 'review');
});

test('usage only on a hidden member is flagged', () => {
  const v = deriveVerdict(idx({ maxOps: 9, perNode: [
    { host: 'h1', present: true, ops: 0 }, { host: 'h3', present: true, ops: 9 }] }),
    { ...CTX, hiddenHosts: ['h3'] });
  assert.equal(v.verdict, 'keep');
  assert.equal(v.flags.includes('used-only-on-hidden'), true);
});

test('an inconsistent definition wins over everything and is never a drop', () => {
  const v = deriveVerdict(idx({ definition: { consistent: false, missingOn: ['h2'], variants: [] } }), CTX);
  assert.equal(v.verdict, 'mismatched');
  assert.match(v.reasons.join(' '), /h2/);
});

test('_id_ is always keep', () => {
  assert.equal(deriveVerdict(idx({ name: '_id_', key: { _id: 1 } }), CTX).verdict, 'keep');
});

test('a suspect field turns likely-drop into drop', () => {
  const v = deriveVerdict(idx({ schema: { checks: [{ field: 'createdAT', issue: 'absent', provable: false }] } }), CTX);
  assert.equal(v.verdict, 'drop');
  assert.equal(v.flags.includes('suspect-field'), true);
});

test('a suspect field never overrides observed usage', () => {
  const v = deriveVerdict(idx({ maxOps: 3, perNode: [{ host: 'h1', present: true, ops: 3 }],
    schema: { checks: [{ field: 'createdAT', issue: 'absent', provable: false }] } }), CTX);
  assert.equal(v.verdict, 'keep');
  assert.equal(v.flags.includes('suspect-field'), true);
});

test('low-presence alone is not a suspect field', () => {
  const v = deriveVerdict(idx({ schema: { checks: [{ field: 'a', issue: 'low-presence', provable: false }] } }), CTX);
  assert.equal(v.flags.includes('suspect-field'), false);
  assert.equal(v.verdict, 'likely-drop');
});

test('applyAnalysis ranks drop candidates first, then by cluster size', () => {
  const payload = {
    members: [{ host: 'h1', hidden: false, reachable: true }],
    gaps: { unreachableMembers: [], skipped: [] },
    namespaces: [{ ns: 'shop.orders' }],
    indexes: [
      idx({ name: 'small_drop', clusterSizeBytes: 10, redundancy: { class: 'prefix', coveredBy: 'x' } }),
      idx({ name: 'keeper', maxOps: 100, perNode: [{ host: 'h1', present: true, ops: 100 }] }),
      idx({ name: 'big_drop', clusterSizeBytes: 9000, redundancy: { class: 'prefix', coveredBy: 'x' } }),
    ],
  };
  const out = applyAnalysis(payload, CONFIG, []);
  assert.deepEqual(out.indexes.map((i) => i.name), ['big_drop', 'small_drop', 'keeper']);
});
