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
  // 1) Grant usage on mtkin schema to supabase roles so Realtime can read changes
  const grants = [
    "GRANT USAGE ON SCHEMA mtkin TO anon, authenticated, service_role",
    "GRANT SELECT ON ALL TABLES IN SCHEMA mtkin TO anon, authenticated, service_role",
    "ALTER DEFAULT PRIVILEGES IN SCHEMA mtkin GRANT SELECT ON TABLES TO anon, authenticated, service_role"
  ];
  for (const sql of grants) {
    try {
      await p.query(sql);
      console.log('OK: ' + sql.substring(0, 60));
    } catch(e) {
      console.log('SKIP: ' + e.message.substring(0, 80));
    }
  }

  // 2) Ensure all key tables are in supabase_realtime publication
  const tables = [
    'estado_turno','combate','combate_cartas','ajuda_combate','combate_participacao',
    'historico_cartas','propostas_troca','cartas_ativas','cartas_no_jogo',
    'sala_online','rooms','room_participants'
  ];
  for (const t of tables) {
    try {
      await p.query('ALTER PUBLICATION supabase_realtime ADD TABLE mtkin.' + t);
      console.log('Added to publication: mtkin.' + t);
    } catch(e) {
      if (e.message.includes('already member')) {
        console.log('Already in publication: mtkin.' + t);
      } else {
        console.log('Error adding ' + t + ': ' + e.message);
      }
    }
  }

  // 3) Set REPLICA IDENTITY FULL on all tables (needed for UPDATE/DELETE events with filters)
  for (const t of tables) {
    try {
      await p.query('ALTER TABLE mtkin.' + t + ' REPLICA IDENTITY FULL');
      console.log('REPLICA IDENTITY FULL: mtkin.' + t);
    } catch(e) {
      console.log('Error REPLICA IDENTITY ' + t + ': ' + e.message);
    }
  }

  // 4) Enable RLS on tables (required for Supabase Realtime to work with filters)
  for (const t of tables) {
    try {
      await p.query('ALTER TABLE mtkin.' + t + ' ENABLE ROW LEVEL SECURITY');
      console.log('RLS enabled: mtkin.' + t);
    } catch(e) {
      console.log('RLS error ' + t + ': ' + e.message);
    }
    // Create permissive policy for SELECT (Realtime needs this)
    try {
      await p.query('CREATE POLICY "Allow realtime select" ON mtkin.' + t + ' FOR SELECT USING (true)');
      console.log('Policy created: mtkin.' + t);
    } catch(e) {
      if (e.message.includes('already exists')) {
        console.log('Policy already exists: mtkin.' + t);
      } else {
        console.log('Policy error ' + t + ': ' + e.message);
      }
    }
  }

  console.log('\nDone! Realtime should now work for mtkin schema.');
  await p.end();
})().catch(e => { console.error(e); p.end(); });
