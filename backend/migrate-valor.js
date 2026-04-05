/**
 * migrate-valor.js
 * Adiciona a coluna valor (INTEGER DEFAULT 0) à tabela mtkin.cartas, se ainda não existir.
 *
 * Uso:
 *   $env:DB_HOST='...'; $env:DB_PORT='5432'; $env:DB_NAME='...'; $env:DB_USER='...'; $env:DB_PASSWORD='...'; $env:DB_SSL='true'; node backend/migrate-valor.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'munchkin',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

async function main() {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE mtkin.cartas
        ADD COLUMN IF NOT EXISTS valor INTEGER DEFAULT 0;
    `);
    console.log('✅ Coluna valor adicionada (ou já existia) em mtkin.cartas.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
