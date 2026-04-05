// Migração: atualizar caminho_imagem para usar ícones PNG em vez das cartas JPG completas
// Cidade: Cartas/Cidade/X.jpg → Cartas/Cidade/Icones das cartas/X.png
// Item:   Cartas/Itens/X.jpg  → Cartas/Itens/Icones das cartas/X.png
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function migrate() {
  try {
    // Atualizar cartas do tipo Cidade
    const cidadeResult = await pool.query(`
      UPDATE mtkin.cartas
      SET caminho_imagem = REPLACE(
        REPLACE(caminho_imagem, 'Cartas/Cidade/', 'Cartas/Cidade/Icones das cartas/'),
        '.jpg', '.png'
      )
      WHERE tipo_carta = 'Cidade'
        AND caminho_imagem LIKE 'Cartas/Cidade/%.jpg'
        AND caminho_imagem NOT LIKE '%Icones das cartas%'
      RETURNING id, nome_carta, caminho_imagem
    `);
    console.log(`✅ ${cidadeResult.rowCount} cartas Cidade atualizadas`);

    // Atualizar cartas do tipo Item
    const itemResult = await pool.query(`
      UPDATE mtkin.cartas
      SET caminho_imagem = REPLACE(
        REPLACE(caminho_imagem, 'Cartas/Itens/', 'Cartas/Itens/Icones das cartas/'),
        '.jpg', '.png'
      )
      WHERE tipo_carta = 'Item'
        AND caminho_imagem LIKE 'Cartas/Itens/%.jpg'
        AND caminho_imagem NOT LIKE '%Icones das cartas%'
      RETURNING id, nome_carta, caminho_imagem
    `);
    console.log(`✅ ${itemResult.rowCount} cartas Item atualizadas`);

    // Mostrar exemplos
    const sample = await pool.query(`
      SELECT id, tipo_carta, caminho_imagem FROM mtkin.cartas
      WHERE caminho_imagem LIKE '%Icones das cartas%'
      ORDER BY id LIMIT 5
    `);
    console.log('\n📋 Exemplos de caminhos atualizados:');
    sample.rows.forEach(r => console.log(`  [${r.id}] ${r.tipo_carta}: ${r.caminho_imagem}`));

    console.log('\n🎉 Migração concluída!');
  } catch (err) {
    console.error('❌ Erro na migração:', err.message);
  } finally {
    await pool.end();
  }
}

migrate();
