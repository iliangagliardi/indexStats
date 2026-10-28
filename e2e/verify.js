// e2e/verify.js
// Asserts against the payload embedded in the generated report. One file covers
// three runs, selected by what the payload itself says plus INDEXSTATS_E2E_MODE:
//   - a replica set                    (e2e/cluster.sh)
//   - a sharded cluster, direct mode   (e2e/sharded.sh, INDEXSTATS_URI reaches the shards)
//   - a sharded cluster, indirect mode (e2e/sharded.sh, INDEXSTATS_E2E_MODE=indirect)
const fs = require('fs');
const assert = require('node:assert/strict');

// This file is run under BOTH runtimes, and they disagree about argv:
//   node   e2e/verify.js indexStats-report.html   -> argv[2] IS the report path
//   mongosh "mongodb://..." --file e2e/verify.js  -> argv[2] is the CONNECTION STRING
// Harness defect found in Task 12 against mongosh 2.13.0: the original
// `process.argv[2] ?? 'indexStats-report.html'` took mongosh's connection
// string as a filename and died with
// `ENOENT: no such file or directory, open 'mongodb://127.0.0.1:27030'`.
// Reading the path ONLY from the environment fixed mongosh but silently broke
// the node form documented in INSTALLATION.md and RUNNING-ON-REPLICA-SETS.md:
// its argument was ignored, so pointing it at a differently-named report
// verified the DEFAULT file and still printed "ok" - a false pass, which is
// worse than the crash it replaced.
// So: honour argv[2] only when it cannot be a connection string and is not a
// flag. Do not "simplify" this guard away; it is what makes one file correct
// under two runtimes. Precedence is argument, then environment, then default.
const proc = (typeof process === 'object' && process) ? process : {};
const env = proc.env ?? {};
const argv = proc.argv ?? [];
const argPath = (typeof argv[2] === 'string' && argv[2].length > 0
  && !/^mongodb(\+srv)?:\/\//.test(argv[2]) && !argv[2].startsWith('-'))
  ? argv[2] : null;
const file = argPath ?? env.INDEXSTATS_E2E_REPORT ?? 'indexStats-report.html';
const expectUnreachable = env.INDEXSTATS_E2E_EXPECT === 'unreachable'
  || argv.includes('--expect-unreachable');
const shardMode = env.INDEXSTATS_E2E_MODE === 'indirect' ? 'indirect' : 'direct';
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/<script type="application\/json" id="indexstats-data">([\s\S]*?)<\/script>/);
assert.ok(m, 'payload present in report');
const p = JSON.parse(m[1]);
const find = (ns, name) => {
  const i = p.indexes.find((x) => x.ns === ns && x.name === name);
  assert.ok(i, `index ${ns} ${name} present in report`);
  return i;
};
const sharded = p.meta.topology === 'sharded';

