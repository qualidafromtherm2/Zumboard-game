/**
 * migrate-remove-missing-cards.js
 * Deleta da tabela mtkin.cartas todas as cartas cujo arquivo de imagem
 * (caminho_imagem) não existe mais no disco.
 *
 * Uso:
 *   $env:DB_HOST='...'; ... ; node backend/migrate-remove-missing-cards.js
 *
 * Passe --dry-run para apenas listar sem deletar.
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const dryRun = process.argv.includes('--dry-run');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'munchkin',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

// Raiz do workspace (um nível acima de backend/)
const ROOT = path.resolve(__dirname, '..');

async function main() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT id, nome_carta, caminho_imagem FROM mtkin.cartas ORDER BY id');
    console.log(`Total de cartas no banco: ${rows.length}`);

    const missing = [];
    for (const row of rows) {
      if (!row.caminho_imagem) {
        // caminho_imagem vazio — considerar como ausente
        missing.push(row);
        continue;
      }
      // caminho_imagem deve ser relativo à raiz, ex: "Cartas/Portas/Monstros/xxx.jpg"
      const absPath = path.resolve(ROOT, row.caminho_imagem);
      if (!fs.existsSync(absPath)) {
        missing.push(row);
      }
    }

    if (missing.length === 0) {
      console.log('✅ Nenhuma carta com imagem ausente encontrada.');
      return;
    }

    console.log(`\n⚠️  Cartas com imagem ausente (${missing.length}):`);
    for (const row of missing) {
      console.log(`  id=${row.id} | "${row.nome_carta}" | ${row.caminho_imagem || '(vazio)'}`);
    }

    if (dryRun) {
      console.log('\n🔍 Modo --dry-run ativo, nenhuma carta foi deletada.');
      return;
    }

    console.log('\nDeletando cartas ausentes...');
    const ids = missing.map(r => r.id);
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const result = await client.query(
      `DELETE FROM mtkin.cartas WHERE id IN (${placeholders}) RETURNING id`,
      ids
    );
    console.log(`✅ ${result.rowCount} carta(s) deletada(s) com sucesso.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
