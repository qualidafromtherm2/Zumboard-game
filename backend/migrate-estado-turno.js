require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔄 Criando tabela mtkin.estado_turno...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS mtkin.estado_turno (
        id_sala       INTEGER NOT NULL REFERENCES mtkin.rooms(id) ON DELETE CASCADE,
        id_jogador    INTEGER NOT NULL REFERENCES mtkin.users(id)  ON DELETE CASCADE,
        turno_numero  INTEGER NOT NULL DEFAULT 0,
        fase_porta    VARCHAR(20) NOT NULL DEFAULT 'idle',
        carta_monstro JSONB,
        mensagem      TEXT,
        atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id_sala, id_jogador)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_estado_turno_sala
        ON mtkin.estado_turno(id_sala);
    `);

    console.log('✅ Migration estado_turno concluída com sucesso!');
  } catch (err) {
    console.error('❌ Erro na migration:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
