// test/e2e/verify.js
const fs = require('fs');
const assert = require('node:assert/strict');

const file = process.argv[2] ?? 'indexStats-report.html';
const expectUnreachable = process.argv.includes('--expect-unreachable');
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/<script type="application\/json" id="indexstats-data">([\s\S]*?)<\/script>/);
assert.ok(m, 'payload present in report');
const p = JSON.parse(m[1]);
const find = (ns, name) => {
  const i = p.indexes.find((x) => x.ns === ns && x.name === name);
  assert.ok(i, `index ${ns} ${name} present in report`);
  return i;
};

assert.equal(p.meta.replicaSetName, 'rsIndexStats');
assert.equal(p.members.length, 3, 'all three data-bearing members discovered');
assert.equal(p.members.filter((x) => x.hidden).length, 1, 'hidden member reported as hidden');

if (!expectUnreachable) {
  assert.equal(p.members.every((x) => x.reachable), true, 'every member reachable');
  assert.equal(p.gaps.unreachableMembers.length, 0);
  assert.equal(find('shop.orders', '_id_').perNode.filter((n) => n.present).length, 3,
    'the _id_ index is observed on all three members');
}

const prefix = find('shop.orders', 'status_1_createdAt_-1');
assert.equal(prefix.redundancy.class, 'prefix');
assert.equal(prefix.redundancy.coveredBy, 'status_1_createdAt_-1_region_1');
assert.equal(find('shop.orders', 'status_1').redundancy.class, 'subsumed');

const typo = find('shop.orders', 'createdAT_1');
const absent = typo.schema.checks.find((c) => c.issue === 'absent');
assert.ok(absent, 'typo field detected as absent');
assert.match(absent.text, /absent from \d+ of \d+ sampled documents/);
assert.equal(typo.flags.includes('suspect-field'), true);

assert.equal(find('shop.orders', 'total_1').schema.checks.some((c) => c.issue === 'mixed-types'),
  true, 'mixed int/string field detected');
assert.equal(find('shop.orders', 'tags_1').schema.checks.some((c) => c.issue === 'unexpected-multikey'),
  true, 'array field detected as multikey');
assert.equal(find('crm.contacts', 'nickname_1').schema.checks
  .some((c) => c.issue === 'not-in-validator' && c.provable), true,
  'closed validator makes the finding provable');

const used = find('crm.contacts', 'email_1');
assert.ok(used.maxOps > 0, 'queried index shows usage');
assert.equal(used.verdict, 'keep');

for (const i of p.indexes) {
  assert.notEqual(i.verdict, 'drop', 'a fresh cluster has counters younger than 14 days');
  assert.notEqual(i.verdict, 'likely-drop');
}
assert.ok(p.indexes.some((i) => i.verdict === 'inconclusive'),
  'young counters produce inconclusive verdicts, never drop recommendations');

if (expectUnreachable) {
  assert.equal(p.gaps.unreachableMembers.length, 1, 'the stopped member is reported unreachable');
  assert.match(html, /unreachable/);
}
console.log(`ok - ${p.indexes.length} indexes, ${p.members.length} members verified`);
