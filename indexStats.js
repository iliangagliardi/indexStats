/**
 * indexStats.js (v3)
 * Cluster-wide index usage, storage, redundancy and schema-consistency
 * report, rendered as a single self-contained HTML file. Runs against a
 * standalone, a replica set, or a sharded cluster (point it at a mongos).
 *
 * Run:
 *   mongosh "<connection-string>" --quiet --file indexStats.js
 *
 * What it does:
 *   - classifies the deployment from hello() and takes the matching path:
 *     - standalone or replica set: discovers every member (replSetGetConfig)
 *       and, when the shell can open extra connections (new Mongo(...)), fans
 *       out to each reachable member instead of reporting only the seed node
 *     - sharded cluster: enumerates the shards (listShards), then collects
 *       each shard one of two ways - DIRECTLY, opening its own connection to
 *       every member of that shard's replica set exactly as above, which is
 *       the only way to get full coverage; or INDIRECTLY through the mongos,
 *       splitting the `shard` and `host` fields that $collStats/$indexStats
 *       attach to every document back out per member. The choice is made per
 *       shard, by probing that shard: one whose members refuse a direct
 *       connection (Atlas, a firewall, credentials URI_TEMPLATE does not
 *       carry) falls back to the mongos on its own, and the rest of the
 *       cluster keeps its full coverage
 *   - per member: one $collStats aggregation (index sizes, WT fragmentation,
 *     WT cache bytes), one $indexStats aggregation (ops + counter start time),
 *     one getIndexes() - merged across members, and across shards, into one
 *     cluster-wide view
 *   - samples documents ($sample) and reads collection validators on one
 *     reachable member (preferring a hidden member, to spare the primary) to
 *     flag indexes on fields that are rare, absent, or excluded by a strict
 *     validator
 *   - flags per index: zero ops on every reachable, observed member since the
 *     counter reset; redundant (a plain index that is a duplicate of, is
 *     subsumed by, or is a strict prefix of another plain index - see
 *     classifyRedundancy for the duplicate/subsumed/prefix classes); hidden;
 *     used-only-on-hidden; suspect-field (a key field absent from every
 *     sampled document, or excluded by a closed validator); and mismatched
 *     (the index's definition differs across members, or a reachable member
 *     was never observed for it at all - never a droppable verdict), rolled
 *     into an advisory verdict (drop / likely-drop / redundant / mismatched /
 *     inconclusive / keep)
 *   - on a sharded cluster, records per-shard coverage ('full' / 'partial' /
 *     'none') with the members observed and the read preference used, and
 *     renders it as its own panel so "why is this inconclusive" is always
 *     answered on the page
 *   - writes the report to OUT_FILE via require('fs') when the shell allows
 *     file access, otherwise prints the whole HTML document to the console
 *
 * Safety:
 *   - read-only: never mutates data, never drops anything - all output is advisory
 *   - views and system collections excluded up front
 *   - only a shard whose every data-bearing member was observed ('full'
 *     coverage) can carry a droppable verdict, exactly as an unreachable
 *     member blocks one on a replica set
 *   - per-database, per-collection, per-member, per-shard and
 *     per-namespace-sample error isolation (one bad namespace, unreachable
 *     member or unreachable shard never kills the run)
 *   - maxTimeMS on every server call so a stalled node cannot hang the report,
 *     with one documented exception: mongosh's getCollectionInfos()/getIndexes()
 *     helpers accept no maxTimeMS parameter
 *   - flags are advisory only and reset-sensitive (UNUSED reflects ops since
 *     the last counter reset on each node) - this script never runs dropIndex
 */