if (!sharded) {
  // ---------------------------- replica set -------------------------------
  assert.equal(p.meta.topology, 'replica-set');
  assert.equal(p.meta.replicaSetName, 'rsIndexStats');
  assert.equal(p.members.length, 3, 'all three data-bearing members discovered');
  assert.equal(p.members.filter((x) => x.hidden).length, 1, 'hidden member reported as hidden');
  assert.equal(p.shards.length, 0, 'a replica set has no shard records');

  if (!expectUnreachable) {
    assert.equal(p.members.every((x) => x.reachable), true, 'every member reachable');
    assert.equal(p.gaps.unreachableMembers.length, 0);
    assert.equal(find('shop.orders', '_id_').perNode.filter((n) => n.present).length, 3,
      'the _id_ index is observed on all three members');
  }
} else {
  // -------------------------- sharded cluster -----------------------------
  assert.equal(p.meta.topology, 'sharded');
  assert.ok(p.meta.readPref, 'the effective read preference is recorded');
  assert.equal(typeof p.meta.readPref, 'string');
  assert.equal(p.shards.length, 2, 'both shards present in the payload');
  assert.deepEqual(p.shards.map((s) => s.name).sort(), ['shardA', 'shardB']);
  assert.equal(p.members.length, 4, 'every configured shard member has an entry');
  assert.equal(p.members.every((x) => x.shard === 'shardA' || x.shard === 'shardB'), true,
    'every member is attributed to a shard');

  // Placement. shop.orders is sharded on { customerId: 1 } with one chunk moved
  // to the other shard, so both shards really answer for it; shop.lookup is
  // unsharded and therefore lives on its database's primary shard alone.
  const orders = p.namespaces.find((n) => n.ns === 'shop.orders');
  assert.ok(orders, 'shop.orders collected');
  assert.deepEqual([...orders.shards].sort(), ['shardA', 'shardB'],
    'the sharded collection is observed on both shards');
  const lookup = p.namespaces.find((n) => n.ns === 'shop.lookup');
  assert.ok(lookup, 'shop.lookup collected');
  assert.equal(lookup.shards.length, 1, 'the unsharded collection lives on exactly one shard');
  assert.ok(p.namespaces.some((n) => n.db === 'inventory'),
    'the second database is collected through the router too');

  // The unsharded-collection fix must do REAL work, not pass vacuously: the
  // shard that does not hold shop.lookup has to be recorded as not-hosting,
  // and the index must not be called mismatched because of it.
  const lookupIndexes = p.indexes.filter((i) => i.ns === 'shop.lookup');
  assert.ok(lookupIndexes.length >= 2, 'shop.lookup has _id_ and code_1');
  for (const i of lookupIndexes) {
    assert.equal(i.definition.consistent, true,
      `${i.name} on an unsharded collection must not be inconsistent`);
    assert.notEqual(i.verdict, 'mismatched',
      `${i.name} on an unsharded collection must not be reported mismatched`);
    assert.ok(i.definition.notHosting.length > 0,
      `${i.name} records the members whose shard does not host shop.lookup`);
    assert.equal(i.definition.missingOn.length, 0,
      `${i.name} must not record a non-hosting shard as missing the index`);
  }

  // Every index carries a per-shard entry for each shard that hosts its
  // namespace - the per-shard separation the whole feature exists to provide.
  const shardsOfNs = new Map(p.namespaces.map((n) => [n.ns, [...n.shards].sort()]));
  for (const i of p.indexes) {
    assert.deepEqual(i.perShard.map((s) => s.shard).sort(), shardsOfNs.get(i.ns),
      `${i.ns} ${i.name} has a perShard entry for every hosting shard`);
  }

  if (shardMode === 'direct') {
    for (const s of p.shards) {
      assert.equal(s.mode, 'direct', `${s.name} was collected directly`);
      assert.equal(s.coverage, 'full', `${s.name} had every data-bearing member observed`);
      assert.deepEqual([...s.observedHosts].sort(), [...s.expectedHosts].sort(),
        `${s.name} observed exactly the members it was expected to`);
    }
    assert.equal(p.members.every((x) => x.reachable), true, 'every shard member reachable');
    assert.equal(p.gaps.unreachableMembers.length, 0);
    assert.equal(p.indexes.every((i) => i.sizeEstimated === false), true,
      'full coverage needs no size extrapolation');

    // The redundant pair seeded on the SHARDED collection.
    const shardKeyIdx = find('shop.orders', 'customerId_1');
    assert.ok(shardKeyIdx.redundancy.class, 'the shard-key index is detected as redundant');
    assert.equal(shardKeyIdx.redundancy.coveredBy, 'customerId_1_createdAt_1');

    // Per-shard ops really are separated, not merged into one bucket.
    const hot = find('shop.orders', 'status_1_createdAt_-1_region_1');
    assert.deepEqual(hot.perShard.map((s) => s.shard).sort(), ['shardA', 'shardB']);
    assert.equal(hot.perShard.every((s) => s.ops > 0), true,
      'the scatter-gather query is recorded as ops on both shards');
  } else {
    for (const s of p.shards) {
      assert.equal(s.mode, 'indirect', `${s.name} fell back to collection through mongos`);
      assert.equal(s.coverage, 'partial', `${s.name} cannot be fully covered through the router`);
      assert.equal(s.observedHosts.length, 1,
        `${s.name} read with readPreference ${s.readPref} yields exactly one member`);
      assert.ok(s.expectedHosts.includes(s.observedHosts[0]),
        `${s.name}'s observed host is reconciled onto a configured member`);
    }
    assert.equal(p.meta.readPref, 'primary',
      'the driver default read preference is what was recorded');
    assert.equal(p.members.filter((x) => x.reachable).length, 2,
      'exactly one member per shard answered through the router');

    // Regression guard for the verified bug where the router was queried
    // successfully and then every scrap of its evidence was thrown away
    // because the hosts it named never matched the hosts listShards named.
    assert.ok(find('shop.orders', 'status_1_createdAt_-1_region_1').maxOps > 0,
      'usage collected through mongos survives into the payload');
    assert.ok(Object.keys(find('shop.orders', 'status_1').key).length > 0,
      'index key definitions collected through mongos survive into the payload');
    assert.ok(find('shop.orders', 'status_1').clusterSizeBytes > 0,
      'index sizes collected through mongos survive into the payload');
    assert.equal(p.indexes.every((i) => i.sizeEstimated === true), true,
      'one-of-two observed members means every size is an extrapolation, and says so');

    // Every zero-operation index must be gated by the partial coverage. _id_ is
    // excluded deliberately: it short-circuits to `keep` before any gate,
    // because it cannot be dropped at all.
    for (const i of p.indexes) {
      if (i.name === '_id_' || i.maxOps > 0) continue;
      assert.equal(i.flags.includes('partial-shard-coverage'), true,
        `${i.ns} ${i.name} is gated by partial shard coverage`);
      assert.equal(i.verdict, 'inconclusive',
        `${i.ns} ${i.name} cannot be judged unused through a primary-only read`);
    }
  }
}

// ------------------------- shared across all runs --------------------------
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

// The 14-day DROP_MIN_COUNTER_DAYS safety rule. $indexStats counters reset on
// restart, so on a cluster seeded minutes ago a drop recommendation is a bug in
// the script, never a test to be adjusted.
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
const where = sharded ? `sharded (${shardMode}), ${p.shards.length} shards` : 'replica set';
console.log(`ok - ${where}: ${p.indexes.length} indexes, `
  + `${p.namespaces.length} collections, ${p.members.length} members verified`);
