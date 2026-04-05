const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'dpg-d2d4b0a4d50c7385vm50-a.oregon-postgres.render.com',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'intranet_db_yd0w',
  user: process.env.DB_USER || 'intranet_db_yd0w_user',
  password: process.env.DB_PASSWORD || 'amLpOKjWzzDRhwcR1NF0eolJzzfCY0ho',
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS mtkin.descarte (
        id            SERIAL PRIMARY KEY,
        id_sala       INTEGER NOT NULL REFERENCES mtkin.rooms(id) ON DELETE CASCADE,
        id_carta      INTEGER NOT NULL,
        nome_carta    VARCHAR(150) NOT NULL,
        tipo_baralho  VARCHAR(20) NOT NULL,
        caminho_imagem VARCHAR(255),
        id_jogador    INTEGER REFERENCES mtkin.users(id) ON DELETE SET NULL,
        nome_jogador  VARCHAR(50),
        descartado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_descarte_sala  ON mtkin.descarte(id_sala);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_descarte_carta ON mtkin.descarte(id_carta);
    `);
    console.log('✅ Tabela mtkin.descarte criada com sucesso!');
  } catch (e) {
    console.error('❌ Erro:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
