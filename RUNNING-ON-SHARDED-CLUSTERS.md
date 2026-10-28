# Running indexStats.js against a sharded cluster

`indexStats.js` detects a `mongos` automatically (it looks at `hello().msg === 'isdbgrid'`) and
collects every shard, splitting index usage and storage out per shard rather than merging them
into one misleading bucket. Schema findings are not shard-attributed: they come from a single
sample taken per namespace through the router connection, the same as the one sample taken per
namespace on a replica set, and are not subject to the per-shard coverage reasoning in §4 below.

How much of the cluster it actually sees depends on whether it can open its **own** connection
straight to each shard's members, or only has the one connection you gave it, routed through the
router. Both are supported. They are not equally informative, and this page exists so you can tell
which one you got.

---

## 1. Atlas

```bash
mongosh "mongodb+srv://<user>@<cluster>.mongodb.net/" --quiet --file indexStats.js
```

That is the whole invocation — no template, no extra environment variable. Run it against the
Atlas connection string the way you'd normally connect.

**Atlas does not allow direct connections to shard members.** Every read your `mongosh` session
makes goes through `mongos`, and `mongos` picks exactly one member per shard to answer — by
default, the primary, because the SRV string carries no read preference. `indexStats.js` reports
that honestly: it records which member each shard was observed on and the read preference used,
and any index with zero recorded operations comes back `inconclusive` rather than `drop`, because
the shard's other members were never asked.

**That is the tool refusing to recommend dropping an index it could not fully verify — not the
tool failing.** An all-`inconclusive` report on Atlas is the expected, correct result of a
single-member-per-shard view, not a bug to work around by lowering the bar.

---

## 2. Widening Atlas coverage

```bash
mongosh "mongodb+srv://<user>@<cluster>.mongodb.net/?readPreference=secondaryPreferred" \
  --quiet --file indexStats.js
```

This is still routed through `mongos`, but now a secondary answers instead of the primary when one
is available. Each namespace's `$collStats`/`$indexStats` call is routed independently, so a single
run can genuinely observe more than one distinct secondary per shard. Each observed member is
recorded as a member in its own right, carrying only the namespaces it actually answered for — so
the evidence is attributed to the member that supplied it, and the shard's coverage counts the
members that genuinely reported something. The script never overrides the read preference your
connection string sets — whatever you pass is what gets recorded in the report and used to pick
which member answers.

It still does not reach **every** member of every shard, in general. `secondaryPreferred` just
means the primary is never selected while a secondary is available — it is not a guarantee that
every secondary gets a turn, so a shard can still come back `partial`. For a run that is guaranteed
to reach every member, see the next section.

---

## 3. On-prem: full coverage via `mongos` + `INDEXSTATS_URI`

```bash
INDEXSTATS_URI='mongodb://user:pass@{host}/?directConnection=true&appName=indexStats' \
  mongosh "mongodb://mongos-host:27017/" --quiet --file indexStats.js
```

Connect `mongosh` to a `mongos` as usual. The script asks that `mongos` for the shard list
(`listShards`), then for each shard whose members accept a direct connection, it reads that
shard's own replica-set config the same way it does on a plain replica set, substitutes each
member's **real address** into `{host}`, and opens its own connection to every one of them — not
just the one `mongos` would have routed to.

This is what buys full coverage and real `drop`/`likely-drop` recommendations: every data-bearing
member of every shard is actually queried, not just the one `mongos` happened to route to. A shard
whose members refuse the direct connection (credentials, firewall, no `Mongo` constructor
available) falls back to collection through `mongos` for that shard only — the rest of the cluster
keeps its full coverage.

This needs:

