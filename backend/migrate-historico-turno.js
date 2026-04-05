require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔄 Migrando historico_cartas para suportar eventos de turno...');

    // Tornar id_carta, nome_carta e tipo_baralho nullable (eventos de turno não têm carta)
    await client.query(`ALTER TABLE mtkin.historico_cartas ALTER COLUMN id_carta   DROP NOT NULL`);
    await client.query(`ALTER TABLE mtkin.historico_cartas ALTER COLUMN nome_carta  DROP NOT NULL`);
    await client.query(`ALTER TABLE mtkin.historico_cartas ALTER COLUMN tipo_baralho DROP NOT NULL`);

    // Adicionar colunas de turno
    await client.query(`ALTER TABLE mtkin.historico_cartas ADD COLUMN IF NOT EXISTS tipo_evento   VARCHAR(50)`);
    await client.query(`ALTER TABLE mtkin.historico_cartas ADD COLUMN IF NOT EXISTS turno_numero  INTEGER`);
    await client.query(`ALTER TABLE mtkin.historico_cartas ADD COLUMN IF NOT EXISTS descricao     TEXT`);

    // Índice para busca por tipo_evento
    await client.query(`CREATE INDEX IF NOT EXISTS idx_historico_cartas_tipo_evento ON mtkin.historico_cartas(tipo_evento)`);

    console.log('✅ Migration historico_cartas concluída com sucesso!');
  } catch (err) {
    console.error('❌ Erro na migration:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
