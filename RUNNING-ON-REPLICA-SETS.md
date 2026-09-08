# Running indexStats.js against a replica set

`indexStats.js` collects index usage, storage and schema data from **every data-bearing member**
of a replica set in one run, then writes a single self-contained HTML report.

This is the whole point of v3: `$indexStats` counters are **per-node**. An index that looks
unused on the primary may be the one serving your BI tooling from a hidden analytics member.
A single-node report cannot tell you the difference, so it must never be used to justify a drop.

---

## 1. What you need

- **mongosh 2.x.** Verified against 2.9.2.
- **A user with these privileges**, cluster-wide and on every database you want covered:

  | Used for | Command / stage |
  |---|---|
  | member discovery | `hello`, `replSetGetConfig`, `serverStatus` |
  | namespace enumeration | `listDatabases`, `listCollections` |
  | index definitions | `listIndexes` (via `getIndexes()`) |
  | usage counters | `$indexStats` |
  | sizes, fragmentation, cache | `$collStats` |
  | schema sampling (optional) | `$sample`, `$listCatalog` |

  In practice: **`clusterMonitor` + `readAnyDatabase`**. `clusterMonitor` alone is not enough —
  it does not grant `listCollections`, `listIndexes` or `find`, so you would get an empty report.

  Nothing here writes. The script issues no write command, and never drops an index.

- **Network reach to each member's own address**, as it appears in `rs.conf()`. This matters more
  than it sounds — see the next section.

---

## 2. Quick start

```bash
INDEXSTATS_URI='mongodb://svc_monitor:PASSWORD@{host}/?directConnection=true&appName=indexStats' \
  mongosh "mongodb://any-member:27017/?directConnection=true" --quiet --file indexStats.js
```

You should see something like:

```
report written to indexStats-report.html
10 indexes across 2 collections on 3/3 members
0 drop candidates, 6 inconclusive, 0 b reclaimable cluster-wide
```

Open `indexStats-report.html` in a browser. It is fully self-contained: no CDN, no network calls,
works from `file://`, and adapts to your OS light/dark setting.

