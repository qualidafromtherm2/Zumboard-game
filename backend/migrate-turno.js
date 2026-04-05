/**
 * Migration: sistema de turnos
 * - Adiciona colunas de controle de turno na tabela rooms
 * - Cria tabela historico_eventos para eventos de jogo
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

    // Colunas de turno na tabela rooms
    await client.query(`
      ALTER TABLE mtkin.rooms
        ADD COLUMN IF NOT EXISTS ordem_turno INTEGER[] DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS turno_atual_index INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS turno_numero INTEGER DEFAULT 0
    `);
    console.log('✅ Colunas de turno adicionadas a mtkin.rooms');

    // Tabela de histórico de eventos de jogo
    await client.query(`
      CREATE TABLE IF NOT EXISTS mtkin.historico_eventos (
        id          SERIAL PRIMARY KEY,
        id_sala     INTEGER REFERENCES mtkin.rooms(id) ON DELETE CASCADE,
        id_jogador  INTEGER REFERENCES mtkin.users(id) ON DELETE SET NULL,
        tipo        VARCHAR(50)  NOT NULL,
        descricao   TEXT,
        dados       JSONB,
        criado_em   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_historico_eventos_sala
        ON mtkin.historico_eventos(id_sala)
    `);
    console.log('✅ Tabela mtkin.historico_eventos criada/verificada');

    await client.query('COMMIT');
    console.log('✅ Migration de turnos concluída com sucesso!');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => { console.error(err); process.exit(1); });