- **Network reach to every shard member's own address** — not just to the router.
- **Credentials valid against every shard member**, substituted into `{host}` the same way as on a
  replica set. See
  [RUNNING-ON-REPLICA-SETS.md §3](RUNNING-ON-REPLICA-SETS.md#3-the-connection-template) for
  `directConnection=true`, TLS, auth sources, and why `mongodb+srv://` cannot be used as the
  template itself.

---

## 4. Reading the shard coverage panel

The report has a "shard coverage" panel, one row per shard, alongside the usual per-replica-set
member list. Three coverage values:

| Coverage | Meaning |
|---|---|
| `full` | Every data-bearing member of this shard answered. Zero-op indexes on this shard can be judged unused. |
| `partial` | At least one data-bearing member was never consulted — typically the normal `mongos`-routed case, where only the read-preference-selected member answered, or one direct member genuinely failed. |
| `none` | Nothing answered for this shard at all — the whole shard is a blind spot. |

`full` means every data-bearing member of the shard supplied evidence of its own. Coverage is a
statement about members, not about any one index: a *second*, per-index gate still applies, so an
index no member of a shard reported on is `inconclusive` even where the shard as a whole is
`full`. That is the usual outcome of a `secondaryPreferred` run, where each namespace is answered
by one member and its siblings were never asked about that particular namespace.

**Any shard short of `full` downgrades zero-usage verdicts to `inconclusive` for every namespace it
hosts**, the same way an unreachable replica-set member does on a plain replica set. This is a
per-namespace gate, not a whole-report one: a namespace that lives only on fully-covered shards can
still get a real `drop` recommendation even while another shard elsewhere in the same cluster is
`partial`.

The panel also names the read preference used and which member(s) answered, so "why is this
`inconclusive`" is always answered on the page rather than left for you to guess.

---

## 5. Required privileges

Same role as a replica set (see
[INSTALLATION.md §3](INSTALLATION.md#3-create-a-user-for-it) — `clusterMonitor` + `readAnyDatabase`,
or `clusterMonitor` + `read` on each database you want covered), plus one more action, used only on
a sharded cluster:

| Used for | Command |
|---|---|
| Shard enumeration | `listShards` |

`listShards` is already included in the built-in `clusterMonitor` role, so if you provisioned the
user from INSTALLATION.md, there is nothing extra to grant.

---

## 6. The script never drops anything

Every verdict — `drop`, `likely-drop`, `redundant`, `inconclusive`, `mismatched`, `keep` — is a
label for you to read. `indexStats.js` issues no write command anywhere, on any topology, and never
calls `dropIndex`. The report's "copy `dropIndexes` commands" button only formats the shell
statements; running them is on you.

One sharded-specific thing worth knowing before you do: a `dropIndexes` command sent to a `mongos`
is routed to **every shard that holds the collection** and drops the index cluster-wide in one
shot — there is no way to drop it on just one shard through the router. That is exactly why full
coverage matters here: a verdict that only accounts for what one member per shard was doing is not
a safe basis for a command that touches the whole cluster at once.

---

## Trying it safely first

The repo ships a throwaway sharded cluster (two two-member shards plus a config server, all plain
`mongod --fork`/`mongos --fork` processes, no containers), parallel to the replica-set one in
[RUNNING-ON-REPLICA-SETS.md §12](RUNNING-ON-REPLICA-SETS.md#12-trying-it-safely-first):

```bash
./e2e/sharded.sh start
```

```bash
mongosh "mongodb://127.0.0.1:27030/" --quiet --file e2e/seed.js
```

```bash
INDEXSTATS_URI='mongodb://{host}/?directConnection=true' \
  mongosh "mongodb://127.0.0.1:27030/" --quiet --file indexStats.js
```

```bash
node e2e/verify.js indexStats-report.html
```

```bash
./e2e/sharded.sh stop
```

That run exercises **direct** collection — `INDEXSTATS_URI` reaches every shard member, so expect
`full` coverage on both shards. To see the **indirect**, Atlas-shaped path instead, run
`indexStats.js` without setting `INDEXSTATS_URI` (so direct shard connections aren't available and
every shard falls back to collection through the `mongos`), then verify with:

```bash
INDEXSTATS_E2E_MODE=indirect node e2e/verify.js indexStats-report.html
```

`e2e/verify.js` also honours `INDEXSTATS_E2E_REPORT` (the report path, used instead of the
positional argument — handy when invoking it from mongosh, where `argv[2]` is the connection string
rather than a filename) and `INDEXSTATS_E2E_EXPECT=unreachable` (asserts the unreachable-member
downgrade instead of the all-reachable case). Precedence is: the command-line argument, then
`INDEXSTATS_E2E_REPORT`, then the `indexStats-report.html` default.

As on the replica-set suite, the seed data is fresh, so every index's usage counter is younger than
the 14-day threshold — expect **0 drop candidates** on both runs. `stop` removes all data.
