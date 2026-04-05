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
  // Check realtime schema exposure settings
  try {
    const r1 = await p.query("SELECT * FROM pg_settings WHERE name LIKE '%realtime%'");
    if (r1.rows.length) {
      console.log('Realtime settings:');
      for (const r of r1.rows) console.log('  ' + r.name + ' = ' + r.setting);
    }
  } catch(e) { console.log('pg_settings check failed:', e.message); }

  // Check if realtime extension handles schemas
  try {
    const r2 = await p.query("SELECT name, setting FROM pg_settings WHERE name = 'pgrst.db_schemas'");
    console.log('\nPostgREST schemas:', r2.rows);
  } catch(e) {}

  // Check exposed schemas in supabase config
  try {
    const r3 = await p.query("SHOW app.settings.realtime_schemas");
    console.log('Realtime schemas setting:', r3.rows);
  } catch(e) { console.log('No app.settings.realtime_schemas'); }

  // Check if the publication has replica identity set
  const tables = [
    'estado_turno','combate','ajuda_combate','sala_online','rooms',
    'room_participants','cartas_ativas','cartas_no_jogo'
  ];
  console.log('\nReplica identity for key tables:');
  for (const t of tables) {
    const r = await p.query(
      "SELECT relreplident FROM pg_class WHERE relname=$1 AND relnamespace=(SELECT oid FROM pg_namespace WHERE nspname='mtkin')",
      [t]
    );
    const ident = r.rows[0]?.relreplident;
    const label = ident === 'f' ? 'FULL' : ident === 'd' ? 'DEFAULT (pk)' : ident === 'n' ? 'NOTHING' : ident;
    console.log('  mtkin.' + t + ': ' + label);
  }

  await p.end();
})().catch(e => { console.error(e.message); p.end(); });
