const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function runSchema() {
  const client = new Client({
    host: 'dpg-d2d4b0a4d50c7385vm50-a.oregon-postgres.render.com',
    port: 5432,
    database: 'intranet_db_yd0w',
    user: 'intranet_db_yd0w_user',
    password: 'amLpOKjWzzDRhwcR1NF0eolJzzfCY0ho',
    ssl: {
      rejectUnauthorized: false
    }
  });

  try {
    console.log('🔌 Conectando ao banco de dados...');
    await client.connect();
    console.log('✓ Conectado com sucesso!\n');

    const sqlFile = path.join(__dirname, '..', 'database', 'schema.sql');
    const sql = fs.readFileSync(sqlFile, 'utf8');

    console.log('📝 Executando script SQL...');
    await client.query(sql);

    console.log('✓ Tabelas criadas com sucesso!\n');

    // Verificar se as tabelas foram criadas
    const result = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'mtkin'
    `);

    console.log('📋 Tabelas criadas no schema mtkin:');
    result.rows.forEach(row => {
      console.log('  - ' + row.table_name);
    });

  } catch (error) {
    console.error('❌ Erro ao executar SQL:', error.message);
    process.exit(1);
  } finally {
    await client.end();
    console.log('\n✓ Conexão fechada.');
  }
}

runSchema();
