require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Adicionar coluna qtd_max com default 1
    await client.query(`
      ALTER TABLE mtkin.cartas
      ADD COLUMN IF NOT EXISTS qtd_max INTEGER NOT NULL DEFAULT 1
    `);

    // Criar índice para consultas de disponibilidade
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cartas_qtd_max ON mtkin.cartas(qtd_max)
    `);

    await client.query('COMMIT');
    console.log('✅ Coluna qtd_max adicionada com sucesso em mtkin.cartas (default = 1).');
    console.log('   Use UPDATE mtkin.cartas SET qtd_max = N WHERE id = X para ajustar por carta.');
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
