const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

async function createTreasureCardsTable() {
  try {
    console.log('📊 Conectando ao banco de dados...');

    await pool.query('DELETE FROM mtkin.cartas WHERE tipo_carta = $1', ['Item']);
    console.log('🗑️  Registros de Item limpos para nova insercao\n');

    const cartasPath = path.join(__dirname, '../Cartas/Itens');
    const files = fs.readdirSync(cartasPath)
      .filter((file) => file.match(/\.(png|jpg|jpeg|webp|gif)$/i))
      .map((file) => `Cartas/Itens/${file}`)
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));

    let totalInserted = 0;

    console.log(`📂 Inserindo ${files.length} cartas de Itens...`);

    for (const relativePath of files) {
      const cardName = path.parse(relativePath).name;
      const imagePath = relativePath;

      await pool.query(
        `INSERT INTO mtkin.cartas (nome_carta, tipo_carta, caminho_imagem, equipar_onde, permite_mochila)
         VALUES ($1, $2, $3, NULL, FALSE)` ,
        [cardName, 'Item', imagePath]
      );

      totalInserted++;
    }

    console.log(`   ✅ ${files.length} cartas de Itens inseridas\n`);
    console.log(`\n🎉 Total de ${totalInserted} cartas inseridas com sucesso!`);

    const result = await pool.query(`
      SELECT tipo_carta, COUNT(*) as total
      FROM mtkin.cartas
      WHERE tipo_carta = 'Item'
      GROUP BY tipo_carta
      ORDER BY tipo_carta
    `);

    console.log('\n📊 Resumo das cartas no banco:');
    result.rows.forEach((row) => {
      console.log(`   ${row.tipo_carta}: ${row.total} cartas`);
    });
  } catch (error) {
    console.error('❌ Erro:', error.message);
  } finally {
    await pool.end();
  }
}

createTreasureCardsTable();
