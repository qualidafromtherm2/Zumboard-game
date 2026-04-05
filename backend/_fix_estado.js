const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  // 1. Ver combates ativos
  const c = await pool.query(
    "SELECT id_combate, id_sala, id_jogador, status FROM mtkin.combate WHERE status NOT IN ('vitoria','fuga','derrota','Ganhou','Perdeu') ORDER BY criado_em DESC LIMIT 5"
  );
  console.log('COMBATES ATIVOS:', JSON.stringify(c.rows, null, 2));

  // 2. Ver estados de turno não-idle
  const et = await pool.query(
    "SELECT id_sala, id_jogador, fase_porta FROM mtkin.estado_turno WHERE fase_porta NOT IN ('idle','turn_over') ORDER BY atualizado_em DESC LIMIT 5"
  );
  console.log('ESTADOS TURNO ATIVOS:', JSON.stringify(et.rows, null, 2));

  // 3. Perguntar antes de limpar
  if (c.rows.length > 0) {
    console.log('\nLimpando combates ativos travados...');
    for (const row of c.rows) {
      await pool.query(
        "UPDATE mtkin.combate SET status='fuga', botoes_jogador='', botoes_outros_jogadores='' WHERE id_combate=$1",
        [row.id_combate]
      );
      await pool.query("DELETE FROM mtkin.combate_cartas WHERE id_combate=$1", [row.id_combate]);
      await pool.query("DELETE FROM mtkin.combate_participacao WHERE id_sala=$1", [row.id_sala]);
      console.log('Combate', row.id_combate, 'marcado como fuga.');
    }
  }

  if (et.rows.length > 0) {
    console.log('\nLimpando estados de turno travados...');
    for (const row of et.rows) {
      if (row.fase_porta === 'monster' || row.fase_porta === 'closed') {
        await pool.query(
          "UPDATE mtkin.estado_turno SET fase_porta='idle', carta_monstro=NULL WHERE id_sala=$1 AND id_jogador=$2",
          [row.id_sala, row.id_jogador]
        );
        console.log('Estado turno sala', row.id_sala, 'jogador', row.id_jogador, 'resetado para idle.');
      }
    }
  }

  console.log('Done.');
  await pool.end();
}

main().catch(e => { console.error(e.message); pool.end(); });
