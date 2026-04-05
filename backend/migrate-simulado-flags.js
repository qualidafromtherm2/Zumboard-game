/**
 * Migração: Adicionar coluna 'simulado' em todas as tabelas de estado de jogo
 * e colunas de backup em sala_online para restaurar o estado pré-simulação.
 *
 * Como executar:
 * node backend/migrate-simulado-flags.js
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

    // Tabelas de estado de jogo que precisam da coluna simulado
    const gameStateTables = [
      'cartas_no_jogo',
      'cartas_ativas',
      'combate_cartas',
      'mochila',
      'historico_cartas',
      'deck_estado',
      'estado_turno',
      'historico_eventos',
      'propostas_troca',
      'ajuda_combate',
      'combate_participacao',
    ];

    for (const table of gameStateTables) {
      await client.query(
        `ALTER TABLE mtkin.${table} ADD COLUMN IF NOT EXISTS simulado BOOLEAN NOT NULL DEFAULT FALSE`
      );
      console.log(`✅ simulado adicionado em mtkin.${table}`);
    }

    // Colunas de backup no sala_online para restaurar estado pré-simulação
    await client.query(
      `ALTER TABLE mtkin.sala_online ADD COLUMN IF NOT EXISTS sim_mao_backup INTEGER`
    );
    await client.query(
      `ALTER TABLE mtkin.sala_online ADD COLUMN IF NOT EXISTS sim_nivel_backup INTEGER`
    );
    await client.query(
      `ALTER TABLE mtkin.sala_online ADD COLUMN IF NOT EXISTS sim_tabuleiro_backup INTEGER`
    );
    console.log('✅ Colunas de backup (sim_mao_backup, sim_nivel_backup, sim_tabuleiro_backup) adicionadas em mtkin.sala_online');

    await client.query('COMMIT');
    console.log('\n✅ Migração simulado-flags concluída com sucesso!');
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
