const test = require('node:test');
const assert = require('node:assert/strict');
const { renderHTML, fmtBytes, jsonForScript } = require('../indexStats.js');

function payload(over = {}) {
  return {
    meta: { generatedAt: '2026-09-07T18:41:00.000Z', scriptVersion: '3.0.0',
            replicaSetName: 'rs-prod-eu', seedHost: 'h1:27017', mode: 'multi-node',
            capabilities: { canWriteFiles: true, canOpenConnections: true },
            config: { DROP_MIN_COUNTER_DAYS: 14, SAMPLE_SIZE: 100 } },
    members: [
      { id: 0, host: 'h1:27017', role: 'primary', hidden: false, delaySecs: 0, votes: 1, reachable: true, error: null },
      { id: 1, host: 'h2:27017', role: 'secondary', hidden: true, delaySecs: 0, votes: 1, reachable: false, error: 'HostUnreachable' },
    ],
    gaps: { unreachableMembers: [{ host: 'h2:27017', error: 'HostUnreachable' }],
            skipped: [{ member: 'h1:27017', ns: 'shop.big', reason: 'MaxTimeMSExpired' }] },
    namespaces: [{ ns: 'shop.orders', db: 'shop', coll: 'orders', presentOn: ['h1:27017'],
                   hasValidator: false, sample: { size: 100, member: 'h1:27017' } }],
    indexes: [{
      ns: 'shop.orders', name: 'a_1', key: { a: 1 }, options: {}, hidden: false,
      perNode: [{ host: 'h1:27017', present: true, ops: 0, since: '2026-08-01T00:00:00.000Z',
                  counterAgeDays: 37, sizeBytes: 2048, reusableBytes: 128, cacheBytes: 64, error: null }],
      maxOps: 0, minCounterAgeDays: 37, clusterSizeBytes: 2048, perMemberSizeBytes: 2048,
      redundancy: { class: 'prefix', coveredBy: 'a_1_b_1' },
      definition: { consistent: true, missingOn: [], variants: [] },
      schema: { checks: [] }, verdict: 'inconclusive',
      flags: ['redundant:prefix'], reasons: ['zero operations everywhere observed, but h2:27017 could not be reached'],
    }],
    ...over,
  };
}

test('fmtBytes renders human sizes with fixed precision', () => {
  assert.equal(fmtBytes(0), '0 b');
  assert.equal(fmtBytes(2048), '2.0 kb');
  assert.equal(fmtBytes(1024 ** 3 * 1.5), '1.5 gb');
});

test('renders a complete standalone document', () => {
  const html = renderHTML(payload());
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<\/html>\s*$/);
  assert.match(html, /prefers-color-scheme/);
});

