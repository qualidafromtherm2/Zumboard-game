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
    console.log('🔄 Adicionando coluna prontos_organizacao em mtkin.rooms...');

    await client.query(`
      ALTER TABLE mtkin.rooms
        ADD COLUMN IF NOT EXISTS prontos_organizacao INTEGER[] NOT NULL DEFAULT '{}';
    `);

    console.log('✅ Migration de turno de organização concluída com sucesso!');
  } catch (err) {
    console.error('❌ Erro na migration:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
