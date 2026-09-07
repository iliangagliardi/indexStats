# Multi-node index report with HTML output — design

Date: 2026-09-07
Status: approved for planning
Supersedes: the single-node text behaviour of `indexStats.js` v2

## Goal

Turn `indexStats.js` from a single-node text report into a replica-set-wide
index audit that emits one self-contained HTML file. Three capabilities are
added:

1. **Fan-out.** Discover replica set members from the live config and collect
   index statistics from every data-bearing member, not just the node the
   shell happens to be attached to.
2. **HTML report.** Replace the piped text output with a single self-contained
   HTML file: sortable, filterable, with per-index drill-down and a
   drop-candidate ranking.
3. **Schema/index consistency.** Detect index key fields that do not match the
   documents or the declared validator — the class of mistake that usage stats
   cannot reveal.

## Non-goals

- **Sharded clusters.** `rs.conf()` does not exist on a `mongos`. Detect and
  refuse with a clear message rather than half-report.
- **Missing-index suggestions.** Recommending indexes needs query-shape data
  (`$queryStats`, slow logs). Out of scope.
- **Dropping anything.** The script never mutates. It can emit `dropIndexes`
  commands for a human to run.

## Runtime constraints

The script must run **pasted into any mongosh or Compass shell**. This is a
hard constraint and it rules out several conveniences:

- No `--file`-only behaviour, no `load()`, no relative `require`.
- No reliance on `require('fs')`, `process.env`, or opening extra connections.
  Each is *probed* and the script degrades when absent.
- Single file. No modules, no dependencies, no network access from the report.

