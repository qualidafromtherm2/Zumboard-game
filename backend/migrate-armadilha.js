/**
 * Migração: Adicionar coluna 'armadilha' em mtkin.cartas
 * e criar tabela mtkin.regras_customizadas
 *
 * Como executar:
 * node backend/migrate-armadilha.js
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

    // Adicionar coluna armadilha em mtkin.cartas
    await client.query(`
      ALTER TABLE mtkin.cartas
      ADD COLUMN IF NOT EXISTS armadilha TEXT
    `);
    console.log('✅ Coluna armadilha adicionada em mtkin.cartas');

    // Criar tabela de regras customizadas
    await client.query(`
      CREATE TABLE IF NOT EXISTS mtkin.regras_customizadas (
        id SERIAL PRIMARY KEY,
        texto TEXT NOT NULL,
        criado_em TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);
    console.log('✅ Tabela mtkin.regras_customizadas criada');

    await client.query('COMMIT');
    console.log('✅ Migração concluída com sucesso!');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Erro na migração:', error.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
