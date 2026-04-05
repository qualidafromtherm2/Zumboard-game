/**
 * Migração: Adicionar coluna 'simulador' na tabela mtkin.rooms
 *
 * Valores: 'ativado' | 'desativado' (default)
 *
 * Como executar:
 * node backend/migrate-simulador.js
 */

const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('📊 Conectando ao banco de dados...');
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE mtkin.rooms
      ADD COLUMN IF NOT EXISTS simulador VARCHAR(20) DEFAULT 'desativado'
    `);
    console.log('✅ Coluna simulador adicionada (ou já existia).');

    await client.query(`
      COMMENT ON COLUMN mtkin.rooms.simulador IS 'Modo simulador da sala: ativado ou desativado'
    `);

    await client.query('COMMIT');
    console.log('✅ Migração concluída com sucesso!');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Erro na migração:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
