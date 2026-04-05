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
  // Discover sala_online columns
  const cols = await p.query("SELECT column_name FROM information_schema.columns WHERE table_schema='mtkin' AND table_name='sala_online' ORDER BY ordinal_position");
  console.log('sala_online columns:', cols.rows.map(x => x.column_name));

  // All users
  const users = await p.query("SELECT u.id, u.username as nome, so.nivel, so.forca, so.tabuleiro FROM mtkin.users u JOIN mtkin.sala_online so ON so.id_player = u.id");
  console.log('=== Users ===');
  console.table(users.rows);

  // Discover cartas columns
  const ccols = await p.query("SELECT column_name FROM information_schema.columns WHERE table_schema='mtkin' AND table_name='cartas' ORDER BY ordinal_position");
  console.log('cartas columns:', ccols.rows.map(x => x.column_name));

  // Discover cartas_ativas columns
  const cacols = await p.query("SELECT column_name FROM information_schema.columns WHERE table_schema='mtkin' AND table_name='cartas_ativas' ORDER BY ordinal_position");
  console.log('cartas_ativas columns:', cacols.rows.map(x => x.column_name));

  for (const u of users.rows) {
    const cards = await p.query("SELECT ca.*, c.nome_carta as cnome, c.forca as carta_forca, c.tipo_carta FROM mtkin.cartas_ativas ca JOIN mtkin.cartas c ON c.id = ca.id_carta WHERE ca.id_jogador = $1", [u.id]);
    console.log('\n=== Cards for ' + u.nome + ' (id=' + u.id + ') ===');
    console.table(cards.rows);
    const totalCardForce = cards.rows.reduce((sum, c) => sum + (c.carta_forca || 0), 0);
    console.log('  Card force total:', totalCardForce, '  Level:', u.nivel, '  Expected:', (u.nivel || 1) + totalCardForce, '  DB forca:', u.forca);
  }

  await p.end();
})().catch(e => { console.error(e); p.end(); });
