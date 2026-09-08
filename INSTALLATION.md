# Installing indexStats.js

There is nothing to build and nothing to install. `indexStats.js` is a single file you feed to
`mongosh`. It has no npm packages, no `package.json`, no compile step, and no runtime dependency
beyond the shell itself.

Once you have `mongosh` and the file, you are done. Everything below is either getting those two
things, or optional verification.

---

## 1. Prerequisites

### mongosh (required)

Verified against **mongosh 2.9.2**; anything on the 2.x line should work.

```bash
# macOS
brew install mongosh
```

```bash
# Debian / Ubuntu (after adding the MongoDB apt repository)
sudo apt-get install -y mongodb-mongosh
```

```bash
# RHEL / Rocky / Amazon Linux
sudo yum install -y mongodb-mongosh
```

Otherwise download it from <https://www.mongodb.com/try/download/shell>.

Confirm:

```bash
mongosh --version
```

### Node.js (optional — only to run the test suite)

**Node 20 or newer.** You do not need Node to *use* the script; it is only for `node --test`,
the end-to-end verifier, and previewing a report from a fixture. If you just want the report,
skip it.

### mongod (optional — only for the throwaway test cluster)

Needed for `e2e/cluster.sh`, which spins up a local three-member replica set. Not needed to run
against your own deployment.

---

## 2. Get the script

### Option A — clone the repo

Gets you the script plus tests and the end-to-end harness.

```bash
git clone https://github.com/iliangagliardi/indexStats.git
```

```bash
cd indexStats
```

### Option B — download the single file

Enough to run it. Good for a jump host.

```bash
curl -fsSLO https://raw.githubusercontent.com/iliangagliardi/indexStats/main/indexStats.js
```

### Option C — copy and paste

The script is deliberately self-contained so it can be pasted straight into a shell that has no
filesystem access — Compass's embedded shell, a container without `curl`, a locked-down bastion.
Copy the contents of `indexStats.js` and paste it in. See
[RUNNING-ON-REPLICA-SETS.md](RUNNING-ON-REPLICA-SETS.md#7-restricted-shells-compass--the-peer-payload-workflow)
for how a restricted shell still produces a cluster-wide report.

---

## 3. Create a user for it

The script only reads. It issues no write command and never drops an index. It needs:

| Purpose | Commands used |
|---|---|
| Member discovery | `hello`, `replSetGetConfig`, `serverStatus` |
| Namespace enumeration | `listDatabases`, `listCollections` |
| Index definitions | `listIndexes` |
| Usage counters | `$indexStats` |
| Sizes, fragmentation, cache | `$collStats` |
| Schema sampling (optional) | `$sample`, `$listCatalog` |

Two built-in roles cover all of it. Run this on the primary, as a user who can create users:

```js
db.getSiblingDB("admin").createUser({
  user: "svc_indexstats",
  pwd: passwordPrompt(),
  roles: [
    { role: "clusterMonitor",   db: "admin" },
    { role: "readAnyDatabase",  db: "admin" }
  ]
})
```

`passwordPrompt()` keeps the password out of your shell history and out of any file.

**`clusterMonitor` alone is not sufficient** — it does not grant `listCollections`, `listIndexes`
or `find`, so you would get an empty report. If granting `readAnyDatabase` is not acceptable,
substitute `read` on each database you want covered; the script simply skips what it cannot see
and lists every skipped namespace in the report's "gaps" panel.

To run without reading any documents at all, set `SAMPLE_SIZE = 0` in the script. You then need
only `clusterMonitor` plus `listCollections`/`listIndexes`, and you still get full usage, storage
and redundancy analysis — just no schema findings.

---

## 4. Configure the connection

For a replica set, the script opens its own connection to each member using a URI template with
`{host}` substituted in. Supply it via the environment so no password touches the file:

```bash
export INDEXSTATS_URI='mongodb://svc_indexstats:PASSWORD@{host}/?directConnection=true&appName=indexStats'
```

`{host}` is required, and `directConnection=true` is mandatory — without it the driver routes you
back to the primary and the same node gets polled repeatedly while the report claims to have
visited every member.

If you cannot set an environment variable (pasting into a GUI shell), edit `URI_TEMPLATE` at the
top of the file instead. The file then contains a live password — do not commit it.

Full details, including TLS, auth sources and why `mongodb+srv://` cannot be used as the template:
[RUNNING-ON-REPLICA-SETS.md](RUNNING-ON-REPLICA-SETS.md#3-the-connection-template).

---

## 5. Run it

```bash
mongosh "mongodb://any-member:27017/?directConnection=true" --quiet --file indexStats.js
```

Expected output:

```
report written to indexStats-report.html
10 indexes across 2 collections on 3/3 members
0 drop candidates, 6 inconclusive, 0 b reclaimable cluster-wide
```

`indexStats-report.html` is written next to the script. Open it in any browser — it is entirely
self-contained, makes no network requests, and works from `file://`.

If the shell cannot write files, the script prints the whole HTML document to the console instead,
prefixed with a line telling you to copy it into a `.html` file.

**Read the `N/M members` count first.** `3/3` means every data-bearing member answered; anything
less means verdicts have been deliberately downgraded because the evidence has a hole.

---

## 6. Verify the install (optional)

### Unit tests

From a clone, with Node 20+:

```bash
node --test
```

Expect 149 passing, 0 failing. Note the bare form: `node --test test/` fails on Node 26, which
rejects directory arguments.

### Against a throwaway replica set

Needs `mongod` on `PATH`. No containers involved; three plain `mongod --fork` processes on ports
27021-27023, one of them hidden.

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

The seed data deliberately includes redundant indexes, a typo'd index field, a mixed-type field,
an array field and a collection with a strict validator, so you can see every kind of finding in a
real report before pointing the script at production. `stop` removes all data.

On a cluster seeded minutes ago you should see **0 drop candidates** — every usage counter is
younger than the 14-day threshold, so nothing is eligible. That is the safety guard working, and
`e2e/verify.js` asserts it.

---

## 7. Upgrading and removing

**Upgrading** is replacing one file:

```bash
curl -fsSLO https://raw.githubusercontent.com/iliangagliardi/indexStats/main/indexStats.js
```

Check `SCRIPT_VERSION` at the top of the file, and re-apply any `URI_TEMPLATE` or config edits you
had made in place — another reason to prefer `INDEXSTATS_URI`.

**Removing** is deleting the file. Nothing was installed anywhere, no packages were added, and no
state was written to your cluster. Delete the generated `indexStats-report.html` too if it contains
namespace names you would rather not keep — it embeds the full report data as JSON.

---

## 8. Where to go next

- [RUNNING-ON-REPLICA-SETS.md](RUNNING-ON-REPLICA-SETS.md) — the connection template, which members
  get queried, how to read the verdicts, when to distrust the report, the Compass peer-payload
  workflow, Atlas caveats, the full configuration reference, and troubleshooting.
- Sharded clusters are not supported. The script detects a `mongos` and refuses rather than
  producing a partial report; run it against one shard's replica set at a time.
