// test/merge.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeNodes, applyAnalysis } = require('../indexStats.js');

const NOW = new Date('2026-09-07T00:00:00Z');
const DAYS = (n) => new Date(NOW.getTime() - n * 86400000);

function node(host, over = {}) {
  return {
    host,
    namespaces: ['shop.orders'],
    skipped: [],
    collections: {
      'shop.orders': {
        error: null,
        indexes: [{ name: 'a_1', key: { a: 1 } }],
        usage: { a_1: { ops: 0, since: DAYS(30) } },
        storage: { a_1: { sizeBytes: 100, reusableBytes: 10, cacheBytes: 5 } },
        ...over,
      },
    },
  };
}

const members = [
  { id: 0, host: 'h1', role: 'primary', hidden: false, delaySecs: 0, votes: 1, reachable: true, error: null },
  { id: 1, host: 'h2', role: 'secondary', hidden: false, delaySecs: 0, votes: 1, reachable: true, error: null },
];

test('sums sizes across members and keeps per-member value', () => {
  const p = mergeNodes({ members, nodeResults: [node('h1'), node('h2')], samples: [], now: NOW });
  const idx = p.indexes[0];
  assert.equal(idx.clusterSizeBytes, 200);
  assert.equal(idx.perMemberSizeBytes, 100);
  assert.equal(idx.perNode.length, 2);
});

test('maxOps takes the highest single member, never the sum', () => {
  const lowOps = node('h1', { usage: { a_1: { ops: 3, since: DAYS(30) } } });
  const highOps = node('h2', { usage: { a_1: { ops: 7, since: DAYS(30) } } });
  const p = mergeNodes({ members, nodeResults: [lowOps, highOps], samples: [], now: NOW });
  assert.equal(p.indexes[0].maxOps, 7);
  assert.notEqual(p.indexes[0].maxOps, 10);
});

test('minCounterAgeDays takes the youngest counter across members', () => {
  const fresh = node('h2', { usage: { a_1: { ops: 0, since: DAYS(2) } } });
  const p = mergeNodes({ members, nodeResults: [node('h1'), fresh], samples: [], now: NOW });
  assert.equal(Math.round(p.indexes[0].minCounterAgeDays), 2);
});

test('definition is inconsistent when the index is missing on a member', () => {
  const without = node('h2', { indexes: [], usage: {}, storage: {} });
  const p = mergeNodes({ members, nodeResults: [node('h1'), without], samples: [], now: NOW });
  const idx = p.indexes[0];
  assert.equal(idx.definition.consistent, false);
  assert.deepEqual(idx.definition.missingOn, ['h2']);
});

test('definition is inconsistent when key patterns differ under one name', () => {
  const other = node('h2', { indexes: [{ name: 'a_1', key: { a: -1 } }] });
  const p = mergeNodes({ members, nodeResults: [node('h1'), other], samples: [], now: NOW });
  assert.equal(p.indexes[0].definition.consistent, false);
  assert.equal(p.indexes[0].definition.variants.length, 2);
});

test('unreachable members are recorded as gaps and contribute no nodes', () => {
  const withDown = [members[0], { ...members[1], reachable: false, error: 'HostUnreachable' }];
  const p = mergeNodes({ members: withDown, nodeResults: [node('h1')], samples: [], now: NOW });
  assert.deepEqual(p.gaps.unreachableMembers, [{ host: 'h2', error: 'HostUnreachable' }]);
  assert.equal(p.indexes[0].perNode.length, 1);
});

test('namespaces are unioned across members and record where they exist', () => {
  const extra = { ...node('h2'), namespaces: ['shop.orders', 'shop.new'] };
  extra.collections['shop.new'] = { error: null, indexes: [], usage: {}, storage: {} };
  const p = mergeNodes({ members, nodeResults: [node('h1'), extra], samples: [], now: NOW });
  const ns = p.namespaces.find((n) => n.ns === 'shop.new');
  assert.deepEqual(ns.presentOn, ['h2']);
});

test('collection-level errors land in gaps.skipped', () => {
  const broken = node('h1');
  broken.collections['shop.orders'] = { error: 'MaxTimeMSExpired', indexes: [], usage: {}, storage: {} };
  const p = mergeNodes({ members, nodeResults: [broken, node('h2')], samples: [], now: NOW });
  assert.deepEqual(p.gaps.skipped, [{ member: 'h1', ns: 'shop.orders', reason: 'MaxTimeMSExpired' }]);
});

