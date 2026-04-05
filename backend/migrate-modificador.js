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
    console.log('1. Adicionando colunas de modificador em mtkin.cartas_ativas...');
    await client.query(`
      ALTER TABLE mtkin.cartas_ativas
        ADD COLUMN IF NOT EXISTS id_modificador INTEGER,
        ADD COLUMN IF NOT EXISTS nome_modificador VARCHAR(150),
        ADD COLUMN IF NOT EXISTS caminho_modificador TEXT;
    `);
    console.log('✅ Colunas id_modificador, nome_modificador, caminho_modificador adicionadas.');

    console.log('2. Atualizando calcular_tabuleiro para somar força do modificador...');
    await client.query(`
      CREATE OR REPLACE FUNCTION mtkin.calcular_tabuleiro(
        p_id_sala INTEGER,
        p_id_jogador INTEGER
      ) RETURNS INTEGER AS $$
      DECLARE
        v_total INTEGER;
      BEGIN
        SELECT COALESCE(SUM(
          COALESCE(c.forca, 0) +
          COALESCE((SELECT cm.forca FROM mtkin.cartas cm WHERE cm.id = ca.id_modificador), 0)
        ), 0)
        INTO v_total
        FROM mtkin.cartas_ativas ca
        JOIN mtkin.cartas c ON c.id = ca.id_carta::int
        WHERE ca.id_sala = p_id_sala
          AND ca.id_jogador = p_id_jogador
          AND ca.id_slot = ANY(ARRAY['79','80','81','82','83','84','85','86','87','88','89']);
        RETURN v_total;
      END;
      $$ LANGUAGE plpgsql;
    `);
    console.log('✅ calcular_tabuleiro atualizado para incluir força do modificador.');

    console.log('3. Atualizando equipar_onde da carta id=5 para slot 86...');
    const before = await client.query('SELECT id, nome_carta, equipar_onde FROM mtkin.cartas WHERE id = 5');
    if (before.rows.length > 0) {
      console.log('   Antes:', before.rows[0]);
      await client.query(`UPDATE mtkin.cartas SET equipar_onde = '86' WHERE id = 5`);
      const after = await client.query('SELECT id, nome_carta, equipar_onde FROM mtkin.cartas WHERE id = 5');
      console.log('   Depois:', after.rows[0]);
    } else {
      console.log('   ⚠️  Carta id=5 não encontrada.');
    }

    console.log('\n✅ Migração de modificador concluída com sucesso!');
  } catch (error) {
    console.error('❌ Erro na migração:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
