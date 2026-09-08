# CLAUDE.md

## What this project is

A single-file mongosh script, `indexStats.js`, that produces a self-contained HTML report of
index usage, storage, redundancy and schema-consistency findings across every collection in
every non-system database of a MongoDB deployment - including every reachable member of a
replica set, not just the one the shell is connected to. There is no build system, no runtime
dependencies, and no `package.json`. Unit tests use only `node:test` and `node:assert/strict`.

## Running it

```bash
mongosh "<connection-string>" --quiet --file indexStats.js
```

Needs a role that can run `listDatabases`, `listCollections`, `replSetGetConfig`, `$collStats`,
`$indexStats`, `$listCatalog`, `getIndexes` and `$sample` (e.g. `clusterMonitor` + read on the
target DBs). Writes `indexStats-report.html` next to itself when the shell can write files;
otherwise it prints the full HTML to the console instead (see "paste-anywhere" below).

To reach every member of a replica set from one invocation, the shell needs to be able to open
its own connections (`new Mongo(...)`), and each member's real address needs to be reachable
using a URI template with `{host}` substituted in - override the shipped placeholder via the
`INDEXSTATS_URI` environment variable, e.g.:

```bash
INDEXSTATS_URI='mongodb://{host}/?directConnection=true' mongosh "mongodb://<seed>/?directConnection=true" --quiet --file indexStats.js
```

## Architecture: two layers

The file is one IIFE, but it is internally split into two layers with a hard boundary between
them:

1. **The live layer** - the only code allowed to touch `db`, `print`, `require`, or `Mongo`.
   Capability probing (`probeCapabilities`), replica-set member discovery
   (`discoverMembers`/`deriveSeedHost`), per-member collection (`collectFromNode`), sampling
   (`sampleNamespace`), and `main()`/`emit()` orchestration all live here. This layer is thin by
   design: its only job is to gather raw data from real (or fake, in tests) connections and hand
   it to the layer below as plain objects.
2. **The pure analysis/render layer** - `mergeNodes`, `mergePeerPayloads`, `classifyRedundancy`,
   `classifySchemaIssues`, `deriveVerdict`, `applyAnalysis`, `renderHTML`, `summarise`,
   `dropCommandsFor`, and their helpers. **None of these functions ever reference `db`, `print`,
   `require`, or `Mongo`.** They take plain data in and return plain data (or an HTML string)
   out. This is what makes the interesting logic - redundancy detection, verdicts, schema
   checks, HTML rendering - testable with plain `node:test`, with no mongosh runtime at all.

**The purity rule**: if you find yourself wanting to call a driver/shell API from anywhere in the
second layer, stop - that data should be gathered by the live layer and passed in as an argument
instead. This is not a style preference; it is what lets 120+ unit tests run in milliseconds
under plain Node, and it is why every real bug found during end-to-end testing against a live
replica set (Task 11) was in the ~150 lines of live-layer glue code, never in the pure layer.

## The export guard - exact form matters

```js
if (typeof module === 'object' && module.exports) {
  module.exports = api;
}
```

Do **not** write `typeof module !== 'undefined'`. In mongosh, `module` is *not* undefined - it
exists, but as a **function**, not an object (`typeof module === 'function'` there). A guard
based on `!== 'undefined'` would be true in mongosh too, and the line would try to write
`.exports` onto that function value on every real run, which is at best a silent no-op and at
worst throws in a stricter environment. The `typeof module === 'object' && module.exports` form
is only true under Node's CommonJS `require()` (which is how every unit test loads the script)
and reliably false in mongosh.

## Paste-anywhere and the capability probe

The script must survive being loaded somewhere it cannot open extra connections and cannot write
files - Compass's embedded shell is the reference case, and it cannot be driven from an
automated test, so `e2e` simulates it under mongosh by forcing both probes to throw. Real
capabilities are established once, up front, by `probeCapabilities()`:

- **can this shell open extra connections?** - probed by trying `new Mongo(seedHost)` in a
  `try/catch`, never assumed from feature-detecting `typeof Mongo`.
- **can this shell write files?** - probed by trying `require('fs')` in a `try/catch`.

When either probe fails, the script downgrades gracefully instead of throwing: it analyses only
the one connection it already has (`mode: 'single-node'` in the payload), and instead of writing
`indexStats-report.html` it prints the full HTML to the console, followed by a
`PEER_PAYLOAD_BEGIN` / `PEER_PAYLOAD_END` block containing that run's own JSON payload. Paste
that raw text into the `PEER_PAYLOADS` array literal near the top of the file (as parseable JSON
strings - the script `JSON.parse`s each entry itself) and rerun on another shell that also can't
fan out; `mergePeerPayloads` unions the evidence and `meta.mode` becomes `'merged-payloads'`.
This is the *only* way to get a cluster-wide report from a shell that cannot open its own
connections, so treat it as a first-class, tested path, not an afterthought - it is directly
exercised end-to-end in `e2e`.

## Member identity: never `conn.host`