(function indexStats() {
  // ----------------------------- configuration -----------------------------
  const EXCLUDED_DBS = new Set(['admin', 'config', 'local']);
  const MAX_TIME_MS = 30000; // per server call
  const SCRIPT_VERSION = '3.1.0';
  // WARNING: this template holds a credentials placeholder ("user:pass") - do
  // not commit this file with a real password filled in. Override at runtime
  // via the INDEXSTATS_URI environment variable instead of editing in place.
  const URI_TEMPLATE = 'mongodb://user:pass@{host}/?directConnection=true&appName=indexStats';
  const OUT_FILE = 'indexStats-report.html';
  const INCLUDE_HIDDEN = true;
  const DROP_MIN_COUNTER_DAYS = 14;
  const SAMPLE_SIZE = 100;
  // Escape hatch for shells that cannot open connections to other members
  // (e.g. Compass's embedded shell): paste each member's own run's printed
  // PEER_PAYLOAD block in here to get a merged, cluster-wide report.
  const PEER_PAYLOADS = [];
  // --------------------------------------------------------------------------

  // ------------------------------ live layer --------------------------------
  // Talks to a real (or fake, in tests) MongoDB connection: capability probing,
  // topology detection, replica-set member discovery and shard enumeration,
  // and per-member collection of index metadata - whether that member is
  // reached directly or observed through a mongos.

  // FINDING 5 (final review, important): this used to probe with
  // `new MongoCtor(seedHost)` - a bare host, no credentials, no
  // directConnection - so canOpenConnections came back true even when every
  // real fan-out connection (built from URI_TEMPLATE, with credentials) would
  // fail authentication. Probe with the ACTUAL template the run will use
  // instead, and distinguish the two ways opening it can fail, because they
  // demand different remedies: no Mongo constructor at all (Compass-style
  // embedded shell - use the peer-payload workflow) versus Mongo exists but
  // the URI_TEMPLATE-built connection string didn't work (fix
  // URI_TEMPLATE/credentials). The caller signals "no constructor" by handing
  // in a stub that throws exactly `new Error('no Mongo')` (see main()) - when
  // the thrown message doesn't match that marker, we cannot honestly tell the
  // two causes apart, so we say so via 'unknown' rather than guessing.
  function probeCapabilities({ requireFn, MongoCtor, uriTemplate, seedHost }) {
    var fsModule = null;
    try { fsModule = requireFn('fs'); } catch (e) { fsModule = null; }
    var canOpen = false;
    var connectionBlockedReason = null;
    try {
      const uri = uriFor(uriTemplate, seedHost);
      new MongoCtor(uri);
      canOpen = true;
    } catch (e) {
      canOpen = false;
      const msg = e && e.message ? e.message : String(e);
      connectionBlockedReason = msg === 'no Mongo' ? 'no-mongo-constructor'
        : msg.includes('URI_TEMPLATE must contain {host}') ? 'template-invalid'
        : 'template-failed';
    }
    return {
      canWriteFiles: Boolean(fsModule && fsModule.writeFileSync),
      canOpenConnections: canOpen,
      connectionBlockedReason,
      fs: fsModule,
    };
  }

  function uriFor(template, host) {
    if (!String(template).includes('{host}')) {
      throw new Error('URI_TEMPLATE must contain {host}');
    }
    return String(template).split('{host}').join(host);
  }

  // FINDING 4 (final whole-branch review, important): MAX_TIME_MS bounds every
  // server call but cannot bound `new Mongo(uri)` - only the driver's
  // server-selection timeout does, and the shipped URI_TEMPLATE sets none. On
  // exactly the deployment the sharded path targets - Atlas, or any firewalled
  // cluster, where the per-shard probe MUST fail for the indirect design to
  // engage - every shard burns that timeout in turn, sequentially, before
  // falling back. Bind it explicitly on the PROBE rather than inheriting
  // whatever the host shell happens to default to. The shipped template, and
  // therefore every replica-set connection and every real per-member
  // collection connection, is left exactly as the user wrote it, so
  // replica-set timing is untouched.
  //
  // WHY 2000 AND NOT 30000 (measured 2026-10-28, mongosh 2.13.0, against a
  // real sharded cluster plus a TCP listener that accepts and never replies -
  // the only way to produce a genuine stall, since an unroutable address fails
  // fast with ENETUNREACH instead): the Node driver's documented default IS
  // 30s, but mongosh does NOT use it. With no option in the URI, mongosh's own
  // probe failed with "Server selection timed out after 2000 ms". A 3000ms
  // value - the obvious "short" choice - therefore made the probe SLOWER than
  // doing nothing on this shell. 2000 matches what mongosh itself applies, and
  // is the right bound on its own merits: if a shard cannot be selected inside
  // it, the real collection connections built from the same template - which
  // carry no timeout and so inherit the same shell default - would not have
  // reached it either. The value earns its keep on a shell whose default is
  // the driver's 30s (or none at all), where it is the difference between a
  // bounded fallback and minutes of apparent hang.
  const PROBE_SELECTION_TIMEOUT_MS = 2000;

  // Pure. A template may already carry a query string ('...{host}/?directConnection=true'),
  // may already set the option itself (in which case the user's value wins),
  // or may have no path separator at all ('mongodb://{host}') - which needs a
  // '/' inserted before any '?', or the URI is malformed.
  function probeUriFor(template, host, timeoutMs) {
    const uri = uriFor(template, host);
    if (uri.includes('serverSelectionTimeoutMS=')) return uri;
    if (uri.includes('?')) return `${uri}&serverSelectionTimeoutMS=${timeoutMs}`;
    const schemeEnd = uri.indexOf('://');
    const rest = schemeEnd === -1 ? uri : uri.slice(schemeEnd + 3);
    return `${uri}${rest.includes('/') ? '' : '/'}?serverSelectionTimeoutMS=${timeoutMs}`;
  }

  // Verified against a live mongod (mongosh 2.9.2): `db.getMongo().host` is
  // `undefined`, so it cannot be trusted to identify the seed member. An
  // undefined SEED_HOST means `discoverMembers`' single-node fallback labels
  // its member 'seed' for every host, which would make payloads pasted from
  // different members collide on one host key and silently keep a one-node
  // report while claiming 'merged-payloads'. Fall through a chain of real
  // sources instead, each wrapped so a privilege error tries the next rather
  // than aborting the run:
  //   1. hello.me - set on replica-set members, and it is exactly the
  //      host:port form replSetGetConfig uses, so identities match.
  //   2. serverStatus().host - verified against a real mongod to return the
  //      server's own host:port, e.g. "mongo-01:27017".
  //   3. only as a last resort, a clearly-synthetic literal - callers must
  //      treat `synthetic: true` as a signal to warn the user to set
  //      SEED_HOST manually before pasting peer payloads, or the merge will
  //      silently collide.
  function deriveSeedHost(adminDb, dbHandle, config) {
    try {
      const me = adminDb.runCommand({ hello: 1, maxTimeMS: config.MAX_TIME_MS }).me;
      if (me) return { host: me, synthetic: false };
    } catch (e) { /* fall through to serverStatus */ }
    try {
      const host = dbHandle.serverStatus({ maxTimeMS: config.MAX_TIME_MS }).host;
      if (host) return { host, synthetic: false };
    } catch (e) { /* fall through to the synthetic literal */ }
    return { host: 'unidentified-seed', synthetic: true };
  }

  // Pure: classify the deployment from a raw `hello` document. A mongos
  // identifies itself with msg: 'isdbgrid'; a replica-set member always
  // reports its setName. Anything else is a standalone. Defensive about a
  // missing document so a privilege-stripped hello can never throw here.
  function detectTopology(hello) {
    if (!hello || typeof hello !== 'object') return 'standalone';
    if (hello.msg === 'isdbgrid') return 'sharded';
    if (hello.setName) return 'replica-set';
    return 'standalone';
  }

  // Pure: `listShards` reports each shard's members as a single string,
  // "shardName/h1:27017,h2:27017" for a replica-set shard or a bare
  // "h1:27017" for a single-host one. This is the ONLY way to learn a
  // shard's members from a mongos - replSetGetConfig does not exist there -
  // so parsing it is what makes the whole sharded path possible.
  function parseShardHost(hostString) {
    const raw = typeof hostString === 'string' ? hostString : '';
    const slash = raw.indexOf('/');
    const setName = slash === -1 ? null : raw.slice(0, slash);
    const hostPart = slash === -1 ? raw : raw.slice(slash + 1);
    const hosts = hostPart.split(',')
      .map((h) => h.trim())
      .filter((h) => h.length > 0);
    return { setName: setName || null, hosts };
  }

  // Pure. VERIFIED BUG (Task 12, real 8.0.21 sharded cluster - the first time
  // the indirect path ever met a real mongos): `listShards` reports each shard's
  // members using the spelling the shard was REGISTERED with, while $collStats
  // and $indexStats tag every document with the mongod's OWN idea of its address.
  // Those two are routinely different - a cluster added as
  // "shardA/127.0.0.1:27031,127.0.0.1:27032" answers with
  // host "mongo-host-01:27031" - and comparing them by string equality marked
  // EVERY member of every indirect shard unreachable, which silently discarded
  // the entire payload (see collectSharded's indirect branch for the damage).
  //
  // Map an observed host back to the configured member it must be: an exact
  // match first, then - only when the shard's configured hosts use DISTINCT
  // ports, which makes the port a unique member identifier within that shard -
  // a port match. Atlas-style shards, where every member listens on 27017,
  // never reach the port branch: there it is the hostnames that differ and they
  // already match exactly. Anything unmatched is returned UNCHANGED, so the
  // caller can record it as a member in its own right rather than throwing its
  // evidence away - erring toward an extra, honestly-labelled member entry and
  // partial coverage, never toward silent data loss.
  function canonicalObservedHost(observed, configuredHosts) {
    const hosts = configuredHosts ?? [];
    if (typeof observed !== 'string' || observed.length === 0) return observed;
    if (hosts.includes(observed)) return observed;
    const colon = observed.lastIndexOf(':');
    if (colon === -1) return observed;
    const port = observed.slice(colon + 1);
    const samePort = hosts.filter((h) =>
      typeof h === 'string' && h.lastIndexOf(':') !== -1
      && h.slice(h.lastIndexOf(':') + 1) === port);
    return samePort.length === 1 ? samePort[0] : observed;
  }

  // Pure: reconcile EVERY host a shard's documents named onto that shard's
  // configured member list in one go, and say whether anything weaker than
  // string equality was needed.
  //
  // Doing it per shard rather than per host is what makes collisions visible.
  // The indirect path now keys one node per (shard, host) - see
  // collectFromMongos - so two distinct observed hosts inferred onto the SAME
  // configured member would silently collapse two members' evidence under one
  // key in mergeNodes' byHost map, losing one of them. When that happens the
  // whole shard falls back to the hosts' own spellings: both nodes stay
  // distinct, no evidence is lost, and `inferred` keeps the shard short of
  // 'full' coverage so nothing droppable can rest on the ambiguity.
  function reconcileShardHosts(observedHosts, configuredHosts) {
    const hosts = observedHosts ?? [];
    const configured = configuredHosts ?? [];
    const mapped = hosts.map((h) => canonicalObservedHost(h, configured));
    const collides = new Set(mapped).size !== mapped.length;
    const map = {};
    let inferred = collides;
    hosts.forEach((h, i) => {
      const canon = collides ? h : mapped[i];
      map[h] = canon;
      if (canon !== h || !configured.includes(canon)) inferred = true;
    });
    return { map, inferred };
  }

  // Pure. VERIFIED BUG (Task 12, same run): `probeCapabilities` answers "can
  // this shell open another connection?" by opening ONE connection built from
  // URI_TEMPLATE and `deriveSeedHost`. On a replica set that seed is a real
  // member out of rs.conf, so the conflation is sound. On a mongos it is the
  // ROUTER's own serverStatus().host - a host this run never connects to, and
  // frequently not even resolvable from the client: reached over
  // "mongodb://127.0.0.1:27030" a real mongos self-reported a bare hostname
  // that failed with getaddrinfo ENOTFOUND, so canOpenConnections came back
  // false and EVERY shard was downgraded to indirect collection even though
  // `new Mongo('mongodb://127.0.0.1:27031/?directConnection=true')` succeeded
  // from that very shell. collectSharded already probes each shard against that
  // SHARD's own host and falls back per shard, so the only capability that may
  // gate it is whether a Mongo constructor exists at all. A router probe that
  // failed on the URI (template-failed) says nothing about the shards; no
  // constructor at all, or a template with no {host} to substitute, still does.
  function canProbeShardsDirectly(caps) {
    if (!caps) return false;
    return Boolean(caps.canOpenConnections)
      || caps.connectionBlockedReason === 'template-failed';
  }

  // Enumerates the cluster's shards from a mongos. Deliberately does NOT
  // catch: unlike `discoverMembers`, where "no replication configured" is a
  // legitimate standalone, there is no safe degraded reading of a failed
  // listShards on a mongos - reporting a subset of shards as if it were the
  // cluster is exactly the mistake that leads to dropping an index another
  // shard still uses. Let it propagate to main()'s FATAL handler.
  function discoverShards(adminDb, config) {
    const res = adminDb.runCommand({ listShards: 1, maxTimeMS: config.MAX_TIME_MS });
    const entries = res.shards ?? [];
    return entries.map((s) => {
      const parsed = parseShardHost(s.host);
      return {
        name: s._id,
        setName: parsed.setName,
        hosts: parsed.hosts,
        state: Number(s.state ?? 1),
        // A draining shard still holds data and still has indexes, so it is
        // collected like any other; `draining` is surfaced in the report so a
        // reader can discount it, not used to skip the shard.
        draining: Boolean(s.draining),
      };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  // Pure: the hybrid decision itself. A shard whose members accept a direct
  // connection is collected member by member, for full coverage; anything else
  // - Atlas refusing direct shard access, a firewall, wrong credentials in
  // URI_TEMPLATE, or a shell that cannot open connections at all - falls back
  // to collection through the mongos, with the reduced coverage that implies.
  function selectShardMode(probeResult) {
    return probeResult && probeResult.ok ? 'direct' : 'indirect';
  }

  // No mongos guard here any more: main() classifies the deployment with
  // detectTopology before it decides which collection path to take, so this
  // function is only ever handed a replica-set member or a standalone - and on
  // a sharded cluster it is reused, unchanged, to enumerate each shard's own
  // replica set from a direct connection to one of its members.
  function discoverMembers(adminDb, config) {
    let rsConfig = null;
    try {
      rsConfig = adminDb.runCommand({ replSetGetConfig: 1, maxTimeMS: config.MAX_TIME_MS }).config;
    } catch (e) {
      // Only these two codes genuinely mean "no replication is configured here" -
      // fall back to single-node mode. Anything else (Unauthorized,
      // AuthenticationFailed, a network blip, ...) must NOT be treated the same way:
      // silently downgrading a real replica set to a one-node "standalone" report
      // is exactly the failure this tool exists to prevent - a user could then drop
      // an index that another member still relies on. Re-throw with the original
      // message/codeName so the caller (main(), Task 9) surfaces it as fatal.
      if (e.codeName === 'NoReplicationEnabled' || e.codeName === 'NotYetInitialized') {
        rsConfig = null;
      } else {
        throw e;
      }
    }
    if (!rsConfig) {
      return {
        replicaSetName: 'standalone',
        mode: 'single-node',
        members: [{ id: 0, host: config.SEED_HOST ?? 'seed', role: 'unknown', hidden: false,
                    delaySecs: 0, votes: 1, reachable: true, error: null }],
        excludedByConfig: [],
      };
    }
    const toMember = (m) => ({
      id: m._id, host: m.host, role: 'unknown', hidden: Boolean(m.hidden),
      delaySecs: Number(m.secondaryDelaySecs ?? m.slaveDelay ?? 0),
      votes: Number(m.votes ?? 1), reachable: false, error: null,
    });
    const votingMembers = rsConfig.members.filter((m) => !m.arbiterOnly);
    const members = votingMembers
      .filter((m) => config.INCLUDE_HIDDEN || !m.hidden)
      .map(toMember);
    // FINDING 4 (final review, important): when INCLUDE_HIDDEN is false, the
    // hidden members filtered out above used to vanish from the accounting
    // entirely - they never appear in gaps.unreachableMembers either, so a
    // zero-ops index goes straight to drop/likely-drop while the hidden
    // analytics member (the likeliest actual user of that index) was never
    // consulted, and nothing in the report says so. Surface them as a
    // distinct, config-caused gap - shaped exactly like an unreachable member
    // so the existing ctx.unreachableHosts safety gate in deriveVerdict
    // downgrades affected verdicts, and renderMembers/renderGapsPanel show
    // the hole - but keep them OUT of `members` (main()'s connection
    // targets), since INCLUDE_HIDDEN=false means "never contact these", not
    // just "don't count them".
    const excludedByConfig = config.INCLUDE_HIDDEN ? [] : votingMembers
      .filter((m) => m.hidden)
      .map((m) => ({
        ...toMember(m),
        reachable: false,
        error: 'excluded by INCLUDE_HIDDEN=false configuration - never contacted, not unreachable',
      }));
    return { replicaSetName: rsConfig._id, mode: 'multi-node', members, excludedByConfig };
  }

  // Controller ruling R2: member identity comes from the replica-set config,
  // passed in explicitly as `host`, not from `conn.host` (unverified in mongosh).
  // The explicit argument wins; conn.host remains only as a fallback.
  function collectFromNode(conn, config, host) {
    conn.setReadPref('secondaryPreferred');
    const result = { host: host ?? conn.host, namespaces: [], collections: {}, skipped: [] };
    const excluded = new Set(config.EXCLUDED_DBS);

    // Bug fixed by real-cluster testing (Task 11): Mongo connection objects in
    // mongosh have no .adminCommand of their own - only Database objects do
    // (conn.getDB(name).adminCommand). Calling it directly on `conn` throws
    // "conn.adminCommand is not a function" on every real member; the unit-test
    // mock had wired a fake `adminCommand` straight onto its fake conn, matching
    // the bug instead of catching it.
    const dbNames = conn.getDB('admin')
      .adminCommand({ listDatabases: 1, nameOnly: true, maxTimeMS: config.MAX_TIME_MS })
      .databases.map((d) => d.name).filter((n) => !excluded.has(n)).sort();

    for (const dbName of dbNames) {
      let collNames = [];
      try {
        // R10, empirically verified against a real mongod (v8.0.21, see CLAUDE.md
        // "The documented maxTimeMS exception"): getCollectionInfos's signature DOES
        // end in an options-shaped 4th argument that accepts { maxTimeMS } without
        // throwing, but it is NOT forwarded/enforced server-side - confirmed by
        // driving it against the maxTimeAlwaysTimeOut failpoint (which does throw
        // MaxTimeMSExpired for a raw listCollections + maxTimeMS call) and observing
        // it return normally regardless. Using the raw listCollections command
        // instead would let maxTimeMS actually work, but that command returns a
        // cursor document, and reading only cursor.firstBatch would silently
        // truncate on a database with more collections than fit in one batch -
        // missing collections here mean missing indexes and wrong "unused" verdicts,
        // which is worse than a rare, unbounded stall on a metadata call. The
        // per-database try/catch below is what bounds that risk instead.
        collNames = conn.getDB(dbName)
          .getCollectionInfos({ type: 'collection' }, true)
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
          // Same R10 trade-off as getCollectionInfos above, same empirical result:
          // getIndexes({ maxTimeMS }) does not throw, but does not enforce the
          // timeout either (verified against the maxTimeAlwaysTimeOut failpoint).
          // The raw listIndexes command's cursor.firstBatch would silently truncate
          // a collection with many indexes. The per-collection try/catch below is
          // what bounds the damage of a stall here, not maxTimeMS.
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

  // Collects every namespace through a mongos, splitting the results per
  // shard. Deliberately does NOT call conn.setReadPref: the whole point of
  // the indirect path is to observe the cluster exactly as the user's own
  // connection string does, and to REPORT the read preference rather than
  // quietly widen it. Changing it here would make the coverage we report a
  // fiction.
  function collectFromMongos(conn, config, shardNames) {
    const excluded = new Set(config.EXCLUDED_DBS);
    // FINDING 1 (final whole-branch review, CRITICAL): this used to model each
    // shard as exactly ONE node, keyed by the first host it ever saw, while
    // still accumulating EVERY host it saw into observedByShard. mongos routes
    // each namespace's aggregation independently, so any read preference that
    // can select more than one member per shard (secondaryPreferred, nearest)
    // made those two disagree: one node ended up carrying namespaces that
    // several different members had answered, every one of those hosts was
    // then marked a reachable member off the back of that single node, and the
    // shard could claim coverage 'full' - the one value that unlocks a drop -
    // on one member's evidence, while the report credited each namespace to
    // whichever member happened to answer first.
    //
    // Key nodes per (shard, host) instead. Each observed host gets its own
    // node carrying only the namespaces it actually answered, exactly like a
    // directly-collected replica-set member, so attribution, reachability and
    // coverage are all derived from the same evidence - and secondaryPreferred
    // genuinely widens coverage within one run, as the docs promise.
    const nodesByShard = new Map();
    const observedByShard = {};
    // Router-level failures - a database that could not be listed, a namespace
    // whose aggregation threw - belong to no single member, and a shard's
    // hosts are not all known until the whole sweep is done. Collect them per
    // shard and attach them to every one of that shard's nodes at the end.
    const skippedByShard = new Map();
    const shardSeen = (shard) => {
      if (!nodesByShard.has(shard)) {
        nodesByShard.set(shard, new Map());
        skippedByShard.set(shard, []);
        observedByShard[shard] = {
          hosts: [], attributedHosts: [], ambiguousHosts: [],
          unattributed: false, ambiguous: false,
        };
      }
      return observedByShard[shard];
    };
    for (const name of shardNames ?? []) shardSeen(name);
    // `host` is null when the documents carried no host field at all. The node
    // still has to exist - its evidence is real - but it is keyed to a
    // synthetic identity and kept out of attributedHosts, so it can never be
    // reported as a reachable member.
    const nodeFor = (shard, host) => {
      const seen = shardSeen(shard);
      const nodes = nodesByShard.get(shard);
      const key = host ?? `${shard}/unattributed`;
      if (!nodes.has(key)) {
        nodes.set(key, { host: key, shard, namespaces: [], collections: {}, skipped: [] });
        if (host && !seen.attributedHosts.includes(host)) seen.attributedHosts.push(host);
      }
      return nodes.get(key);
    };

    const dbNames = conn.getDB('admin')
      .adminCommand({ listDatabases: 1, nameOnly: true, maxTimeMS: config.MAX_TIME_MS })
      .databases.map((d) => d.name).filter((n) => !excluded.has(n)).sort();

    for (const dbName of dbNames) {
      let collNames = [];
      try {
        // Same documented R10 exception as collectFromNode: these helpers accept
        // { maxTimeMS } but do not enforce it, and the raw commands would
        // truncate at one cursor batch. The try/catch is what bounds the risk.
        collNames = conn.getDB(dbName)
          .getCollectionInfos({ type: 'collection' }, true)
          .map((c) => c.name).filter((n) => !n.startsWith('system.')).sort();
      } catch (e) {
        const reason = e.codeName ?? e.message;
        for (const list of skippedByShard.values()) list.push({ ns: dbName, reason });
        continue;
      }

      for (const collName of collNames) {
        const ns = `${dbName}.${collName}`;
        let demuxed;
        try {
          const coll = conn.getDB(dbName).getCollection(collName);
          const collStatsDocs = coll
            .aggregate([{ $collStats: { storageStats: {} } }], { maxTimeMS: config.MAX_TIME_MS })
            .toArray();
          const indexStatsDocs = coll
            .aggregate([{ $indexStats: {} }], { maxTimeMS: config.MAX_TIME_MS })
            .toArray();
          demuxed = demuxShardStats(collStatsDocs, indexStatsDocs);
        } catch (e) {
          const reason = e.codeName ?? e.message;
          for (const list of skippedByShard.values()) list.push({ ns, reason });
          continue;
        }

        for (const [shard, data] of Object.entries(demuxed.byShard)) {
          const seen = shardSeen(shard);
          for (const h of data.hosts) {
            if (!seen.hosts.includes(h)) seen.hosts.push(h);
          }
          if (demuxed.unattributed) seen.unattributed = true;
          // mongos routes one namespace's aggregation to one member, so a
          // (shard, namespace) pair normally names exactly one host. When it
          // does not - no host field at all, or $collStats and $indexStats
          // answered by two DIFFERENT members of the same shard, which
          // demuxShardStats has already blended into one entry - no single
          // member can honestly be credited with the result. Throwing the
          // entry away is the Task 12 blank-report bug, so keep it: attribute
          // it to the first host for determinism, record the rest as
          // ambiguous (they are observed, but they get no node and so can
          // never be claimed as reachable members), and flag the shard so
          // buildShardRecord can never call it fully covered.
          if (data.hosts.length !== 1) {
            seen.ambiguous = true;
            for (const h of data.hosts.slice(1)) {
              if (!seen.ambiguousHosts.includes(h)) seen.ambiguousHosts.push(h);
            }
          }
          const node = nodeFor(shard, data.hosts.length ? data.hosts[0] : null);
          node.namespaces.push(ns);
          node.collections[ns] = {
            indexes: data.indexes, usage: data.usage, storage: data.storage, error: null,
          };
        }
      }
    }

    const nodeResults = [];
    for (const [shard, nodes] of nodesByShard) {
      // A shard that answered nothing still needs a stable identity: without
      // one it would vanish from the payload and its skipped entries with it.
      if (nodes.size === 0) {
        const host = `${shard}/unobserved`;
        nodes.set(host, { host, shard, namespaces: [], collections: {}, skipped: [] });
      }
      const shardSkips = skippedByShard.get(shard) ?? [];
      for (const node of nodes.values()) {
        node.skipped = node.skipped.concat(shardSkips);
        nodeResults.push(node);
      }
    }
    return { nodeResults, observedByShard };
  }

  // Live-layer orchestration of the hybrid strategy, one decision per shard.
  // Kept deliberately thin: every judgement it makes comes from a pure,
  // separately tested function, because this glue layer is where every real
  // bug in this project has been found. MongoCtor and printFn are arguments,
  // never the ambient `Mongo`/`print`, so the whole thing stays testable.
  function collectSharded({ conn, config, shards, MongoCtor, canOpenConnections,
                            readPref, printFn }) {
    const members = [];
    const nodeResults = [];
    const shardRecords = [];
    const indirect = [];

    for (const shard of shards) {
      const probe = { ok: false, error: 'connections not available' };
      if (canOpenConnections && shard.hosts.length) {
        try {
          // Bounded: see probeUriFor. Only this throwaway probe connection
          // gets the short server-selection timeout - the collection
          // connections below use the user's template verbatim.
          new MongoCtor(probeUriFor(config.URI_TEMPLATE, shard.hosts[0],
            PROBE_SELECTION_TIMEOUT_MS));
          probe.ok = true;
          probe.error = null;
        } catch (e) {
          probe.error = e && e.message ? e.message : String(e);
        }
      }

      if (selectShardMode(probe) === 'indirect') {
        indirect.push(shard);
        printFn(`shard ${shard.name}: collecting through mongos (${probe.error})`);
        continue;
      }

      // Direct: each shard is an ordinary replica set, so reuse the existing,
      // unchanged fan-out wholesale.
      const observed = [];
      const shardMembers = [];
      let shardError = null;
      try {
        const seedConn = new MongoCtor(uriFor(config.URI_TEMPLATE, shard.hosts[0]));
        // SEED_HOST must be shard-scoped here. The enclosing config's SEED_HOST
        // identifies the MONGOS this run connected to, not this shard - so if a
        // shard ever takes discoverMembers' single-node fallback (replSetGetConfig
        // reports NoReplicationEnabled, i.e. a bare standalone shard), that
        // fallback would label the shard's one member with the ROUTER's host.
        // buildShardRecord would then compare that fabricated identity against
        // itself, report coverage 'full', and unlock drop verdicts for a shard
        // nobody actually identified. Same failure class as the real-cluster bug
        // behind selectCollectionTargets: identity must never be inherited from
        // whichever connection happened to be in scope.
        const discovered = discoverMembers(seedConn.getDB('admin'),
          { ...config, SEED_HOST: shard.hosts[0] });
        for (const member of discovered.members) {
          member.shard = shard.name;
          shardMembers.push(member);
          try {
            const memberConn = new MongoCtor(uriFor(config.URI_TEMPLATE, member.host));
            const hello = memberConn.getDB('admin')
              .runCommand({ hello: 1, maxTimeMS: config.MAX_TIME_MS });
            member.role = (hello.isWritablePrimary || hello.ismaster) ? 'primary' : 'secondary';
            member.reachable = true;
            const collected = collectFromNode(memberConn, config, member.host);
            collected.shard = shard.name;
            nodeResults.push(collected);
            observed.push(member.host);
          } catch (e) {
            member.reachable = false;
            member.error = e.codeName ?? e.message;
            printFn(`shard ${shard.name} member ${member.host} unreachable: ${member.error}`);
          }
        }
        for (const excluded of discovered.excludedByConfig ?? []) {
          excluded.shard = shard.name;
          shardMembers.push(excluded);
        }
      } catch (e) {
        shardError = e.codeName ?? e.message;
        printFn(`shard ${shard.name}: direct collection failed (${shardError})`);
        // CRITICAL: a wholly-failed direct shard - the seed connection refused,
        // or discoverMembers re-throwing a non-NoReplicationEnabled error such
        // as Unauthorized, which is realistic whenever the shard credentials in
        // URI_TEMPLATE differ from the mongos session - would otherwise
        // contribute NO member entries at all. Nothing then reaches
        // gaps.unreachableMembers, so ctx.unreachableHosts stays empty and that
        // gate is silent; and the shard's coverage:'none' record gates nothing
        // either, because nsShards is built only from shards that actually
        // reported a namespace, so a shard that reported nothing appears in no
        // namespace's list. A zero-operation index could then still be
        // recommended for drop while the member that might be using it was
        // never consulted - the unreachable-member downgrade this project
        // treats as load-bearing, silently skipped. Synthesise the same shape
        // the indirect branch below already builds, so the gates can see the
        // hole. (Deliberately NOT a fallback to the mongos: a directly-reached
        // shard that fails is reported as a gap, not re-collected through the
        // router, so the report keeps one evidence model.)
        if (!shardMembers.length) {
          for (const host of shard.hosts) {
            shardMembers.push({
              id: null, host, shard: shard.name, role: 'unknown', hidden: false,
              delaySecs: 0, votes: 1, reachable: false, error: shardError,
            });
          }
        }
      }

      members.push(...shardMembers);
      shardRecords.push(buildShardRecord(shard, {
        mode: 'direct',
        // Every data-bearing member of the shard, reachable or not, including
        // the hidden ones INCLUDE_HIDDEN=false excluded: that full set is what
        // "full coverage" has to be measured against. shardMembers cannot
        // contain duplicates - each configured member is pushed exactly once.
        expectedHosts: shardMembers.map((m) => m.host),
        observedHosts: observed,
        readPref: 'secondaryPreferred',
        error: shardError,
        unattributed: false,
      }));
    }

    if (indirect.length) {
      const names = indirect.map((s) => s.name);
      // Guarded: collectFromMongos' first statement is a listDatabases through
      // the router with no try of its own, so an unguarded throw here would
      // propagate out of collectSharded, out of main(), and hit the bottom
      // gate - printing FATAL and emitting NO report at all, discarding every
      // shard already collected successfully. The non-sharded path has always
      // caught member-level failures and carried on; so must this one. A failed
      // router call becomes an honest gap, not a lost run.
      let viaMongos = null;
      let mongosError = null;
      try {
        viaMongos = collectFromMongos(conn, config, names);
      } catch (e) {
        mongosError = e.codeName ?? e.message;
        printFn(`collection through mongos failed (${mongosError}) - `
          + `${names.length} shard(s) reported as unobserved`);
      }
      const observedByShard = viaMongos ? viaMongos.observedByShard : {};
      // VERIFIED BUG (Task 12, real cluster): the hosts $collStats/$indexStats
      // name are the mongods' own addresses, not the spellings listShards
      // registered, so every identity below - the member entries, the shard's
      // observedHosts, and the nodeResult key mergeNodes looks members up by -
      // has to be canonicalised onto the configured set first. Without this the
      // router was queried successfully and then EVERY index came back with an
      // empty key, zero ops, zero bytes, no redundancy finding and no schema
      // check, because mergeNodes walks `reachable` members and not one member
      // matched a nodeResult host.
      //
      // One reconciliation per shard, computed once from every host that
      // shard's documents named, so the node keys, the shard's observedHosts
      // and the member reachability flags cannot disagree about who answered -
      // and so a collision between two inferred hosts is visible (finding 1
      // made it possible for one shard to own several nodes).
      const reconciled = new Map(indirect.map((s) => [s.name,
        reconcileShardHosts((observedByShard[s.name] ?? {}).hosts, s.hosts)]));
      if (viaMongos) {
        for (const node of viaMongos.nodeResults) {
          const r = reconciled.get(node.shard);
          // Synthetic keys ('<shard>/unobserved', '<shard>/unattributed') are
          // not in the map and must keep their own identity.
          if (r && Object.prototype.hasOwnProperty.call(r.map, node.host)) {
            node.host = r.map[node.host];
          }
        }
        nodeResults.push(...viaMongos.nodeResults);
      }
      for (const shard of indirect) {
        const seen = observedByShard[shard.name] ?? {};
        const r = reconciled.get(shard.name) ?? { map: {}, inferred: false };
        // A shard's observed members are exactly the hosts that have their own
        // nodeResult - evidence of their own, not a sibling's. A host that
        // answered but whose evidence could not be pinned to it alone is
        // listed separately, informationally, and never counted as observed
        // or marked reachable.
        const observed = (seen.attributedHosts ?? []).map((h) => r.map[h] ?? h);
        const ambiguousHosts = (seen.ambiguousHosts ?? [])
          .map((h) => r.map[h] ?? h).filter((h) => !observed.includes(h));
        shardRecords.push(buildShardRecord(shard, {
          mode: 'indirect',
          expectedHosts: shard.hosts,
          observedHosts: observed,
          readPref,
          error: mongosError,
          unattributed: Boolean(seen.unattributed),
          // True when any host had to be inferred onto a configured member by
          // port rather than matched outright, could not be placed at all, or
          // supplied evidence no single member can be credited with.
          // buildShardRecord refuses to call such a shard fully covered: the
          // identification is sound, but a droppable verdict must never rest
          // on an inference about WHICH member answered.
          inferredHosts: r.inferred || Boolean(seen.ambiguous),
          ambiguousHosts,
        }));
        // Every configured member of an indirect shard becomes a member entry:
        // the ones mongos routed to are reachable, the rest are explicitly
        // unreachable. That is what lets the existing coverage gates see the
        // hole instead of silently assuming the shard was fully observed.
        for (const host of shard.hosts) {
          members.push({
            id: null, host, shard: shard.name, role: 'unknown', hidden: false,
            delaySecs: 0, votes: 1,
            reachable: observed.includes(host),
            error: observed.includes(host) ? null
              : (mongosError
                ? `not observed - collection through mongos failed (${mongosError})`
                : `not observed - routed through mongos with readPreference ${readPref}`),
          });
        }
        // A host that answered but matched no configured member still has to
        // appear, or its evidence is dropped on the floor exactly as it was
        // before canonicalObservedHost existed. It is listed as its own member
        // rather than merged into a configured one, because when the match is
        // ambiguous we genuinely do not know WHICH member replied - and the
        // shard's coverage stays 'partial' either way, so no droppable verdict
        // can ride on the ambiguity.
        for (const host of observed) {
          if (shard.hosts.includes(host)) continue;
          members.push({
            id: null, host, shard: shard.name, role: 'unknown', hidden: false,
            delaySecs: 0, votes: 1, reachable: true,
            error: null,
          });
        }
      }
    }

    return { members, nodeResults, shardRecords };
  }
  // --------------------------------------------------------------------------

  // ------------------------- redundancy detection ---------------------------
  // An index is a redundancy CANDIDATE when:
  //   - both indexes are "plain" (no unique, sparse, partial, TTL, collation,
  //     hidden, wildcard, text, geo or hashed semantics), and
  //   - its key pattern is a strict prefix of the other index's key pattern.
  // Special case: a single-field plain index matches on field name only,
  // because a single-field index can be traversed in both directions.
  const SPECIAL_OPTIONS = [
    'unique', 'sparse', 'partialFilterExpression', 'expireAfterSeconds',
    'collation', 'hidden', 'wildcardProjection', 'weights', 'textIndexVersion',
    '2dsphereIndexVersion', 'bits', 'min', 'max',
  ];

  function isPlain(spec) {
    if (spec.name === '_id_') return false;
    if (SPECIAL_OPTIONS.some((o) => o in spec)) return false;
    // every key direction must be 1 or -1 (excludes text, hashed, geo, wildcard)
    return Object.values(spec.key).every((v) => v === 1 || v === -1);
  }

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

  // Pure: fold "what we expected to see on this shard" and "what actually
  // answered" into one coverage verdict. This is the safety gate for sharded
  // clusters - an index can only be called unused on a shard whose every
  // data-bearing member was observed, exactly as on a replica set.
  //
  // Three values, not two: 'none' (nothing answered) is kept distinct from
  // 'partial' (some members answered) because the report has to explain the
  // two differently. Both block a droppable verdict identically.
  function buildShardRecord(shard, opts) {
    const expectedHosts = opts.expectedHosts ?? [];
    const observedHosts = opts.observedHosts ?? [];
    // Hosts that answered for this shard but whose evidence belongs to no one
    // member - informational only, never counted as observed, never a
    // reachable member, and on their own enough to deny 'full'.
    const ambiguousHosts = opts.ambiguousHosts ?? [];
    let coverage;
    if (observedHosts.length === 0) {
      coverage = 'none';
    } else if (opts.error || opts.unattributed || opts.inferredHosts
               || ambiguousHosts.length
               || expectedHosts.length === 0
               || !expectedHosts.every((h) => observedHosts.includes(h))) {
      // `inferredHosts` says at least one observed host was reconciled onto a
      // configured member by something weaker than string equality - the port
      // inference in canonicalObservedHost - or could not be reconciled at all.
      // The inference is sound (within one shard, a member that answered on a
      // port only one configured member uses IS that member), but "full
      // coverage" is the single fact that unlocks a droppable verdict, so it is
      // never allowed to rest on an inference. Exact-match reconciliation -
      // the Atlas shape, and every direct run - does not set this flag and is
      // unaffected.
      coverage = 'partial';
    } else {
      coverage = 'full';
    }
    return {
      name: shard.name ?? null,
      setName: shard.setName ?? null,
      hosts: shard.hosts ?? [],
      state: Number(shard.state ?? 1),
      draining: Boolean(shard.draining),
      mode: opts.mode,
      coverage,
      expectedHosts,
      observedHosts,
      ambiguousHosts,
      readPref: opts.readPref ?? 'primary',
      error: opts.error ?? null,
    };
  }

  // Pure: on a sharded cluster, $collStats and $indexStats run through a
  // mongos return one document per shard, each tagged with `shard` and the
  // `host` that answered. Split those tagged documents into the same
  // per-collection entry shape collectFromNode builds, one entry per shard.
  //
  // Index SPECS come from $indexStats' `spec` field rather than getIndexes():
  // through a mongos, getIndexes() returns a single merged list with no shard
  // attribution, so it cannot tell us which shard actually holds which index -
  // and "which shard is missing this index" is precisely the mismatched-index
  // finding we need. Servers that omit `spec` still give us `name` and `key`,
  // which is enough to record presence.
  function demuxShardStats(collStatsDocs, indexStatsDocs) {
    const byShard = {};
    let unattributed = false;
    const entryFor = (shard) => {
      if (!byShard[shard]) {
        byShard[shard] = { indexes: [], usage: {}, storage: {}, hosts: [] };
      }
      return byShard[shard];
    };
    const noteHost = (entry, host) => {
      if (host && !entry.hosts.includes(host)) entry.hosts.push(host);
    };
    const shardOf = (doc) => {
      if (doc && doc.shard) return doc.shard;
      unattributed = true;
      return 'unknown';
    };

    for (const doc of collStatsDocs ?? []) {
      const entry = entryFor(shardOf(doc));
      noteHost(entry, doc.host);
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

    for (const doc of indexStatsDocs ?? []) {
      const entry = entryFor(shardOf(doc));
      noteHost(entry, doc.host);
      const ops = Number(doc?.accesses?.ops ?? 0);
      const since = doc?.accesses?.since;
      const use = entry.usage[doc.name] ?? (entry.usage[doc.name] = { ops: 0, since });
      use.ops += ops;
      if (since && (!use.since || since < use.since)) use.since = since;
      // Do not write `entry.indexes?.find(...)` here: mongosh's async-rewriter
      // breaks optional chaining immediately before `.find(`. Resolve the array
      // on its own line first.
      const specs = entry.indexes;
      const known = specs.find((s) => s.name === doc.name);
      if (!known) specs.push(doc.spec ? doc.spec : { name: doc.name, key: doc.key });
    }

    return { byShard, unattributed };
  }

  function mergeNodes({ members, nodeResults, samples, now, shards }) {
    const at = now instanceof Date ? now : new Date();
    const byHost = new Map(nodeResults.map((r) => [r.host, r]));
    const reachable = members.filter((m) => m.reachable);
    const shardList = shards ?? [];
    const skipped = [];
    const nsPresence = new Map();
    // Which shard does each member belong to? `null` is the implicit single
    // shard every non-sharded deployment uses, which keeps one code path for
    // replica sets, standalones and sharded clusters alike.
    const shardOfHost = new Map(members.map((m) => [m.host, m.shard ?? null]));
    // Which shards actually reported each namespace? This is the single source
    // of truth for placement: it needs no extra privilege, it is identical in
    // direct and indirect mode, and it cannot disagree with the data collected.
    const shardsOfNs = new Map();

    for (const r of nodeResults) {
      for (const ns of r.namespaces) {
        if (!nsPresence.has(ns)) nsPresence.set(ns, []);
        nsPresence.get(ns).push(r.host);
        if (!shardsOfNs.has(ns)) shardsOfNs.set(ns, new Set());
        shardsOfNs.get(ns).add(r.shard ?? null);
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
      const hostingShards = shardsOfNs.get(ns) ?? new Set([null]);

      for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
        const perNode = [];
        const variants = new Map();
        const missingOn = [];
        const notHosting = [];
        let maxOps = 0;
        let minAge = Infinity;
        let firstSpec = null;

        for (const m of reachable) {
          // A shard that does not hold this collection is not "missing the
          // index" - it was never supposed to have it. Recording it in
          // missingOn would mark almost every index on an unsharded collection
          // mismatched; recording it nowhere would let the unobserved-member
          // gate in deriveVerdict treat it as a coverage hole. It gets its own
          // list, which is neither.
          if (!hostingShards.has(shardOfHost.get(m.host) ?? null)) {
            notHosting.push(m.host);
            continue;
          }
          const coll = byHost.get(m.host)?.collections[ns];
          // Verified bug (Task 11, real mongosh 2.9.2 --file execution, not the unit
          // tests which use plain `require` and never see it): mongosh's async-rewriter
          // rewrites any `.find(` call - even plain Array.prototype.find, it cannot tell
          // it apart from Collection.prototype.find - and that rewrite silently breaks
          // when the receiver expression itself uses optional chaining directly before
          // the call (`x?.y?.find(...)` never invokes the callback and yields undefined,
          // or throws "this is null or not defined" depending on chain shape). Splitting
          // the optional chaining from the `.find(` call - resolving to a plain array
          // first - avoids the rewriter's broken code path entirely.
          const idxList = coll?.indexes ?? [];
          const spec = idxList.find((s) => s.name === name);
          if (!coll || !spec) {
            if (coll && !coll.error) missingOn.push(m.host);
            // When `coll` is entirely absent, the whole database was skipped for
            // this member (e.g. Unauthorized) rather than the collection itself
            // erroring - that reason lives in this node's own `skipped` list, not
            // on a collections[ns] entry. Surface it on perNode too, so a
            // downstream "unobserved" verdict (finding 1) can name why.
            let observationError = coll?.error ?? null;
            if (!coll) {
              const dbName = ns.split('.')[0];
              const skip = byHost.get(m.host)?.skipped.find((s) => s.ns === dbName);
              if (skip) observationError = skip.reason;
            }
            perNode.push({ host: m.host, shard: shardOfHost.get(m.host) ?? null,
                           present: false,
                           // Did this member demonstrably CHECK this namespace?
                           // "absent" and "never looked at" are different
                           // facts, and the report must not print the first
                           // when it means the second - routinely the case on
                           // an indirect shard, where mongos sends each
                           // namespace to one member and its siblings were
                           // simply never asked about this one.
                           observed: Boolean(coll && !coll.error),
                           ops: null, since: null,
                           counterAgeDays: null, sizeBytes: 0, reusableBytes: 0,
                           cacheBytes: 0, error: observationError });
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
          perNode.push({ host: m.host, shard: shardOfHost.get(m.host) ?? null,
                         present: true, ops, since,
                         counterAgeDays: ageDays, sizeBytes: store.sizeBytes,
                         reusableBytes: store.reusableBytes,
                         cacheBytes: store.cacheBytes, error: null });
        }

        const { name: _n, key: _k, v: _v, ns: _ns, ...options } = firstSpec ?? { key: {} };
        const perShardMap = new Map();
        for (const node of perNode) {
          if (!node.present) continue;
          const key = node.shard ?? null;
          const agg = perShardMap.get(key)
            ?? { shard: key, ops: 0, observedSizeBytes: 0, observedNodes: 0, present: true };
          agg.ops = Math.max(agg.ops, node.ops);
          agg.observedSizeBytes += node.sizeBytes;
          agg.observedNodes += 1;
          perShardMap.set(key, agg);
        }
        // Scale each shard's observed average by the members that shard
        // actually has. Summing raw observed bytes would under-report any
        // shard seen through mongos, where exactly one member answers, while
        // a directly-collected shard contributes every replica - and the
        // "reclaimable" headline would then be a number nobody can act on.
        const shardByName = new Map(shardList.map((s) => [s.name ?? null, s]));
        let clusterSize = 0;
        let perMemberTotal = 0;
        let sizeEstimated = false;
        for (const agg of perShardMap.values()) {
          const avgPerMember = agg.observedNodes ? agg.observedSizeBytes / agg.observedNodes : 0;
          const record = shardByName.get(agg.shard);
          const expected = record && record.expectedHosts && record.expectedHosts.length
            ? record.expectedHosts.length : agg.observedNodes;
          if (expected > agg.observedNodes) sizeEstimated = true;
          agg.sizeBytes = Math.round(avgPerMember * expected);
          clusterSize += agg.sizeBytes;
          perMemberTotal += avgPerMember;
        }
        const shardCount = perShardMap.size;
        built.push({
          ns, name,
          key: firstSpec?.key ?? {},
          options,
          hidden: Boolean(firstSpec?.hidden),
          perNode, maxOps,
          perShard: [...perShardMap.values()],
          minCounterAgeDays: minAge === Infinity ? null : minAge,
          clusterSizeBytes: Math.round(clusterSize),
          perMemberSizeBytes: shardCount ? Math.round(perMemberTotal / shardCount) : 0,
          sizeEstimated,
          redundancy: { class: null, coveredBy: null },
          definition: {
            consistent: missingOn.length === 0 && variants.size <= 1,
            missingOn,
            notHosting,
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
      shards: shardList,
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
          shards: [...(shardsOfNs.get(ns) ?? new Set([null]))],
          hasValidator: Boolean(sample?.validator),
          sample: sample ? { size: sample.size, member: sample.member } : null,
        };
      }),
      indexes,
    };
  }

  // Pure merge of a local payload with peer payloads pasted by hand into
  // PEER_PAYLOADS (escape hatch for shells that cannot open connections to
  // other members, e.g. Compass's embedded shell). Unions members and
  // per-node vectors by host, recomputes cluster-wide aggregates and
  // definition.missingOn, and STRIPS any verdicts/flags/reasons carried over
  // from a peer - those were derived from that peer's partial view and must
  // never be trusted. applyAnalysis must re-derive every verdict from the
  // union of per-member evidence afterwards.
  //
  // Acceptance gate: `discoverMembers` reads replSetGetConfig on the LOCAL
  // connection alone, so even a single-node run already lists every replica-
  // set member, marking every one but the seed as an unreachable placeholder.
  // A peer's evidence for host H must therefore be accepted whenever the
  // local payload has no PRESENT/covered entry for H yet - whether H is
  // absent from `members` entirely, or present only as that unreachable
  // placeholder - not only when H is a genuinely brand-new host. A host is
  // "covered" once some payload (local or an earlier peer in this same call)
  // supplied a genuine reachable member entry for it; re-merging the same
  // peer again must then be a no-op (idempotent), and a peer's genuine entry
  // always replaces a placeholder rather than sitting beside it, so every
  // (index, host) pair ends up with at most one perNode entry.
  function mergePeerPayloads(local, peers) {
    if (!peers || peers.length === 0) return local;
    const out = JSON.parse(JSON.stringify(local));
    const coveredHosts = new Set(out.members.filter((m) => m.reachable).map((m) => m.host));
    const byKey = new Map(out.indexes.map((i) => [`${i.ns} ${i.name}`, i]));
    const COVERAGE_RANK = { none: 0, partial: 1, full: 2 };
    out.shards = out.shards ?? [];
    const shardByName = new Map(out.shards.map((s) => [s.name ?? null, s]));

    for (const peer of peers) {
      // Shard records union by name. A peer that observed more members of a
      // shard genuinely improves that shard's coverage; one that observed
      // fewer must never degrade it, or re-pasting an older payload could
      // silently turn a confirmed drop candidate into an estimate - or worse,
      // the reverse.
      for (const s of peer.shards ?? []) {
        const known = shardByName.get(s.name ?? null);
        if (!known) {
          const copy = JSON.parse(JSON.stringify(s));
          out.shards.push(copy);
          shardByName.set(s.name ?? null, copy);
          continue;
        }
        for (const h of s.observedHosts ?? []) {
          if (!known.observedHosts.includes(h)) known.observedHosts.push(h);
        }
        if ((COVERAGE_RANK[s.coverage] ?? 0) > (COVERAGE_RANK[known.coverage] ?? 0)) {
          known.coverage = s.coverage;
          known.mode = s.mode;
          known.readPref = s.readPref;
          known.error = s.error ?? null;
        }
      }

      // Only a peer's OWN genuinely reachable members are evidence. A host
      // already covered (by local, or by an earlier peer this call) is left
      // alone - this is what makes re-pasting the same payload a no-op.
      const accepted = new Set(
        peer.members.filter((m) => m.reachable && !coveredHosts.has(m.host)).map((m) => m.host),
      );
      if (accepted.size === 0) continue;

      for (const m of peer.members) {
        if (!accepted.has(m.host)) continue;
        const i = out.members.findIndex((om) => om.host === m.host);
        if (i === -1) out.members.push(m);
        else out.members[i] = m; // replace the unreachable placeholder with genuine data
        coveredHosts.add(m.host);
      }

      // Reconcile gaps: a host we just covered can no longer be "unreachable",
      // and any host neither local nor any peer has covered must stay so.
      out.gaps.unreachableMembers = out.gaps.unreachableMembers
        .filter((u) => !accepted.has(u.host));
      for (const m of peer.gaps.unreachableMembers) {
        if (coveredHosts.has(m.host)) continue; // covered by local or an earlier/this peer
        if (!out.gaps.unreachableMembers.some((u) => u.host === m.host)) {
          out.gaps.unreachableMembers.push(m);
        }
      }

      for (const s of peer.gaps.skipped) {
        const dup = out.gaps.skipped.some(
          (e) => e.member === s.member && e.ns === s.ns && e.reason === s.reason);
        if (!dup) out.gaps.skipped.push(s);
      }

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
        // A genuine observation always beats a placeholder: drop any existing
        // entry for a host we're about to add real data for (there shouldn't
        // be one, since mergeNodes never emits perNode placeholders for
        // unreachable members - but this keeps the "at most one entry per
        // (index, host)" invariant explicit rather than assumed).
        target.perNode = target.perNode.filter((n) => !accepted.has(n.host));
        target.perNode.push(...nodes);
      }
    }

    for (const idx of out.indexes) {
      const present = idx.perNode.filter((n) => n.present);
      idx.maxOps = present.reduce((m, n) => Math.max(m, Number(n.ops ?? 0)), 0);
      const ages = present.map((n) => n.counterAgeDays)
        .filter((a) => a !== null && a !== undefined);
      idx.minCounterAgeDays = ages.length ? Math.min(...ages) : null;
      // Recompute clusterSizeBytes/perMemberSizeBytes/perShard/sizeEstimated
      // from the unioned perNode entries exactly as mergeNodes does (~724-753),
      // rather than a raw per-member sum - that undercounts any shard seen
      // through mongos, where exactly one member answers, while a directly-
      // collected shard contributes every replica (the Task 7 bug).
      const perShardMap = new Map();
      for (const n of present) {
        const key = n.shard ?? null;
        const agg = perShardMap.get(key)
          ?? { shard: key, ops: 0, observedSizeBytes: 0, observedNodes: 0, present: true };
        agg.ops = Math.max(agg.ops, Number(n.ops ?? 0));
        agg.observedSizeBytes += Number(n.sizeBytes ?? 0);
        agg.observedNodes += 1;
        perShardMap.set(key, agg);
      }
      let clusterSize = 0;
      let perMemberTotal = 0;
      let sizeEstimated = false;
      for (const agg of perShardMap.values()) {
        const avgPerMember = agg.observedNodes ? agg.observedSizeBytes / agg.observedNodes : 0;
        const record = shardByName.get(agg.shard);
        const expected = record && record.expectedHosts && record.expectedHosts.length
          ? record.expectedHosts.length : agg.observedNodes;
        if (expected > agg.observedNodes) sizeEstimated = true;
        agg.sizeBytes = Math.round(avgPerMember * expected);
        clusterSize += agg.sizeBytes;
        perMemberTotal += avgPerMember;
      }
      const shardCount = perShardMap.size;
      idx.clusterSizeBytes = Math.round(clusterSize);
      idx.perMemberSizeBytes = shardCount ? Math.round(perMemberTotal / shardCount) : 0;
      idx.perShard = [...perShardMap.values()];
      idx.sizeEstimated = sizeEstimated;
      // Same rule as mergeNodes' own missingOn (~365): a reachable member only
      // counts as "missing this index" when it demonstrably finished checking
      // this namespace without error - never when it simply was never observed
      // (a whole-collection error, or a peer payload that never reached this ns
      // at all). Without this exclusion this path used to treat "not present"
      // and "never observed" identically, disagreeing with mergeNodes and
      // forcing a misleading "mismatched / possible in-flight index build"
      // verdict where the real story is "this member was never checked" -
      // finding 1's coverage gate in deriveVerdict is what actually downgrades
      // those to inconclusive, and it needs missingOn to NOT already claim them.
      // gaps.skipped mixes two shapes (db-level skips store the db name in
      // `ns`; collection-level errors store the full namespace) - match both.
      const dbNameOfNs = idx.ns.split('.')[0];
      const skippedThisNs = new Set(
        out.gaps.skipped
          .filter((s) => s.ns === idx.ns || s.ns === dbNameOfNs)
          .map((s) => s.member));
      // FINDING 2 (final whole-branch review, important): mergeNodes keeps
      // "this shard does not host the collection" (notHosting) strictly apart
      // from "this member is missing the index" (missingOn); this copy of the
      // computation did not, so every member of a shard that never held the
      // namespace was recomputed into missingOn on merge, flipping
      // definition.consistent to false and the verdict to `mismatched` - a
      // member being blamed for lacking an index it was never supposed to
      // have. Carry the exclusion across, so the two computations agree.
      const notHostingThisIdx = new Set(idx.definition.notHosting ?? []);
      const missingOn = out.members
        .filter((m) => m.reachable)
        .filter((m) => !present.some((n) => n.host === m.host))
        .filter((m) => !skippedThisNs.has(m.host))
        .filter((m) => !notHostingThisIdx.has(m.host))
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

  // Pure boundary parser for PEER_PAYLOADS. Entries are documented as raw JSON
  // text pasted from another shell's PEER_PAYLOAD_BEGIN/END block, but someone
  // hand-editing the array literal could just as easily paste an already-
  // parsed object literal instead - accept either. (Verified bug, Task 11:
  // main() used to hand PEER_PAYLOADS straight to mergePeerPayloads without
  // parsing at all, which crashed on the first real paste-in with a bare
  // "Cannot read properties of undefined" - JSON.parse alone would only trade
  // that for an unhelpful "Unexpected token" with no clue which entry was
  // bad.) Throws a clear error naming the offending entry's index so a
  // hand-edited array is easy to fix.
  function parsePeerPayloads(entries) {
    return (entries ?? []).map((entry, i) => {
      if (entry !== null && typeof entry === 'object') return entry;
      if (typeof entry === 'string') {
        try {
          return JSON.parse(entry);
        } catch (e) {
          throw new Error(`PEER_PAYLOADS[${i}] is not valid JSON: ${e.message}`);
        }
      }
      throw new Error(`PEER_PAYLOADS[${i}] must be a JSON string or a parsed object, got ${typeof entry}`);
    });
  }

  // --------------------------------------------------------------------------
  // Schema and index consistency checks
  // --------------------------------------------------------------------------

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
        const isTopLevel = !field.includes('.');
        const provable = sample.validator.closed && isTopLevel;
        let text;
        if (sample.validator.closed) {
          if (isTopLevel) {
            text = 'not declared in the collection validator, which forbids additional properties';
          } else {
            text = 'not declared in the collection validator - root forbids additional properties, but this nested level is unverified (advisory)';
          }
        } else {
          text = 'not declared in the collection validator (which permits additional properties, so this is advisory)';
        }
        issues.push({ ...base, issue: 'not-in-validator', provable, text });
      }
    }
    return issues;
  }

  // --------------------------------------------------------------------------
  // Sampling, orchestration and output
  // --------------------------------------------------------------------------

  // Pure selection of which members main()'s collection loop should target.
  // When fanning out (this shell can open its own connections to a
  // multi-node replica set), every discovered member is a target. Otherwise
  // there is exactly one real connection available - the one this shell is
  // already on - and it must be attributed to the member matching seedHost,
  // never to whichever member happens to sort first in the discovered list.
  // (Verified bug, Task 11: the degraded/single-connection loop used to
  // iterate discovered members in rs.config order and `break` after the
  // first, so a run on a real secondary silently mislabelled its one
  // reachable connection as a different, sometimes genuinely-unreachable,
  // member.) Falls back to the full member list only when seedHost couldn't
  // be matched to any configured member at all (the synthetic/unidentified
  // seed case, flagged to the user separately).
  function selectCollectionTargets(members, seedHost, fanOut) {
    if (fanOut) return members;
    const seedMatches = members.filter((m) => m.host === seedHost);
    return seedMatches.length ? seedMatches : members;
  }

  // Prefers a reachable hidden member for document sampling (spares the
  // primary), then a reachable secondary, then a reachable primary, then any
  // reachable member. Returns null when nothing is reachable.
  function pickSampleMember(members) {
    const up = members.filter((m) => m.reachable);
    return up.find((m) => m.hidden)
      ?? up.find((m) => m.role === 'secondary')
      ?? up.find((m) => m.role === 'primary')
      ?? up[0] ?? null;
  }

  // Controller ruling R2: member identity comes from the replica-set config,
  // passed in explicitly as `host`, not from `conn.host` (unverified in
  // mongosh). The explicit argument wins; conn.host remains only as a fallback.
  function sampleNamespace(conn, ns, config, host) {
    const dbName = ns.split('.')[0];
    const collName = ns.split('.').slice(1).join('.');
    const out = { ns, member: host ?? conn.host, size: 0, paths: {},
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
            // Verified bug (Task 11, real cluster): every key of multikeyPaths is present
            // for every field of the index, whether or not that field is actually
            // multikey - the real server (observed here on a recent build) encodes the
            // per-path flag as a BSON Binary one-byte bitset (0x00 = not multikey, a
            // non-zero byte = multikey), not as a boolean or as key-presence. Treating
            // Object.keys() alone as "this path is multikey" (the original code) flagged
            // every indexed field as multikey, including plain scalar fields like
            // status/createdAt/_id. Older servers are documented to instead use an
            // array-of-subpaths shape (non-empty array = multikey); both are handled,
            // and any other/unrecognized shape defaults to "not multikey" rather than
            // over-flagging, since false positives here are actively misleading advice.
            for (const [p, flag] of Object.entries(idx.multikeyPaths ?? {})) {
              const isMultikey = Array.isArray(flag)
                ? flag.length > 0
                : Boolean(flag?.buffer && Array.from(flag.buffer).some((b) => b !== 0));
              if (!isMultikey) continue;
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

  // Writes the HTML report to disk when the runtime allows it, falling back
  // to printing the whole document when it cannot (no fs, or the write throws).
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

  function main() {
    const config = {
      URI_TEMPLATE: (typeof process === 'object' && process.env && process.env.INDEXSTATS_URI)
        ? process.env.INDEXSTATS_URI : URI_TEMPLATE,
      OUT_FILE, EXCLUDED_DBS: [...EXCLUDED_DBS], MAX_TIME_MS, INCLUDE_HIDDEN,
      DROP_MIN_COUNTER_DAYS, SAMPLE_SIZE, LOW_PRESENCE,
      SEED_HOST: undefined,
    };
    const seed = deriveSeedHost(db.getSiblingDB('admin'), db, config);
    config.SEED_HOST = seed.host;
    // Plain statement form, deliberately - NOT an IIFE. mongosh's async-rewriter
    // silently miscompiles constructs it cannot classify (three of this
    // project's five known live bugs were exactly that), and a shell API call
    // inside a non-async function expression is precisely such a construct. If
    // it returned a Promise here, detectTopology would see an object with no
    // msg/setName, answer 'standalone', and the whole sharded path would be
    // silently dead on a real mongos - with no unit test able to see it.
    let helloDoc = null;
    try {
      helloDoc = db.getSiblingDB('admin').runCommand({ hello: 1, maxTimeMS: config.MAX_TIME_MS });
    } catch (e) {
      helloDoc = null;
    }
    // detectTopology defaults a missing document to 'standalone', which ROUTES
    // correctly (anything not 'sharded' takes the replica-set path), but
    // recording it as fact would have meta.topology say 'standalone' while
    // meta.replicaSetName in the same object names a replica set. Report what
    // was actually established.
    const topology = helloDoc === null ? 'unknown' : detectTopology(helloDoc);
    // Whatever read preference the user's own connection carries is what the
    // indirect path actually observes. Report it; never override it.
    let readPref = 'primary';
    try {
      readPref = db.getMongo().getReadPrefMode() || 'primary';
    } catch (e) {
      readPref = 'primary';
    }
    const caps = probeCapabilities({
      requireFn: typeof require === 'function' ? require
        : () => { throw new Error('no require'); },
      MongoCtor: typeof Mongo === 'function' ? Mongo
        : function () { throw new Error('no Mongo'); },
      uriTemplate: config.URI_TEMPLATE,
      seedHost: config.SEED_HOST,
    });

    let discovered;
    let members;
    let nodeResults;
    let shardRecords;
    let fanOut;
    // What meta reports as this shell's connection capability. It starts as the
    // probe's prediction and is replaced by the observed fact on the sharded
    // path, where the probe deliberately does not get the last word (see
    // canProbeShardsDirectly). A local, assigned once, rather than a late
    // mutation of `caps`: every other reader of `caps` wants the probe's own
    // result, and rewriting it underneath them would be a side effect nobody
    // looking at probeCapabilities would expect.
    let openedConnections = caps.canOpenConnections;
    // Hoisted only so the sampling block below can still reach it; the
    // non-sharded path assigns and uses it exactly as it always has.
    let connFor;

    if (topology === 'sharded') {
      let shards;
      try {
        shards = discoverShards(db.getSiblingDB('admin'), config);
      } catch (e) {
        print(`FATAL: ${e.message}`);
        return;
      }
      const collected = collectSharded({
        conn: db.getMongo(), config, shards,
        MongoCtor: typeof Mongo === 'function' ? Mongo
          : function () { throw new Error('no Mongo'); },
        // NOT caps.canOpenConnections: that probe targeted the ROUTER's own
        // address, which this run never connects to and which a real mongos
        // routinely reports in a form the client cannot resolve. See
        // canProbeShardsDirectly for the verified failure.
        canOpenConnections: canProbeShardsDirectly(caps),
        readPref, printFn: print,
      });
      members = collected.members;
      nodeResults = collected.nodeResults;
      shardRecords = collected.shardRecords;
      // Report what actually happened rather than what the router probe
      // predicted: a shard collected directly is proof this shell can open
      // connections, whatever the probe against the router's own address said.
      openedConnections = openedConnections || shardRecords.some((s) => s.mode === 'direct');
      // A sharded run reaches every shard - directly where the probe succeeded,
      // through mongos otherwise - so it is never the degraded single-connection
      // case the peer-payload workflow exists to rescue.
      fanOut = true;
      discovered = { replicaSetName: 'sharded cluster', mode: 'multi-node',
                     members, excludedByConfig: [] };
    } else {
      try {
        discovered = discoverMembers(db.getSiblingDB('admin'), config);
      } catch (e) {
        print(`FATAL: ${e.message}`);
        return;
      }

      fanOut = caps.canOpenConnections && discovered.mode === 'multi-node';
      connFor = (host) => (fanOut ? new Mongo(uriFor(config.URI_TEMPLATE, host)) : db.getMongo());

      // Verified bug (Task 11, real cluster): when !fanOut, connFor ignores its `host`
      // argument entirely (every call returns the one local connection), but the loop
      // below used to iterate discovered.members in rs.config order and `break` after
      // the first - so it always attributed the local, actually-reachable connection
      // to whichever member happens to sort first in rs.config, not to the member the
      // script is actually running on. Running this exact degraded path directly on a
      // secondary (127.0.0.1:27022) produced a payload claiming host 127.0.0.1:27021 -
      // a different, potentially genuinely-unreachable member - was the one reachable.
      // Fixed by extracting the selection into the pure, tested selectCollectionTargets.
      const targets = selectCollectionTargets(discovered.members, config.SEED_HOST, fanOut);

      nodeResults = [];
      for (const member of targets) {
        try {
          const conn = connFor(member.host);
          const hello = conn.getDB('admin').runCommand({ hello: 1, maxTimeMS: config.MAX_TIME_MS });
          member.role = (hello.isWritablePrimary || hello.ismaster) ? 'primary' : 'secondary';
          member.reachable = true;
          nodeResults.push(collectFromNode(conn, config, member.host));
        } catch (e) {
          member.reachable = false;
          member.error = e.codeName ?? e.message;
          print(`member ${member.host} unreachable: ${member.error}`);
        }
        if (!fanOut) break;
      }

      // FINDING 4: members excluded by INCLUDE_HIDDEN=false never got connected
      // to (discovered.members already omits them, so they were never targets
      // above) but must still show up as a gap, not vanish from the report.
      members = [...discovered.members, ...(discovered.excludedByConfig ?? [])];
      shardRecords = [];
    }

    const samples = [];
    if (topology === 'sharded') {
      // One connection, and mongos routes the sampling reads itself. The
      // sample member is recorded as 'mongos' rather than a host, because
      // that is literally what was asked - claiming a member here would be
      // inventing evidence about which node the documents came from.
      const sampledNamespaces = [];
      for (const r of nodeResults) {
        for (const ns of r.namespaces) {
          if (!sampledNamespaces.includes(ns)) sampledNamespaces.push(ns);
        }
      }
      for (const ns of sampledNamespaces) {
        samples.push(sampleNamespace(db.getMongo(), ns, config, 'mongos'));
      }
    } else {
      const sampleMember = pickSampleMember(discovered.members);
      if (sampleMember) {
        try {
          const sampleConn = connFor(sampleMember.host);
          const namespaces = (nodeResults.find((r) => r.host === sampleMember.host)
            ?? nodeResults[0])?.namespaces ?? [];
          for (const ns of namespaces) samples.push(sampleNamespace(sampleConn, ns, config, sampleMember.host));
        } catch (e) {
          print(`sampling skipped: ${e.codeName ?? e.message}`);
        }
      }
    }

    const merged = mergeNodes({
      members, nodeResults, samples, now: new Date(), shards: shardRecords,
    });
    merged.meta = {
      generatedAt: new Date().toISOString(),
      scriptVersion: SCRIPT_VERSION,
      topology,
      readPref,
      replicaSetName: discovered.replicaSetName,
      seedHost: config.SEED_HOST,
      mode: fanOut ? discovered.mode : 'single-node',
      capabilities: {
        canWriteFiles: caps.canWriteFiles,
        canOpenConnections: openedConnections,
      },
      config: { DROP_MIN_COUNTER_DAYS, SAMPLE_SIZE, INCLUDE_HIDDEN, MAX_TIME_MS },
    };

    // Verified bug (Task 11, real cluster, first genuine exercise of this path):
    // PEER_PAYLOADS is documented and printed as raw JSON text to paste in (see the
    // "paste each payload below into PEER_PAYLOADS" message below), but mergePeerPayloads
    // expects parsed objects (that's what every unit test in peer.test.js hands it) -
    // passing the raw strings straight through crashed with "Cannot read properties of
    // undefined (reading 'filter')" on the very first real paste-in. Fixed by extracting
    // the boundary parse into the pure, tested parsePeerPayloads.
    const withPeers = mergePeerPayloads(merged, parsePeerPayloads(PEER_PAYLOADS));
    const payload = applyAnalysis(withPeers, config, samples);
    const s = summarise(payload.indexes);

    emit(renderHTML(payload), payload, caps, config,
      { writeFileSync: caps.fs ? caps.fs.writeFileSync : null, printFn: print });

    print(`${payload.indexes.length} indexes across ${payload.namespaces.length} collections on `
      + `${payload.members.filter((m) => m.reachable).length}/${payload.members.length} members`);
    print(`${s.drop} drop candidates, ${s.inconclusive} inconclusive, `
      + `${fmtBytes(s.reclaimable)} reclaimable cluster-wide`);

    if (!fanOut) {
      if (payload.meta.mode === 'merged-payloads') {
        print(`this shell could only reach ${config.SEED_HOST} directly, but `
          + `${PEER_PAYLOADS.length} peer payload(s) supplied in PEER_PAYLOADS were merged in `
          + 'for a cluster-wide report');
      } else {
        // FINDING 5: tell apart the two reasons a multi-node deployment can
        // still end up single-node here, since they demand different fixes.
        let capReason;
        if (discovered.mode !== 'multi-node') {
          capReason = 'the deployment is not a replica set';
        } else if (caps.connectionBlockedReason === 'no-mongo-constructor') {
          capReason = 'this shell forbids opening additional connections (no Mongo '
            + 'constructor available, e.g. Compass\'s embedded shell) - use the '
            + 'peer-payload workflow below';
        } else if (caps.connectionBlockedReason === 'template-failed'
            || caps.connectionBlockedReason === 'template-invalid') {
          capReason = 'this shell CAN open connections, but the one built from '
            + 'URI_TEMPLATE did not work - check URI_TEMPLATE/credentials (or set '
            + 'INDEXSTATS_URI), then re-run';
        } else {
          capReason = 'this shell could not open a second connection - either it '
            + 'forbids opening connections entirely, or URI_TEMPLATE/credentials are '
            + 'wrong; use the peer-payload workflow below, or fix URI_TEMPLATE and re-run';
        }
        print(`this shell analysed only ${config.SEED_HOST}: ${capReason}`);
        print('for cluster-wide verdicts, run this script on each member and paste each '
          + 'payload below into PEER_PAYLOADS');
      }
      if (seed.synthetic) {
        print(`warning: this member could not identify itself (no hello.me, no `
          + `serverStatus().host) - SEED_HOST was set to the placeholder "${config.SEED_HOST}". `
          + 'Set SEED_HOST manually to a value unique to this member before pasting payloads, '
          + 'or the merge will silently treat different members as the same host.');
      }
      print(`PEER_PAYLOAD_BEGIN\n${JSON.stringify(payload)}\nPEER_PAYLOAD_END`);
    }
  }

  const VERDICT_ORDER = ['drop', 'likely-drop', 'redundant', 'inconclusive', 'mismatched', 'keep'];

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
        // The finding itself is definite: for the classes classifyRedundancy
        // reports (duplicate / prefix / subsumed, all of them plain indexes),
        // the wider index covers this one's key pattern outright, so this
        // index should go. It is not `drop` only because it is still serving
        // live traffic, which is a question of SEQUENCING, not of doubt -
        // hide it, watch, then drop. Say that, rather than "review".
        reasons.push(`redundant: '${idx.redundancy.coveredBy}' already covers this key pattern, `
          + 'so this index should go - but it is still serving traffic, so hide it first '
          + `(db.getSiblingDB('${idx.ns.split('.')[0]}').getCollection('${idx.ns.split('.').slice(1).join('.')}')`
          + `.hideIndex('${idx.name}')), confirm nothing regresses, then drop it`);
        return { verdict: 'redundant', flags, reasons };
      }
      return { verdict: 'keep', flags, reasons };
    }

    // FINDING 1 (critical, final review): a reachable member that produced NO
    // observation for THIS index (a collection-level error, a per-database
    // skip, or - in a merged peer payload - a namespace that peer's own run
    // never reached at all) must block a droppable verdict exactly like an
    // unreachable member does. Before this gate, `idx.definition.missingOn`
    // deliberately excludes these hosts (that field means "confirmed genuinely
    // absent", not "unknown"), so `definition.consistent` stayed true and a
    // zero-ops verdict sailed straight through to likely-drop/drop while
    // one member was silently never checked. Compute the gap directly from
    // perNode presence, using missingOn only to recognise the (legitimate,
    // separately-handled-by-the-mismatched-gate-above) "confirmed absent"
    // case as NOT a coverage gap.
    const presentHosts = new Set(idx.perNode.filter((n) => n.present).map((n) => n.host));
    const confirmedAbsentHosts = new Set(idx.definition.missingOn ?? []);
    // A member whose shard does not hold this collection was never supposed to
    // report it. Counting it as an unobserved member would make every index on
    // an unsharded collection inconclusive on a sharded cluster.
    const notHostingHosts = new Set(idx.definition.notHosting ?? []);
    const unobservedHosts = (ctx.reachableHosts ?? [])
      .filter((h) => !presentHosts.has(h) && !confirmedAbsentHosts.has(h)
                     && !notHostingHosts.has(h));
    if (unobservedHosts.length) {
      const detail = unobservedHosts.map((h) => {
        const node = idx.perNode.find((n) => n.host === h);
        return node && node.error ? `${h} (${node.error})` : h;
      }).join(', ');
      flags.push('unobserved-member');
      reasons.unshift(`no observation for this index on ${detail} - a zero-operation `
        + 'verdict cannot be confirmed there, so this index cannot be dropped yet');
      return { verdict: 'inconclusive', flags, reasons };
    }

    // Sharded safety gate. An index can only be called unused on a shard whose
    // every data-bearing member was observed. Through a mongos only one member
    // per shard answers - the one the connection's read preference selects - so
    // the rest are unobserved and might be the ones using this index. On Atlas,
    // where direct shard connections are refused, this is the ordinary outcome
    // rather than an error, so the reason has to explain itself.
    const hostingShardNames = (ctx.nsShards ?? {})[idx.ns] ?? null;
    const gappy = (ctx.shards ?? []).filter((s) =>
      s.coverage !== 'full'
      && (hostingShardNames === null || hostingShardNames.includes(s.name)));
    if (gappy.length) {
      flags.push('partial-shard-coverage');
      const detail = gappy.map((s) => {
        if (s.coverage === 'none') {
          return `${s.name} returned no data at all${s.error ? ` (${s.error})` : ''}`;
        }
        const seen = s.observedHosts.join(', ');
        return s.mode === 'indirect'
          ? `${s.name} was observed through mongos on ${seen} only `
            + `(readPreference ${s.readPref}), so its remaining members were never consulted`
          : `${s.name} was observed on ${seen} only, so its remaining members were never consulted`;
      }).join('; ');
      reasons.unshift(`zero operations everywhere observed, but ${detail} - unused cannot be `
        + 'confirmed cluster-wide. Connect with readPreference=secondaryPreferred, or run '
        + 'against each shard directly, to widen coverage');
      return { verdict: 'inconclusive', flags, reasons };
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
    const reachableHosts = payload.members.filter((m) => m.reachable).map((m) => m.host);
    const nsShards = {};
    for (const n of payload.namespaces ?? []) nsShards[n.ns] = n.shards ?? null;
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
      Object.assign(idx, deriveVerdict(idx, { config, hiddenHosts, unreachableHosts,
        reachableHosts, shards: payload.shards ?? [], nsShards }));
    }

    payload.indexes.sort((a, b) => {
      const d = VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict);
      return d !== 0 ? d : b.clusterSizeBytes - a.clusterSizeBytes;
    });
    return payload;
  }

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
      var byShard = !state.shard || state.shard === 'all'
        || (i.perShard || []).some(function (s) { return s.shard === state.shard; });
      return byFilter && bySearch && byShard;
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
      // Count the `redundant` verdict as well as the `redundant:<class>` flag,
      // so this card can never disagree with the `redundant` chip (which
      // matches verdict-or-flag). In practice a `redundant` verdict always
      // carries the flag too, so this is belt and braces - but two different
      // numbers under one label is exactly the kind of thing a reader should
      // never have to reconcile.
      if (i.verdict === 'redundant'
          || (i.flags || []).some(function (f) { return f.indexOf('redundant') === 0; })) {
        out.redundant++;
      }
    });
    return out;
  }

  function dropCommandsFor(indexes) {
    var byNs = {};
    indexes.forEach(function (i) {
      if (i.verdict !== 'drop' && i.verdict !== 'likely-drop') return;
      (byNs[i.ns] = byNs[i.ns] || []).push(i.name);
    });
    // Must-fix minor (final review): bare `"` quoting let a namespace or
    // index name containing a `"` produce a broken - and potentially
    // injectable - statement that a human pastes straight into a production
    // shell. JSON.stringify each name instead, so any embedded quote,
    // backslash, or control character is escaped correctly.
    return Object.keys(byNs).sort().map(function (ns) {
      var dbName = ns.split('.')[0];
      var collName = ns.split('.').slice(1).join('.');
      var names = byNs[ns].map(function (n) { return JSON.stringify(n); }).join(',');
      return 'db.getSiblingDB(' + JSON.stringify(dbName) + ').getCollection(' + JSON.stringify(collName)
        + ').dropIndexes([' + names + '])';
    }).join('\n');
  }

  const CLIENT_FUNCTIONS = [fmtBytes, selectIndexes, summarise, dropCommandsFor]
    .map((f) => f.toString()).join('\n');

  const CLIENT_BOOTSTRAP = `
var DATA = JSON.parse(document.getElementById('indexstats-data').textContent);
var STATE = { filter: 'all', search: '', sortKey: 'size', sortDir: -1, shard: 'all' };
var FILTERS = ['all','drop','likely-drop','redundant','inconclusive','mismatched','keep',
               'suspect-field','used-only-on-hidden'];
function h(s){return String(s).replace(/[&<>"]/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
/* The chips must count what the cards and the table show, so the shard
   filter has to be threaded through here too - without it, selecting one
   shard left every chip reading a cluster-wide total beside a card reading
   the shard's own. Deliberately NOT STATE.filter: each chip counts its own
   filter. ES5 only - this is stringified into the page. */
function countFor(f){return selectIndexes(DATA.indexes,
  {filter:f,search:'',sortKey:'size',sortDir:-1,shard:STATE.shard}).length;}
function renderControls(){
  var html = FILTERS.filter(function(f){return f==='all'||countFor(f)>0;}).map(function(f){
    return '<button class="chip '+f+(STATE.filter===f?' on':'')+'" data-f="'+f+'">'+f+' '+countFor(f)+'</button>';
  }).join('');
  if (DATA.shards && DATA.shards.length > 1) {
    html += '<select id="shard"><option value="all">all shards</option>' +
      DATA.shards.map(function(s){
        return '<option value="'+h(s.name)+'"'+(STATE.shard===s.name?' selected':'')+'>'+
          h(s.name)+' ('+h(s.coverage)+')</option>';
      }).join('') + '</select>';
  }
  html += '<input type="search" id="q" placeholder="filter by namespace or index name" value="'+h(STATE.search)+'">';
  html += '<button class="act" id="copy">copy dropIndexes commands</button>';
  var el = document.getElementById('controls');
  el.innerHTML = html;
  el.querySelectorAll('.chip').forEach(function(b){
    b.onclick = function(){ STATE.filter = b.dataset.f; draw(); };
  });
  var q = document.getElementById('q');
  q.oninput = function(){ STATE.search = q.value; drawTable(); drawCards(); };
  var sh = document.getElementById('shard');
  if (sh) sh.onchange = function(){ STATE.shard = sh.value; draw(); };
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
    if(!n.present) return '<tr><td class="mono">'+h(n.host)+'</td><td colspan="4" class="muted">'+
      (n.observed===false?'not observed on this member':'index not present')+
      (n.error?' - '+h(n.error):'')+'</td></tr>';
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
  if(i.perShard && i.perShard.length > 1){
    parts += '<table><thead><tr><th>shard</th><th class="num">ops</th>'+
      '<th class="num">size</th><th class="num">members observed</th></tr></thead><tbody>'+
      i.perShard.map(function(s){
        return '<tr><td class="mono">'+h(s.shard)+'</td><td class="num">'+s.ops+
          '</td><td class="num">'+fmtBytes(s.sizeBytes)+'</td><td class="num">'+
          s.observedNodes+'</td></tr>';
      }).join('')+'</tbody></table>';
  }
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
      '<td class="num">'+fmtBytes(i.clusterSizeBytes)+
      (i.sizeEstimated?'<div class="muted">estimated</div>':'')+'</td></tr>'+
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
.tag.inconclusive,.tag.redundant{background:var(--warnbg);color:var(--warn)}
.tag.mismatched{background:var(--card);color:var(--fg)}
.tag.keep{background:var(--accentbg);color:var(--accent)}
.tag.full{background:var(--card);color:var(--ok)}
.tag.partial{background:var(--warnbg);color:var(--warn)}
.tag.none{background:var(--dangerbg);color:var(--danger)}
.detail{background:var(--card)}
.detail table{margin:0}
.detail td,.detail th{border-bottom:none;padding:3px 4px}
details{margin-top:24px}
summary{cursor:pointer;color:var(--muted)}
pre{overflow:auto;background:var(--card);padding:12px;border-radius:8px;font-size:12px}
`;

  function renderMembers(members) {
    return members.map((m) => {
      const cls = !m.reachable ? 'down' : m.hidden ? 'hid'
        : m.role === 'primary' ? 'pri' : 'sec';
      const bits = [esc(m.role)];
      if (m.hidden) bits.push('hidden');
      if (m.delaySecs) bits.push(`delayed ${m.delaySecs}s`);
      const label = !m.reachable
        ? `unreachable - ${esc(m.error ?? 'unknown error')}${m.hidden ? ' / hidden' : ''}${m.delaySecs ? ` / delayed ${m.delaySecs}s` : ''}`
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

  // The shard coverage panel. On Atlas, where direct shard connections are
  // refused, nearly every verdict comes back inconclusive - this panel is what
  // turns that from "the tool is broken" into "here is exactly what was
  // observed, and here is how to widen it".
  function renderShardCoverage(payload) {
    const shards = payload.shards ?? [];
    if (shards.length === 0) return '';
    const rows = shards.map((s) => {
      // Shard records normally come from buildShardRecord(), which guarantees
      // these arrays - but they can also arrive via mergePeerPayloads() from
      // PEER_PAYLOADS, JSON a human pastes in by hand, where a truncated or
      // hand-edited entry could omit either field. Fall back to [] so one bad
      // pasted record can't throw and take down the whole report.
      const observedHosts = s.observedHosts ?? [];
      const expectedHosts = s.expectedHosts ?? [];
      const how = s.mode === 'indirect'
        ? `through mongos (readPreference ${esc(s.readPref)})`
        : 'direct connection to each member';
      const seen = observedHosts.length
        ? `${observedHosts.length} of ${expectedHosts.length} members: `
          + observedHosts.map((h) => esc(h)).join(', ')
        : 'no members answered';
      const note = s.error ? ` - ${esc(s.error)}` : s.draining ? ' - draining' : '';
      // Rare, but it must not be invisible: a host that answered for this
      // shard whose evidence could not be credited to it alone (mongos sent
      // $collStats and $indexStats for one namespace to two different
      // members). It is not counted as observed, which is why it needs saying.
      const ambiguous = s.ambiguousHosts ?? [];
      const amb = ambiguous.length
        ? ` - evidence from ${ambiguous.map((h) => esc(h)).join(', ')} could not be `
          + 'attributed to one member'
        : '';
      return `<tr><td class="mono">${esc(s.name)}</td><td>${how}</td>`
        + `<td><span class="tag ${esc(s.coverage)}">${esc(s.coverage)}</span></td>`
        + `<td>${seen}${amb}${note}</td></tr>`;
    }).join('');
    const partial = shards.filter((s) => s.coverage !== 'full').length;
    const note = partial
      ? `<div class="muted">${partial} shard${partial > 1 ? 's were' : ' was'} not fully `
        + 'observed, so zero-operation verdicts there are downgraded to inconclusive. '
        + 'Connect with readPreference=secondaryPreferred, or run against each shard '
        + 'directly, to widen coverage.</div>'
      : '';
    return `<details open><summary>shard coverage (${shards.length})</summary>`
      + '<table><thead><tr><th>shard</th><th>reached</th><th>coverage</th>'
      + `<th>members observed</th></tr></thead><tbody>${rows}</tbody></table>${note}</details>`;
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
${renderShardCoverage(payload)}
<div class="cards" id="cards"></div>
<div class="members">${renderMembers(payload.members)}</div>
<div class="controls" id="controls"></div>
<div id="table-host"></div>
${renderGapsPanel(payload)}
<details><summary>raw payload (json)</summary><pre id="raw"></pre></details>
</div>
<script type="application/json" id="indexstats-data">${jsonForScript(payload)}</script>
<script>${CLIENT_FUNCTIONS}
${CLIENT_BOOTSTRAP}</script>
</body></html>`;
  }

  const api = { SCRIPT_VERSION, detectTopology, parseShardHost, canonicalObservedHost, reconcileShardHosts, probeUriFor, PROBE_SELECTION_TIMEOUT_MS, canProbeShardsDirectly, discoverShards, selectShardMode, collectSharded, isPlain, canonicalKeyString, generatedName, isStrictPrefix, classifyRedundancy, mergeNodes, buildShardRecord, demuxShardStats, mergePeerPayloads, parsePeerPayloads, selectCollectionTargets, LOW_PRESENCE, bsonTypeOf, flattenPaths, profileSample, keyFieldsOf, validatorPaths, classifySchemaIssues, VERDICT_ORDER, deriveVerdict, applyAnalysis, esc, jsonForScript, fmtBytes, renderHTML, renderShardCoverage, selectIndexes, summarise, dropCommandsFor, probeCapabilities, uriFor, discoverMembers, deriveSeedHost, collectFromNode, collectFromMongos, pickSampleMember, sampleNamespace, emit, URI_TEMPLATE, OUT_FILE, EXCLUDED_DBS, MAX_TIME_MS, INCLUDE_HIDDEN, DROP_MIN_COUNTER_DAYS, SAMPLE_SIZE, PEER_PAYLOADS };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  // FINDING 3 (final review, important): this try/catch used to wrap the
  // main() call itself, so ANY throw from inside main() - a bad URI_TEMPLATE,
  // a render error, an unexpected driver shape - printed only the "Connect to
  // a database first" message, giving the DBA no report AND a wrong
  // diagnosis (the shell IS connected; something else broke). The try/catch
  // below now guards ONLY the capability probe (`typeof db`/`typeof print`,
  // which is what can legitimately fail to even evaluate outside a connected
  // mongosh shell, e.g. `mongosh --nodb`). A genuine failure inside main()
  // gets its own distinct FATAL line with the real error, never disguised as
  // "not connected".
  let connected = false;
  try {
    connected = typeof db !== 'undefined' && typeof print === 'function';
  } catch (e) {
    connected = false;
  }

  if (!connected) {
    if (typeof print === 'function') {
      print('| Connect to a database first: mongosh "mongodb://..." --file indexStats.js');
    }
  } else {
    try {
      main();
    } catch (e) {
      print(`FATAL: indexStats.js failed unexpectedly: ${e && e.message ? e.message : e}`);
    }
  }
})();
