# Multi-node HTML index report (indexStats.js v3) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `indexStats.js` from a single-node text report into a replica-set-wide index audit that writes one self-contained, interactive HTML file.

**Architecture:** One file, no dependencies, paste-able into any mongosh or Compass shell. A thin live layer (capability probe, member discovery, per-member collection, one-member document sampling) produces a plain data payload; everything after that — merge, redundancy classification, schema checks, verdicts, HTML rendering — is a pure function of that payload with no `db` access. Purity is what makes the logic testable under `node --test` without a cluster, via an export guard mongosh ignores.

**Tech Stack:** mongosh 2.9.2 (shell runtime), Node.js `node:test` + `node:assert/strict` (unit tests, zero dependencies), plain `mongod` processes for end-to-end tests. No npm packages, no CDN, no containers.

**Spec:** `docs/superpowers/specs/2026-09-07-multinode-html-index-report-design.md` — read it alongside this plan; the plan argues from it.

## Global Constraints

- **Single file.** All shell code lives in `indexStats.js`. No modules, no `load()`, no relative `require`, no npm dependencies.
- **Paste-able runtime.** The script must run pasted into any mongosh or Compass shell. `require('fs')`, `process.env`, and `new Mongo()` are *probed*, never assumed.
- **Export guard is exactly** `if (typeof module === 'object' && module.exports)`. In mongosh `typeof module === 'function'` (the shell's own helper), so `typeof module !== 'undefined'` would misfire and is forbidden.
- **No `db` access after collection.** `mergeNodes`, `classifyRedundancy`, `classifySchemaIssues`, `deriveVerdict`, `renderHTML` take plain data and return plain data or strings.
- **`maxTimeMS: MAX_TIME_MS` on every server call.** Default `30000`.
- **`directConnection=true` is mandatory in `URI_TEMPLATE`**, or the driver reconnects to the primary and the same node is polled N times.
- **Never mutate the database.** No `dropIndex`, no `createIndex`, no writes. The report emits `dropIndexes` commands as text for a human.
- **`DROP_MIN_COUNTER_DAYS = 14`** default. A zero-op index is only recommended for dropping when the *youngest* counter across all members is at least this old.
- **Evidentiary wording.** Schema findings say "absent from 100 of 100 sampled documents", never "field does not exist". Verdicts never guess which side of a schema mismatch is wrong.
- **Report is offline.** Inline CSS and JS only. No CDN, no fetch, no external fonts.
- **Config values, copied verbatim:** `OUT_FILE = 'indexStats-report.html'`, `EXCLUDED_DBS = ['admin','config','local']`, `MAX_TIME_MS = 30000`, `INCLUDE_HIDDEN = true`, `DROP_MIN_COUNTER_DAYS = 14`, `SAMPLE_SIZE = 100`, `PEER_PAYLOADS = []`, `SCRIPT_VERSION = '3.0.0'`, low-presence threshold `0.10`, sample flatten depth cap `8`.

---

## File Structure

| File | Responsibility |
|---|---|
| `indexStats.js` (modify) | The entire shell script: config block, live collection layer, pure analysis layer, HTML renderer, output. Grows from ~220 to ~800-900 lines. Ends with the guarded export. |
| `test/redundancy.test.js` (create) | Unit tests for `isPlain`, `canonicalKeyString`, `classifyRedundancy`. |
| `test/merge.test.js` (create) | Unit tests for `mergeNodes`. |
| `test/schema.test.js` (create) | Unit tests for `flattenPaths`, `keyFieldsOf`, `classifySchemaIssues`. |
| `test/verdict.test.js` (create) | Unit tests for `deriveVerdict` — the full verdict table. |
| `test/render.test.js` (create) | Unit tests for `renderHTML` — payload round-trip, escaping, filter counts. |
| `test/peer.test.js` (create) | Unit tests for peer-payload merging and degradation modes. |
| `test/e2e/cluster.sh` (create) | Starts/stops a 3-member `mongod` replica set on ports 27021-27023, one member hidden. |
| `test/e2e/seed.js` (create) | mongosh script seeding databases, redundant indexes, a typo'd index field, a validator, and index usage. |
| `test/e2e/verify.js` (create) | Node script: extracts the JSON payload from the generated HTML and asserts on it. |
| `CLAUDE.md` (modify) | Update conventions for v3. |

Why one file: mongosh's module resolution for relative `require`/`load` is unreliable, and the paste-into-Compass constraint forbids multi-file loading. The cost is paid down with hard internal boundaries and the purity rule above.

---

### Task 1: Dual-mode file skeleton and test harness

Makes `indexStats.js` loadable by Node for testing while still running normally in a shell. v2's text behaviour keeps working — this task is pure scaffolding, so the repo is never left broken.

**Files:**
- Modify: `indexStats.js:23` (IIFE opening) and `indexStats.js:220` (IIFE closing)
- Test: `test/skeleton.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `module.exports` object (`api`) from `indexStats.js`, initially `{ SCRIPT_VERSION: string, isPlain: (spec) => boolean }`. Every later task adds its functions to this same `api` object literal. Also produces the `inShell` gate: `main()` runs only when `typeof db !== 'undefined'`.

- [ ] **Step 1: Write the failing test**

```js
// test/skeleton.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../indexStats.js');

test('requiring the script under node does not execute the shell run', () => {
  assert.equal(typeof S, 'object');
});

test('exports the script version', () => {
  assert.equal(S.SCRIPT_VERSION, '3.0.0');
});

test('exports isPlain as a pure function', () => {
  assert.equal(typeof S.isPlain, 'function');
  assert.equal(S.isPlain({ name: 'a_1', key: { a: 1 } }), true);
  assert.equal(S.isPlain({ name: '_id_', key: { _id: 1 } }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/skeleton.test.js`
Expected: FAIL. The current file calls `db.adminCommand` at load, so this throws `ReferenceError: db is not defined` before any assertion runs.

- [ ] **Step 3: Write minimal implementation**

In `indexStats.js`, add `SCRIPT_VERSION` to the config block:

```js
  const SCRIPT_VERSION = '3.0.0';
```

Move everything from `let dbNames = [];` (line 88) through the end of the summary printing into a new `function main() { ... }` — a pure cut-and-paste, no logic changes. Then replace the IIFE's closing lines with:

```js
  const api = { SCRIPT_VERSION, isPlain };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (typeof db !== 'undefined' && typeof print === 'function') {
    main();
  }
})();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/`
Expected: PASS, 3 tests.

Also confirm the shell path still works — this must not regress v2:
Run: `mongosh --nodb --quiet --eval "typeof db"`
Expected: prints `undefined`, proving the gate is meaningful.

- [ ] **Step 5: Commit**

```bash
git add indexStats.js test/skeleton.test.js
git commit -m "refactor: make indexStats.js loadable under node for testing"
```

---

### Task 2: Redundancy classification

**Files:**
- Modify: `indexStats.js` — replace `findRedundant` (lines 71-85) and extend the helpers above it
- Test: `test/redundancy.test.js`

**Interfaces:**
- Consumes: `isPlain(spec)` from Task 1.
- Produces:
  - `canonicalKeyString(key: object) => string` — e.g. `{a:1,b:-1}` becomes `[["a",1],["b",-1]]`.
  - `classifyRedundancy(specs: Array<{name, key, ...options}>, opsByName: {[name]: number}) => Map<string, {class: 'duplicate'|'prefix'|'subsumed', coveredBy: string}>`. Names absent from the map have no redundancy. `class` values are exactly these three strings; `mismatched` is *not* produced here — it comes from `mergeNodes` in Task 3.

Note on `duplicate`: modern MongoDB rejects two indexes with an identical key pattern under different names (`IndexOptionsConflict`), and the reachable same-key cases differ by collation or `partialFilterExpression`, which `isPlain` excludes. This class is a cheap defensive check that will rarely fire on a healthy server. That is expected, not a bug.

- [ ] **Step 1: Write the failing test**

```js
// test/redundancy.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalKeyString, classifyRedundancy } = require('../indexStats.js');

const noOps = {};

test('canonicalKeyString preserves key order and direction', () => {
  assert.equal(canonicalKeyString({ a: 1, b: -1 }), '[["a",1],["b",-1]]');
  assert.notEqual(canonicalKeyString({ a: 1, b: 1 }), canonicalKeyString({ b: 1, a: 1 }));
});

test('flags a compound prefix of a wider index', () => {
  const r = classifyRedundancy([
    { name: 'a_1_b_1', key: { a: 1, b: 1 } },
    { name: 'a_1_b_1_c_1', key: { a: 1, b: 1, c: 1 } },
  ], noOps);
  assert.deepEqual(r.get('a_1_b_1'), { class: 'prefix', coveredBy: 'a_1_b_1_c_1' });
  assert.equal(r.has('a_1_b_1_c_1'), false);
});

test('does not flag a prefix whose direction differs', () => {
  const r = classifyRedundancy([
    { name: 'a_1_b_1', key: { a: 1, b: 1 } },
    { name: 'a_1_b_-1_c_1', key: { a: 1, b: -1, c: 1 } },
  ], noOps);
  assert.equal(r.has('a_1_b_1'), false);
});

test('flags a single-field index regardless of direction', () => {
  const r = classifyRedundancy([
    { name: 'a_-1', key: { a: -1 } },
    { name: 'a_1_b_1', key: { a: 1, b: 1 } },
  ], noOps);
  assert.deepEqual(r.get('a_-1'), { class: 'subsumed', coveredBy: 'a_1_b_1' });
});

test('never flags _id_ or indexes with special semantics', () => {
  const specs = [
    { name: '_id_', key: { _id: 1 } },
    { name: 'a_1', key: { a: 1 }, unique: true },
    { name: 'b_1', key: { b: 1 }, expireAfterSeconds: 60 },
    { name: 'c_1', key: { c: 1 }, partialFilterExpression: { c: { $gt: 1 } } },
    { name: 'd_1', key: { d: 1 }, sparse: true },
    { name: 'e_1', key: { e: 1 }, collation: { locale: 'fr' } },
    { name: 'f_text', key: { _fts: 'text', _ftsx: 1 }, weights: { f: 1 } },
    { name: 'g_hashed', key: { g: 'hashed' } },
    { name: 'wide', key: { _id: 1, a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1 } },
  ];
  const r = classifyRedundancy(specs, noOps);
  assert.equal(r.size, 0);
});

test('duplicate keeps the more used index and reports the other', () => {
  const r = classifyRedundancy([
    { name: 'a_1', key: { a: 1 } },
    { name: 'custom_name', key: { a: 1 } },
  ], { a_1: 0, custom_name: 500 });
  assert.deepEqual(r.get('a_1'), { class: 'duplicate', coveredBy: 'custom_name' });
  assert.equal(r.has('custom_name'), false);
});

test('duplicate with equal usage keeps the generated-name index', () => {
  const r = classifyRedundancy([
    { name: 'a_1', key: { a: 1 } },
    { name: 'zzz', key: { a: 1 } },
  ], { a_1: 0, zzz: 0 });
  assert.deepEqual(r.get('zzz'), { class: 'duplicate', coveredBy: 'a_1' });
});

test('an index is reported once, duplicate taking precedence over prefix', () => {
  const r = classifyRedundancy([
    { name: 'a_1', key: { a: 1 } },
    { name: 'dup', key: { a: 1 } },
    { name: 'a_1_b_1', key: { a: 1, b: 1 } },
  ], { a_1: 10, dup: 0, a_1_b_1: 0 });
  assert.equal(r.get('dup').class, 'duplicate');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/redundancy.test.js`
Expected: FAIL with `TypeError: canonicalKeyString is not a function`.

- [ ] **Step 3: Write minimal implementation**

Replace `findRedundant` with:

```js
  function canonicalKeyString(key) {
    return JSON.stringify(Object.entries(key));
  }

  function generatedName(key) {
    return Object.entries(key).map(([f, d]) => `${f}_${d}`).join('_');
  }

  function isStrictPrefix(shorter, longer) {
    if (shorter.length >= longer.length) return false;
    if (shorter.length === 1) return shorter[0][0] === longer[0][0];
    return shorter.every(([f, d], i) => longer[i][0] === f && longer[i][1] === d);
  }

  function classifyRedundancy(specs, opsByName) {
    const plain = specs.filter(isPlain).map((s) => ({
      name: s.name,
      key: s.key,
      keys: Object.entries(s.key),
      canon: canonicalKeyString(s.key),
      ops: Number(opsByName?.[s.name] ?? 0),
    }));
    const result = new Map();

    const byCanon = new Map();
    for (const idx of plain) {
      if (!byCanon.has(idx.canon)) byCanon.set(idx.canon, []);
      byCanon.get(idx.canon).push(idx);
    }
    for (const group of byCanon.values()) {
      if (group.length < 2) continue;
      const survivor = [...group].sort((a, b) => {
        if (b.ops !== a.ops) return b.ops - a.ops;
        const ag = a.name === generatedName(a.key) ? 0 : 1;
        const bg = b.name === generatedName(b.key) ? 0 : 1;
        if (ag !== bg) return ag - bg;
        return a.name.localeCompare(b.name);
      })[0];
      for (const idx of group) {
        if (idx.name !== survivor.name) {
          result.set(idx.name, { class: 'duplicate', coveredBy: survivor.name });
        }
      }
    }

    for (const a of plain) {
      if (result.has(a.name)) continue;
      for (const b of plain) {
        if (a.name === b.name || a.canon === b.canon) continue;
        if (isStrictPrefix(a.keys, b.keys)) {
          result.set(a.name, {
            class: a.keys.length === 1 && b.keys.length > 1 ? 'subsumed' : 'prefix',
            coveredBy: b.name,
          });
          break;
        }
      }
    }
    return result;
  }
```

Extend `SPECIAL_OPTIONS` to also exclude `hidden`, then add to `api`: `canonicalKeyString`, `generatedName`, `isStrictPrefix`, `classifyRedundancy`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add indexStats.js test/redundancy.test.js
git commit -m "feat: classify index redundancy into duplicate, prefix and subsumed"
```

---

### Task 3: Cross-node merge

**Files:**
- Modify: `indexStats.js` — add `mergeNodes` after `classifyRedundancy`
- Test: `test/merge.test.js`

**Interfaces:**
- Consumes: `classifyRedundancy`, `canonicalKeyString` from Task 2.
- Produces: `mergeNodes({ members, nodeResults, samples, now }) => payload`.

Input shapes, exactly:

```js
member     = { id, host, role: 'primary'|'secondary'|'unknown', hidden, delaySecs, votes, reachable, error }
nodeResult = { host, namespaces: [ns], collections: { [ns]: {
                 indexes: [{ name, key, ...options }],
                 usage:   { [name]: { ops, since } },
                 storage: { [name]: { sizeBytes, reusableBytes, cacheBytes } },
                 error } },
               skipped: [{ ns, reason }] }
sample     = { ns, member, size, paths, multikeyPaths, validator, error }   // Task 4 shape
```

Output payload (the spec's data model), where each `indexes[]` entry carries `ns, name, key, options, hidden, perNode, maxOps, minCounterAgeDays, clusterSizeBytes, perMemberSizeBytes, redundancy, definition` — but **not** `verdict`, `flags`, `reasons` or `schema`, which Tasks 4 and 5 add.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/merge.test.js`
Expected: FAIL with `TypeError: mergeNodes is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
  function mergeNodes({ members, nodeResults, samples, now }) {
    const at = now instanceof Date ? now : new Date();
    const byHost = new Map(nodeResults.map((r) => [r.host, r]));
    const reachable = members.filter((m) => m.reachable);
    const skipped = [];
    const nsPresence = new Map();

    for (const r of nodeResults) {
      for (const ns of r.namespaces) {
        if (!nsPresence.has(ns)) nsPresence.set(ns, []);
        nsPresence.get(ns).push(r.host);
      }
      for (const s of r.skipped) skipped.push({ member: r.host, ns: s.ns, reason: s.reason });
      for (const [ns, coll] of Object.entries(r.collections)) {
        if (coll.error) skipped.push({ member: r.host, ns, reason: coll.error });
      }
    }

    const indexes = [];
    for (const [ns, presentOn] of nsPresence) {
      const names = new Set();
      for (const host of presentOn) {
        for (const spec of byHost.get(host).collections[ns]?.indexes ?? []) names.add(spec.name);
      }

      const specsForRedundancy = [];
      const opsByName = {};
      const built = [];

      for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
        const perNode = [];
        const variants = new Map();
        const missingOn = [];
        let maxOps = 0;
        let minAge = Infinity;
        let clusterSize = 0;
        let firstSpec = null;

        for (const m of reachable) {
          const coll = byHost.get(m.host)?.collections[ns];
          const spec = coll?.indexes?.find((s) => s.name === name);
          if (!coll || !spec) {
            if (coll && !coll.error) missingOn.push(m.host);
            perNode.push({ host: m.host, present: false, ops: null, since: null,
                           counterAgeDays: null, sizeBytes: 0, reusableBytes: 0,
                           cacheBytes: 0, error: coll?.error ?? null });
            continue;
          }
          firstSpec = firstSpec ?? spec;
          const canon = canonicalKeyString(spec.key);
          if (!variants.has(canon)) variants.set(canon, { key: spec.key, hosts: [] });
          variants.get(canon).hosts.push(m.host);

          const use = coll.usage[name] ?? { ops: 0, since: at };
          const store = coll.storage[name] ?? { sizeBytes: 0, reusableBytes: 0, cacheBytes: 0 };
          const ops = Number(use.ops ?? 0);
          const since = use.since instanceof Date ? use.since : new Date(use.since);
          const ageDays = (at.getTime() - since.getTime()) / 86400000;

          maxOps = Math.max(maxOps, ops);
          minAge = Math.min(minAge, ageDays);
          clusterSize += store.sizeBytes;
          perNode.push({ host: m.host, present: true, ops, since,
                         counterAgeDays: ageDays, sizeBytes: store.sizeBytes,
                         reusableBytes: store.reusableBytes,
                         cacheBytes: store.cacheBytes, error: null });
        }

        const presentNodes = perNode.filter((n) => n.present);
        const { name: _n, key: _k, v: _v, ns: _ns, ...options } = firstSpec ?? { key: {} };
        built.push({
          ns, name,
          key: firstSpec?.key ?? {},
          options,
          hidden: Boolean(firstSpec?.hidden),
          perNode, maxOps,
          minCounterAgeDays: minAge === Infinity ? null : minAge,
          clusterSizeBytes: clusterSize,
          perMemberSizeBytes: presentNodes.length
            ? Math.round(clusterSize / presentNodes.length) : 0,
          redundancy: { class: null, coveredBy: null },
          definition: {
            consistent: missingOn.length === 0 && variants.size <= 1,
            missingOn,
            variants: [...variants.values()],
          },
        });
        if (firstSpec) specsForRedundancy.push(firstSpec);
        opsByName[name] = maxOps;
      }

      const red = classifyRedundancy(specsForRedundancy, opsByName);
      for (const idx of built) {
        if (red.has(idx.name)) idx.redundancy = red.get(idx.name);
        indexes.push(idx);
      }
    }

    return {
      members,
      gaps: {
        unreachableMembers: members.filter((m) => !m.reachable)
          .map((m) => ({ host: m.host, error: m.error })),
        skipped,
      },
      namespaces: [...nsPresence.entries()].map(([ns, presentOn]) => {
        const sample = samples.find((s) => s.ns === ns) ?? null;
        return {
          ns, db: ns.split('.')[0], coll: ns.split('.').slice(1).join('.'),
          presentOn,
          hasValidator: Boolean(sample?.validator),
          sample: sample ? { size: sample.size, member: sample.member } : null,
        };
      }),
      indexes,
    };
  }
```

Add `mergeNodes` to `api`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add indexStats.js test/merge.test.js
git commit -m "feat: merge per-member index statistics into one payload"
```

---

### Task 4: Schema and index consistency checks

**Files:**
- Modify: `indexStats.js` — add the schema helpers after `mergeNodes`
- Test: `test/schema.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `bsonTypeOf(value) => string`
  - `flattenPaths(doc, out = {}, prefix = '', depth = 0) => { [path]: { types: string[], multikey: boolean } }` — shape of ONE document.
  - `profileSample(docs: object[]) => { size, paths: { [path]: { count, types, multikey } } }` — presence counted once per document.
  - `keyFieldsOf(spec) => string[]` — dotted index key paths; `_fts`/`_ftsx` replaced by `weights` keys, `$**` paths skipped.
  - `validatorPaths(validator) => { props: string[], closed: boolean } | null`
  - `classifySchemaIssues(spec, sample, config) => Array<{ field, presence, sampleSize, types, multikey, inValidator, issue, provable, text }>` where `issue` is one of `absent`, `low-presence`, `mixed-types`, `unexpected-multikey`, `not-in-validator`, and `text` is the evidentiary sentence shown in the report.

- [ ] **Step 1: Write the failing test**

```js
// test/schema.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { flattenPaths, profileSample, keyFieldsOf, validatorPaths,
        classifySchemaIssues } = require('../indexStats.js');

const CONFIG = { LOW_PRESENCE: 0.10 };

test('flattenPaths walks nested objects and arrays of objects', () => {
  const p = flattenPaths({ a: 1, b: { c: 'x' }, d: [{ e: true }] });
  assert.deepEqual(Object.keys(p).sort(), ['a', 'b', 'b.c', 'd', 'd.e']);
  assert.equal(p.d.multikey, true);
  assert.deepEqual(p['b.c'].types, ['string']);
});

test('flattenPaths treats dates as scalars, not objects', () => {
  const p = flattenPaths({ at: new Date() });
  assert.deepEqual(Object.keys(p), ['at']);
  assert.deepEqual(p.at.types, ['date']);
});

test('profileSample counts a path once per document', () => {
  const s = profileSample([{ a: [1, 1, 1] }, { b: 2 }]);
  assert.equal(s.size, 2);
  assert.equal(s.paths.a.count, 1);
  assert.equal(s.paths.b.count, 1);
});

test('keyFieldsOf uses weights for text indexes and skips wildcards', () => {
  assert.deepEqual(keyFieldsOf({ name: 'a_1', key: { a: 1 } }), ['a']);
  assert.deepEqual(keyFieldsOf({ name: 't', key: { _fts: 'text', _ftsx: 1 }, weights: { title: 1 } }), ['title']);
  assert.deepEqual(keyFieldsOf({ name: 'w', key: { '$**': 1 } }), []);
});

test('validatorPaths extracts nested properties and detects closed schemas', () => {
  const v = validatorPaths({ $jsonSchema: {
    additionalProperties: false,
    properties: { a: { bsonType: 'int' }, b: { bsonType: 'object', properties: { c: {} } } },
  } });
  assert.deepEqual(v.props.sort(), ['a', 'b', 'b.c']);
  assert.equal(v.closed, true);
});

test('a field absent from every sampled document is flagged, with evidence', () => {
  const sample = { size: 100, paths: { createdAt: { count: 100, types: ['date'], multikey: false } }, validator: null };
  const [issue] = classifySchemaIssues({ name: 'createdAT_1', key: { createdAT: 1 } }, sample, CONFIG);
  assert.equal(issue.issue, 'absent');
  assert.equal(issue.presence, 0);
  assert.match(issue.text, /absent from 100 of 100 sampled documents/);
});

test('a rarely present field is low-presence, not absent', () => {
  const sample = { size: 100, paths: { deletedAt: { count: 4, types: ['date'], multikey: false } }, validator: null };
  const [issue] = classifySchemaIssues({ name: 'deletedAt_1', key: { deletedAt: 1 } }, sample, CONFIG);
  assert.equal(issue.issue, 'low-presence');
});

test('a field present in most documents produces no issue', () => {
  const sample = { size: 100, paths: { a: { count: 99, types: ['int'], multikey: false } }, validator: null };
  assert.deepEqual(classifySchemaIssues({ name: 'a_1', key: { a: 1 } }, sample, CONFIG), []);
});

test('mixed bson types on an indexed field are flagged', () => {
  const sample = { size: 100, paths: { a: { count: 100, types: ['int', 'string'], multikey: false } }, validator: null };
  const issues = classifySchemaIssues({ name: 'a_1', key: { a: 1 } }, sample, CONFIG);
  assert.equal(issues.some((i) => i.issue === 'mixed-types'), true);
});

test('unexpected multikey is flagged', () => {
  const sample = { size: 100, paths: { tags: { count: 100, types: ['array'], multikey: true } }, validator: null };
  const issues = classifySchemaIssues({ name: 'tags_1', key: { tags: 1 } }, sample, CONFIG);
  assert.equal(issues.some((i) => i.issue === 'unexpected-multikey'), true);
});

test('not-in-validator is provable only for a closed schema', () => {
  const closed = { size: 0, paths: {}, validator: { props: ['a'], closed: true } };
  const open = { size: 0, paths: {}, validator: { props: ['a'], closed: false } };
  const spec = { name: 'b_1', key: { b: 1 } };
  assert.equal(classifySchemaIssues(spec, closed, CONFIG)[0].provable, true);
  assert.equal(classifySchemaIssues(spec, open, CONFIG)[0].provable, false);
});

test('no sample and no validator yields no issues', () => {
  const none = { size: 0, paths: {}, validator: null };
  assert.deepEqual(classifySchemaIssues({ name: 'a_1', key: { a: 1 } }, none, CONFIG), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/schema.test.js`
Expected: FAIL with `TypeError: flattenPaths is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
  const LOW_PRESENCE = 0.10;
  const MAX_SAMPLE_DEPTH = 8;

  function bsonTypeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (v instanceof Date) return 'date';
    if (v && v._bsontype) return String(v._bsontype).toLowerCase();
    if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
    return typeof v;
  }

  function isWalkable(v) {
    return v && typeof v === 'object' && !Array.isArray(v)
      && !(v instanceof Date) && !v._bsontype;
  }

  function flattenPaths(doc, out = {}, prefix = '', depth = 0) {
    if (depth > MAX_SAMPLE_DEPTH || !isWalkable(doc)) return out;
    for (const [k, v] of Object.entries(doc)) {
      const path = prefix ? `${prefix}.${k}` : k;
      const entry = out[path] ?? (out[path] = { types: [], multikey: false });
      const t = bsonTypeOf(v);
      if (!entry.types.includes(t)) entry.types.push(t);
      if (Array.isArray(v)) {
        entry.multikey = true;
        for (const el of v) flattenPaths(el, out, path, depth + 1);
      } else {
        flattenPaths(v, out, path, depth + 1);
      }
    }
    return out;
  }

  function profileSample(docs) {
    const paths = {};
    for (const doc of docs) {
      for (const [path, info] of Object.entries(flattenPaths(doc))) {
        const entry = paths[path] ?? (paths[path] = { count: 0, types: [], multikey: false });
        entry.count++;
        entry.multikey = entry.multikey || info.multikey;
        for (const t of info.types) if (!entry.types.includes(t)) entry.types.push(t);
      }
    }
    return { size: docs.length, paths };
  }

  function keyFieldsOf(spec) {
    const fields = Object.keys(spec.key ?? {});
    const out = [];
    for (const f of fields) {
      if (f === '_fts' || f === '_ftsx') {
        for (const w of Object.keys(spec.weights ?? {})) if (!out.includes(w)) out.push(w);
        continue;
      }
      if (f.includes('$**')) continue;
      out.push(f);
    }
    return out;
  }

  function validatorPaths(validator) {
    const schema = validator?.$jsonSchema;
    if (!schema) return null;
    const props = [];
    let closed = schema.additionalProperties === false;
    (function walk(node, prefix) {
      for (const [k, v] of Object.entries(node?.properties ?? {})) {
        const path = prefix ? `${prefix}.${k}` : k;
        props.push(path);
        if (v && v.properties) walk(v, path);
        if (v && v.items && v.items.properties) walk(v.items, path);
      }
    })(schema, '');
    return { props, closed };
  }

  function classifySchemaIssues(spec, sample, config) {
    const low = config?.LOW_PRESENCE ?? LOW_PRESENCE;
    const issues = [];
    for (const field of keyFieldsOf(spec)) {
      const info = sample.paths?.[field] ?? null;
      const size = sample.size ?? 0;
      const presence = size > 0 ? (info?.count ?? 0) / size : null;
      const base = { field, presence, sampleSize: size,
                     types: info?.types ?? [], multikey: Boolean(info?.multikey),
                     inValidator: sample.validator
                       ? sample.validator.props.includes(field) : null };

      if (size > 0 && presence === 0) {
        issues.push({ ...base, issue: 'absent', provable: false,
          text: `absent from ${size} of ${size} sampled documents on this collection` });
      } else if (size > 0 && presence < low) {
        issues.push({ ...base, issue: 'low-presence', provable: false,
          text: `present in ${info.count} of ${size} sampled documents (${(presence * 100).toFixed(0)}%) - a partial or sparse index would be smaller` });
      }
      if (info && info.types.filter((t) => t !== 'null').length > 1) {
        issues.push({ ...base, issue: 'mixed-types', provable: false,
          text: `holds more than one bson type across the sample: ${info.types.join(', ')}` });
      }
      if (info && info.multikey) {
        issues.push({ ...base, issue: 'unexpected-multikey', provable: false,
          text: 'indexed as multikey - the field holds an array in sampled documents' });
      }
      if (sample.validator && !sample.validator.props.includes(field)) {
        issues.push({ ...base, issue: 'not-in-validator',
          provable: sample.validator.closed,
          text: sample.validator.closed
            ? 'not declared in the collection validator, which forbids additional properties'
            : 'not declared in the collection validator (which permits additional properties, so this is advisory)' });
      }
    }
    return issues;
  }
```

Add all six functions plus `LOW_PRESENCE` to `api`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add indexStats.js test/schema.test.js
git commit -m "feat: detect index key fields that do not match documents or validator"
```

---

### Task 5: Verdict derivation

**Files:**
- Modify: `indexStats.js` — add `deriveVerdict` and `applyAnalysis` after the schema helpers
- Test: `test/verdict.test.js`

**Interfaces:**
- Consumes: payload `indexes[]` from Task 3, `classifySchemaIssues` from Task 4.
- Produces:
  - `deriveVerdict(idx, ctx) => { verdict, flags, reasons }` where `verdict` is one of `mismatched`, `keep`, `review`, `inconclusive`, `drop`, `likely-drop`, and `ctx = { config, hiddenHosts: string[], unreachableHosts: string[] }`.
  - `applyAnalysis(payload, config, samples) => payload` — attaches `schema`, `verdict`, `flags`, `reasons` to every index and sorts `payload.indexes` by drop confidence then `clusterSizeBytes` descending.
  - `VERDICT_ORDER = ['drop','likely-drop','review','inconclusive','mismatched','keep']`

- [ ] **Step 1: Write the failing test**

```js
// test/verdict.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/verdict.test.js`
Expected: FAIL with `TypeError: deriveVerdict is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
  const VERDICT_ORDER = ['drop', 'likely-drop', 'review', 'inconclusive', 'mismatched', 'keep'];

  function deriveVerdict(idx, ctx) {
    const flags = [];
    const reasons = [];
    if (idx.redundancy.class) flags.push(`redundant:${idx.redundancy.class}`);
    if (idx.hidden) flags.push('hidden');

    const suspect = (idx.schema?.checks ?? []).filter(
      (c) => c.issue === 'absent' || (c.issue === 'not-in-validator' && c.provable));
    if (suspect.length) {
      flags.push('suspect-field');
      reasons.push(`key field '${suspect[0].field}' ${suspect[0].text ?? 'does not match the documents'}`);
    }

    if (!idx.definition.consistent) {
      flags.push('mismatched');
      reasons.unshift(idx.definition.missingOn.length
        ? `definition missing on ${idx.definition.missingOn.join(', ')} - possible in-flight or stalled rolling index build`
        : 'key pattern differs between members - possible in-flight or stalled rolling index build');
      return { verdict: 'mismatched', flags, reasons };
    }

    if (idx.name === '_id_') {
      reasons.unshift('the _id_ index cannot be dropped');
      return { verdict: 'keep', flags, reasons };
    }

    if (idx.maxOps > 0) {
      const usedHosts = idx.perNode.filter((n) => n.present && n.ops > 0).map((n) => n.host);
      if (usedHosts.length && usedHosts.every((h) => ctx.hiddenHosts.includes(h))) {
        flags.push('used-only-on-hidden');
        reasons.unshift(`all ${idx.maxOps} observed operations came from hidden or delayed members (${usedHosts.join(', ')})`);
      } else {
        reasons.unshift(`${idx.maxOps} operations on ${usedHosts.join(', ')}`);
      }
      if (idx.redundancy.class) {
        reasons.push(`covered by '${idx.redundancy.coveredBy}', which can serve these reads`);
        return { verdict: 'review', flags, reasons };
      }
      return { verdict: 'keep', flags, reasons };
    }

    if (ctx.unreachableHosts.length) {
      reasons.unshift(`zero operations everywhere observed, but ${ctx.unreachableHosts.join(', ')} could not be reached - unused cannot be confirmed`);
      return { verdict: 'inconclusive', flags, reasons };
    }
    if (idx.minCounterAgeDays === null
        || idx.minCounterAgeDays < ctx.config.DROP_MIN_COUNTER_DAYS) {
      const age = idx.minCounterAgeDays === null ? 'unknown'
        : idx.minCounterAgeDays.toFixed(1);
      reasons.unshift(`zero operations, but the youngest counter is ${age} days old, under the ${ctx.config.DROP_MIN_COUNTER_DAYS}-day threshold - counters reset on mongod restart`);
      return { verdict: 'inconclusive', flags, reasons };
    }

    reasons.unshift(`zero operations on every data-bearing member for at least ${Math.floor(idx.minCounterAgeDays)} days`);
    if (idx.redundancy.class || suspect.length) {
      if (idx.redundancy.class) reasons.push(`covered by '${idx.redundancy.coveredBy}'`);
      return { verdict: 'drop', flags, reasons };
    }
    return { verdict: 'likely-drop', flags, reasons };
  }

  function applyAnalysis(payload, config, samples) {
    const hiddenHosts = payload.members.filter((m) => m.hidden).map((m) => m.host);
    const unreachableHosts = payload.gaps.unreachableMembers.map((m) => m.host);
    const sampleByNs = new Map((samples ?? []).map((s) => [s.ns, s]));

    for (const idx of payload.indexes) {
      const sample = sampleByNs.get(idx.ns);
      idx.schema = {
        checks: sample && !sample.error
          ? classifySchemaIssues({ name: idx.name, key: idx.key, ...idx.options },
              { size: sample.size, paths: sample.paths,
                validator: sample.validator }, config)
          : [],
      };
      Object.assign(idx, deriveVerdict(idx, { config, hiddenHosts, unreachableHosts }));
    }

    payload.indexes.sort((a, b) => {
      const d = VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict);
      return d !== 0 ? d : b.clusterSizeBytes - a.clusterSizeBytes;
    });
    return payload;
  }
```

Add `VERDICT_ORDER`, `deriveVerdict`, `applyAnalysis` to `api`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add indexStats.js test/verdict.test.js
git commit -m "feat: derive index verdicts with counter-age and reachability guards"
```

---

### Task 6: HTML shell — document, styles, payload embedding, summary

**Files:**
- Modify: `indexStats.js` — add the formatting helpers and `renderHTML` after `applyAnalysis`
- Test: `test/render.test.js`

**Interfaces:**
- Consumes: the analysed payload from Task 5.
- Produces:
  - `esc(value) => string` — HTML-escapes `&`, `<`, `>`, `"`.
  - `jsonForScript(obj) => string` — `JSON.stringify` with every `<` replaced by its unicode escape.
  - `fmtBytes(bytes) => string` — e.g. `1.2 gb`, `840.0 mb`, `0 b`. **Must be self-contained** (see Task 7).
  - `renderHTML(payload) => string` — a complete HTML document. This task renders everything except the index table, which Task 7 adds.

- [ ] **Step 1: Write the failing test**

```js
// test/render.test.js
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

test('labels a hidden member as hidden in the member strip', () => {
  assert.match(renderHTML(payload()), /hidden/);
});

test('lists skipped namespaces with their reason', () => {
  const html = renderHTML(payload());
  assert.match(html, /shop\.big/);
  assert.match(html, /MaxTimeMSExpired/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/render.test.js`
Expected: FAIL with `TypeError: renderHTML is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
  function esc(v) {
    return String(v).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function jsonForScript(obj) {
    return JSON.stringify(obj).replace(/</g, '\\u003c');
  }

  function fmtBytes(bytes) {
    var b = Number(bytes || 0);
    if (b < 1024) return b.toFixed(0) + ' b';
    var units = ['kb', 'mb', 'gb', 'tb'];
    var i = -1;
    do { b = b / 1024; i++; } while (b >= 1024 && i < units.length - 1);
    return b.toFixed(1) + ' ' + units[i];
  }
```

Then the stylesheet, as a single template literal constant `REPORT_CSS`. Keep it flat and legible in both colour schemes:

```js
  const REPORT_CSS = `
:root{--bg:#fff;--card:#f7f7f5;--fg:#1a1a19;--muted:#6b6b68;--line:#e3e3e0;
--danger:#b3261e;--dangerbg:#fdecea;--warn:#8a5300;--warnbg:#fdf3e3;
--accent:#1a56a8;--accentbg:#eaf1fb;--ok:#1e6b3a}
@media(prefers-color-scheme:dark){:root{--bg:#191918;--card:#232322;--fg:#ececeb;
--muted:#a1a19d;--line:#33332f;--danger:#f2857c;--dangerbg:#3a1f1c;--warn:#e0ac5c;
--warnbg:#332715;--accent:#8fb6f0;--accentbg:#1b2740;--ok:#7fc79b}}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:var(--bg);color:var(--fg);
font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
h1{font-size:20px;font-weight:500;margin:0}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.muted{color:var(--muted)}
.wrap{max-width:1200px;margin:0 auto}
.head{display:flex;justify-content:space-between;align-items:baseline;
border-bottom:1px solid var(--line);padding-bottom:12px}
.banner{margin-top:12px;padding:10px 12px;border-radius:8px;
background:var(--warnbg);color:var(--warn);border:1px solid var(--warn)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:16px}
.card{background:var(--card);border-radius:8px;padding:12px 14px}
.card .k{font-size:12px;color:var(--muted)}
.card .v{font-size:24px;font-weight:500;margin-top:2px}
.members{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin-top:12px}
.member{background:var(--card);border-left:3px solid var(--muted);padding:8px 10px;font-size:13px}
.member.pri{border-left-color:var(--ok)}
.member.sec{border-left-color:var(--accent)}
.member.hid{border-left-color:var(--warn)}
.member.down{border-left-color:var(--danger);color:var(--danger)}
.controls{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:20px}
.chip{font-size:13px;border:1px solid var(--line);border-radius:999px;padding:3px 10px;
background:none;color:var(--muted);cursor:pointer}
.chip.on{border-color:var(--fg);color:var(--fg)}
.chip.drop.on{border-color:var(--danger);color:var(--danger);background:var(--dangerbg)}
input[type=search]{padding:6px 10px;border:1px solid var(--line);border-radius:8px;
background:var(--bg);color:var(--fg);min-width:220px}
button.act{padding:6px 10px;border:1px solid var(--line);border-radius:8px;
background:var(--bg);color:var(--fg);cursor:pointer}
table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}
th{text-align:left;font-weight:400;color:var(--muted);border-bottom:1px solid var(--line);
padding:6px 4px;cursor:pointer;white-space:nowrap}
td{padding:8px 4px;border-bottom:1px solid var(--line);vertical-align:top}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
tr.idx{cursor:pointer}
tr.idx:hover td{background:var(--card)}
.tag{display:inline-block;border-radius:6px;padding:1px 7px;font-size:12px}
.tag.drop,.tag.likely-drop{background:var(--dangerbg);color:var(--danger)}
.tag.inconclusive,.tag.review{background:var(--warnbg);color:var(--warn)}
.tag.mismatched{background:var(--card);color:var(--fg)}
.tag.keep{background:var(--accentbg);color:var(--accent)}
.detail{background:var(--card)}
.detail table{margin:0}
.detail td,.detail th{border-bottom:none;padding:3px 4px}
details{margin-top:24px}
summary{cursor:pointer;color:var(--muted)}
pre{overflow:auto;background:var(--card);padding:12px;border-radius:8px;font-size:12px}
`;
```

Then the server-rendered sections:

```js
  function renderMembers(members) {
    return members.map((m) => {
      const cls = !m.reachable ? 'down' : m.hidden ? 'hid'
        : m.role === 'primary' ? 'pri' : 'sec';
      const bits = [esc(m.role)];
      if (m.hidden) bits.push('hidden');
      if (m.delaySecs) bits.push(`delayed ${m.delaySecs}s`);
      const label = !m.reachable
        ? `unreachable - ${esc(m.error ?? 'unknown error')}`
        : bits.join(' / ');
      return `<div class="member ${cls}"><div class="mono">${esc(m.host)}</div>`
        + `<div class="muted">${label}</div></div>`;
    }).join('');
  }

  function renderGapBanner(payload) {
    const down = payload.gaps.unreachableMembers;
    if (down.length === 0) return '';
    const hosts = down.map((d) => esc(d.host)).join(', ');
    return `<div class="banner" id="gap-banner">${down.length} member`
      + `${down.length > 1 ? 's' : ''} unreachable (${hosts}) - no index can be `
      + 'confirmed unused, so zero-operation verdicts are downgraded to inconclusive</div>';
  }

  function renderGapsPanel(payload) {
    const total = payload.gaps.skipped.length + payload.gaps.unreachableMembers.length;
    if (total === 0) return '';
    const rows = [
      ...payload.gaps.unreachableMembers.map((m) =>
        `<tr><td class="mono">${esc(m.host)}</td><td>member unreachable</td>`
        + `<td>${esc(m.error ?? '')}</td></tr>`),
      ...payload.gaps.skipped.map((s) =>
        `<tr><td class="mono">${esc(s.member)}</td><td class="mono">${esc(s.ns)}</td>`
        + `<td>${esc(s.reason)}</td></tr>`),
    ].join('');
    return `<details><summary>gaps in this report (${total})</summary>`
      + '<table><thead><tr><th>member</th><th>namespace</th><th>reason</th></tr></thead>'
      + `<tbody>${rows}</tbody></table></details>`;
  }

  function renderHTML(payload) {
    const dbCount = new Set(payload.namespaces.map((n) => n.db)).size;
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>index report - ${esc(payload.meta.replicaSetName)}</title>
<style>${REPORT_CSS}</style></head>
<body><div class="wrap">
<div class="head">
<div><h1>${esc(payload.meta.replicaSetName)}</h1>
<div class="muted mono">${payload.members.length} members / ${dbCount} databases / ${payload.namespaces.length} collections / ${payload.indexes.length} indexes</div></div>
<div class="muted">${esc(payload.meta.generatedAt)}</div>
</div>
${renderGapBanner(payload)}
<div class="cards" id="cards"></div>
<div class="members">${renderMembers(payload.members)}</div>
<div class="controls" id="controls"></div>
<div id="table-host"></div>
${renderGapsPanel(payload)}
<details><summary>raw payload (json)</summary><pre id="raw"></pre></details>
</div>
<script type="application/json" id="indexstats-data">${jsonForScript(payload)}</script>
</body></html>`;
  }
```

Add `esc`, `jsonForScript`, `fmtBytes`, `renderHTML` to `api`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add indexStats.js test/render.test.js && git commit -m "feat: render self-contained html report shell with embedded payload"
```

---

### Task 7: HTML table, filters, sorting and drop commands

The interactive half. The functions the browser runs are defined **in `indexStats.js` as normal functions**, unit-tested under Node, and serialised into the report with `Function.prototype.toString()`. One hard constraint follows: these functions must be **entirely self-contained** — no closure over the enclosing IIFE, since `toString()` drops the closure. They take what they need as arguments and use `var` internally.

**Files:**
- Modify: `indexStats.js` — add the client functions, `CLIENT_BOOTSTRAP`, and extend `renderHTML` to emit them
- Test: `test/render.test.js` (extend)

**Interfaces:**
- Consumes: `fmtBytes`, `esc`, `renderHTML` from Task 6.
- Produces:
  - `selectIndexes(indexes, state) => indexes[]` where `state = { filter, search, sortKey, sortDir }`; `filter` is `'all'`, a verdict, or a flag prefix such as `'redundant'`; `sortKey` is `'size' | 'ops' | 'age' | 'ns'`; `sortDir` is `1` or `-1`.
  - `summarise(indexes) => { reclaimable, drop, inconclusive, redundant }`
  - `dropCommandsFor(indexes) => string` — newline-separated mongosh statements.
  - `CLIENT_FUNCTIONS` — serialised source of those three plus `fmtBytes`.

- [ ] **Step 1: Write the failing test**

```js
// append to test/render.test.js
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

test('dropCommandsFor never emits commands for non-candidates', () => {
  const cmds = dropCommandsFor([ix({ verdict: 'keep' }), ix({ verdict: 'inconclusive' }),
                                ix({ verdict: 'mismatched' }), ix({ verdict: 'review' })]);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/render.test.js`
Expected: FAIL with `TypeError: selectIndexes is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
  function selectIndexes(indexes, state) {
    var q = (state.search || '').toLowerCase();
    var rows = indexes.filter(function (i) {
      var byFilter = state.filter === 'all'
        || i.verdict === state.filter
        || (i.flags || []).some(function (f) {
             return f === state.filter || f.indexOf(state.filter + ':') === 0;
           });
      var bySearch = !q
        || i.ns.toLowerCase().indexOf(q) !== -1
        || i.name.toLowerCase().indexOf(q) !== -1;
      return byFilter && bySearch;
    });
    var key = state.sortKey;
    var dir = state.sortDir;
    return rows.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'ops') { av = a.maxOps; bv = b.maxOps; }
      else if (key === 'age') { av = a.minCounterAgeDays || 0; bv = b.minCounterAgeDays || 0; }
      else if (key === 'ns') { return dir * (a.ns + a.name).localeCompare(b.ns + b.name); }
      else { av = a.clusterSizeBytes; bv = b.clusterSizeBytes; }
      return dir * (av - bv);
    });
  }

  function summarise(indexes) {
    var out = { reclaimable: 0, drop: 0, inconclusive: 0, redundant: 0 };
    indexes.forEach(function (i) {
      if (i.verdict === 'drop' || i.verdict === 'likely-drop') {
        out.drop++;
        out.reclaimable += i.clusterSizeBytes;
      }
      if (i.verdict === 'inconclusive') out.inconclusive++;
      if ((i.flags || []).some(function (f) { return f.indexOf('redundant') === 0; })) out.redundant++;
    });
    return out;
  }

  function dropCommandsFor(indexes) {
    var byNs = {};
    indexes.forEach(function (i) {
      if (i.verdict !== 'drop' && i.verdict !== 'likely-drop') return;
      (byNs[i.ns] = byNs[i.ns] || []).push(i.name);
    });
    return Object.keys(byNs).sort().map(function (ns) {
      var dbName = ns.split('.')[0];
      var collName = ns.split('.').slice(1).join('.');
      var names = byNs[ns].map(function (n) { return '"' + n + '"'; }).join(',');
      return 'db.getSiblingDB("' + dbName + '").getCollection("' + collName
        + '").dropIndexes([' + names + '])';
    }).join('\n');
  }

  const CLIENT_FUNCTIONS = [fmtBytes, selectIndexes, summarise, dropCommandsFor]
    .map((f) => f.toString()).join('\n');
```

The bootstrap, as a template literal. It runs in the browser, so it is `var`-and-`function` only:

```js
  const CLIENT_BOOTSTRAP = `
var DATA = JSON.parse(document.getElementById('indexstats-data').textContent);
var STATE = { filter: 'all', search: '', sortKey: 'size', sortDir: -1 };
var FILTERS = ['all','drop','likely-drop','inconclusive','review','mismatched','keep',
               'redundant','suspect-field','used-only-on-hidden'];
function h(s){return String(s).replace(/[&<>"]/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function countFor(f){return f==='all'?DATA.indexes.length:
  selectIndexes(DATA.indexes,{filter:f,search:'',sortKey:'size',sortDir:-1}).length;}
function renderControls(){
  var html = FILTERS.filter(function(f){return f==='all'||countFor(f)>0;}).map(function(f){
    return '<button class="chip '+f+(STATE.filter===f?' on':'')+'" data-f="'+f+'">'+f+' '+countFor(f)+'</button>';
  }).join('');
  html += '<input type="search" id="q" placeholder="filter by namespace or index name" value="'+h(STATE.search)+'">';
  html += '<button class="act" id="copy">copy dropIndexes commands</button>';
  var el = document.getElementById('controls');
  el.innerHTML = html;
  el.querySelectorAll('.chip').forEach(function(b){
    b.onclick = function(){ STATE.filter = b.dataset.f; draw(); };
  });
  var q = document.getElementById('q');
  q.oninput = function(){ STATE.search = q.value; drawTable(); drawCards(); };
  document.getElementById('copy').onclick = function(){
    var cmds = dropCommandsFor(selectIndexes(DATA.indexes, STATE));
    var btn = document.getElementById('copy');
    navigator.clipboard.writeText(cmds).then(function(){
      btn.textContent = cmds ? 'copied' : 'nothing to copy';
      setTimeout(renderControls, 1500);
    }, function(){ btn.textContent = 'clipboard blocked - see raw payload'; });
  };
}
function drawCards(){
  var s = summarise(selectIndexes(DATA.indexes, STATE));
  document.getElementById('cards').innerHTML =
    '<div class="card"><div class="k">reclaimable, cluster</div><div class="v">'+fmtBytes(s.reclaimable)+'</div></div>'+
    '<div class="card"><div class="k">drop candidates</div><div class="v">'+s.drop+'</div></div>'+
    '<div class="card"><div class="k">inconclusive</div><div class="v">'+s.inconclusive+'</div></div>'+
    '<div class="card"><div class="k">redundant</div><div class="v">'+s.redundant+'</div></div>';
}
function nodeRows(i){
  return i.perNode.map(function(n){
    if(!n.present) return '<tr><td class="mono">'+h(n.host)+'</td><td colspan="4" class="muted">index not present'+(n.error?' - '+h(n.error):'')+'</td></tr>';
    return '<tr><td class="mono">'+h(n.host)+'</td><td class="num">'+n.ops+'</td><td class="num">'+
      (n.counterAgeDays===null?'-':n.counterAgeDays.toFixed(1)+' d')+'</td><td class="num">'+
      fmtBytes(n.sizeBytes)+'</td><td class="num">'+fmtBytes(n.reusableBytes)+'</td></tr>';
  }).join('');
}
function detailFor(i){
  var parts = '<div class="muted">'+h(JSON.stringify(i.key))+
    (i.redundancy.coveredBy?' - covered by '+h(i.redundancy.coveredBy):'')+'</div>';
  if(i.reasons && i.reasons.length) parts += '<ul class="muted">'+i.reasons.map(function(r){
    return '<li>'+h(r)+'</li>';}).join('')+'</ul>';
  if(i.schema && i.schema.checks.length) parts += '<ul class="muted">'+i.schema.checks.map(function(c){
    return '<li>key field <span class="mono">'+h(c.field)+'</span>: '+h(c.text)+'</li>';}).join('')+'</ul>';
  parts += '<table><thead><tr><th>member</th><th class="num">ops</th><th class="num">counter age</th>'+
    '<th class="num">size</th><th class="num">reusable</th></tr></thead><tbody>'+nodeRows(i)+'</tbody></table>';
  return parts;
}
function drawTable(){
  var rows = selectIndexes(DATA.indexes, STATE);
  var head = '<table><thead><tr><th data-s="ns">namespace and index</th><th>verdict</th>'+
    '<th class="num" data-s="ops">ops, max</th><th class="num" data-s="age">counter age</th>'+
    '<th class="num" data-s="size">cluster size</th></tr></thead><tbody>';
  var body = rows.map(function(i,n){
    return '<tr class="idx" data-n="'+n+'"><td><span class="mono">'+h(i.ns)+
      '</span><div class="mono muted">'+h(i.name)+'</div></td>'+
      '<td><span class="tag '+i.verdict+'">'+i.verdict+'</span>'+
      (i.flags.length?'<div class="muted">'+h(i.flags.join(', '))+'</div>':'')+'</td>'+
      '<td class="num">'+i.maxOps+'</td>'+
      '<td class="num">'+(i.minCounterAgeDays===null?'-':i.minCounterAgeDays.toFixed(0)+' d')+'</td>'+
      '<td class="num">'+fmtBytes(i.clusterSizeBytes)+'</td></tr>'+
      '<tr class="detail" id="d'+n+'" hidden><td colspan="5">'+detailFor(i)+'</td></tr>';
  }).join('');
  document.getElementById('table-host').innerHTML = head + body + '</tbody></table>';
  document.querySelectorAll('#table-host th[data-s]').forEach(function(th){
    th.onclick = function(){
      var k = th.dataset.s;
      STATE.sortDir = STATE.sortKey === k ? -STATE.sortDir : -1;
      STATE.sortKey = k;
      drawTable();
    };
  });
  document.querySelectorAll('tr.idx').forEach(function(tr){
    tr.onclick = function(){
      var d = document.getElementById('d' + tr.dataset.n);
      d.hidden = !d.hidden;
    };
  });
}
function draw(){ renderControls(); drawCards(); drawTable(); }
document.getElementById('raw').textContent = JSON.stringify(DATA, null, 2);
draw();
`;
```

In `renderHTML`, directly after the payload script tag and before `</body>`:

```js
<script>${CLIENT_FUNCTIONS}
${CLIENT_BOOTSTRAP}</script>
```

Add `selectIndexes`, `summarise`, `dropCommandsFor` to `api`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/`
Expected: PASS, all tests.

Then look at the real thing — unit tests cannot see a broken layout. Create `test/fixtures/payload.json` from the `payload()` helper in `test/render.test.js`, extended to roughly eight indexes covering every verdict so each tag colour is exercised, then:

```bash
node -e 'const S=require("./indexStats.js"),fs=require("fs");fs.writeFileSync("/tmp/preview.html",S.renderHTML(JSON.parse(fs.readFileSync("test/fixtures/payload.json","utf8"))));'
```

```bash
open /tmp/preview.html
```

Confirm in the browser: chips filter and their counts are right, columns sort both ways, a row expands to per-node detail, the copy button reports success, and dark mode is legible (toggle your OS appearance).

- [ ] **Step 5: Commit**

```bash
git add indexStats.js test/render.test.js test/fixtures/payload.json && git commit -m "feat: add interactive filtering, sorting and dropIndexes export to report"
```

---

### Task 8: Live layer — capability probe, member discovery, per-member collection

The first task that talks to a server. Verified end to end in Task 11; here the tests use fake connection objects, so no server is needed.

**Files:**
- Modify: `indexStats.js` — add the live functions after the config block, before the pure helpers
- Test: `test/live.test.js`

**Interfaces:**
- Consumes: nothing from the pure layer.
- Produces:
  - `probeCapabilities({ requireFn, MongoCtor, seedHost }) => { canWriteFiles, canOpenConnections, fs }`
  - `uriFor(template, host) => string` — substitutes `{host}`; throws an `Error` mentioning `{host}` when the placeholder is missing.
  - `discoverMembers(adminDb, config) => { replicaSetName, members, mode }` where `mode` is `'multi-node'` or `'single-node'`. Throws when `hello().msg === 'isdbgrid'`.
  - `collectFromNode(conn, config) => nodeResult` — exactly the Task 3 input shape.

- [ ] **Step 1: Write the failing test**

```js
// test/live.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { probeCapabilities, uriFor, discoverMembers, collectFromNode } = require('../indexStats.js');

const CONFIG = { EXCLUDED_DBS: ['admin', 'config', 'local'], MAX_TIME_MS: 30000, INCLUDE_HIDDEN: true };

test('uriFor substitutes the host placeholder', () => {
  assert.equal(uriFor('mongodb://u:p@{host}/?directConnection=true', 'h1:27017'),
    'mongodb://u:p@h1:27017/?directConnection=true');
});

test('uriFor rejects a template without the placeholder', () => {
  assert.throws(() => uriFor('mongodb://h1:27017/', 'h2:27017'), /\{host\}/);
});

test('probeCapabilities reports false when both probes throw', () => {
  const caps = probeCapabilities({
    requireFn: () => { throw new Error('not available'); },
    MongoCtor: function () { throw new Error('forbidden'); },
    seedHost: 'h1:27017',
  });
  assert.deepEqual({ w: caps.canWriteFiles, c: caps.canOpenConnections }, { w: false, c: false });
});

test('probeCapabilities reports true when both succeed', () => {
  const caps = probeCapabilities({
    requireFn: () => ({ writeFileSync() {} }),
    MongoCtor: function () { return {}; },
    seedHost: 'h1:27017',
  });
  assert.deepEqual({ w: caps.canWriteFiles, c: caps.canOpenConnections }, { w: true, c: true });
});

function fakeAdmin(rsConfig, helloMsg) {
  return {
    runCommand(cmd) {
      if (cmd.hello) return helloMsg ? { msg: helloMsg } : { ok: 1 };
      if (cmd.replSetGetConfig) {
        if (!rsConfig) {
          const e = new Error('not running with --replSet');
          e.codeName = 'NoReplicationEnabled';
          throw e;
        }
        return { config: rsConfig };
      }
      throw new Error('unexpected command ' + JSON.stringify(cmd));
    },
  };
}

test('refuses to run against a mongos', () => {
  assert.throws(() => discoverMembers(fakeAdmin(null, 'isdbgrid'), CONFIG), /sharded/i);
});

test('drops arbiters and keeps hidden members', () => {
  const { members, replicaSetName, mode } = discoverMembers(fakeAdmin({
    _id: 'rs0',
    members: [
      { _id: 0, host: 'h1:27017' },
      { _id: 1, host: 'h2:27017', hidden: true, priority: 0, secondaryDelaySecs: 60 },
      { _id: 2, host: 'h3:27017', arbiterOnly: true },
    ],
  }), CONFIG);
  assert.equal(replicaSetName, 'rs0');
  assert.equal(mode, 'multi-node');
  assert.deepEqual(members.map((m) => m.host), ['h1:27017', 'h2:27017']);
  assert.equal(members[1].hidden, true);
  assert.equal(members[1].delaySecs, 60);
});

test('excludes hidden members when INCLUDE_HIDDEN is false', () => {
  const { members } = discoverMembers(fakeAdmin({
    _id: 'rs0',
    members: [{ _id: 0, host: 'h1:27017' },
              { _id: 1, host: 'h2:27017', hidden: true, priority: 0 }],
  }), { ...CONFIG, INCLUDE_HIDDEN: false });
  assert.deepEqual(members.map((m) => m.host), ['h1:27017']);
});

test('falls back to single-node mode when replication is not enabled', () => {
  const { mode, members } = discoverMembers(fakeAdmin(null), { ...CONFIG, SEED_HOST: 'h9:27017' });
  assert.equal(mode, 'single-node');
  assert.deepEqual(members.map((m) => m.host), ['h9:27017']);
});

function fakeConn() {
  const coll = () => ({
    aggregate(pipeline) {
      if (pipeline[0].$collStats) {
        return { toArray: () => [{ storageStats: {
          indexSizes: { _id_: 100, a_1: 200 },
          indexDetails: {
            _id_: { 'block-manager': { 'file bytes available for reuse': 10 },
                    cache: { 'bytes currently in the cache': 5 } },
            a_1: { 'block-manager': { 'file bytes available for reuse': 20 },
                   cache: { 'bytes currently in the cache': 7 } },
          },
        } }] };
      }
      if (pipeline[0].$indexStats) {
        return { toArray: () => [
          { name: '_id_', accesses: { ops: 5, since: new Date('2026-01-01') } },
          { name: 'a_1', accesses: { ops: 0, since: new Date('2026-01-01') } },
        ] };
      }
      throw new Error('unexpected pipeline');
    },
    getIndexes: () => [{ v: 2, name: '_id_', key: { _id: 1 } }, { v: 2, name: 'a_1', key: { a: 1 } }],
  });
  return {
    host: 'h1:27017',
    setReadPref() { this.readPref = 'set'; },
    getDB: () => ({
      getCollectionInfos: () => [{ name: 'orders', type: 'collection' },
                                 { name: 'system.profile', type: 'collection' }],
      getCollection: coll,
    }),
    adminCommand: (cmd) => (cmd.listDatabases
      ? { databases: [{ name: 'shop' }, { name: 'admin' }, { name: 'local' }, { name: 'config' }] }
      : { ok: 1 }),
  };
}

test('collects indexes, usage and storage for non-system collections only', () => {
  const r = collectFromNode(fakeConn(), CONFIG);
  assert.deepEqual(r.namespaces, ['shop.orders']);
  const c = r.collections['shop.orders'];
  assert.deepEqual(c.indexes.map((i) => i.name), ['_id_', 'a_1']);
  assert.equal(c.usage._id_.ops, 5);
  assert.equal(c.storage.a_1.sizeBytes, 200);
  assert.equal(c.storage.a_1.reusableBytes, 20);
  assert.equal(c.storage.a_1.cacheBytes, 7);
});

test('excludes admin, local and config databases', () => {
  const r = collectFromNode(fakeConn(), CONFIG);
  assert.equal(r.namespaces.some((ns) => /^(admin|local|config)\./.test(ns)), false);
});

test('sets secondaryPreferred read preference before collecting', () => {
  const conn = fakeConn();
  collectFromNode(conn, CONFIG);
  assert.equal(conn.readPref, 'set');
});

test('a failing collection is skipped, not fatal', () => {
  const conn = fakeConn();
  conn.getDB = () => ({
    getCollectionInfos: () => [{ name: 'orders', type: 'collection' }],
    getCollection: () => ({
      aggregate() { const e = new Error('timed out'); e.codeName = 'MaxTimeMSExpired'; throw e; },
      getIndexes() { return []; },
    }),
  });
  const r = collectFromNode(conn, CONFIG);
  assert.equal(r.collections['shop.orders'].error, 'MaxTimeMSExpired');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/live.test.js`
Expected: FAIL with `TypeError: probeCapabilities is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
  function probeCapabilities({ requireFn, MongoCtor, seedHost }) {
    var fsModule = null;
    try { fsModule = requireFn('fs'); } catch (e) { fsModule = null; }
    var canOpen = false;
    try { new MongoCtor(seedHost); canOpen = true; } catch (e) { canOpen = false; }
    return {
      canWriteFiles: Boolean(fsModule && fsModule.writeFileSync),
      canOpenConnections: canOpen,
      fs: fsModule,
    };
  }

  function uriFor(template, host) {
    if (!String(template).includes('{host}')) {
      throw new Error('URI_TEMPLATE must contain {host}');
    }
    return String(template).split('{host}').join(host);
  }

  function discoverMembers(adminDb, config) {
    const hello = adminDb.runCommand({ hello: 1, maxTimeMS: config.MAX_TIME_MS });
    if (hello.msg === 'isdbgrid') {
      throw new Error('connected to a mongos: sharded clusters are not supported, because '
        + 'rs.conf() does not exist there - connect to a member of one shard instead');
    }
    let rsConfig = null;
    try {
      rsConfig = adminDb.runCommand({ replSetGetConfig: 1, maxTimeMS: config.MAX_TIME_MS }).config;
    } catch (e) {
      rsConfig = null;
    }
    if (!rsConfig) {
      return {
        replicaSetName: 'standalone',
        mode: 'single-node',
        members: [{ id: 0, host: config.SEED_HOST ?? 'seed', role: 'unknown', hidden: false,
                    delaySecs: 0, votes: 1, reachable: true, error: null }],
      };
    }
    const members = rsConfig.members
      .filter((m) => !m.arbiterOnly)
      .filter((m) => config.INCLUDE_HIDDEN || !m.hidden)
      .map((m) => ({
        id: m._id, host: m.host, role: 'unknown', hidden: Boolean(m.hidden),
        delaySecs: Number(m.secondaryDelaySecs ?? m.slaveDelay ?? 0),
        votes: Number(m.votes ?? 1), reachable: false, error: null,
      }));
    return { replicaSetName: rsConfig._id, mode: 'multi-node', members };
  }

  function collectFromNode(conn, config) {
    conn.setReadPref('secondaryPreferred');
    const result = { host: conn.host, namespaces: [], collections: {}, skipped: [] };
    const excluded = new Set(config.EXCLUDED_DBS);

    const dbNames = conn
      .adminCommand({ listDatabases: 1, nameOnly: true, maxTimeMS: config.MAX_TIME_MS })
      .databases.map((d) => d.name).filter((n) => !excluded.has(n)).sort();

    for (const dbName of dbNames) {
      let collNames = [];
      try {
        collNames = conn.getDB(dbName)
          .getCollectionInfos({ type: 'collection' }, { nameOnly: true })
          .map((c) => c.name).filter((n) => !n.startsWith('system.')).sort();
      } catch (e) {
        result.skipped.push({ ns: dbName, reason: e.codeName ?? e.message });
        continue;
      }
      for (const collName of collNames) {
        const ns = `${dbName}.${collName}`;
        const entry = { indexes: [], usage: {}, storage: {}, error: null };
        try {
          const coll = conn.getDB(dbName).getCollection(collName);
          const shardDocs = coll
            .aggregate([{ $collStats: { storageStats: {} } }], { maxTimeMS: config.MAX_TIME_MS })
            .toArray();
          for (const doc of shardDocs) {
            const s = doc.storageStats ?? {};
            for (const [name, size] of Object.entries(s.indexSizes ?? {})) {
              const e = entry.storage[name] ?? (entry.storage[name] =
                { sizeBytes: 0, reusableBytes: 0, cacheBytes: 0 });
              e.sizeBytes += Number(size ?? 0);
            }
            for (const [name, det] of Object.entries(s.indexDetails ?? {})) {
              const e = entry.storage[name] ?? (entry.storage[name] =
                { sizeBytes: 0, reusableBytes: 0, cacheBytes: 0 });
              e.reusableBytes += Number(det?.['block-manager']?.['file bytes available for reuse'] ?? 0);
              e.cacheBytes += Number(det?.cache?.['bytes currently in the cache'] ?? 0);
            }
          }
          for (const st of coll.aggregate([{ $indexStats: {} }],
              { maxTimeMS: config.MAX_TIME_MS }).toArray()) {
            const e = entry.usage[st.name]
              ?? (entry.usage[st.name] = { ops: 0, since: st.accesses.since });
            e.ops += Number(st.accesses.ops);
            if (st.accesses.since < e.since) e.since = st.accesses.since;
          }
          entry.indexes = coll.getIndexes();
        } catch (e) {
          entry.error = e.codeName ?? e.message;
        }
        result.namespaces.push(ns);
        result.collections[ns] = entry;
      }
    }
    return result;
  }
```

Add the four functions to `api`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add indexStats.js test/live.test.js && git commit -m "feat: add capability probe, member discovery and per-member collection"
```

---

### Task 9: Sampling, orchestration and output — replace the text report

Where v2's text output goes away and the new pipeline is wired end to end.

**Files:**
- Modify: `indexStats.js` — add `pickSampleMember`, `sampleNamespace`, `emit`; rewrite `main()`; delete v2's per-index and summary printing
- Test: `test/orchestrate.test.js`

**Interfaces:**
- Consumes: everything from Tasks 2-8.
- Produces:
  - `pickSampleMember(members) => member | null` — a reachable hidden member, else a reachable secondary, else a reachable primary, else any reachable member, else `null`.
  - `sampleNamespace(conn, ns, config) => sample` — the Task 4 sample shape; sets `error` instead of throwing.
  - `emit(html, payload, caps, config, out) => { written, path }` where `out = { writeFileSync, printFn }`.
  - `main()` — orchestrates and emits; no return value.

- [ ] **Step 1: Write the failing test**

```js
// test/orchestrate.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickSampleMember, sampleNamespace, emit } = require('../indexStats.js');

const CONFIG = { SAMPLE_SIZE: 100, MAX_TIME_MS: 30000, OUT_FILE: 'indexStats-report.html' };

test('prefers a hidden member for sampling, to spare the primary', () => {
  const m = pickSampleMember([
    { host: 'h1', role: 'primary', hidden: false, reachable: true },
    { host: 'h2', role: 'secondary', hidden: false, reachable: true },
    { host: 'h3', role: 'secondary', hidden: true, reachable: true },
  ]);
  assert.equal(m.host, 'h3');
});

test('falls back to a secondary, then to the primary', () => {
  assert.equal(pickSampleMember([
    { host: 'h1', role: 'primary', hidden: false, reachable: true },
    { host: 'h2', role: 'secondary', hidden: false, reachable: true },
  ]).host, 'h2');
  assert.equal(pickSampleMember([
    { host: 'h1', role: 'primary', hidden: false, reachable: true },
  ]).host, 'h1');
});

test('never picks an unreachable member, and returns null when none are reachable', () => {
  assert.equal(pickSampleMember([{ host: 'h1', role: 'primary', hidden: true, reachable: false }]), null);
});

function sampleConn(docs, validator) {
  return {
    host: 'h1:27017',
    getDB: () => ({
      getCollectionInfos: () => [{ name: 'orders', options: validator ? { validator } : {} }],
      getCollection: () => ({
        aggregate: (pipeline) => {
          if (pipeline[0].$sample) return { toArray: () => docs };
          if (pipeline[0].$listCatalog) return { toArray: () => [] };
          throw new Error('unexpected pipeline');
        },
      }),
    }),
  };
}

test('profiles sampled documents into path presence', () => {
  const s = sampleNamespace(sampleConn([{ a: 1 }, { a: 2, b: 3 }]), 'shop.orders', CONFIG);
  assert.equal(s.size, 2);
  assert.equal(s.paths.a.count, 2);
  assert.equal(s.paths.b.count, 1);
  assert.equal(s.error, null);
});

test('extracts the collection validator when present', () => {
  const s = sampleNamespace(sampleConn([{ a: 1 }], {
    $jsonSchema: { additionalProperties: false, properties: { a: { bsonType: 'int' } } },
  }), 'shop.orders', CONFIG);
  assert.deepEqual(s.validator, { props: ['a'], closed: true });
});

test('SAMPLE_SIZE of zero skips document sampling but still reads the validator', () => {
  const s = sampleNamespace(sampleConn([{ a: 1 }], { $jsonSchema: { properties: { a: {} } } }),
    'shop.orders', { ...CONFIG, SAMPLE_SIZE: 0 });
  assert.equal(s.size, 0);
  assert.deepEqual(s.paths, {});
  assert.deepEqual(s.validator, { props: ['a'], closed: false });
});

test('a failed sample degrades that namespace only', () => {
  const conn = { host: 'h1:27017', getDB: () => ({
    getCollectionInfos: () => [{ name: 'orders', options: {} }],
    getCollection: () => ({
      aggregate() { const e = new Error('nope'); e.codeName = 'MaxTimeMSExpired'; throw e; },
    }),
  }) };
  const s = sampleNamespace(conn, 'shop.orders', CONFIG);
  assert.equal(s.error, 'MaxTimeMSExpired');
  assert.equal(s.size, 0);
});

test('emit writes the file when the runtime allows it', () => {
  const writes = [];
  const prints = [];
  const r = emit('<html></html>', { indexes: [] }, { canWriteFiles: true }, CONFIG,
    { writeFileSync: (p, c) => writes.push([p, c]), printFn: (s) => prints.push(s) });
  assert.equal(r.written, true);
  assert.equal(writes[0][0], 'indexStats-report.html');
  assert.match(prints.join('\n'), /indexStats-report\.html/);
});

test('emit prints the html when files are unavailable', () => {
  const prints = [];
  const r = emit('<html>x</html>', { indexes: [] }, { canWriteFiles: false }, CONFIG,
    { writeFileSync: null, printFn: (s) => prints.push(s) });
  assert.equal(r.written, false);
  assert.equal(prints.join('\n').includes('<html>x</html>'), true);
});

test('emit falls back to printing when the write throws', () => {
  const prints = [];
  const r = emit('<html>y</html>', { indexes: [] }, { canWriteFiles: true }, CONFIG,
    { writeFileSync: () => { throw new Error('EACCES'); }, printFn: (s) => prints.push(s) });
  assert.equal(r.written, false);
  assert.match(prints.join('\n'), /EACCES/);
  assert.equal(prints.join('\n').includes('<html>y</html>'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/orchestrate.test.js`
Expected: FAIL with `TypeError: pickSampleMember is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
  function pickSampleMember(members) {
    const up = members.filter((m) => m.reachable);
    return up.find((m) => m.hidden)
      ?? up.find((m) => m.role === 'secondary')
      ?? up.find((m) => m.role === 'primary')
      ?? up[0] ?? null;
  }

  function sampleNamespace(conn, ns, config) {
    const dbName = ns.split('.')[0];
    const collName = ns.split('.').slice(1).join('.');
    const out = { ns, member: conn.host, size: 0, paths: {},
                  multikeyPaths: [], validator: null, error: null };
    try {
      const database = conn.getDB(dbName);
      const info = database.getCollectionInfos({ name: collName })[0];
      out.validator = validatorPaths(info?.options?.validator);

      if (config.SAMPLE_SIZE > 0) {
        const docs = database.getCollection(collName)
          .aggregate([{ $sample: { size: config.SAMPLE_SIZE } }],
            { maxTimeMS: config.MAX_TIME_MS })
          .toArray();
        const profile = profileSample(docs);
        out.size = profile.size;
        out.paths = profile.paths;
      }

      try {
        const catalog = database.getCollection(collName)
          .aggregate([{ $listCatalog: {} }], { maxTimeMS: config.MAX_TIME_MS }).toArray();
        for (const entry of catalog) {
          for (const idx of entry?.md?.indexes ?? []) {
            for (const p of Object.keys(idx.multikeyPaths ?? {})) {
              if (!out.multikeyPaths.includes(p)) out.multikeyPaths.push(p);
              if (out.paths[p]) out.paths[p].multikey = true;
            }
          }
        }
      } catch (e) {
        // $listCatalog needs 4.4+ and elevated privileges; it is optional enrichment
      }
    } catch (e) {
      out.error = e.codeName ?? e.message;
    }
    return out;
  }

  function emit(html, payload, caps, config, out) {
    if (caps.canWriteFiles && out.writeFileSync) {
      try {
        out.writeFileSync(config.OUT_FILE, html);
        out.printFn(`report written to ${config.OUT_FILE}`);
        return { written: true, path: config.OUT_FILE };
      } catch (e) {
        out.printFn(`could not write ${config.OUT_FILE} (${e.message}) - printing the report instead`);
      }
    } else {
      out.printFn('this shell cannot write files - printing the report, copy it into a .html file');
    }
    out.printFn(html);
    return { written: false, path: null };
  }
```

Now rewrite `main()`, deleting v2's `print` loops entirely:

```js
  function main() {
    const config = {
      URI_TEMPLATE: (typeof process === 'object' && process.env && process.env.INDEXSTATS_URI)
        ? process.env.INDEXSTATS_URI : URI_TEMPLATE,
      OUT_FILE, EXCLUDED_DBS: [...EXCLUDED_DBS], MAX_TIME_MS, INCLUDE_HIDDEN,
      DROP_MIN_COUNTER_DAYS, SAMPLE_SIZE, LOW_PRESENCE,
      SEED_HOST: db.getMongo().host,
    };
    const caps = probeCapabilities({
      requireFn: typeof require === 'function' ? require
        : () => { throw new Error('no require'); },
      MongoCtor: typeof Mongo === 'function' ? Mongo
        : function () { throw new Error('no Mongo'); },
      seedHost: config.SEED_HOST,
    });

    let discovered;
    try {
      discovered = discoverMembers(db.getSiblingDB('admin'), config);
    } catch (e) {
      print(`FATAL: ${e.message}`);
      return;
    }

    const fanOut = caps.canOpenConnections && discovered.mode === 'multi-node';
    const connFor = (host) => (fanOut ? new Mongo(uriFor(config.URI_TEMPLATE, host)) : db.getMongo());

    const nodeResults = [];
    for (const member of discovered.members) {
      try {
        const conn = connFor(member.host);
        const hello = conn.getDB('admin').runCommand({ hello: 1, maxTimeMS: config.MAX_TIME_MS });
        member.role = (hello.isWritablePrimary || hello.ismaster) ? 'primary' : 'secondary';
        member.reachable = true;
        nodeResults.push(collectFromNode(conn, config));
      } catch (e) {
        member.reachable = false;
        member.error = e.codeName ?? e.message;
        print(`member ${member.host} unreachable: ${member.error}`);
      }
      if (!fanOut) break;
    }

    const samples = [];
    const sampleMember = pickSampleMember(discovered.members);
    if (sampleMember) {
      try {
        const sampleConn = connFor(sampleMember.host);
        const namespaces = (nodeResults.find((r) => r.host === sampleMember.host)
          ?? nodeResults[0])?.namespaces ?? [];
        for (const ns of namespaces) samples.push(sampleNamespace(sampleConn, ns, config));
      } catch (e) {
        print(`sampling skipped: ${e.codeName ?? e.message}`);
      }
    }

    const merged = mergeNodes({
      members: discovered.members, nodeResults, samples, now: new Date(),
    });
    merged.meta = {
      generatedAt: new Date().toISOString(),
      scriptVersion: SCRIPT_VERSION,
      replicaSetName: discovered.replicaSetName,
      seedHost: config.SEED_HOST,
      mode: fanOut ? discovered.mode : 'single-node',
      capabilities: {
        canWriteFiles: caps.canWriteFiles,
        canOpenConnections: caps.canOpenConnections,
      },
      config: { DROP_MIN_COUNTER_DAYS, SAMPLE_SIZE, INCLUDE_HIDDEN, MAX_TIME_MS },
    };

    const payload = applyAnalysis(merged, config, samples);
    const s = summarise(payload.indexes);

    emit(renderHTML(payload), payload, caps, config,
      { writeFileSync: caps.fs ? caps.fs.writeFileSync : null, printFn: print });

    print(`${payload.indexes.length} indexes across ${payload.namespaces.length} collections on `
      + `${payload.members.filter((m) => m.reachable).length}/${payload.members.length} members`);
    print(`${s.drop} drop candidates, ${s.inconclusive} inconclusive, `
      + `${fmtBytes(s.reclaimable)} reclaimable cluster-wide`);
  }
```

Note the `if (!fanOut) break;` — without fan-out only the seed node can be read, and looping would poll it once per configured member and triple-count its sizes.

Also rewrite the header comment block at the top of the file to describe v3 — fan-out, HTML output, schema checks — and the new run instructions.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add indexStats.js test/orchestrate.test.js && git commit -m "feat: wire multi-node collection, sampling and html output into main"
```

---

### Task 10: Peer payload merge and degraded modes

**Files:**
- Modify: `indexStats.js` — add `mergePeerPayloads`, call it from `main()`
- Test: `test/peer.test.js`

**Interfaces:**
- Consumes: `mergeNodes` from Task 3, `applyAnalysis` from Task 5.
- Produces: `mergePeerPayloads(localPayload, peerPayloads) => payload` — unions members and per-node vectors by host, recomputes `maxOps`, `minCounterAgeDays`, `clusterSizeBytes` and `definition.missingOn`, strips any carried-over verdicts, and sets `meta.mode = 'merged-payloads'`. Verdicts must be re-derived by `applyAnalysis` afterwards, never trusted from a peer.

- [ ] **Step 1: Write the failing test**

```js
// test/peer.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/peer.test.js`
Expected: FAIL with `TypeError: mergePeerPayloads is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
  function mergePeerPayloads(local, peers) {
    if (!peers || peers.length === 0) return local;
    const out = JSON.parse(JSON.stringify(local));
    const hosts = new Set(out.members.map((m) => m.host));
    const byKey = new Map(out.indexes.map((i) => [`${i.ns} ${i.name}`, i]));

    for (const peer of peers) {
      const newMembers = peer.members.filter((m) => !hosts.has(m.host));
      for (const m of newMembers) { out.members.push(m); hosts.add(m.host); }
      const accepted = new Set(newMembers.map((m) => m.host));
      if (accepted.size === 0) continue;

      for (const m of peer.gaps.unreachableMembers) {
        if (!out.gaps.unreachableMembers.some((u) => u.host === m.host)) {
          out.gaps.unreachableMembers.push(m);
        }
      }
      for (const s of peer.gaps.skipped) out.gaps.skipped.push(s);

      for (const ns of peer.namespaces) {
        const existing = out.namespaces.find((n) => n.ns === ns.ns);
        if (!existing) out.namespaces.push(ns);
        else for (const h of ns.presentOn) {
          if (!existing.presentOn.includes(h)) existing.presentOn.push(h);
        }
      }

      for (const idx of peer.indexes) {
        const nodes = idx.perNode.filter((n) => accepted.has(n.host));
        if (nodes.length === 0) continue;
        const key = `${idx.ns} ${idx.name}`;
        let target = byKey.get(key);
        if (!target) {
          target = { ...idx, perNode: [] };
          byKey.set(key, target);
          out.indexes.push(target);
        }
        target.perNode.push(...nodes);
      }
    }

    for (const idx of out.indexes) {
      const present = idx.perNode.filter((n) => n.present);
      idx.maxOps = present.reduce((m, n) => Math.max(m, Number(n.ops ?? 0)), 0);
      const ages = present.map((n) => n.counterAgeDays)
        .filter((a) => a !== null && a !== undefined);
      idx.minCounterAgeDays = ages.length ? Math.min(...ages) : null;
      idx.clusterSizeBytes = present.reduce((s, n) => s + Number(n.sizeBytes ?? 0), 0);
      idx.perMemberSizeBytes = present.length ? Math.round(idx.clusterSizeBytes / present.length) : 0;
      const missingOn = out.members
        .filter((m) => m.reachable && !present.some((n) => n.host === m.host))
        .map((m) => m.host);
      idx.definition = {
        ...idx.definition,
        missingOn,
        consistent: missingOn.length === 0 && (idx.definition.variants?.length ?? 0) <= 1,
      };
      delete idx.verdict;
      delete idx.flags;
      delete idx.reasons;
    }
    out.meta = { ...out.meta, mode: 'merged-payloads' };
    return out;
  }
```

In `main()`, replace the `applyAnalysis(merged, ...)` call with:

```js
    const withPeers = mergePeerPayloads(merged, PEER_PAYLOADS);
    const payload = applyAnalysis(withPeers, config, samples);
```

and after the two summary prints, add the degraded-mode guidance:

```js
    if (!fanOut) {
      print(`this shell analysed only ${config.SEED_HOST}: `
        + (caps.canOpenConnections
          ? 'the deployment is not a replica set'
          : 'connections to other members are not permitted here'));
      print('for cluster-wide verdicts, run this script on each member and paste each '
        + 'payload below into PEER_PAYLOADS');
      print(`PEER_PAYLOAD_BEGIN\n${JSON.stringify(payload)}\nPEER_PAYLOAD_END`);
    }
```

Add `mergePeerPayloads` to `api`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add indexStats.js test/peer.test.js && git commit -m "feat: merge peer payloads for shells that cannot fan out"
```

---

### Task 11: End-to-end verification on a real replica set, and docs

No containers: three plain `mongod` processes on loopback ports.

**Files:**
- Create: `test/e2e/cluster.sh`, `test/e2e/seed.js`, `test/e2e/verify.js`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the finished `indexStats.js`.
- Produces: `test/e2e/cluster.sh {start|stop}`, and a `verify.js` that exits non-zero on any failed assertion.

- [ ] **Step 1: Write the cluster harness**

```bash
#!/usr/bin/env bash
# test/e2e/cluster.sh
set -euo pipefail
BASE="${TMPDIR:-/tmp}/indexstats-e2e"
PORTS=(27021 27022 27023)

start() {
  mkdir -p "$BASE"
  for p in "${PORTS[@]}"; do
    mkdir -p "$BASE/$p"
    mongod --replSet rsIndexStats --port "$p" --dbpath "$BASE/$p" \
      --logpath "$BASE/$p/mongod.log" --bind_ip 127.0.0.1 \
      --wiredTigerCacheSizeGB 0.25 --fork > /dev/null
  done
  sleep 2
  mongosh "mongodb://127.0.0.1:27021/?directConnection=true" --quiet --eval '
    rs.initiate({ _id: "rsIndexStats", members: [
      { _id: 0, host: "127.0.0.1:27021", priority: 2 },
      { _id: 1, host: "127.0.0.1:27022" },
      { _id: 2, host: "127.0.0.1:27023", priority: 0, hidden: true }
    ]});'
  for _ in $(seq 30); do
    if mongosh "mongodb://127.0.0.1:27021/?directConnection=true" --quiet \
         --eval 'db.hello().isWritablePrimary' | grep -q true; then
      echo "primary ready"; return 0
    fi
    sleep 1
  done
  echo "primary never came up" >&2
  exit 1
}

stop() {
  for p in "${PORTS[@]}"; do
    mongosh "mongodb://127.0.0.1:$p/?directConnection=true" --quiet \
      --eval 'db.getSiblingDB("admin").shutdownServer()' > /dev/null 2>&1 || true
  done
  sleep 1
  rm -rf "$BASE"
  echo "cluster stopped and data removed"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 {start|stop}" >&2; exit 2 ;;
esac
```

Run:

```bash
chmod +x test/e2e/cluster.sh && ./test/e2e/cluster.sh start
```

Expected: `primary ready`.

- [ ] **Step 2: Write and run the seed script**

```js
// test/e2e/seed.js  - run against the primary
const shop = db.getSiblingDB('shop');
shop.orders.drop();
shop.orders.insertMany(Array.from({ length: 500 }, (_, i) => ({
  status: i % 3 === 0 ? 'open' : 'closed',
  createdAt: new Date(Date.now() - i * 3600000),
  region: i % 2 ? 'eu' : 'us',
  total: i % 7 === 0 ? String(i) : i,
  tags: ['a', 'b'],
})));
shop.orders.createIndex({ status: 1, createdAt: -1 });
shop.orders.createIndex({ status: 1, createdAt: -1, region: 1 });
shop.orders.createIndex({ status: 1 });
shop.orders.createIndex({ createdAT: 1 });
shop.orders.createIndex({ total: 1 });
shop.orders.createIndex({ tags: 1 });

const crm = db.getSiblingDB('crm');
crm.contacts.drop();
crm.createCollection('contacts', { validator: { $jsonSchema: {
  bsonType: 'object',
  additionalProperties: false,
  properties: { _id: {}, email: { bsonType: 'string' }, tenant: { bsonType: 'string' } },
} } });
crm.contacts.insertMany(Array.from({ length: 200 },
  (_, i) => ({ email: `u${i}@x.io`, tenant: 't1' })));
crm.contacts.createIndex({ email: 1 });
crm.contacts.createIndex({ nickname: 1 });

for (let i = 0; i < 50; i++) {
  shop.orders.find({ status: 'open', createdAt: { $gt: new Date(0) }, region: 'eu' }).toArray();
  crm.contacts.find({ email: 'u1@x.io' }).toArray();
}
print('seeded');
```

Note that `crm.contacts.createIndex({ nickname: 1 })` succeeds even though the validator forbids the field — validators constrain documents, not indexes. That is exactly the mistake this check exists to surface.

Run:

```bash
mongosh "mongodb://127.0.0.1:27021/?directConnection=true" --quiet --file test/e2e/seed.js
```

Expected: `seeded`.

- [ ] **Step 3: Generate the report and write the verifier**

Run:

```bash
INDEXSTATS_URI='mongodb://{host}/?directConnection=true' mongosh "mongodb://127.0.0.1:27021/?directConnection=true" --quiet --file indexStats.js
```

Expected: `report written to indexStats-report.html` plus the two summary lines.

```js
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
```

Run:

```bash
node test/e2e/verify.js indexStats-report.html
```

Expected: `ok - N indexes, 3 members verified`.

This asserts the load-bearing guard directly: on a cluster seeded minutes ago **nothing** may be recommended for dropping, because every counter is younger than 14 days. Any `drop` or `likely-drop` here means the threshold logic is broken.

- [ ] **Step 4: Verify the unreachable-member path**

```bash
mongosh "mongodb://127.0.0.1:27023/?directConnection=true" --quiet --eval 'db.getSiblingDB("admin").shutdownServer()' || true
```

```bash
INDEXSTATS_URI='mongodb://{host}/?directConnection=true' mongosh "mongodb://127.0.0.1:27021/?directConnection=true" --quiet --file indexStats.js
```

```bash
node test/e2e/verify.js indexStats-report.html --expect-unreachable
```

Expected: the run prints `member 127.0.0.1:27023 unreachable: ...`, the report carries the gap banner, and the verifier passes.

Then open the report and confirm by eye: the banner, one member shown down in the strip, filtering, sorting, row expansion, and the copy button.

```bash
open indexStats-report.html
```

- [ ] **Step 5: Verify the mismatched-definition path (optional, heavier)**

A real definition mismatch cannot be created by writing to a secondary — index builds replicate. The authentic procedure is to take a member out, change it in isolation, and rejoin:

```bash
./test/e2e/cluster.sh stop && ./test/e2e/cluster.sh start && mongosh "mongodb://127.0.0.1:27021/?directConnection=true" --quiet --file test/e2e/seed.js
```

```bash
mongosh "mongodb://127.0.0.1:27023/?directConnection=true" --quiet --eval 'db.getSiblingDB("admin").shutdownServer()' || true
```

```bash
mongod --port 27033 --dbpath "${TMPDIR:-/tmp}/indexstats-e2e/27023" --logpath "${TMPDIR:-/tmp}/indexstats-e2e/27023/standalone.log" --bind_ip 127.0.0.1 --fork
```

```bash
mongosh "mongodb://127.0.0.1:27033/?directConnection=true" --quiet --eval 'db.getSiblingDB("shop").orders.dropIndex("tags_1")'
```

```bash
mongosh "mongodb://127.0.0.1:27033/?directConnection=true" --quiet --eval 'db.getSiblingDB("admin").shutdownServer()' || true
```

```bash
mongod --replSet rsIndexStats --port 27023 --dbpath "${TMPDIR:-/tmp}/indexstats-e2e/27023" --logpath "${TMPDIR:-/tmp}/indexstats-e2e/27023/mongod.log" --bind_ip 127.0.0.1 --fork
```

Then regenerate the report and assert:

```bash
INDEXSTATS_URI='mongodb://{host}/?directConnection=true' mongosh "mongodb://127.0.0.1:27021/?directConnection=true" --quiet --file indexStats.js
```

```bash
node -e 'const fs=require("fs"),assert=require("node:assert/strict");const p=JSON.parse(fs.readFileSync("indexStats-report.html","utf8").match(/id="indexstats-data">([\s\S]*?)<\/script>/)[1]);const i=p.indexes.find(x=>x.ns==="shop.orders"&&x.name==="tags_1");assert.equal(i.verdict,"mismatched");assert.deepEqual(i.definition.missingOn,["127.0.0.1:27023"]);console.log("ok - mismatched definition detected");'
```

Honest caveat: this races the oplog. Once rejoined, the member may rebuild the index on its own, so run the report promptly. If it proves flaky, delete this step and rely on the deterministic unit coverage in Tasks 3 and 5 — but say so in the commit message. Do not leave a flaky test in place, and do not drop the coverage silently.

Tear down:

```bash
./test/e2e/cluster.sh stop
```

- [ ] **Step 6: Verify the degraded, Compass-like path**

Compass's shell cannot be driven from here, so simulate its restrictions under mongosh by making both probes fail:

```bash
./test/e2e/cluster.sh start && mongosh "mongodb://127.0.0.1:27021/?directConnection=true" --quiet --file test/e2e/seed.js
```

```bash
mongosh "mongodb://127.0.0.1:27021/?directConnection=true" --quiet --eval 'require = function(){ throw new Error("blocked"); }; Mongo = function(){ throw new Error("blocked"); };' --file indexStats.js
```

Expected: the script completes without throwing, prints the "cannot write files" notice followed by the full HTML, prints the `PEER_PAYLOAD_BEGIN`/`PEER_PAYLOAD_END` block, and the embedded `meta.mode` is `single-node`.

Then confirm the peer path closes the loop: save two such payloads from two members, paste them into `PEER_PAYLOADS`, rerun, and check that `meta.mode` is `merged-payloads` with both hosts in `members`.

Tear down:

```bash
./test/e2e/cluster.sh stop
```

- [ ] **Step 7: Update CLAUDE.md and commit**

Rewrite `CLAUDE.md` for v3, covering: the two layers and the purity rule; the export guard's exact form and why `typeof module !== 'undefined'` is wrong in mongosh; the paste-anywhere constraint and the capability probe; `node --test test/` for units and `test/e2e/cluster.sh` for end-to-end; and that verdicts are advisory — the script never mutates.

```bash
chmod +x test/e2e/cluster.sh && git add test/e2e CLAUDE.md && git commit -F - <<'MSG'
test: verify multi-node report end to end against a real replica set

Adds a container-free three-mongod harness (one hidden member), a seed
script covering prefix and subsumed redundancy, a typo'd index field,
mixed types, multikey and a closed validator, plus a verifier that
asserts on the payload embedded in the generated report.

Covers the unreachable-member downgrade and the degraded no-fs,
no-fan-out path. Asserts that a freshly seeded cluster yields no drop
recommendations at all, since every counter is younger than 14 days.

The Compass paste-in path is simulated under mongosh, not run in
Compass; that check is left to the user.
MSG
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task. Runtime constraints and the export guard, Task 1. Redundancy's four classes: `duplicate`, `prefix` and `subsumed` in Task 2, `mismatched` in Task 3 (it needs more than one member). The data model, Task 3. Schema checks including the validator and `$listCatalog`, Tasks 4 and 9. The verdict table with both `inconclusive` downgrades, Task 5. The HTML report, Tasks 6 and 7. Capability probe, discovery, `directConnection`, `secondaryPreferred` and per-member collection, Task 8. Sampling member choice, orchestration and the output fallback, Task 9. Peer payload merge, Task 10. Error isolation, Tasks 8 and 9, asserted in Task 11. Testing strategy, Tasks 1-11.

**Known gaps, stated rather than hidden.**

- The `duplicate` class is near-unreachable on modern servers, which reject identical key patterns under different names (`IndexOptionsConflict`). Task 2's coverage is unit-only by necessity — the end-to-end seed cannot create one. It stays as a cheap defensive check.
- Task 11 Step 5 (`mismatched` end to end) races the oplog and is marked optional, with explicit instructions if it proves flaky.
- The Compass runtime is simulated, never actually exercised. Task 11 Step 6 covers the degradation logic; the real paste-in remains the user's check.
- `renderHTML`'s visual result is verified by eye in Task 7 Step 4, not asserted. The unit tests cover structure, escaping and offline-ness; they cannot see a broken layout.
- Sampling reads from a hidden member first, which on a *delayed* member means slightly stale documents. Fine for field-name checks, mildly odd for type checks; noted in the spec as a deliberate load-avoidance trade.

**Type consistency.** Verdict strings are identical in Tasks 5, 7, 10 and 11: `drop`, `likely-drop`, `review`, `inconclusive`, `mismatched`, `keep`. `redundancy.class` is only ever `duplicate`, `prefix` or `subsumed`; `mismatched` reaches an index through `definition.consistent`, never through `redundancy.class`. The `sample` shape produced by Task 9's `sampleNamespace` (`{ ns, member, size, paths, multikeyPaths, validator, error }`) is exactly what Task 4's `classifySchemaIssues` and Task 3's `mergeNodes` consume. `perNode` entry fields are identical in Tasks 3, 7, 10 and 11. `fmtBytes`, `selectIndexes`, `summarise` and `dropCommandsFor` are `var`-only and closure-free, which Task 7's final test enforces.
