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

async function addPontosColumns() {
  try {
    console.log('📊 Conectando ao banco de dados...');
    
    // Adicionar colunas pontos_ganhos e pontos_perdidos
    await pool.query(`
      ALTER TABLE mtkin.cartas_porta 
      ADD COLUMN IF NOT EXISTS pontos_ganhos INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS pontos_perdidos INTEGER DEFAULT 0;
    `);
    
    console.log('✅ Colunas pontos_ganhos e pontos_perdidos adicionadas com sucesso!');
    
    // Adicionar comentários
    await pool.query(`
      COMMENT ON COLUMN mtkin.cartas_porta.pontos_ganhos IS 'Pontos ganhos ao jogar/usar a carta';
      COMMENT ON COLUMN mtkin.cartas_porta.pontos_perdidos IS 'Pontos perdidos ao jogar/usar a carta';
    `);
    
    console.log('✅ Comentários adicionados às novas colunas!');
    
    // Mostrar estrutura atualizada
    const result = await pool.query(`
      SELECT column_name, data_type, column_default
      FROM information_schema.columns
      WHERE table_schema = 'mtkin' 
      AND table_name = 'cartas_porta'
      ORDER BY ordinal_position;
    `);
    
    console.log('\n📋 Estrutura da tabela mtkin.cartas_porta:');
    result.rows.forEach(row => {
      console.log(`   ${row.column_name} (${row.data_type})`);
    });
    
  } catch (error) {
    console.error('❌ Erro:', error.message);
  } finally {
    await pool.end();
  }
}

addPontosColumns();
