/**
 * indexStats.js (v2)
 * Index usage, storage and redundancy report for every collection
 * in every non-system database.
 *
 * Run:
 *   mongosh "<connection-string>" --quiet --file indexStats.js
 *
 * What it reports per index:
 *   - access counter and counter start time ($indexStats, per-node, merged across shards)
 *   - on-disk size, reusable space (fragmentation), bytes in WiredTiger cache
 *   - UNUSED flag (zero ops on this node since the counter started)
 *   - REDUNDANT flag (a plain index whose keys are a strict prefix of another plain index)
 *   - HIDDEN flag
 *
 * Safety:
 *   - views and system collections excluded up front
 *   - per-database and per-collection error isolation (one bad namespace never kills the run)
 *   - maxTimeMS on every server call so a stalled node cannot hang the report
 *   - final summary section with drop candidates, so you do not grep the report by hand
 */

(function indexStats() {
  // ----------------------------- configuration -----------------------------
  const EXCLUDED_DBS = new Set(['admin', 'config', 'local']);
  const MAX_TIME_MS = 30000; // per server call
  const SCRIPT_VERSION = '3.0.0';
  // --------------------------------------------------------------------------

  const MB = 1024 * 1024;
  const toMB = (bytes) => (Number(bytes ?? 0) / MB).toFixed(2);
  const line = '='.repeat(96);

  const summary = {
    databases: 0,
    collections: 0,
    indexes: 0,
    totalIndexBytes: 0,
    unused: [],     // { ns, name, sizeMB }
    redundant: [],  // { ns, name, coveredBy }
    skipped: [],    // { ns, reason }
  };

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
  // --------------------------------------------------------------------------

  function main() {
    let dbNames = [];
    try {
      dbNames = db
        .adminCommand({ listDatabases: 1, nameOnly: true, maxTimeMS: MAX_TIME_MS })
        .databases.map((d) => d.name)
        .filter((name) => !EXCLUDED_DBS.has(name))
        .sort();
    } catch (err) {
      print(`FATAL: cannot list databases: ${err.codeName ?? err.message}`);
      return;
    }

    for (const dbName of dbNames) {
      try {
        const database = db.getSiblingDB(dbName);

        const collNames = database
          .getCollectionInfos({ type: 'collection' }, { nameOnly: true })
          .map((c) => c.name)
          .filter((name) => !name.startsWith('system.'))
          .sort();

        if (collNames.length === 0) continue;
        summary.databases++;

        print(`|${line}`);
        print(`| Database '${dbName}'`);
        print(`|${line}`);

        for (const collName of collNames) {
          const ns = `${dbName}.${collName}`;
          const coll = database.getCollection(collName);

          try {
            // --- one storage stats call, merged across shards ---
            const shardDocs = coll
              .aggregate([{ $collStats: { storageStats: {} } }], { maxTimeMS: MAX_TIME_MS })
              .toArray();

            const totals = { totalIndexSize: 0, sizes: {}, frag: {}, cache: {} };
            for (const shardDoc of shardDocs) {
              const s = shardDoc.storageStats ?? {};
              totals.totalIndexSize += s.totalIndexSize ?? 0;
              for (const [n, size] of Object.entries(s.indexSizes ?? {})) {
                totals.sizes[n] = (totals.sizes[n] ?? 0) + size;
              }
              for (const [n, det] of Object.entries(s.indexDetails ?? {})) {
                totals.frag[n] = (totals.frag[n] ?? 0) +
                  (det?.['block-manager']?.['file bytes available for reuse'] ?? 0);
                totals.cache[n] = (totals.cache[n] ?? 0) +
                  (det?.cache?.['bytes currently in the cache'] ?? 0);
              }
            }

            // --- one $indexStats call, merged across shards ---
            const usage = new Map();
            coll
              .aggregate([{ $indexStats: {} }], { maxTimeMS: MAX_TIME_MS })
              .forEach((idx) => {
                const e = usage.get(idx.name) ?? { ops: 0, since: idx.accesses.since };
                e.ops += Number(idx.accesses.ops);
                if (idx.accesses.since < e.since) e.since = idx.accesses.since;
                usage.set(idx.name, e);
              });

            // --- one getIndexes call for definitions and redundancy ---
            const specs = coll.getIndexes();
            const specByName = new Map(specs.map((s) => [s.name, s]));
            const opsByName = {};
            for (const [name, st] of usage.entries()) {
              opsByName[name] = st.ops;
            }
            const redundant = classifyRedundancy(specs, opsByName);

            summary.collections++;
            summary.totalIndexBytes += totals.totalIndexSize;
            print(`|  Collection '${collName}' - ${specs.length} indexes, total index size ${toMB(totals.totalIndexSize)} MB`);

            [...usage.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .forEach(([name, st]) => {
                summary.indexes++;
                const spec = specByName.get(name);
                const flags = [];
                if (st.ops === 0 && name !== '_id_') {
                  flags.push('UNUSED');
                  summary.unused.push({ ns, name, sizeMB: toMB(totals.sizes[name]) });
                }
                if (redundant.has(name)) {
                  const dup = redundant.get(name);
                  flags.push(`REDUNDANT (${dup.class} of '${dup.coveredBy}')`);
                  summary.redundant.push({ ns, name, coveredBy: dup.coveredBy });
                }
                if (spec?.hidden) flags.push('HIDDEN');

                const since = st.since instanceof Date ? st.since.toISOString() : st.since;
                const keyStr = spec ? JSON.stringify(spec.key) : 'n/a';
                print(`|    index '${name}' ${keyStr}${flags.length ? '   <-- ' + flags.join(', ') : ''}`);
                print(`|      accessed ${st.ops} times since ${since}`);
                print(`|      size ${toMB(totals.sizes[name])} MB`);
                print(`|      reusable space (fragmentation) ${toMB(totals.frag[name])} MB`);
                print(`|      in WiredTiger cache ${toMB(totals.cache[name])} MB`);
              });
          } catch (err) {
            const reason = err.codeName ?? err.message;
            summary.skipped.push({ ns, reason });
            print(`|  Collection '${collName}' - skipped: ${reason}`);
          }
        }
      } catch (err) {
        const reason = err.codeName ?? err.message;
        summary.skipped.push({ ns: dbName, reason });
        print(`| Database '${dbName}' - skipped: ${reason}`);
      }
    }

    // ------------------------------- summary ----------------------------------
    print(`|${line}`);
    print(`| SUMMARY`);
    print(`|${line}`);
    print(`|  Scanned: ${summary.databases} databases, ${summary.collections} collections, ${summary.indexes} indexes`);
    print(`|  Total index storage: ${toMB(summary.totalIndexBytes)} MB`);

    print(`|`);
    print(`|  Unused on this node (${summary.unused.length}) - verify on ALL members before dropping:`);
    summary.unused.forEach((u) => print(`|    ${u.ns} -> '${u.name}' (${u.sizeMB} MB)`));

    print(`|`);
    print(`|  Redundancy candidates (${summary.redundant.length}) - plain prefix of a wider plain index:`);
    summary.redundant.forEach((r) => print(`|    ${r.ns} -> '${r.name}' covered by '${r.coveredBy}'`));

    if (summary.skipped.length > 0) {
      print(`|`);
      print(`|  Skipped namespaces (${summary.skipped.length}):`);
      summary.skipped.forEach((s) => print(`|    ${s.ns}: ${s.reason}`));
    }
    print(`|${line}`);
  }

  const api = { SCRIPT_VERSION, isPlain, canonicalKeyString, generatedName, isStrictPrefix, classifyRedundancy };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  try {
    if (typeof db !== 'undefined' && typeof print === 'function') {
      main();
    }
  } catch (e) {
    if (typeof print === 'function') {
      print('| Connect to a database first: mongosh "mongodb://..." --file indexStats.js');
    }
  }
})();