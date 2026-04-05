require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({
  host: process.env.DB_HOST,
  port: +process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  // Check if supabase_realtime publication exists and which tables it covers
  const pub = await p.query("SELECT * FROM pg_publication WHERE pubname = 'supabase_realtime'");
  console.log('Publication:', JSON.stringify(pub.rows));

  const tables = await p.query(
    "SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime' ORDER BY schemaname, tablename"
  );
  console.log('\nTables in supabase_realtime publication:');
  for (const t of tables.rows) {
    console.log('  ' + t.schemaname + '.' + t.tablename);
  }

  if (tables.rows.length === 0) {
    console.log('\n  (NONE — Realtime is NOT enabled for any table!)');
  }

  // Check if mtkin schema tables are included
  const mtkinTables = tables.rows.filter(t => t.schemaname === 'mtkin');
  console.log('\nmtkin tables in publication: ' + mtkinTables.length);

  await p.end();
})().catch(e => { console.error(e.message); p.end(); });
