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

module.exports = { payload };
