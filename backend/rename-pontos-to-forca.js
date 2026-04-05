const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

async function renamePontosToForca() {
  try {
    console.log('📊 Conectando ao banco de dados...');
    
    // Renomear pontos_ganhos para forca_ganha
    await pool.query(`
      ALTER TABLE mtkin.cartas_porta 
      RENAME COLUMN pontos_ganhos TO forca_ganha;
    `);
    console.log('✅ Coluna pontos_ganhos renomeada para forca_ganha');
    
    // Renomear pontos_perdidos para forca_perdida
    await pool.query(`
      ALTER TABLE mtkin.cartas_porta 
      RENAME COLUMN pontos_perdidos TO forca_perdida;
    `);
    console.log('✅ Coluna pontos_perdidos renomeada para forca_perdida');
    
    // Atualizar comentários
    await pool.query(`
      COMMENT ON COLUMN mtkin.cartas_porta.forca_ganha IS 'Força ganha ao jogar/usar a carta';
      COMMENT ON COLUMN mtkin.cartas_porta.forca_perdida IS 'Força perdida ao jogar/usar a carta';
    `);
    console.log('✅ Comentários atualizados!');
    
    // Mostrar estrutura atualizada
    const result = await pool.query(`
      SELECT column_name, data_type, column_default
      FROM information_schema.columns
      WHERE table_schema = 'mtkin' 
      AND table_name = 'cartas_porta'
      ORDER BY ordinal_position;
    `);
    
    console.log('\n📋 Estrutura atualizada da tabela mtkin.cartas_porta:');
    result.rows.forEach(row => {
      console.log(`   ${row.column_name} (${row.data_type})`);
    });
    
  } catch (error) {
    console.error('❌ Erro:', error.message);
  } finally {
    await pool.end();
  }
}

renamePontosToForca();
