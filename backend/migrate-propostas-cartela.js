// Migração: permitir cartas da cartela nas propostas de troca
// Torna id_mochila nullable e adiciona colunas fonte + id_carta
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Tornar id_mochila nullable (drop NOT NULL)
    await client.query(`
      ALTER TABLE mtkin.propostas_troca_itens
        ALTER COLUMN id_mochila DROP NOT NULL
    `);
    console.log('✅ id_mochila agora é nullable');

    // 2. Adicionar coluna fonte ('mochila' ou 'cartela')
    await client.query(`
      ALTER TABLE mtkin.propostas_troca_itens
        ADD COLUMN IF NOT EXISTS fonte VARCHAR(10) NOT NULL DEFAULT 'mochila'
    `);
    console.log('✅ Coluna fonte adicionada');

    // 3. Adicionar coluna id_carta (referência direta à carta)
    await client.query(`
      ALTER TABLE mtkin.propostas_troca_itens
        ADD COLUMN IF NOT EXISTS id_carta INTEGER
    `);
    console.log('✅ Coluna id_carta adicionada');

    await client.query('COMMIT');
    console.log('🎉 Migração concluída com sucesso!');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Erro na migração:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
