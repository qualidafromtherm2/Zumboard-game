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
  // 1) Restore calcular_tabuleiro with slots 79-89
  await p.query(`
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
  console.log('Function restored (slots 79-89)');

  // 2) Recalculate tabuleiro for all players
  const players = await p.query("SELECT so.id_player, so.id, so.nome_sala FROM mtkin.sala_online so");
  for (const row of players.rows) {
    const roomRes = await p.query("SELECT id FROM mtkin.rooms WHERE room_name = $1", [row.nome_sala]);
    if (roomRes.rows.length === 0) continue;
    const roomId = roomRes.rows[0].id;
    const sumRes = await p.query(
      `SELECT COALESCE(SUM(COALESCE(c.forca, 0)), 0)::int AS total
       FROM mtkin.cartas_ativas ca
       JOIN mtkin.cartas c ON c.id = ca.id_carta::int
       WHERE ca.id_sala = $1 AND ca.id_jogador = $2
         AND ca.id_slot = ANY(ARRAY['79','80','81','82','83','84','85','86','87','88','89'])`,
      [roomId, row.id_player]
    );
    const newTabuleiro = sumRes.rows[0].total;
    await p.query("UPDATE mtkin.sala_online SET tabuleiro = $1 WHERE id_player = $2", [newTabuleiro, row.id_player]);
    console.log('  Player ' + row.id_player + ': tabuleiro = ' + newTabuleiro);
  }

  const result = await p.query("SELECT id_player, nome_jogador, nivel, tabuleiro, forca FROM mtkin.sala_online");
  console.log('\\nRestored values:');
  console.table(result.rows);
  await p.end();
})().catch(e => { console.error(e); p.end(); });
