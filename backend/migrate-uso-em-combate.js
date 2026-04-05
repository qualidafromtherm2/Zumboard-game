const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

pool.query('ALTER TABLE mtkin.cartas ADD COLUMN IF NOT EXISTS uso_em_combate BOOLEAN DEFAULT FALSE')
  .then(() => {
    console.log('✓ Coluna uso_em_combate adicionada com sucesso');
    pool.end();
  })
  .catch(e => {
    console.error('Erro:', e.message);
    pool.end();
    process.exit(1);
  });
