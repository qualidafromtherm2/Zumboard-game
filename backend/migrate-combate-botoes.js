// Migration: adiciona colunas botoes_jogador e botoes_outros_jogadores em mtkin.combate
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE mtkin.combate
        ADD COLUMN IF NOT EXISTS botoes_jogador          TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS botoes_outros_jogadores TEXT NOT NULL DEFAULT ''
    `);

    await client.query('COMMIT');
    console.log('✅ Colunas botoes_jogador e botoes_outros_jogadores adicionadas em mtkin.combate');
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
