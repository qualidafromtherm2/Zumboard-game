/**
 * Aplica TODAS as colunas faltantes das migrations no banco novo.
 * Pode ser executado com: node backend/migrate-all-missing.js
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const alters = [
  // === rooms ===
  "ALTER TABLE mtkin.rooms ADD COLUMN IF NOT EXISTS ordem_turno INTEGER[] DEFAULT '{}'",
  "ALTER TABLE mtkin.rooms ADD COLUMN IF NOT EXISTS turno_atual_index INTEGER DEFAULT 0",
  "ALTER TABLE mtkin.rooms ADD COLUMN IF NOT EXISTS turno_numero INTEGER DEFAULT 0",
  "ALTER TABLE mtkin.rooms ADD COLUMN IF NOT EXISTS prontos_organizacao INTEGER[] NOT NULL DEFAULT '{}'",
  // === cartas ===
  "ALTER TABLE mtkin.cartas ADD COLUMN IF NOT EXISTS uso_em_combate BOOLEAN DEFAULT FALSE",
  "ALTER TABLE mtkin.cartas ADD COLUMN IF NOT EXISTS pesado BOOLEAN DEFAULT FALSE",
  "ALTER TABLE mtkin.cartas ADD COLUMN IF NOT EXISTS qtd_max INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE mtkin.cartas ADD COLUMN IF NOT EXISTS valor INTEGER DEFAULT 0",
  "ALTER TABLE mtkin.cartas ADD COLUMN IF NOT EXISTS armadilha TEXT",
  // === historico_cartas ===
  "ALTER TABLE mtkin.historico_cartas ADD COLUMN IF NOT EXISTS tipo_evento VARCHAR(50)",
  "ALTER TABLE mtkin.historico_cartas ADD COLUMN IF NOT EXISTS turno_numero INTEGER",
  "ALTER TABLE mtkin.historico_cartas ADD COLUMN IF NOT EXISTS descricao TEXT",
  "ALTER TABLE mtkin.historico_cartas ADD COLUMN IF NOT EXISTS origem_acao VARCHAR(50)",
  "ALTER TABLE mtkin.historico_cartas ADD COLUMN IF NOT EXISTS foi_combate BOOLEAN DEFAULT FALSE",
  "ALTER TABLE mtkin.historico_cartas ADD COLUMN IF NOT EXISTS resultado_combate VARCHAR(20)",
  "ALTER TABLE mtkin.historico_cartas ADD COLUMN IF NOT EXISTS quantidade_tesouros INTEGER DEFAULT 0",
  // === estado_turno ===
  "ALTER TABLE mtkin.estado_turno ADD COLUMN IF NOT EXISTS duo_modo BOOLEAN NOT NULL DEFAULT FALSE",
  "ALTER TABLE mtkin.estado_turno ADD COLUMN IF NOT EXISTS duo_helper_id INTEGER",
  "ALTER TABLE mtkin.estado_turno ADD COLUMN IF NOT EXISTS duo_prontos INTEGER[] NOT NULL DEFAULT '{}'",
  // === combate ===
  "ALTER TABLE mtkin.combate ADD COLUMN IF NOT EXISTS tipo_acordo TEXT",
  "ALTER TABLE mtkin.combate ADD COLUMN IF NOT EXISTS distribuicao_vez INTEGER",
  // === combate_participacao ===
  "ALTER TABLE mtkin.combate_participacao ADD COLUMN IF NOT EXISTS duo_pronto_lutador BOOLEAN NOT NULL DEFAULT FALSE",
  "ALTER TABLE mtkin.combate_participacao ADD COLUMN IF NOT EXISTS duo_pronto_helper BOOLEAN NOT NULL DEFAULT FALSE",
  // === ajuda_combate ===
  "ALTER TABLE mtkin.ajuda_combate ADD COLUMN IF NOT EXISTS escolhido BOOLEAN NOT NULL DEFAULT FALSE",
];

(async () => {
  let ok = 0, fail = 0;
  for (const sql of alters) {
    try {
      await pool.query(sql);
      ok++;
      console.log('OK:', sql.substring(12, 70));
    } catch (e) {
      fail++;
      console.error('FALHOU:', sql.substring(12, 70), '-', e.message);
    }
  }
  console.log(`\nConcluido: ${ok} OK, ${fail} falhas`);
  await pool.end();
})();
