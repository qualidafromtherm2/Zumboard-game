// Migration: cria tabela mtkin.combate para registrar cada combate iniciado
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : { rejectUnauthorized: false },
});

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS mtkin.combate (
        id               SERIAL PRIMARY KEY,
        id_combate       VARCHAR(64)  NOT NULL UNIQUE,
        id_sala          INTEGER      NOT NULL REFERENCES mtkin.rooms(id) ON DELETE CASCADE,
        id_jogador       INTEGER      NOT NULL REFERENCES mtkin.users(id) ON DELETE CASCADE,
        forca_jogador    INTEGER      NOT NULL DEFAULT 0,
        forca_monstro    INTEGER      NOT NULL DEFAULT 0,
        id_carta_monstro INTEGER      REFERENCES mtkin.cartas(id) ON DELETE SET NULL,
        simulado         BOOLEAN      NOT NULL DEFAULT FALSE,
        status           VARCHAR(30)  NOT NULL DEFAULT 'em_andamento',
        criado_em        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        atualizado_em    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_combate_id_combate ON mtkin.combate (id_combate);
      CREATE INDEX IF NOT EXISTS idx_combate_id_sala    ON mtkin.combate (id_sala);
    `);

    await client.query('COMMIT');
    console.log('✅ Tabela mtkin.combate criada com sucesso');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Erro na migration:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