test('makes no network requests of any kind', () => {
  const html = renderHTML(payload());
  assert.equal(/src\s*=\s*["']https?:/.test(html), false);
  assert.equal(/href\s*=\s*["']https?:/.test(html), false);
  assert.equal(html.includes('fetch('), false);
});

test('embeds the payload so it round-trips exactly', () => {
  const p = payload();
  const html = renderHTML(p);
  const m = html.match(/<script type="application\/json" id="indexstats-data">([\s\S]*?)<\/script>/);
  assert.ok(m, 'payload script tag present');
  assert.deepEqual(JSON.parse(m[1]), JSON.parse(JSON.stringify(p)));
});

test('a payload value containing a closing script tag cannot break out', () => {
  const p = payload();
  p.indexes[0].ns = 'evil.</script><script>alert(1)</script>';
  const html = renderHTML(p);
  const closes = html.split('</script>').length - 1;
  const opens = html.split('<script').length - 1;
  assert.equal(closes, opens);
  assert.equal(jsonForScript({ a: '</script>' }).includes('</script>'), false);
});

test('shows the replica set name and member count in the header', () => {
  const html = renderHTML(payload());
  assert.match(html, /rs-prod-eu/);
  assert.match(html, /2 members/);
});

test('banners the unreachable member and the verdict downgrade', () => {
  const html = renderHTML(payload());
  assert.match(html, /h2:27017/);
  assert.match(html, /inconclusive/i);
});

test('omits the gap banner entirely when every member answered', () => {
  const p = payload();
  p.members[1].reachable = true;
  p.gaps.unreachableMembers = [];
  assert.equal(renderHTML(p).includes('id="gap-banner"'), false);
});

// Controller ruling: the brief's version of this test asserted /hidden/ against
// the whole document, which passes merely because the word appears in the
// embedded JSON payload - the fixture's hidden member is also unreachable, and
// renderMembers must show BOTH statuses on its tile, not just one. Assert on
// the member strip's own markup so a regression that drops the hidden status
// (while keeping the unreachable note) would fail this test.
test('labels a hidden member as hidden in the member strip', () => {
  const html = renderHTML(payload());
  const membersMatch = html.match(/<div class="members">([\s\S]*?)<\/div>\s*<div class="controls"/);
  assert.ok(membersMatch, 'member strip present');
  const strip = membersMatch[1];
  const tileMatch = strip.match(/<div class="member down">[\s\S]*?<\/div>\s*<\/div>/);
  assert.ok(tileMatch, 'a "member down" tile is present');
  const tile = tileMatch[0];
  assert.match(tile, /hidden/);
  assert.match(tile, /unreachable/);
});

test('lists skipped namespaces with their reason', () => {
  const html = renderHTML(payload());
  assert.match(html, /shop\.big/);
  assert.match(html, /MaxTimeMSExpired/);
});

const { selectIndexes, summarise, dropCommandsFor } = require('../indexStats.js');

function ix(over) {
  return { ns: 'shop.orders', name: 'a_1', verdict: 'keep', flags: [], maxOps: 0,
           clusterSizeBytes: 100, minCounterAgeDays: 30, ...over };
}

test('selectIndexes filters by verdict', () => {
  const all = [ix({ name: 'x', verdict: 'drop' }), ix({ name: 'y', verdict: 'keep' })];
  const out = selectIndexes(all, { filter: 'drop', search: '', sortKey: 'size', sortDir: -1 });
  assert.deepEqual(out.map((i) => i.name), ['x']);
});

test('selectIndexes filters by flag prefix', () => {
  const all = [ix({ name: 'x', flags: ['redundant:prefix'] }), ix({ name: 'y', flags: [] })];
  const out = selectIndexes(all, { filter: 'redundant', search: '', sortKey: 'size', sortDir: -1 });
  assert.deepEqual(out.map((i) => i.name), ['x']);
});

// The `redundant` verdict shares its name with the `redundant:<class>` flag on
// purpose: there is one chip, and it means "every index that is redundant",
// whether or not it is also unused. Pin both halves, since dropping the old
// separate `review` chip is what made this filter do double duty.
test('the redundant filter matches the verdict AND the flag', () => {
  const all = [
    ix({ name: 'byVerdict', verdict: 'redundant', flags: [] }),
    ix({ name: 'byFlag', verdict: 'drop', flags: ['redundant:duplicate'] }),
    ix({ name: 'both', verdict: 'redundant', flags: ['redundant:prefix'] }),
    ix({ name: 'neither', verdict: 'keep', flags: [] }),
  ];
  const out = selectIndexes(all, { filter: 'redundant', search: '', sortKey: 'size', sortDir: -1 });
  assert.deepEqual(out.map((i) => i.name).sort(), ['both', 'byFlag', 'byVerdict']);
});

// A redundant index that is still serving traffic must never be auto-emitted
// as a dropIndexes statement - it needs hiding and observing first. The copy
// button stays limited to drop/likely-drop.
test('dropCommandsFor never emits a redundant-but-in-use index', () => {
  assert.equal(dropCommandsFor([ix({ verdict: 'redundant', flags: ['redundant:prefix'] })]).trim(), '');
});

test('selectIndexes searches namespace and index name, case-insensitively', () => {
  const all = [ix({ ns: 'crm.contacts', name: 'email_1' }), ix({ ns: 'shop.orders', name: 'a_1' })];
  const base = { filter: 'all', sortKey: 'size', sortDir: -1 };
  assert.deepEqual(selectIndexes(all, { ...base, search: 'CRM' }).map((i) => i.ns), ['crm.contacts']);
  assert.deepEqual(selectIndexes(all, { ...base, search: 'email' }).map((i) => i.name), ['email_1']);
});

test('selectIndexes sorts by the requested key and direction', () => {
  const all = [ix({ name: 'small', clusterSizeBytes: 1 }), ix({ name: 'big', clusterSizeBytes: 900 })];
  const state = { filter: 'all', search: '', sortKey: 'size', sortDir: -1 };
  assert.deepEqual(selectIndexes(all, state).map((i) => i.name), ['big', 'small']);
  assert.deepEqual(selectIndexes(all, { ...state, sortDir: 1 }).map((i) => i.name), ['small', 'big']);
});

test('selectIndexes does not mutate its input', () => {
  const all = [ix({ name: 'a', clusterSizeBytes: 1 }), ix({ name: 'b', clusterSizeBytes: 9 })];
  selectIndexes(all, { filter: 'all', search: '', sortKey: 'size', sortDir: -1 });
  assert.deepEqual(all.map((i) => i.name), ['a', 'b']);
});

test('summarise counts only what is passed to it', () => {
  const s = summarise([
    ix({ verdict: 'drop', clusterSizeBytes: 100 }),
    ix({ verdict: 'likely-drop', clusterSizeBytes: 50 }),
    ix({ verdict: 'inconclusive', clusterSizeBytes: 10 }),
    ix({ verdict: 'keep', flags: ['redundant:prefix'] }),
  ]);
  assert.equal(s.drop, 2);
  assert.equal(s.reclaimable, 150);
  assert.equal(s.inconclusive, 1);
  assert.equal(s.redundant, 1);
});

test('dropCommandsFor emits one runnable statement per namespace', () => {
  const cmds = dropCommandsFor([
    ix({ ns: 'shop.orders', name: 'a_1', verdict: 'drop' }),
    ix({ ns: 'shop.orders', name: 'b_1', verdict: 'drop' }),
    ix({ ns: 'crm.contacts', name: 'c_1', verdict: 'likely-drop' }),
  ]);
  assert.match(cmds, /getSiblingDB\("shop"\)\.getCollection\("orders"\)\.dropIndexes\(\["a_1","b_1"\]\)/);
  assert.match(cmds, /getSiblingDB\("crm"\)\.getCollection\("contacts"\)\.dropIndexes\(\["c_1"\]\)/);
});

// Must-fix minor (final review): bare `"` + string-concat quoting let a
// namespace or index name containing a `"` produce a broken, potentially
// injectable statement pasted straight into a production shell.
test('dropCommandsFor JSON-escapes names containing quotes and backslashes', () => {
  const cmds = dropCommandsFor([
    ix({ ns: 'shop.orders', name: 'weird"index\\name', verdict: 'drop' }),
  ]);
  // Must round-trip through JSON.parse (i.e. be a validly-escaped string
  // literal), not just "contain" the raw characters via naive concatenation.
  const match = cmds.match(/dropIndexes\((\[.*\])\)/);
  assert.ok(match, 'expected a dropIndexes([...]) statement');
  assert.deepEqual(JSON.parse(match[1]), ['weird"index\\name']);
});

test('dropCommandsFor never emits commands for non-candidates', () => {
  const cmds = dropCommandsFor([ix({ verdict: 'keep' }), ix({ verdict: 'inconclusive' }),
                                ix({ verdict: 'mismatched' }), ix({ verdict: 'redundant' })]);
  assert.equal(cmds.trim(), '');
});

test('the report embeds the client functions and boots them', () => {
  const html = renderHTML(payload());
  assert.match(html, /function selectIndexes/);
  assert.match(html, /function summarise/);
  assert.match(html, /function dropCommandsFor/);
  assert.match(html, /function fmtBytes/);
  assert.match(html, /id="table-host"/);
});

test('client functions close over nothing from the enclosing scope', () => {
  for (const fn of [selectIndexes, summarise, dropCommandsFor, fmtBytes]) {
    const src = fn.toString();
    assert.equal(/\bLOW_PRESENCE\b|\bVERDICT_ORDER\b|\bREPORT_CSS\b|\bapi\b/.test(src), false,
      `${fn.name} must not reference enclosing scope`);
  }
});

module.exports = { payload };

// The `redundant` metric card and the `redundant` chip must never show
// different numbers for the same word: the card counts verdict-or-flag, the
// chip filter matches verdict-or-flag. Pin them to each other.
test('the redundant card count always equals the redundant chip count', () => {
  const all = [
    ix({ name: 'a', verdict: 'redundant', flags: ['redundant:prefix'] }),
    ix({ name: 'b', verdict: 'drop', flags: ['redundant:duplicate'] }),
    ix({ name: 'c', verdict: 'redundant', flags: [] }),
    ix({ name: 'd', verdict: 'keep', flags: [] }),
  ];
  const chip = selectIndexes(all, { filter: 'redundant', search: '', sortKey: 'size', sortDir: -1 }).length;
  assert.equal(summarise(all).redundant, chip);
  assert.equal(chip, 3);
});
