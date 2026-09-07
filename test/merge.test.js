// test/merge.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeNodes } = require('../indexStats.js');

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
  const busy = node('h2', { usage: { a_1: { ops: 7, since: DAYS(30) } } });
  const p = mergeNodes({ members, nodeResults: [node('h1'), busy], samples: [], now: NOW });
  assert.equal(p.indexes[0].maxOps, 7);
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
