const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

const sql = `
CREATE OR REPLACE VIEW mtkin.cartas_tesouro AS
SELECT 
    id,
    nome_carta,
    tipo_carta,
    caminho_imagem,
    equipar_onde,
    n_pode_equipar,
    permite_mochila,
    forca,
    item,
    nivel,
    fulga_minima,
    texto_da_carta,
    NULL::INTEGER AS bonus,
    NULL::BOOLEAN AS uso_unico,
    FALSE AS permite_equipar,
    NULL::VARCHAR AS para_quem,
    NULL::BOOLEAN AS descartar_apos_uso,
    NULL::INTEGER AS preco_venda,
    NULL::BOOLEAN AS bonus_tesouro,
    NULL::BOOLEAN AS mostrar_carta,
    NULL::BOOLEAN AS mostrar_descarte,
    NULL::INTEGER AS valor_dado,
    NULL::BOOLEAN AS cancela_maldicao,
    NULL::BOOLEAN AS transfere_luta,
    NULL::BOOLEAN AS fuga_automatica,
    NULL::BOOLEAN AS ganha_tesouro_monstro,
    NULL::TEXT AS nao_pode_usar,
    NULL::TEXT AS so_pode_usar,
    NULL::INTEGER AS ocupa_espaco,
    NULL::BOOLEAN AS item_grande,
    NULL::BOOLEAN AS so_em_combate,
    NULL::VARCHAR AS so_para_sexo,
    NULL::INTEGER AS bonus_fuga,
    NULL::BOOLEAN AS protecao_maldicao,
    NULL::VARCHAR AS contra_qual,
    COALESCE(uso_em_combate, FALSE) AS uso_em_combate
FROM mtkin.cartas
WHERE tipo_carta = 'Item';
`;

pool.query(sql)
  .then(() => {
    console.log('✓ View mtkin.cartas_tesouro atualizada com uso_em_combate');
    pool.end();
  })
  .catch(e => {
    console.error('Erro:', e.message);
    pool.end();
    process.exit(1);
  });