In mongosh 2.9.2, both `db.getMongo().host` and `new Mongo(h).host` are **undefined** - there is
no reliable way to ask a connection object what it's connected to. Member identity therefore
always comes from the replica-set config plus `deriveSeedHost()`, in this priority order:
`hello().me` (matches `rs.conf()` exactly on a real member) -> `serverStatus().host` (a bare
hostname, used only as a fallback, e.g. on a standalone where `hello().me` is undefined) -> a
clearly-flagged synthetic literal as a last resort, which triggers a printed warning telling the
user to set `SEED_HOST` manually before pasting payloads. Every place that needs "which member is
this" - `collectFromNode`'s `host` parameter, `mergeNodes`'s `perNode` entries, the single-
connection path's self-identification - takes that derived host explicitly rather than reading
it off a connection object. (A related, real bug found in Task 11: the live-layer loop that
collects from members must match the *actual* target host against `config.SEED_HOST`, not just
grab `discovered.members[0]`, or a single-connection run silently mislabels itself as whichever
member happens to sort first in `rs.conf()`.)

## The documented `maxTimeMS` exception

**Every server call carries `maxTimeMS`** so one stalled node cannot hang the run - except two,
deliberately: mongosh's `getCollectionInfos`/`getIndexes` helpers accept no `maxTimeMS` argument
at all. The raw `listCollections`/`listIndexes` commands do accept it, but they return a cursor
document, and reading only `cursor.firstBatch` would silently truncate a database with many
collections or a collection with many indexes - missing collections mean missing indexes and
wrong "unused" verdicts, which is worse than a rare stall on a metadata call. The per-database and
per-collection `try`/`catch` around these calls is what bounds the damage instead of `maxTimeMS`.
Keep this exception; do not "fix" it by switching to the raw commands.

## Testing

- **Unit tests**: bare `node --test` from the repo root. This works cleanly because the
  end-to-end helpers live in a separate top-level `e2e/` directory, not under `test/` - Node's
  default test-file discovery recursively sweeps up every `.js` file under any directory
  literally named `test`, and `e2e/seed.js`/`e2e/verify.js` are mongosh-only driver/verifier
  scripts, not `node:test` suites, so keeping them out of `test/` entirely (rather than filtering
  them out with a glob or flag) is what makes the plain, documented command correct. (Note:
  `node --test test/` - i.e. passing the directory as a positional argument - is rejected on
  newer Node; bare `node --test` with no arguments is the form to use.) All units run under plain
  Node via `require('./indexStats.js')` - the module export guard above is what makes that
  possible - so they exercise only the pure layer and never touch a real deployment.
- **End-to-end**: `e2e/cluster.sh {start|stop}` brings up three plain `mongod --fork`
  processes on loopback ports 27021-27023 as a real replica set (one member `hidden: true,
  priority: 0`) - no containers. `e2e/seed.js` seeds known redundancy/schema scenarios,
  `e2e/verify.js` asserts against the payload embedded in the generated report, including
  the unreachable-member downgrade. This is the *only* thing that has ever caught a live-mongosh
  bug in this project (five of them, in one pass: `conn.adminCommand` doesn't exist - it's
  `conn.getDB('admin').adminCommand`; mongosh's async-rewriter breaks `x?.y?.find(...)` chains
  since it cannot tell `Array.prototype.find` from `Collection.prototype.find`; `$listCatalog`'s
  `multikeyPaths` encodes a per-path flag as a BSON Binary bitset, not "key present = multikey";
  `PEER_PAYLOADS` entries were never `JSON.parse`d before being merged; and the single-connection
  collection loop mislabelled its own identity). Unit-test mocks can only be as good as their
  authors' assumptions about the real API surface - run the end-to-end suite after any change
  that touches the live layer, not just the unit tests.

## Safety rules, not preferences

These are load-bearing correctness guarantees, not style choices - do not relax them to make a
report "cleaner" or a test pass:

- **The 14-day drop threshold** (`DROP_MIN_COUNTER_DAYS`). An index whose usage counter is
  younger than this can never be recommended `drop` or `likely-drop`, no matter how idle it
  looks - `$indexStats` counters reset on restart/failover, so a young counter proves nothing. On
  a cluster seeded minutes ago, *every* verdict must downgrade to `inconclusive` (or `keep`,
  `mismatched`, `review` where those apply) - never a drop recommendation. `e2e/verify.js`
  asserts exactly this and treats any `drop`/`likely-drop` on a freshly-seeded cluster as a
  genuine bug in the script, not a test to be adjusted.
- **The unreachable-member downgrade.** If any replica-set member could not be reached, no index
  can be confirmed unused cluster-wide - every zero-operation verdict must downgrade to
  `inconclusive` rather than `drop`/`likely-drop`, since the missing member might be the one
  actually using it.
- **Verdicts are advisory, always.** `drop`, `likely-drop`, `review`, `inconclusive`,
  `mismatched`, `keep` are labels for a human to read. The script never calls `dropIndex`, never
  mutates any collection or index, and never should. `dropCommandsFor` only formats the shell
  commands a human would need to run themselves.

## Output format

Self-contained HTML report (`indexStats-report.html`): a filterable/sortable table with
per-index detail rows, a summary of drop candidates, and offline-safe (no external requests/
fonts/scripts). When the shell can't write files, the same HTML is printed to the console
instead of being written out - see "paste-anywhere" above.
