// Migration: adicionar coluna duracao_ms ao historico_eventos
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST,
  port: +process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

(async () => {
  const cols = [
    { name: 'duracao_ms', sql: "ALTER TABLE mtkin.historico_eventos ADD COLUMN IF NOT EXISTS duracao_ms INTEGER" },
    { name: 'nome_jogador', sql: "ALTER TABLE mtkin.historico_eventos ADD COLUMN IF NOT EXISTS nome_jogador VARCHAR(50)" },
    { name: 'nome_sala', sql: "ALTER TABLE mtkin.historico_eventos ADD COLUMN IF NOT EXISTS nome_sala VARCHAR(100)" },
    { name: 'turno_numero', sql: "ALTER TABLE mtkin.historico_eventos ADD COLUMN IF NOT EXISTS turno_numero INTEGER" },
    { name: 'evento_id_ref', sql: "ALTER TABLE mtkin.historico_eventos ADD COLUMN IF NOT EXISTS evento_id_ref INTEGER" },
  ];
  for (const c of cols) {
    await pool.query(c.sql);
    console.log('OK: ' + c.name);
  }

  // Index para consultas rápidas
  await pool.query("CREATE INDEX IF NOT EXISTS idx_historico_eventos_sala ON mtkin.historico_eventos(id_sala)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_historico_eventos_tipo ON mtkin.historico_eventos(tipo)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_historico_eventos_criado ON mtkin.historico_eventos(criado_em)");
  console.log('Indexes OK');

  await pool.end();
  console.log('Migration complete');
})().catch(e => { console.error(e); pool.end(); });
