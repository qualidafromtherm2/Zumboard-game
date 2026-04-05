require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Adicionando colunas em mtkin.cartas...');

    await client.query(`
      ALTER TABLE mtkin.cartas
        ADD COLUMN IF NOT EXISTS n_pode_equipar TEXT,
        ADD COLUMN IF NOT EXISTS forca INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS item INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS nivel INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS fulga_minima INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS texto_da_carta TEXT;
    `);

    console.log('✅ Colunas adicionadas/garantidas com sucesso.');
  } catch (error) {
    console.error('Erro na migração:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
