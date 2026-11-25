const { initDb } = require('D:/munnisoft-v2/src/db');
const db = initDb('D:/munnisoft-v2/data/ledger.db');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'metrics_chat_%'").all();
console.log('Tables in munnisoft-v2 ledger.db:', tables.map(t => t.name));
for (const t of tables) {
  const c = db.prepare(`SELECT count(*) as c FROM "${t.name}"`).get();
  console.log(`${t.name}: ${c.c} rows`);
}
const adSpend = db.prepare('SELECT count(*) as c, sum(amount) as s FROM ad_spend').get();
console.log('ad_spend in munnisoft-v2:', adSpend);
