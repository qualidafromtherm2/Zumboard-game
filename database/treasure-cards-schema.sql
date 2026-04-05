-- Schema de cartas de tesouro

CREATE TABLE IF NOT EXISTS mtkin.cartas_tesouro (
  id SERIAL PRIMARY KEY,
  nome_carta VARCHAR(150) NOT NULL,
  tipo_carta VARCHAR(50) NOT NULL,
  caminho_imagem VARCHAR(255) NOT NULL,
  bonus INTEGER DEFAULT 0,
  uso_unico BOOLEAN DEFAULT FALSE,
  permite_equipar BOOLEAN DEFAULT FALSE,
  permite_mochila BOOLEAN DEFAULT FALSE,
  equipar_onde TEXT,
  para_quem VARCHAR(20),
  descartar_apos_uso BOOLEAN DEFAULT FALSE,
  preco_venda INTEGER DEFAULT 0,
  bonus_tesouro BOOLEAN DEFAULT FALSE,
  mostrar_carta BOOLEAN DEFAULT FALSE,
  mostrar_descarte BOOLEAN DEFAULT FALSE,
  valor_dado INTEGER DEFAULT 0,
  cancela_maldicao BOOLEAN DEFAULT FALSE,
  transfere_luta BOOLEAN DEFAULT FALSE,
  fuga_automatica BOOLEAN DEFAULT FALSE,
  ganha_tesouro_monstro BOOLEAN DEFAULT FALSE,
  nao_pode_usar TEXT,
  so_pode_usar TEXT,
  ocupa_espaco INTEGER DEFAULT 0,
  item_grande BOOLEAN DEFAULT FALSE,
  nivel INTEGER DEFAULT 0,
  so_em_combate BOOLEAN DEFAULT FALSE,
  so_para_sexo VARCHAR(5),
  bonus_fuga INTEGER DEFAULT 0,
  protecao_maldicao BOOLEAN DEFAULT FALSE,
  contra_qual VARCHAR(20),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cartas_tesouro_tipo ON mtkin.cartas_tesouro(tipo_carta);

COMMENT ON TABLE mtkin.cartas_tesouro IS 'Cartas de tesouro do baralho Munchkin';
