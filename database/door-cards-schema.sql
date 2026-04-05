-- Tabela de Cartas de Porta do Munchkin
CREATE TABLE IF NOT EXISTS mtkin.cartas_porta (
  id SERIAL PRIMARY KEY,
  nome_carta VARCHAR(100) NOT NULL,
  tipo_carta VARCHAR(20) NOT NULL, -- Classe, Raça, Monstros, Maldição, Especiais
  forca INTEGER DEFAULT 0, -- Força do monstro
  tesouros INTEGER DEFAULT 0, -- Quantidade de tesouros
  niveis INTEGER DEFAULT 0, -- Níveis ganhos
  coisa_boa INTEGER DEFAULT 0, -- Coisa boa (efeito positivo)
  coisa_ruim INTEGER DEFAULT 0, -- Coisa ruim (efeito negativo)
  especial TEXT, -- Habilidade especial
  forca_ganha INTEGER DEFAULT 0, -- Força ganha ao jogar/usar a carta
  forca_perdida INTEGER DEFAULT 0, -- Força perdida ao jogar/usar a carta
  fuga_automatica BOOLEAN DEFAULT FALSE, -- Fuga automática
  nivel_fuga_automatica INTEGER DEFAULT 0, -- Nível de fuga automática
  morte BOOLEAN DEFAULT FALSE, -- Morte (sim/nao)
  mais_forte_contra TEXT, -- Texto descritivo (mais forte contra)
  mais_fraco_contra TEXT, -- Texto descritivo (mais fraco contra)
  perde_niveis INTEGER DEFAULT 0, -- Perde niveis
  necessario_para_fugir INTEGER DEFAULT 0, -- Necessario para fugir
  descartar_toda_mao BOOLEAN DEFAULT FALSE, -- Descartar toda mao (sim/nao)
  caminho_imagem VARCHAR(255) NOT NULL, -- Caminho da imagem
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índices para melhor performance
CREATE INDEX IF NOT EXISTS idx_cartas_porta_tipo ON mtkin.cartas_porta(tipo_carta);
CREATE INDEX IF NOT EXISTS idx_cartas_porta_nome ON mtkin.cartas_porta(nome_carta);

-- Comentários
COMMENT ON TABLE mtkin.cartas_porta IS 'Cartas de Porta do jogo Munchkin';
COMMENT ON COLUMN mtkin.cartas_porta.tipo_carta IS 'Tipo: Classe, Raça, Monstros, Maldição, Especiais';
COMMENT ON COLUMN mtkin.cartas_porta.forca IS 'Força do monstro (apenas para tipo Monstros)';
COMMENT ON COLUMN mtkin.cartas_porta.tesouros IS 'Número de tesouros que a carta dá';
COMMENT ON COLUMN mtkin.cartas_porta.niveis IS 'Níveis ganhos (geralmente ao derrotar monstros)';
