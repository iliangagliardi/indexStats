// e2e/seed.js  - run against the primary (cluster.sh) or the mongos (sharded.sh)
// The sharded additions are guarded on the router's own self-identification, so
// the exact same file still seeds the replica-set suite unchanged.
const isSharded = db.getSiblingDB('admin').runCommand({ hello: 1 }).msg === 'isdbgrid';

const shop = db.getSiblingDB('shop');
shop.orders.drop();
if (isSharded) {
  // enableSharding is not idempotent across every server version; a second run
  // against a cluster that already has it must not abort the whole seed.
  try { sh.enableSharding('shop'); } catch (e) { print(`enableSharding: ${e.codeName ?? e.message}`); }
  sh.shardCollection('shop.orders', { customerId: 1 });
}
shop.orders.insertMany(Array.from({ length: 500 }, (_, i) => ({
  customerId: i,
  status: i % 3 === 0 ? 'open' : 'closed',
  createdAt: new Date(Date.now() - i * 3600000),
  region: i % 2 ? 'eu' : 'us',
  total: i % 7 === 0 ? String(i) : i,
  tags: ['a', 'b'],
})));
if (isSharded) {
  // Force the collection onto BOTH shards, so each one really reports
  // $collStats/$indexStats for it and the per-shard separation in the payload
  // is exercised rather than asserted vacuously against a single-shard cluster.
  const primaryShard = db.getSiblingDB('config').databases.findOne({ _id: 'shop' }).primary;
  const otherShard = db.getSiblingDB('admin').runCommand({ listShards: 1 })
    .shards.map((s) => s._id).filter((n) => n !== primaryShard)[0];
  sh.splitAt('shop.orders', { customerId: 250 });
  sh.moveChunk('shop.orders', { customerId: 400 }, otherShard);
  print(`shop.orders split across ${primaryShard} and ${otherShard}`);
}
shop.orders.createIndex({ status: 1, createdAt: -1 });
shop.orders.createIndex({ status: 1, createdAt: -1, region: 1 });
shop.orders.createIndex({ status: 1 });
shop.orders.createIndex({ createdAT: 1 });
shop.orders.createIndex({ total: 1 });
shop.orders.createIndex({ tags: 1 });
if (isSharded) {
  // A redundant pair on the SHARDED collection: { customerId: 1 } (created by
  // shardCollection) is a strict prefix of this one.
  shop.orders.createIndex({ customerId: 1, createdAt: 1 });

  // An UNSHARDED collection in the same database. It lives only on shop's
  // primary shard, so every other shard is "not hosting" it rather than
  // "missing the index" - the distinction that keeps it out of `mismatched`.
  shop.lookup.drop();
  shop.lookup.insertMany(Array.from({ length: 120 },
    (_, i) => ({ code: `c${i}`, label: `label ${i}` })));
  shop.lookup.createIndex({ code: 1 });

  // A second database, so the multi-database path is exercised on the router.
  const inventory = db.getSiblingDB('inventory');
  inventory.items.drop();
  inventory.items.insertMany(Array.from({ length: 80 },
    (_, i) => ({ sku: `s${i}`, qty: i })));
  inventory.items.createIndex({ sku: 1 });
}

const crm = db.getSiblingDB('crm');
crm.contacts.drop();
crm.createCollection('contacts', { validator: { $jsonSchema: {
  bsonType: 'object',
  additionalProperties: false,
  properties: { _id: {}, email: { bsonType: 'string' }, tenant: { bsonType: 'string' } },
} } });
crm.contacts.insertMany(Array.from({ length: 200 },
  (_, i) => ({ email: `u${i}@x.io`, tenant: 't1' })));
crm.contacts.createIndex({ email: 1 });
crm.contacts.createIndex({ nickname: 1 });

for (let i = 0; i < 50; i++) {
  shop.orders.find({ status: 'open', createdAt: { $gt: new Date(0) }, region: 'eu' }).toArray();
  crm.contacts.find({ email: 'u1@x.io' }).toArray();
}
if (isSharded) {
  // Drive traffic to the sharded collection's own shard-key index on both
  // shards, so per-shard ops are non-zero on each of them.
  for (let i = 0; i < 50; i++) {
    shop.orders.find({ customerId: { $gte: 100, $lt: 450 } }).toArray();
  }
}
print('seeded');
