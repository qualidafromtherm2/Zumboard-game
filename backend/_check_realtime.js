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
  const tables = [
    'rooms','room_participants','sala_online','estado_turno',
    'combate','combate_cartas','ajuda_combate','combate_participacao',
    'historico_cartas','propostas_troca','cartas_ativas','cartas_no_jogo'
  ];
  for (const t of tables) {
    const r = await p.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='mtkin' AND table_name=$1 ORDER BY ordinal_position",
      [t]
    );
    const cols = r.rows.map(x => x.column_name);
    const hasIdSala = cols.includes('id_sala');
    console.log(t + ': id_sala=' + hasIdSala + (hasIdSala ? '' : '  cols=[' + cols.join(',') + ']'));
  }
  await p.end();
})().catch(e => { console.error(e.message); p.end(); });
