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
<script>${CLIENT_FUNCTIONS}
${CLIENT_BOOTSTRAP}</script>
</body></html>`;
  }

  const api = { SCRIPT_VERSION, isPlain, canonicalKeyString, generatedName, isStrictPrefix, classifyRedundancy, mergeNodes, LOW_PRESENCE, bsonTypeOf, flattenPaths, profileSample, keyFieldsOf, validatorPaths, classifySchemaIssues, VERDICT_ORDER, deriveVerdict, applyAnalysis, esc, jsonForScript, fmtBytes, renderHTML, selectIndexes, summarise, dropCommandsFor };

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