/**
 * migrate-vencedor.js
 * Adiciona a coluna vencedor_id (INTEGER) à tabela mtkin.rooms, se ainda não existir.
 *
 * Uso:
 *   $env:DB_HOST='...'; $env:DB_PORT='5432'; $env:DB_NAME='...'; $env:DB_USER='...'; $env:DB_PASSWORD='...'; $env:DB_SSL='true'; node backend/migrate-vencedor.js
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
      ALTER TABLE mtkin.rooms
        ADD COLUMN IF NOT EXISTS vencedor_id INTEGER REFERENCES mtkin.users(id);
    `);
    console.log('✅ Coluna vencedor_id adicionada (ou já existia) em mtkin.rooms.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('❌ Erro:', err.message);
  process.exit(1);
});
