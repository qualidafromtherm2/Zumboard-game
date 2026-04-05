const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

async function migrate() {
  try {
    console.log('🔄 Atualizando função calcular_tabuleiro...');

    await pool.query(`
      CREATE OR REPLACE FUNCTION mtkin.calcular_tabuleiro(
        p_id_sala INTEGER,
        p_id_jogador INTEGER
      ) RETURNS INTEGER AS $$
      DECLARE
        v_total INTEGER;
      BEGIN
        SELECT COALESCE(SUM(COALESCE(c.forca, 0)), 0)
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

    console.log('✅ Função calcular_tabuleiro atualizada com sucesso!');
  } catch (err) {
    console.error('❌ Erro:', err.message);
  } finally {
    await pool.end();
  }
}

migrate();
