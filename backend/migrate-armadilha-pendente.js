require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mtkin.armadilha_pendente (
        id SERIAL PRIMARY KEY,
        id_sala INTEGER NOT NULL REFERENCES mtkin.rooms(id) ON DELETE CASCADE,
        regra_id INTEGER NOT NULL,
        id_carta_armadilha INTEGER NOT NULL,
        id_jogador_alvo INTEGER NOT NULL REFERENCES mtkin.users(id) ON DELETE CASCADE,
        id_jogador_ator INTEGER NOT NULL REFERENCES mtkin.users(id) ON DELETE CASCADE,
        dados JSONB NOT NULL DEFAULT '{}',
        respostas JSONB NOT NULL DEFAULT '{}',
        status VARCHAR(20) NOT NULL DEFAULT 'pendente',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_armadilha_pendente_sala ON mtkin.armadilha_pendente(id_sala);
      CREATE INDEX IF NOT EXISTS idx_armadilha_pendente_status ON mtkin.armadilha_pendente(status);
    `);
    console.log('Tabela mtkin.armadilha_pendente criada com sucesso.');
  } catch (err) {
    console.error('Erro:', err);
  } finally {
    await pool.end();
  }
})();