// FINDING 1 (final review, critical): a collection-level error on ONE member
// must NOT be conflated with "index confirmed absent there" (missingOn) - it
// is "never observed", a different, more dangerous condition that end-to-end
// (applyAnalysis) must downgrade a zero-ops verdict to inconclusive for, on
// pain of recommending a drop for an index a member was simply never checked
// against (the reviewer's own reproduction: a hidden analytics member timing
// out on $collStats while every other member is old and unused).
test('a collection-level error is excluded from missingOn but still present:false with the error carried on perNode', () => {
  const broken = node('h1');
  broken.collections['shop.orders'] = { error: 'MaxTimeMSExpired', indexes: [], usage: {}, storage: {} };
  const p = mergeNodes({ members, nodeResults: [broken, node('h2')], samples: [], now: NOW });
  const idx = p.indexes[0];
  assert.equal(idx.definition.consistent, true, 'a collection error must not itself flip consistent to false');
  assert.deepEqual(idx.definition.missingOn, []);
  const h1Node = idx.perNode.find((n) => n.host === 'h1');
  assert.equal(h1Node.present, false);
  assert.equal(h1Node.error, 'MaxTimeMSExpired');
});

test('end-to-end: a collection-level error on one member downgrades an old, zero-ops, otherwise-droppable index to inconclusive, not drop', () => {
  const broken = node('h1', { usage: { a_1: { ops: 0, since: DAYS(300) } } });
  broken.collections['shop.orders'] = { error: 'MaxTimeMSExpired', indexes: [], usage: {}, storage: {} };
  const other = node('h2', { usage: { a_1: { ops: 0, since: DAYS(300) } } });
  const merged = mergeNodes({ members, nodeResults: [broken, other], samples: [], now: NOW });
  const payload = applyAnalysis(merged, { DROP_MIN_COUNTER_DAYS: 14, LOW_PRESENCE: 0.10 }, []);
  const idx = payload.indexes[0];
  assert.notEqual(idx.verdict, 'drop');
  assert.notEqual(idx.verdict, 'likely-drop');
  assert.equal(idx.verdict, 'inconclusive');
  assert.match(idx.reasons.join(' '), /h1/);
  assert.match(idx.reasons.join(' '), /MaxTimeMSExpired/);
});

// Same defect via the per-database skip path (~183-186): the collection
// never even gets an entry, so `coll` itself is undefined for that host.
// FINDING 4 (final review, important): a member excluded by
// INCLUDE_HIDDEN=false (main() folds discoverMembers().excludedByConfig into
// the `members` list handed to mergeNodes) must show up in
// gaps.unreachableMembers and downgrade a zero-ops verdict to inconclusive,
// exactly like a genuinely unreachable member does.
test('end-to-end: a member excluded by INCLUDE_HIDDEN=false lands in gaps.unreachableMembers and downgrades an old, zero-ops index to inconclusive', () => {
  const membersWithExcluded = [
    ...members,
    { id: 2, host: 'h3', role: 'unknown', hidden: true, delaySecs: 0, votes: 0,
      reachable: false, error: 'excluded by INCLUDE_HIDDEN=false configuration - never contacted, not unreachable' },
  ];
  const oldZeroOps = { usage: { a_1: { ops: 0, since: DAYS(300) } } };
  const merged = mergeNodes({
    members: membersWithExcluded,
    nodeResults: [node('h1', oldZeroOps), node('h2', oldZeroOps)],
    samples: [], now: NOW,
  });
  assert.deepEqual(merged.gaps.unreachableMembers.map((m) => m.host), ['h3']);
  assert.match(merged.gaps.unreachableMembers[0].error, /INCLUDE_HIDDEN/);

  const payload = applyAnalysis(merged, { DROP_MIN_COUNTER_DAYS: 14, LOW_PRESENCE: 0.10 }, []);
  assert.equal(payload.indexes[0].verdict, 'inconclusive');
  assert.match(payload.indexes[0].reasons.join(' '), /h3/);
});

test('a per-database skip (Unauthorized) also carries its reason onto perNode and is excluded from missingOn', () => {
  const skipped = { ...node('h1'), namespaces: [], collections: {}, skipped: [{ ns: 'shop', reason: 'Unauthorized' }] };
  const p = mergeNodes({ members, nodeResults: [skipped, node('h2')], samples: [], now: NOW });
  const idx = p.indexes[0];
  assert.deepEqual(idx.definition.missingOn, []);
  const h1Node = idx.perNode.find((n) => n.host === 'h1');
  assert.equal(h1Node.present, false);
  assert.equal(h1Node.error, 'Unauthorized');
});
