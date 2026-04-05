/**
 * Migration: propostas_troca v2 - suporte many-to-many de cartas por proposta
 * Cria tabela propostas_troca_itens e limpa as colunas antigas carta_origem/carta_destino
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Criar tabela pivot de itens da proposta
    await client.query(`
      CREATE TABLE IF NOT EXISTS mtkin.propostas_troca_itens (
        id          SERIAL PRIMARY KEY,
        id_proposta INTEGER NOT NULL REFERENCES mtkin.propostas_troca(id) ON DELETE CASCADE,
        id_mochila  INTEGER NOT NULL REFERENCES mtkin.mochila(id) ON DELETE CASCADE,
        lado        VARCHAR(10) NOT NULL CHECK (lado IN ('origem', 'destino'))
      );
    `);
    console.log('✅ Tabela propostas_troca_itens criada/verificada.');

    // 2. Índices
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_prop_itens_proposta ON mtkin.propostas_troca_itens(id_proposta);
      CREATE INDEX IF NOT EXISTS idx_prop_itens_mochila  ON mtkin.propostas_troca_itens(id_mochila);
    `);

    // 3. Remover FK constraints das colunas antigas (se existirem) e torná-las nullable
    //    (mantemos as colunas para não perder dados históricos)
    await client.query(`
      ALTER TABLE mtkin.propostas_troca
        ALTER COLUMN carta_origem DROP NOT NULL,
        ALTER COLUMN carta_destino DROP NOT NULL;
    `).catch(() => { /* colunas já podem ser nullable */ });

    // 4. Remover FK de carta_origem e carta_destino se existirem (podem ter constraint nomeada)
    const fks = await client.query(`
      SELECT constraint_name
      FROM information_schema.table_constraints
      WHERE table_schema = 'mtkin'
        AND table_name = 'propostas_troca'
        AND constraint_type = 'FOREIGN KEY'
        AND constraint_name LIKE '%carta%';
    `);
    for (const row of fks.rows) {
      await client.query(`ALTER TABLE mtkin.propostas_troca DROP CONSTRAINT IF EXISTS "${row.constraint_name}";`);
      console.log(`  Removido FK: ${row.constraint_name}`);
    }

    await client.query('COMMIT');
    console.log('✅ Migração propostas v2 concluída com sucesso!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Erro na migração:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
