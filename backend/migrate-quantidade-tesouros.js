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
    console.log('Adicionando coluna quantidade_tesouros...');
    
    await client.query(`
      ALTER TABLE mtkin.historico_cartas 
      ADD COLUMN IF NOT EXISTS quantidade_tesouros INTEGER DEFAULT 0;
    `);
    
    console.log('✅ Coluna quantidade_tesouros adicionada com sucesso!');
    
  } catch (error) {
    console.error('Erro na migração:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
