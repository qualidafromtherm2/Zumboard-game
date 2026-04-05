require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, ssl: { rejectUnauthorized: false }
});

(async () => {
  // Colunas da tabela rooms
  const cols = await p.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='mtkin' AND table_name='rooms' ORDER BY ordinal_position"
  );
  console.log('=== ROOMS COLUMNS ===');
  cols.rows.forEach(x => console.log(' ', x.column_name));

  // Dados atuais da room
  const rooms = await p.query('SELECT id, room_name, status, prontos_organizacao, ordem_turno FROM mtkin.rooms LIMIT 5');
  console.log('\n=== ROOMS DATA ===');
  console.table(rooms.rows);

  // Dados de sala_online
  const so = await p.query('SELECT id_player, nome_jogador, nivel, personagem_caminho FROM mtkin.sala_online');
  console.log('\n=== SALA_ONLINE ===');
  console.table(so.rows);

  // Status da room
  const status = await p.query('SELECT status FROM mtkin.rooms LIMIT 1');
  console.log('\nRoom status:', status.rows[0]?.status);

  await p.end();
})();
