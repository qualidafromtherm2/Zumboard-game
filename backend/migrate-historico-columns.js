const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: {
    rejectUnauthorized: false
  }
});

async function migrate() {
  try {
    console.log('🔄 Adicionando novas colunas na tabela mtkin.historico_cartas...');
    
    // Adicionar coluna origem_acao
    await pool.query(`
      ALTER TABLE mtkin.historico_cartas 
      ADD COLUMN IF NOT EXISTS origem_acao VARCHAR(50)
    `);
    console.log('✅ Coluna origem_acao adicionada');
    
    // Adicionar coluna foi_combate
    await pool.query(`
      ALTER TABLE mtkin.historico_cartas 
      ADD COLUMN IF NOT EXISTS foi_combate BOOLEAN DEFAULT FALSE
    `);
    console.log('✅ Coluna foi_combate adicionada');
    
    // Adicionar coluna resultado_combate
    await pool.query(`
      ALTER TABLE mtkin.historico_cartas 
      ADD COLUMN IF NOT EXISTS resultado_combate VARCHAR(20)
    `);
    console.log('✅ Coluna resultado_combate adicionada');
    
    console.log('✨ Migração concluída com sucesso!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Erro na migração:', error);
    process.exit(1);
  }
}

migrate();
