// FINDING 3 (final review, important): the outer try/catch at the bottom of
// indexStats.js used to wrap the main() call itself, so ANY throw from
// inside main() printed only "Connect to a database first: ..." - a false
// diagnosis (the shell IS connected; something else broke) and no report.
// main() is not exported (it is invoked once, at module-load time, guarded
// by `typeof db`), so the only way to exercise the real bottom-of-file gate
// is to set up the mongosh-shaped globals it reads (`db`, `print`, `Mongo`,
// `process`) BEFORE requiring the module fresh, and force a genuine failure
// deep inside main() that is not already caught by one of its own inner
// try/catches (per-member connection errors, discoverMembers errors, and
// sampling errors are all deliberately caught inside main() itself - this
// test must reach past all of those to prove the OUTER gate no longer
// mislabels a real bug as "not connected").
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const SCRIPT_PATH = require.resolve('../indexStats.js');

function runWithGlobals(globals) {
  const prevKeys = ['db', 'print', 'Mongo', 'require'];
  const saved = {};
  for (const k of prevKeys) saved[k] = global[k];
  Object.assign(global, globals);
  delete Module._cache[SCRIPT_PATH];
  try {
    require(SCRIPT_PATH);
  } finally {
    delete Module._cache[SCRIPT_PATH];
    for (const k of prevKeys) {
      if (saved[k] === undefined) delete global[k];
      else global[k] = saved[k];
    }
  }
}

test('finding 3: a genuine error deep inside main() prints a FATAL line, never the "connect to a database" message', () => {
  const prints = [];
  const fakePrint = (msg) => {
    // The per-member "unreachable" notice (main(), ~line 866) is the deepest
    // point NOT already guarded by its own outer try/catch that reports a
    // clean message - make it explode, simulating an unanticipated bug deep
    // in a spot the author reasonably assumed could only ever hit the
    // adjacent `member.reachable = false` catch cleanly.
    if (String(msg).startsWith('member ') && String(msg).includes('unreachable')) {
      throw new TypeError('simulated unexpected failure deep inside main()');
    }
    prints.push(msg);
  };

  const adminDb = {
    runCommand(cmd) {
      if (cmd.hello) return { ok: 1 };
      if (cmd.replSetGetConfig) {
        const e = new Error('not running with --replSet');
        e.codeName = 'NoReplicationEnabled';
        throw e;
      }
      throw new Error('unexpected admin command ' + JSON.stringify(cmd));
    },
    serverStatus() { throw new Error('no serverStatus in this fake'); },
  };

  const fakeDb = {
    getSiblingDB(name) {
      assert.equal(name, 'admin');
      return adminDb;
    },
    getMongo() {
      // Reached by connFor() in non-fanout mode; throwing here is what the
      // fakePrint('member ... unreachable') branch above turns into an
      // uncaught TypeError, since main()'s own catch block's print() call
      // is what actually explodes.
      throw new Error('connection refused');
    },
  };

  runWithGlobals({ db: fakeDb, print: fakePrint, Mongo: undefined, require: undefined });

  assert.equal(prints.some((m) => /Connect to a database first/.test(m)), false,
    'must not disguise a real bug inside main() as "not connected"');
  assert.equal(prints.some((m) => /^FATAL: /.test(m)), true,
    'must surface a distinct FATAL line for a genuine failure inside main()');
  assert.equal(prints.some((m) => /simulated unexpected failure/.test(m)), true,
    'the FATAL line must carry the real underlying error message');
});

test('finding 3: the shell gate itself still prints the connect message, unaffected, when db is genuinely absent', () => {
  const prints = [];
  runWithGlobals({ db: undefined, print: (m) => prints.push(m), Mongo: undefined, require: undefined });
  assert.equal(prints.length, 1);
  assert.match(prints[0], /Connect to a database first/);
});
