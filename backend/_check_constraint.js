const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'munchkin',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});
pool.query(`
  SELECT c.conname, pg_get_constraintdef(c.oid) AS def
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE t.relname = 'deck_estado' AND n.nspname = 'mtkin' AND c.contype = 'c'
`).then(r => {
  r.rows.forEach(x => console.log(x.conname, ':', x.def));
  pool.end();
}).catch(e => { console.error(e.message); pool.end(); });
