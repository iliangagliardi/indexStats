// e2e/seed.js  - run against the primary
const shop = db.getSiblingDB('shop');
shop.orders.drop();
shop.orders.insertMany(Array.from({ length: 500 }, (_, i) => ({
  status: i % 3 === 0 ? 'open' : 'closed',
  createdAt: new Date(Date.now() - i * 3600000),
  region: i % 2 ? 'eu' : 'us',
  total: i % 7 === 0 ? String(i) : i,
  tags: ['a', 'b'],
})));
shop.orders.createIndex({ status: 1, createdAt: -1 });
shop.orders.createIndex({ status: 1, createdAt: -1, region: 1 });
shop.orders.createIndex({ status: 1 });
shop.orders.createIndex({ createdAT: 1 });
shop.orders.createIndex({ total: 1 });
shop.orders.createIndex({ tags: 1 });

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
print('seeded');
