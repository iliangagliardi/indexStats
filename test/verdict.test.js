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

test('usage plus redundancy means redundant, not keep', () => {
  const v = deriveVerdict(idx({ maxOps: 5, perNode: [{ host: 'h1', present: true, ops: 5 }],
    redundancy: { class: 'prefix', coveredBy: 'a_1_b_1' } }), CTX);
  assert.equal(v.verdict, 'redundant');
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

// Must-fix minor (final review): no verdict-level test previously covered
// the `not-in-validator && provable === true` half of the suspect-field
// condition - one of only two conditions (with 'absent') that escalate a
// verdict to 'drop'.
test('a provable not-in-validator field turns likely-drop into drop', () => {
  const v = deriveVerdict(idx({
    schema: { checks: [{ field: 'legacyFlag', issue: 'not-in-validator', provable: true,
      text: 'not declared in the collection validator, which forbids additional properties' }] },
  }), CTX);
  assert.equal(v.verdict, 'drop');
  assert.equal(v.flags.includes('suspect-field'), true);
});

// The non-provable half must NOT escalate (already implied elsewhere, but
// pins the boundary explicitly next to the provable case above).
test('a non-provable not-in-validator field alone is not a suspect field', () => {
  const v = deriveVerdict(idx({
    schema: { checks: [{ field: 'legacyFlag', issue: 'not-in-validator', provable: false,
      text: 'not declared in the collection validator (which permits additional properties, so this is advisory)' }] },
  }), CTX);
  assert.equal(v.flags.includes('suspect-field'), false);
  assert.equal(v.verdict, 'likely-drop');
});

test('low-presence alone is not a suspect field', () => {
  const v = deriveVerdict(idx({ schema: { checks: [{ field: 'a', issue: 'low-presence', provable: false }] } }), CTX);
  assert.equal(v.flags.includes('suspect-field'), false);
  assert.equal(v.verdict, 'likely-drop');
});

// FINDING 1 (final review, critical): a reachable member that produced no
// observation for an index (collection-level error, e.g. MaxTimeMSExpired on
// a large collection) must block a droppable verdict exactly like an
// unreachable member does - even though `definition.missingOn` deliberately
// excludes it (that field means "confirmed genuinely absent", not "unknown").
test('a reachable member with a collection-level error blocks a drop even though missingOn excludes it', () => {
  const ctx = { ...CTX, reachableHosts: ['h1', 'h2'], unreachableHosts: [] };
  const v = deriveVerdict(idx({
    perNode: [
      { host: 'h1', present: true, ops: 0 },
      { host: 'h2', present: false, ops: null, error: 'MaxTimeMSExpired' },
    ],
    definition: { consistent: true, missingOn: [], variants: [] },
  }), ctx);
  assert.equal(v.verdict, 'inconclusive');
  assert.equal(v.flags.includes('unobserved-member'), true);
  assert.match(v.reasons.join(' '), /h2/);
  assert.match(v.reasons.join(' '), /MaxTimeMSExpired/);
  // must not falsely claim zero ops everywhere was confirmed
  assert.doesNotMatch(v.reasons.join(' '), /zero operations on every data-bearing member/);
});

// Same defect, reached via a per-database skip (Unauthorized) rather than a
// per-collection error: the member never even produced a perNode entry.
test('a reachable member entirely missing from perNode (never observed) blocks a drop', () => {
  const ctx = { ...CTX, reachableHosts: ['h1', 'h2'], unreachableHosts: [] };
  const v = deriveVerdict(idx({
    perNode: [{ host: 'h1', present: true, ops: 0 }],
    definition: { consistent: true, missingOn: [], variants: [] },
  }), ctx);
  assert.equal(v.verdict, 'inconclusive');
  assert.match(v.reasons.join(' '), /h2/);
});

// A genuinely confirmed-absent member (real schema drift, present in
// missingOn) must still take the mismatched path, not be swept into the new
// coverage gate.
test('a confirmed-missing member (in definition.missingOn) is still mismatched, not inconclusive-by-coverage', () => {
  const ctx = { ...CTX, reachableHosts: ['h1', 'h2'], unreachableHosts: [] };
  const v = deriveVerdict(idx({
    perNode: [{ host: 'h1', present: true, ops: 0 }],
    definition: { consistent: false, missingOn: ['h2'], variants: [] },
  }), ctx);
  assert.equal(v.verdict, 'mismatched');
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