**Check the `N/M members` figure before trusting anything.** `3/3` means every data-bearing
member answered. `2/3` means one did not, and every zero-op verdict has been deliberately
downgraded to `inconclusive` — read [Section 6](#6-when-to-distrust-the-report) before acting.

---

## 3. The connection template

The script connects to the seed you launched `mongosh` against, reads `rs.conf()`, and then opens
its **own** connection to each member by substituting that member's `host:port` into a template.

Two rules:

**`{host}` is required.** The script throws `URI_TEMPLATE must contain {host}` without it.

**`directConnection=true` is mandatory.** Without it the driver performs replica-set discovery and
transparently routes you back to the primary — so the script would poll the *same node* N times
while believing it had visited N members, and silently report the primary's usage counters as
though they were the whole cluster. Keep it in.

### Supplying it

Prefer the environment variable, which overrides the in-file constant:

```bash
export INDEXSTATS_URI='mongodb://svc_monitor:PASSWORD@{host}/?directConnection=true&appName=indexStats'
```

Editing `URI_TEMPLATE` in the file works too, and is the only option when you are pasting the
script into a GUI shell — but the file then contains a live password. Do not commit it.

`appName=indexStats` is worth keeping: it is how you identify this tool's own connections in
`db.currentOp()` and the server log while it runs.

### TLS, auth sources, SRV

Any options a normal connection string takes are fine, since the template is used verbatim:

```bash
# TLS with a CA file, authenticating against admin
INDEXSTATS_URI='mongodb://svc:pw@{host}/?directConnection=true&tls=true&tlsCAFile=/etc/ssl/rs-ca.pem&authSource=admin'
```

`mongodb+srv://` will **not** work as a template. SRV records resolve to a seed list rather than a
single host, and the driver refuses the combination outright:

```
SRV URI does not support directConnection
```

Use the plain `mongodb://` form with `{host}`. You can still *launch* mongosh with an SRV URI —
only the fan-out template needs the direct form.

---

## 4. Which members get queried

| Member type | Queried? | Why |
|---|---|---|
| Primary | yes | |
| Secondaries | yes | |
| Hidden / priority-0 / delayed | **yes, by default** | The likeliest home of an index the primary never touches |
| Arbiters | no | No data |

The script sets `secondaryPreferred` on each connection; without it `$collStats` and `$indexStats`
are refused on a secondary.

Setting `INCLUDE_HIDDEN = false` stops the script contacting hidden members, but they are still
recorded as a gap in the report, and their absence still downgrades zero-op verdicts. That is
deliberate: excluding the analytics member from the *evidence* must not silently license a drop.

Document sampling runs on **one** member only — a hidden one if available, else a secondary, else
the primary — because document shape is replicated and this keeps the extra load off the primary.

---

## 5. Reading the report

Six verdicts, in the order the table ranks them:

| Verdict | Meaning |
|---|---|
| `drop` | Zero ops on every member, counters old enough, **and** redundant or on a suspect field |
| `likely-drop` | Zero ops on every member with old enough counters, on usage evidence alone |
| `review` | Still receiving operations, but a wider index covers it |
| `inconclusive` | The evidence has a hole — see below |
| `mismatched` | The definition differs across members, or is missing on some. Often an in-flight or stalled rolling index build |
| `keep` | In use |

Flags are independent of the verdict, and filterable: `redundant:duplicate|prefix|subsumed`,
`hidden`, `suspect-field`, `mismatched`, `used-only-on-hidden`.

`used-only-on-hidden` is the one to read carefully — every observed operation came from a hidden or
delayed member. A primary-only report would have called that index unused.

The **copy `dropIndexes` commands** button emits statements only for `drop` and `likely-drop`
indexes currently shown by your filter. It emits text for you to review; nothing is executed.

---

## 6. When to distrust the report

An index only ever becomes droppable when **all** of these hold:

1. Zero operations on every data-bearing member.
2. Every one of those members was actually reached **and** returned data for that index.
3. The youngest counter across members is at least `DROP_MIN_COUNTER_DAYS` (default 14) old.

Any hole gives `inconclusive` instead. The three that occur in practice:

- **A member was unreachable.** "Zero ops everywhere we looked" is not "zero ops everywhere".
- **A member was reached but a collection errored** — commonly a `$collStats` `MaxTimeMSExpired`
  on a very large collection. That member observed nothing for those indexes, so it cannot vouch
  for them.
- **A counter is too young.** `$indexStats` counters reset when `mongod` restarts. After a rolling
  restart *every* counter is young, and a zero there means nothing at all. This is why a freshly
  restarted cluster legitimately reports nothing as droppable.

The report states which of these applied, per index, in the row's drill-down — and banners
unreachable members at the top. If you see a banner, the answer is "not yet", not "probably fine".

---

## 7. Restricted shells (Compass) — the peer-payload workflow

Some embedded shells, including Compass's, forbid opening additional connections. The script
detects this and says so rather than pretending:

```
this shell analysed only mongo-01:27017: this shell forbids opening additional connections
(no Mongo constructor available, e.g. Compass's embedded shell) - use the peer-payload workflow below
```

It then prints its own findings between `PEER_PAYLOAD_BEGIN` and `PEER_PAYLOAD_END`. To assemble a
real cluster-wide report:

1. Run the script on **each** member in turn (connect Compass to that member directly).
2. Copy each run's payload — the JSON between the two markers.
3. In one final run, paste them into the `PEER_PAYLOADS` array near the top of the file:

   ```js
   const PEER_PAYLOADS = [
     '{"meta":{...},"members":[...],"indexes":[...]}',   // from mongo-02
     '{"meta":{...},"members":[...],"indexes":[...]}',   // from mongo-03
   ];
   ```

   Entries may be JSON strings or already-parsed objects. A bad entry is rejected by index
   (`PEER_PAYLOADS[1] must be a JSON string or a parsed object, got number`) rather than with a
   bare parse error.
4. Re-run. `meta.mode` becomes `merged-payloads`, and every verdict is **re-derived** from the
   union of all members' evidence.

Peer-supplied verdicts are never trusted — they are stripped and recomputed. If one member reports
an index as unused and another shows 9,000 operations against it, the merged answer is `keep`.

Pasting the same member's payload twice is harmless; a member no payload ever covers stays a
recorded gap and keeps blocking drops.

Two notes:

- If the shell also cannot write files, the script prints the whole HTML document to the output
  pane, prefixed with `this shell cannot write files - printing the report, copy it into a .html file`.
  Copy it into a file and open it.
- If a member cannot identify itself (no `hello.me`, no `serverStatus().host`), the script warns
  that `SEED_HOST` fell back to a placeholder. Set it manually to something unique per member
  before collecting payloads, or two members will collide on one identity during the merge.

---

## 8. MongoDB Atlas

Atlas needs care and is not fully supported:

- Members must be reachable individually with `directConnection=true`. On shared and some
  serverless tiers this is restricted, and analytics/hidden nodes may not be directly addressable.
- `$listCatalog` is typically unavailable — the script degrades gracefully, losing only multikey
  enrichment; sampled documents still detect arrays.
- Atlas hostnames are long; use the `{host}` template with `tls=true`.

Test with two members before assuming a full run works. If members come back unreachable, you get
an honest `inconclusive` report rather than a wrong one, but it is not much use.

---

## 9. Sharded clusters

Not supported, and refused explicitly rather than half-reported:

```
FATAL: connected to a mongos: sharded clusters are not supported, because rs.conf() does not
exist there - connect to a member of one shard instead
```

Run it against one shard's replica set at a time.

---

## 10. Configuration reference

All at the top of `indexStats.js`.

| Constant | Default | Effect |
|---|---|---|
| `URI_TEMPLATE` | `mongodb://user:pass@{host}/?directConnection=true&appName=indexStats` | Fan-out template. `{host}` required; overridden by `INDEXSTATS_URI` |
| `OUT_FILE` | `indexStats-report.html` | Written when the shell can write files |
| `EXCLUDED_DBS` | `admin`, `config`, `local` | Never scanned |
| `MAX_TIME_MS` | `30000` | Per server call, so one stalled node cannot hang the run |
| `INCLUDE_HIDDEN` | `true` | Query hidden/delayed members. See [Section 4](#4-which-members-get-queried) |
| `DROP_MIN_COUNTER_DAYS` | `14` | Minimum counter age before a drop may be recommended |
| `SAMPLE_SIZE` | `100` | Documents sampled per collection. `0` disables sampling entirely |
| `PEER_PAYLOADS` | `[]` | See [Section 7](#7-restricted-shells-compass--the-peer-payload-workflow) |

Set `SAMPLE_SIZE = 0` for a first run against an unfamiliar production cluster: it skips all
document reads, and you still get usage, storage and redundancy analysis.

---

## 11. Troubleshooting

| What you see | Cause | Fix |
|---|---|---|
| `member X unreachable: ...` and everything `inconclusive` | The fan-out connection to X failed | Check `URI_TEMPLATE` credentials, TLS options, and that X's `rs.conf()` address resolves from where you are running |
| `this shell CAN open connections, but the one built from URI_TEMPLATE did not work` | Template or credentials wrong | Fix `URI_TEMPLATE`, or set `INDEXSTATS_URI`, and re-run |
| `this shell forbids opening additional connections` | Restricted shell (Compass) | Use the [peer-payload workflow](#7-restricted-shells-compass--the-peer-payload-workflow) |
| `this shell analysed only X: the deployment is not a replica set` | Standalone `mongod` | Expected. Single-node mode; verdicts stay cautious |
| Report shows `N/M members` with N < M | Some member did not answer | Nothing is droppable until it does — that is the design, not a bug |
| Everything is `inconclusive` on a healthy cluster | Counters younger than 14 days, usually after a rolling restart | Wait, or lower `DROP_MIN_COUNTER_DAYS` knowing exactly what you are giving up |
| `URI_TEMPLATE must contain {host}` | Template has a fixed host | Replace the host with `{host}` |
| `FATAL: connected to a mongos` | Connected to a router | Connect to a shard member |
| `Connect to a database first: ...` | Run with no connection (e.g. `mongosh --nodb`) | Launch mongosh against a member |
| `FATAL: indexStats.js failed unexpectedly: ...` | A genuine error inside the run | The message carries the real cause; report it with the output |
| `sampling skipped: ...` | The connection used for sampling could not be opened at all, so no collection was sampled | Same causes as an unreachable member. Usage, storage and redundancy analysis are unaffected |
| No schema findings for some collections, but no error printed | Sampling failed for *that namespace only* (commonly `Unauthorized` on `$sample`, or `MaxTimeMSExpired`). It is recorded on the namespace, not printed | Grant read on those databases, or set `SAMPLE_SIZE = 0` to disable sampling deliberately rather than by accident |
| Report is missing collections you expect | Per-database or per-collection error, or a privilege gap | Open the "gaps in this report" panel — every skipped namespace is listed with its reason |

---

## 12. Trying it safely first

The repo ships a throwaway three-member replica set (one hidden), used by the end-to-end tests.
It needs `mongod` on `PATH` and no containers:

```bash
./e2e/cluster.sh start
```

```bash
mongosh "mongodb://127.0.0.1:27021/?directConnection=true" --quiet --file e2e/seed.js
```

```bash
INDEXSTATS_URI='mongodb://{host}/?directConnection=true' \
  mongosh "mongodb://127.0.0.1:27021/?directConnection=true" --quiet --file indexStats.js
```

```bash
node e2e/verify.js indexStats-report.html
```

```bash
./e2e/cluster.sh stop
```

It runs on ports 27021-27023, keeps its data under `$TMPDIR/indexstats-e2e`, and `stop` removes
everything. The seed data deliberately contains redundant indexes, a typo'd index field, a
mixed-type field, an array field, and a collection with a strict validator, so you can see each
finding in a report before pointing the script at anything you care about.

On a cluster seeded minutes ago you should see **0 drop candidates** — every counter is younger
than the threshold. That is the safety guard working, and `e2e/verify.js` asserts it.
