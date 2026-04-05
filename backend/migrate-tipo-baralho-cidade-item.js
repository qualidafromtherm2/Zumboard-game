/**
 * Migração: atualiza CHECK constraint de tipo_baralho
 *
 * Muda: ('porta', 'tesouro')  →  ('cidade', 'item')
 * Tabelas afetadas: mtkin.deck_estado
 * Também ajusta o DEFAULT de tipo_baralho em cartas_no_jogo e deck_estado
 *
 * Execução:
 *   $env:DB_HOST='dpg-d2d4b0a4d50c7385vm50-a.oregon-postgres.render.com'
 *   $env:DB_PORT='5432'; $env:DB_NAME='intranet_db_yd0w'
 *   $env:DB_USER='intranet_db_yd0w_user'; $env:DB_PASSWORD='amLpOKjWzzDRhwcR1NF0eolJzzfCY0ho'
 *   $env:DB_SSL='true'
 *   node backend/migrate-tipo-baralho-cidade-item.js
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Atualizar dados existentes em deck_estado (se houver)
    const { rowCount: updatedCidade } = await client.query(`
      UPDATE mtkin.deck_estado SET tipo_baralho = 'cidade' WHERE tipo_baralho = 'porta'
    `);
    const { rowCount: updatedItem } = await client.query(`
      UPDATE mtkin.deck_estado SET tipo_baralho = 'item' WHERE tipo_baralho = 'tesouro'
    `);
    console.log(`✏️  deck_estado: porta→cidade (${updatedCidade} linhas), tesouro→item (${updatedItem} linhas)`);

    // 2. Dropar constraint antiga e recriar com novos valores
    await client.query(`
      ALTER TABLE mtkin.deck_estado
        DROP CONSTRAINT IF EXISTS deck_estado_tipo_baralho_check
    `);
    await client.query(`
      ALTER TABLE mtkin.deck_estado
        ADD CONSTRAINT deck_estado_tipo_baralho_check
          CHECK (tipo_baralho IN ('cidade', 'item'))
    `);
    console.log('✅ CHECK constraint de deck_estado atualizada para (\'cidade\', \'item\')');

    // 3. Atualizar DEFAULT de tipo_baralho em deck_estado
    await client.query(`
      ALTER TABLE mtkin.deck_estado
        ALTER COLUMN tipo_baralho SET DEFAULT 'cidade'
    `);
    console.log('✅ DEFAULT de deck_estado.tipo_baralho atualizado para \'cidade\'');

    // 4. Atualizar DEFAULT de tipo_baralho em cartas_no_jogo
    await client.query(`
      ALTER TABLE mtkin.cartas_no_jogo
        ALTER COLUMN tipo_baralho SET DEFAULT 'cidade'
    `);
    // Migrar dados existentes em cartas_no_jogo também
    const { rowCount: cnjCidade } = await client.query(`
      UPDATE mtkin.cartas_no_jogo SET tipo_baralho = 'cidade' WHERE tipo_baralho = 'porta'
    `);
    const { rowCount: cnjItem } = await client.query(`
      UPDATE mtkin.cartas_no_jogo SET tipo_baralho = 'item' WHERE tipo_baralho = 'tesouro'
    `);
    console.log(`✅ cartas_no_jogo: porta→cidade (${cnjCidade}), tesouro→item (${cnjItem})`);

    // 5. Migrar historico_cartas (caso exista coluna tipo_baralho)
    const { rows: cols } = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'mtkin' AND table_name = 'historico_cartas' AND column_name = 'tipo_baralho'
    `);
    if (cols.length > 0) {
      const { rowCount: hcCidade } = await client.query(`
        UPDATE mtkin.historico_cartas SET tipo_baralho = 'cidade' WHERE tipo_baralho = 'porta'
      `);
      const { rowCount: hcItem } = await client.query(`
        UPDATE mtkin.historico_cartas SET tipo_baralho = 'item' WHERE tipo_baralho = 'tesouro'
      `);
      console.log(`✅ historico_cartas: porta→cidade (${hcCidade}), tesouro→item (${hcItem})`);
    } else {
      console.log('ℹ️  historico_cartas não tem coluna tipo_baralho — pulado');
    }

    await client.query('COMMIT');
    console.log('\n🎉 Migração concluída com sucesso!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Erro durante migração:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