Verified on mongosh 2.9.2: `require('fs')`, `process.env`, `new Mongo()` and
`connect()` are all available. Note `typeof module === 'function'` in mongosh
(it is the shell's own helper), so any test-export guard must check
`typeof module === 'object' && module.exports` — never `typeof module !== 'undefined'`.

Compass's embedded shell is **not** verified to permit `fs` or `new Mongo()`.
The design therefore treats both as optional capabilities.

## Configuration

A single block at the top of the file. Credentials live here by decision —
there is nowhere else to put them on the paste-into-Compass path — with a
comment warning against committing a filled-in password.

| Constant | Default | Purpose |
|---|---|---|
| `URI_TEMPLATE` | `mongodb://user:pass@{host}/?directConnection=true&appName=indexStats` | `{host}` is replaced with each member's `host:port`. `directConnection=true` is mandatory, otherwise the driver reconnects to the primary and the same node is polled N times. Overridden by `process.env.INDEXSTATS_URI` when that exists. |
| `OUT_FILE` | `indexStats-report.html` | Written when `fs` is available. |
| `EXCLUDED_DBS` | `admin`, `config`, `local` | Unchanged from v2. |
| `MAX_TIME_MS` | `30000` | Per server call. Unchanged. |
| `INCLUDE_HIDDEN` | `true` | Hidden/delayed members are queried by default. |
| `DROP_MIN_COUNTER_DAYS` | `14` | A zero-op index is only recommended for dropping when the *youngest* counter across all members is at least this old. |
| `SAMPLE_SIZE` | `100` | Documents sampled per collection for schema checks. `0` disables sampling entirely. |
| `PEER_PAYLOADS` | `[]` | Payloads pasted from other runs, for merging when fan-out is impossible. |

## Flow

### 1. Capability probe

- `canWriteFiles` — `require('fs')` inside try/catch.
- `canOpenConnections` — `new Mongo()` against the seed host inside try/catch.

Both outcomes are recorded in the report metadata. Nothing silently changes
behaviour without saying so in the output.

### 2. Topology discovery

1. `hello`. If `msg === 'isdbgrid'`, abort with the sharded-cluster message.
2. `replSetGetConfig` for members: `host`, `arbiterOnly`, `hidden`,
   `priority`, `secondaryDelaySecs`, `votes`.
   - Arbiters are dropped — no data.
   - Hidden and delayed members are kept when `INCLUDE_HIDDEN`.
3. If replication is not enabled, run in **single-node mode** against the seed
   connection. The report still renders, with one member column.

### 3. Per-member collection

For each data-bearing member: `new Mongo(uri)`, then set read preference to
`secondaryPreferred` on the connection — without it `$collStats` and
`$indexStats` are refused on a secondary.

Namespaces are enumerated **per member** and unioned, not taken once from the
primary: a member mid-initial-sync genuinely has a different set, and the
report should show that rather than hide it.

Per member, per namespace, three calls, each with `maxTimeMS` (unchanged from v2):

- `$collStats` with `storageStats` — `indexSizes`, plus per-index
  `block-manager['file bytes available for reuse']` and
  `cache['bytes currently in the cache']`.
- `$indexStats` — `accesses.ops` and `accesses.since`.
- `getIndexes()` — key patterns and options.

### 4. Schema sampling (once per namespace, not per member)

Document shape is replicated, so sampling runs on exactly **one** member,
chosen in this order: a hidden member, else a secondary, else the primary.
This keeps the extra load off the primary.

- `$sample` of `SAMPLE_SIZE` documents, `maxTimeMS` applied.
- Each document is flattened to a set of dotted field paths (depth cap 8).
  Arrays contribute both their own path and the paths inside their elements.
  Presence is counted per document: a path seen at least once counts once.
- `$listCatalog` supplies `multikeyPaths` where available.
- `getCollectionInfos()` already returns `options.validator`; its
  `$jsonSchema.properties` are extracted recursively.

### 5. Merge, analyse, render, write

Everything after collection is a **pure function of plain data** with no `db`
access: `mergeNodes()`, `analyze()`, `renderHTML()`. This is what makes the
logic testable without a cluster.

Output: write `OUT_FILE` when `canWriteFiles`, otherwise print the HTML to the
shell for copy-paste. Either way a short text summary is printed, so the
terminal is never silent.

## Data model

One payload object, embedded in the report and reusable as `PEER_PAYLOADS`
input:

```js
{
  meta: { generatedAt, scriptVersion, replicaSetName, seedHost, mode,
          capabilities: { canWriteFiles, canOpenConnections }, config },
  members: [ { id, host, role, hidden, delaySecs, votes, reachable, error,
               sampledOn } ],
  gaps:    { unreachableMembers: [], skipped: [ { member, ns, reason } ] },
  namespaces: [ { ns, db, coll, presentOn: [host], hasValidator,
                  sample: { size, member } } ],
  indexes: [ {
    ns, name, key, options, hidden,
    perNode: [ { host, present, ops, since, counterAgeDays,
                 sizeBytes, reusableBytes, cacheBytes, error } ],
    maxOps, minCounterAgeDays, clusterSizeBytes, perMemberSizeBytes,
    redundancy:  { class, coveredBy },
    definition:  { consistent, missingOn: [host], variants: [] },
    schema:      { checks: [ { field, presence, sampleSize, types,
                               multikey, inValidator, issue } ] },
    verdict, flags: [], reasons: []
  } ]
}
```

Index identity is `ns + name`. Sizes stay per-node; `clusterSizeBytes` is the
sum across data-bearing members, because that total is what justifies the
ticket.

## Analysis rules

### Redundancy

Four classes, computed from the union of definitions per namespace:

1. `duplicate` — identical canonical key pattern and equivalent options under
   two names. Which one survives is deterministic: the one with higher
   `maxOps`; on a tie, the one whose name matches MongoDB's generated name for
   that key; failing that, the alphabetically first. The other is reported as
   covered by it.
2. `prefix` — a plain index whose key pattern is a strict prefix of a wider
   plain index, **directions matching** for multi-field prefixes.
3. `subsumed` — a single-field plain index whose field leads a compound plain
   index. Direction-agnostic, because a single-field index traverses both ways.
4. `mismatched` — same name, differing key patterns across members, or present
   on some members and absent on others. A stalled or in-flight rolling index
   build. New in v3; structurally invisible to v2.

Never flagged, because a wider index does not carry their semantics:
`_id_`, and any index with `unique`, `sparse`, `partialFilterExpression`,
`expireAfterSeconds`, `collation`, `wildcardProjection`, `weights`,
`textIndexVersion`, `2dsphereIndexVersion`, `bits`, `min`, `max`, or any key
direction that is not `1`/`-1`.

### Schema/index consistency

Per index key field, against the sampled path set and the validator. The
report states the discrepancy and never guesses which side is wrong — a typo
in the index and a renamed application field are indistinguishable from here.

| Issue | Condition |
|---|---|
| `absent` | path present in 0 of `SAMPLE_SIZE` sampled documents |
| `low-presence` | path present in under 10% — a partial or sparse index would be smaller |
| `mixed-types` | indexed path holds more than one BSON type across the sample |
| `unexpected-multikey` | `multikeyPaths` reports the path as multikey |
| `not-in-validator` | absent from `$jsonSchema.properties`; **provable** only when `additionalProperties: false` at that level, otherwise advisory |

Wording is evidentiary: "absent from 100 of 100 sampled documents", never
"field does not exist". Text index internals (`_fts`, `_ftsx`) are checked via
`weights` keys instead; wildcard (`$**`) paths are skipped.

### Verdicts

Evaluated in order; first match wins:

1. `definition.consistent === false` → **mismatched**. Informational, never a
   drop candidate.
2. `name === '_id_'` → **keep**.
3. `maxOps > 0` → **review** if any redundancy class applies, else **keep**.
   Annotated `used-only-on-hidden` when every non-zero counter came from a
   hidden or delayed member — the analytics index a primary-only report would
   have told you to drop.
4. `maxOps === 0` on every member where the index is present:
   - any data-bearing member unreachable → **inconclusive**
   - `minCounterAgeDays < DROP_MIN_COUNTER_DAYS` → **inconclusive**
   - a redundancy class or a `suspect-field` flag applies → **drop**
   - otherwise → **likely-drop**

`$indexStats` counters reset on `mongod` restart, which makes the age check
load-bearing rather than decorative: after a rolling restart every counter is
young, and a zero there is not evidence of anything.

Flags are orthogonal to the verdict and independently filterable:
`redundant:<class>`, `hidden`, `suspect-field`, `mismatched`,
`used-only-on-hidden`. Per the decision on weighting, `suspect-field` raises
confidence when combined with zero usage but never recommends a drop alone,
since a rename may be in progress.

Ranking for the table: `drop` before `likely-drop`, ties broken by
`clusterSizeBytes` descending.

## HTML report

Self-contained: inline CSS and JS, no CDN, no network, `prefers-color-scheme`
for dark mode. The payload is embedded as
`<script type="application/json" id="indexstats-data">`. Every `<` in the
serialised JSON is escaped to the `\u003c` unicode escape, so a namespace or
field value containing `</script>` cannot break out of the tag.

Landing view, top to bottom:

- **Header** — replica set name, member count, database/collection/index counts, timestamp.
- **Gap banner** — unreachable members and the resulting verdict downgrade,
  stated prominently. Anything that compromises a verdict is visible next to
  that verdict, never only in a footer.
- **Metric cards** — reclaimable bytes cluster-wide, drop candidates,
  inconclusive, redundant. These recompute against the active filter.
- **Member strip** — one tile per member: host, role, hidden/delayed, counter
  age, reachability.
- **Verdict chips** — toggle filters with counts.
- **Index table** — namespace and index, verdict with reasons, max ops,
  cluster size. Sortable on size, ops and counter age; text filter on
  namespace. Each row expands to the per-node breakdown (ops, counter age,
  size, reusable bytes) plus redundancy and schema findings.
- **Copy `dropIndexes` commands** — emits mongosh statements for the current
  filter. This is the step otherwise done by hand from a text report.
- **Gaps panel** — every unreachable member and skipped namespace with its
  `codeName`.
- **Raw payload** — collapsed `<details>` holding the JSON, so the report is
  its own machine-readable artifact.

## Error handling

Isolation keeps v2's shape and gains a level:

- A member that fails to connect degrades that member only, and lands in
  `gaps.unreachableMembers`, which forces zero-op verdicts to `inconclusive`.
- A database or collection that throws is recorded with `err.codeName ?? err.message`
  and skipped, exactly as in v2.
- `maxTimeMS` on every server call, so a stalled node cannot hang the run.
- A failed `$sample` or `$listCatalog` degrades schema checks for that
  namespace alone; usage and storage analysis continue.

Every gap appears in the report, not just the terminal.

## Peer payload merge

For environments where fan-out is impossible (Compass forbidding
`new Mongo()`, or per-member network isolation), the script prints its own
compact payload. Pasting those payloads into `PEER_PAYLOADS` on a later run
merges them by member host into one cluster-wide report, with
`meta.mode = 'merged-payloads'`. This is the only route to trustworthy
cluster-wide verdicts in a locked-down Compass-only environment.

## File layout

One file, `indexStats.js`, growing from ~220 to roughly 700-900 lines. This is
a deliberate trade: mongosh's module resolution for relative `require`/`load`
is unreliable and the paste-into-Compass constraint forbids multi-file
loading. The cost is paid down with hard internal boundaries —
`probeCapabilities`, `discoverMembers`, `collectFromNode`, `sampleSchema`,
`mergeNodes`, `analyze`, `renderHTML`, `emit` — where everything from
`mergeNodes` onward touches only plain data.

A guarded export at the end of the file exposes the pure functions to
`node --test` while mongosh ignores it:

```js
if (typeof module === 'object' && module.exports) module.exports = { ... };
```

## Testing

**Unit, no server.** TDD against hand-built fixtures for the pure functions:
all four redundancy classes and every exclusion, cross-node merge, the schema
issue classification, and the full verdict table — including the 14-day
threshold and both `inconclusive` downgrades. These are where a subtle error
silently recommends dropping a live index.

**End-to-end, real replica set, no containers.** Three `mongod` processes on
ports 27021-27023 with `--replSet`, data dirs under the scratchpad, initiated
with one member `hidden: true, priority: 0` so the hidden path is genuinely
exercised. Seeded with deliberately redundant indexes, a typo'd index field, a
collection with a validator, and queries run against some indexes to move
counters. Then verify the generated HTML. Additionally: kill one member to
confirm the unreachable/`inconclusive` path, and drop an index on a single node
to trigger `mismatched`. Processes shut down and data dirs removed afterward.

**Compass path.** Not verifiable from this environment. The capability probe's
degradation is tested by forcing the `fs` and `new Mongo` probes to fail under
mongosh; the actual paste-into-Compass check is left to the user, and stated as
such rather than claimed as covered.
