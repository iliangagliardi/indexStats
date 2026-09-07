# CLAUDE.md

## What this project is

A single-file mongosh script, `indexStats.js`, that prints an index usage / storage /
redundancy report for every collection in every non-system database of a MongoDB
deployment. There is no build system, no dependencies, no tests, and no git repo.

## Running it

```bash
mongosh "<connection-string>" --quiet --file indexStats.js
```

Needs a role that can run `listDatabases`, `listCollections`, `$collStats`,
`$indexStats` and `getIndexes` (e.g. `clusterMonitor` + read on the target DBs).

## Architecture

Everything lives in one IIFE in `indexStats.js`:

- **config** — `EXCLUDED_DBS` (admin/config/local), `MAX_TIME_MS` (per server call).
- **redundancy detection** — `isPlain` / `isStrictPrefix` / `findRedundant`. A plain
  index (no unique, sparse, partial, TTL, collation, wildcard, text, geo, hashed;
  not `_id_`) is flagged REDUNDANT when its key pattern is a strict prefix of
  another plain index. Single-field indexes are compared on field name only,
  since they are traversable in both directions.
- **main loop** — per database, per collection: one `$collStats` aggregation
  (index sizes, WT `file bytes available for reuse`, `bytes currently in the cache`),
  one `$indexStats` aggregation (ops + `since`), one `getIndexes()`. Shard results
  are merged: sizes/frag/cache summed, ops summed, `since` takes the minimum.
- **summary** — running `summary` object accumulates counters plus `unused`,
  `redundant` and `skipped` lists, printed at the end as drop candidates.

## Conventions to preserve when editing

- **Pure mongosh, no imports.** Only `db`, `print`, and standard JS.
- **Every server call carries `maxTimeMS`** so one stalled node cannot hang the run.
  Documented exception: mongosh's `getCollectionInfos`/`getIndexes` helpers accept no
  `maxTimeMS`. The raw `listCollections`/`listIndexes` commands do, but they return a
  cursor document, and reading only `cursor.firstBatch` would silently truncate a
  database with many collections or a collection with many indexes - missing
  collections mean missing indexes and wrong "unused" verdicts, worse than a rare
  stall on a metadata call. The per-database and per-collection try/catch bounds the
  damage instead.
- **Error isolation at both levels.** A throwing database or collection is caught,
  pushed to `summary.skipped` with `err.codeName ?? err.message`, and the run
  continues. Never let one namespace abort the report.
- **Views and `system.*` collections are filtered up front**, not handled by rescue
  in the catch block.
- **Output format** — every line starts with `|`, sections framed by `line`
  (96 `=`), sizes via `toMB()` (2 decimals). Keep the leading-`|` style if adding
  output.
- **Flags are advisory.** UNUSED is per-node since the counter reset; the report
  says so. Do not turn any of this into an automatic `dropIndex`.
