/**
 * Migração: cria tabela mtkin.deck_estado
 *
 * Objetivo: rastrear onde cada carta está durante uma partida.
 * Impede cartas duplicadas em door-random e permite saber o que
 * já saiu do baralho físico.
 *
 * Execução:
 *   $env:DB_HOST='...'; $env:DB_PORT='5432'; $env:DB_NAME='...';
 *   $env:DB_USER='...'; $env:DB_PASSWORD='...'; $env:DB_SSL='true';
 *   node backend/migrate-deck-estado.js
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS mtkin.deck_estado (
        id              SERIAL PRIMARY KEY,
        id_sala         INTEGER NOT NULL,
        id_carta        INTEGER NOT NULL,
        tipo_baralho    VARCHAR(20) NOT NULL CHECK (tipo_baralho IN ('cidade','item')),
        localizacao     VARCHAR(30) NOT NULL DEFAULT 'mao'
                        CHECK (localizacao IN ('mao','cartela','mochila','combate','descarte')),
        id_jogador      INTEGER,
        criado_em       TIMESTAMP DEFAULT NOW(),
        atualizado_em   TIMESTAMP DEFAULT NOW(),
        UNIQUE (id_sala, id_carta, tipo_baralho)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_deck_estado_sala
        ON mtkin.deck_estado (id_sala);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_deck_estado_sala_baralho
        ON mtkin.deck_estado (id_sala, tipo_baralho);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_deck_estado_sala_loc
        ON mtkin.deck_estado (id_sala, localizacao);
    `);

    await client.query('COMMIT');
    console.log('✅ Tabela mtkin.deck_estado criada com sucesso.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Erro:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
