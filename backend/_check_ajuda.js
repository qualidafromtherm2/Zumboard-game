require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({
  host: process.env.DB_HOST,
  port: +process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});
(async () => {
  const r = await p.query(
    "SELECT id, id_sala, id_proponente, id_destinatario, status, tipo_proposta, fluxo, escolhido FROM mtkin.ajuda_combate ORDER BY created_at DESC LIMIT 10"
  );
  console.table(r.rows);
  await p.end();
})().catch(e => { console.error(e.message); p.end(); });
