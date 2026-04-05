// Migration: adiciona coluna interferencia em mtkin.combate
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
        ADD COLUMN IF NOT EXISTS interferencia TEXT NOT NULL DEFAULT ''
    `);
    await client.query('COMMIT');
    console.log('✅ Coluna interferencia adicionada em mtkin.combate');
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
