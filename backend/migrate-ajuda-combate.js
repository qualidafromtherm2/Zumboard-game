// migrate-ajuda-combate.js
// Cria a tabela mtkin.ajuda_combate usada para negociar ajuda durante combate
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS mtkin.ajuda_combate (
        id              SERIAL        PRIMARY KEY,
        id_sala         INTEGER       NOT NULL,
        id_combate      TEXT,
        id_lutador      INTEGER       NOT NULL,
        id_proponente   INTEGER       NOT NULL,
        id_destinatario INTEGER       NOT NULL,
        tipo_proposta   VARCHAR(50)   NOT NULL,
        fluxo           VARCHAR(20)   NOT NULL DEFAULT 'direto',
        status          VARCHAR(30)   NOT NULL DEFAULT 'pendente',
        proposta_pai    INTEGER       REFERENCES mtkin.ajuda_combate(id),
        created_at      TIMESTAMPTZ   DEFAULT NOW(),
        updated_at      TIMESTAMPTZ   DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ajuda_combate_sala ON mtkin.ajuda_combate(id_sala, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ajuda_combate_dest ON mtkin.ajuda_combate(id_destinatario, status)`);
    console.log('✅ Tabela mtkin.ajuda_combate criada/verificada com sucesso');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(e => { console.error('Erro na migração:', e.message); process.exit(1); });
