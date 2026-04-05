                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            -- Script SQL para criar tabela de usuários no banco de dados PostgreSQL
-- Schema: mtkin
-- Executar este script no seu banco de dados Render

-- Criar schema se não existir
CREATE SCHEMA IF NOT EXISTS mtkin;

-- Criar tabela de usuários
CREATE TABLE IF NOT EXISTS mtkin.users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    is_admin BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP,
    active BOOLEAN DEFAULT TRUE
);

-- Criar índices para melhor performance
CREATE INDEX IF NOT EXISTS idx_users_username ON mtkin.users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON mtkin.users(email);

-- Criar tabela de sessões (opcional, para controle de login)
CREATE TABLE IF NOT EXISTS mtkin.sessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES mtkin.users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON mtkin.sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON mtkin.sessions(user_id);

-- Comentários nas colunas
COMMENT ON TABLE mtkin.users IS 'Tabela de usuários do sistema Munchkin Digital';
COMMENT ON COLUMN mtkin.users.is_admin IS 'Define se o usuário tem permissões de administrador';
COMMENT ON COLUMN mtkin.users.active IS 'Define se a conta está ativa';

-- Criar tabela de salas
CREATE TABLE IF NOT EXISTS mtkin.rooms (
    id SERIAL PRIMARY KEY,
    room_name VARCHAR(100) NOT NULL,
    max_players INTEGER NOT NULL CHECK (max_players >= 3 AND max_players <= 6),
    jog1 VARCHAR(50),
    jog2 VARCHAR(50),
    jog3 VARCHAR(50),
    jog4 VARCHAR(50),
    jog5 VARCHAR(50),
    jog6 VARCHAR(50),
    created_by INTEGER REFERENCES mtkin.users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) DEFAULT 'waiting',
    room_code VARCHAR(10) UNIQUE NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    simulador VARCHAR(20) DEFAULT 'desativado',
    vencedor_id INTEGER REFERENCES mtkin.users(id)
);

CREATE INDEX IF NOT EXISTS idx_rooms_code ON mtkin.rooms(room_code);
CREATE INDEX IF NOT EXISTS idx_rooms_status ON mtkin.rooms(status);
CREATE INDEX IF NOT EXISTS idx_rooms_active ON mtkin.rooms(is_active);

COMMENT ON TABLE mtkin.rooms IS 'Tabela de salas de jogo do Munchkin Digital';
COMMENT ON COLUMN mtkin.rooms.status IS 'Status da sala: waiting, playing, finished';
COMMENT ON COLUMN mtkin.rooms.room_code IS 'Código único para entrar na sala';
COMMENT ON COLUMN mtkin.rooms.is_active IS 'Define se a sala está ativa';
COMMENT ON COLUMN mtkin.rooms.simulador IS 'Modo simulador da sala: ativado ou desativado';

-- Criar tabela de participantes da sala (para controle de quem está online)
CREATE TABLE IF NOT EXISTS mtkin.room_participants (
    id SERIAL PRIMARY KEY,
    room_id INTEGER REFERENCES mtkin.rooms(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES mtkin.users(id) ON DELETE CASCADE,
    username VARCHAR(50) NOT NULL,
    player_slot INTEGER CHECK (player_slot >= 1 AND player_slot <= 6),
    is_online BOOLEAN DEFAULT TRUE,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(room_id, user_id),
    UNIQUE(room_id, player_slot)
);

CREATE INDEX IF NOT EXISTS idx_room_participants_room ON mtkin.room_participants(room_id);
CREATE INDEX IF NOT EXISTS idx_room_participants_user ON mtkin.room_participants(user_id);

COMMENT ON TABLE mtkin.room_participants IS 'Controle de participantes e status online/offline nas salas';

-- Criar tabela de controle de personagem/jogador na sala
CREATE TABLE IF NOT EXISTS mtkin.sala_online (
    id SERIAL PRIMARY KEY,
    id_player INTEGER REFERENCES mtkin.users(id) ON DELETE CASCADE,
    nome_jogador VARCHAR(50) NOT NULL,
    nome_sala VARCHAR(100) NOT NULL,
    mao INTEGER NOT NULL DEFAULT 0,
    turno INTEGER NOT NULL DEFAULT 0,
    nivel INTEGER NOT NULL DEFAULT 1,
    tabuleiro INTEGER DEFAULT 0,
    forca INTEGER GENERATED ALWAYS AS (COALESCE(tabuleiro, 0) + nivel) STORED,
    mochila INTEGER,
    personagem_caminho VARCHAR(255),
    UNIQUE(id_player)
);

CREATE INDEX IF NOT EXISTS idx_sala_online_player ON mtkin.sala_online(id_player);

COMMENT ON TABLE mtkin.sala_online IS 'Estado do jogador logado por sala (personagem, mao, forca)';

-- Tabela de personagens disponiveis
CREATE TABLE IF NOT EXISTS mtkin.personagens (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(120) NOT NULL,
    caminho_imagem VARCHAR(255) UNIQUE NOT NULL,
    ativo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_personagens_nome ON mtkin.personagens(nome);
CREATE INDEX IF NOT EXISTS idx_personagens_ativo ON mtkin.personagens(ativo);

COMMENT ON TABLE mtkin.personagens IS 'Personagens disponiveis para selecao no jogo';

ALTER TABLE mtkin.sala_online
    ADD COLUMN IF NOT EXISTS turno INTEGER NOT NULL DEFAULT 0;

ALTER TABLE mtkin.sala_online
    ADD COLUMN IF NOT EXISTS personagem_caminho VARCHAR(255);

-- Tabela de mensagens exibidas nos cards do tabuleiro
CREATE TABLE IF NOT EXISTS mtkin.card_mensagens (
    id INTEGER PRIMARY KEY,
    mensagem TEXT NOT NULL,
    acao VARCHAR(100)
);

INSERT INTO mtkin.card_mensagens (id, mensagem, acao)
VALUES (1, 'Posiciona suas cartas e sem seguida clique aqui "Abrir Porta"', 'Abrir porta')
ON CONFLICT (id) DO UPDATE
SET mensagem = EXCLUDED.mensagem,
    acao = EXCLUDED.acao;

-- Tabela unificada de cartas
-- ⚠️  NÃO usar DROP TABLE aqui: a tabela cartas contém dados configurados
--     manualmente (equipar_onde, categoria, nomes). Usar apenas ADD COLUMN IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS mtkin.cartas (
  id SERIAL PRIMARY KEY,
  nome_carta VARCHAR(150) NOT NULL,
  tipo_carta VARCHAR(50) NOT NULL,
  caminho_imagem VARCHAR(255) NOT NULL,
    categoria VARCHAR(100),
  equipar_onde TEXT,
  n_pode_equipar TEXT,
  forca INTEGER DEFAULT 0,
  item INTEGER DEFAULT 0,
  nivel INTEGER DEFAULT 0,
  fulga_minima INTEGER DEFAULT 0,
  texto_da_carta TEXT,
  permite_mochila BOOLEAN DEFAULT FALSE,
  qtd_max INTEGER NOT NULL DEFAULT 1,
  valor INTEGER DEFAULT 0,
  uso_em_combate BOOLEAN DEFAULT FALSE,
  pesado BOOLEAN DEFAULT FALSE,
  armadilha TEXT
);

CREATE INDEX IF NOT EXISTS idx_cartas_tipo ON mtkin.cartas(tipo_carta);
CREATE INDEX IF NOT EXISTS idx_cartas_nome ON mtkin.cartas(nome_carta);
CREATE INDEX IF NOT EXISTS idx_cartas_categoria ON mtkin.cartas(categoria);

-- Tabela de categorias de cartas
CREATE TABLE IF NOT EXISTS mtkin.categorias (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) UNIQUE NOT NULL
);

-- Tabela de campos personalizados para cartas
CREATE TABLE IF NOT EXISTS mtkin.carta_campos (
  id SERIAL PRIMARY KEY,
  nome_campo VARCHAR(100) UNIQUE NOT NULL,
  tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('checkbox', 'listbox', 'numero', 'texto')),
  criado_em TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tabela de regras customizadas para cartas de armadilha
CREATE TABLE IF NOT EXISTS mtkin.regras_customizadas (
  id SERIAL PRIMARY KEY,
  texto TEXT NOT NULL,
  criado_em TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Remove tabelas/views antigas, se ainda existirem
DROP VIEW  IF EXISTS mtkin.cartas_porta  CASCADE;
DROP VIEW  IF EXISTS mtkin.cartas_tesouro CASCADE;
DROP TABLE IF EXISTS mtkin.cartas_porta  CASCADE;
DROP TABLE IF EXISTS mtkin.cartas_tesouro CASCADE;

-- Views de compatibilidade para código legado
DROP VIEW IF EXISTS mtkin.cartas_porta;
CREATE VIEW mtkin.cartas_porta AS
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
    NULL::INTEGER AS tesouros,
    NULL::INTEGER AS niveis,
    NULL::BOOLEAN AS fuga_automatica,
    NULL::INTEGER AS nivel_fuga_automatica,
    NULL::INTEGER AS forca_ganha,
    NULL::VARCHAR AS para_quem_porta,
    NULL::INTEGER AS forca_perdida,
    NULL::INTEGER AS especial,
    NULL::BOOLEAN AS morte,
    NULL::INTEGER AS perde_niveis,
    NULL::INTEGER AS necessario_para_fugir,
    NULL::BOOLEAN AS descartar_toda_mao,
    NULL::INTEGER AS "Limite_mão",
    NULL::VARCHAR AS perde_equipamento,
    NULL::VARCHAR AS perde_item,
    NULL::VARCHAR AS mais_forte_contra,
    NULL::VARCHAR AS mais_fraco_contra,
    FALSE AS permite_equipar
FROM mtkin.cartas
WHERE tipo_carta = 'Cidade';

DROP VIEW IF EXISTS mtkin.cartas_tesouro;
CREATE VIEW mtkin.cartas_tesouro AS
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

-- Tabela de cartas distribuidas no jogo
CREATE TABLE IF NOT EXISTS mtkin.cartas_no_jogo (
  id SERIAL PRIMARY KEY,
  id_sala INTEGER REFERENCES mtkin.rooms(id) ON DELETE CASCADE,
  nome_sala VARCHAR(100) NOT NULL,
  id_jogador INTEGER REFERENCES mtkin.users(id) ON DELETE CASCADE,
  nome_jogador VARCHAR(50) NOT NULL,
  id_carta INTEGER NOT NULL,
  nome_carta VARCHAR(150) NOT NULL,
  tipo_baralho VARCHAR(20) NOT NULL DEFAULT 'cidade'
);

CREATE INDEX IF NOT EXISTS idx_cartas_no_jogo_sala ON mtkin.cartas_no_jogo(id_sala);
CREATE INDEX IF NOT EXISTS idx_cartas_no_jogo_jogador ON mtkin.cartas_no_jogo(id_jogador);

COMMENT ON TABLE mtkin.cartas_no_jogo IS 'Cartas distribuidas para jogadores durante a partida';

ALTER TABLE mtkin.cartas_no_jogo
    ADD COLUMN IF NOT EXISTS nome_sala VARCHAR(100),
    ADD COLUMN IF NOT EXISTS nome_jogador VARCHAR(50),
    ADD COLUMN IF NOT EXISTS id_sala INTEGER,
    ADD COLUMN IF NOT EXISTS id_jogador INTEGER,
    ADD COLUMN IF NOT EXISTS id_carta INTEGER,
    ADD COLUMN IF NOT EXISTS nome_carta VARCHAR(150),
    ADD COLUMN IF NOT EXISTS tipo_baralho VARCHAR(20) NOT NULL DEFAULT 'cidade';

-- Cartas equipadas em slots (substitui cartela_munchkin)
CREATE TABLE IF NOT EXISTS mtkin.cartas_ativas (
  id SERIAL PRIMARY KEY,
  id_sala INTEGER REFERENCES mtkin.rooms(id) ON DELETE CASCADE,
  nome_sala VARCHAR(100) NOT NULL,
  id_jogador INTEGER REFERENCES mtkin.users(id) ON DELETE CASCADE,
  nome_jogador VARCHAR(50) NOT NULL,
  id_carta INTEGER NOT NULL,
  nome_carta VARCHAR(150) NOT NULL,
  id_slot VARCHAR(10) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cartas_ativas_sala ON mtkin.cartas_ativas(id_sala);
CREATE INDEX IF NOT EXISTS idx_cartas_ativas_jogador ON mtkin.cartas_ativas(id_jogador);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cartas_ativas_unique_slot ON mtkin.cartas_ativas(id_sala, id_jogador, id_slot);

-- Tabela de cartas jogadas em combate
CREATE TABLE IF NOT EXISTS mtkin.combate_cartas (
    id SERIAL PRIMARY KEY,
    id_sala INTEGER REFERENCES mtkin.rooms(id) ON DELETE CASCADE,
    id_combate UUID NOT NULL DEFAULT gen_random_uuid(),
    id_jogador INTEGER REFERENCES mtkin.users(id) ON DELETE CASCADE,
    nome_jogador VARCHAR(50) NOT NULL,
    id_carta INTEGER NOT NULL,
    nome_carta VARCHAR(150) NOT NULL,
    tipo_carta VARCHAR(50) NOT NULL,
    bonus INTEGER DEFAULT 0,
    lado VARCHAR(20) NOT NULL CHECK (lado IN ('monstro', 'jogador')),
    caminho_imagem VARCHAR(255),
    descartar_apos_uso BOOLEAN DEFAULT TRUE,
    jogado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_combate_cartas_sala ON mtkin.combate_cartas(id_sala);
CREATE INDEX IF NOT EXISTS idx_combate_cartas_combate ON mtkin.combate_cartas(id_combate);
CREATE INDEX IF NOT EXISTS idx_combate_cartas_jogador ON mtkin.combate_cartas(id_jogador);

COMMENT ON TABLE mtkin.combate_cartas IS 'Cartas jogadas durante combates para ajudar monstro ou jogador';
COMMENT ON COLUMN mtkin.combate_cartas.lado IS 'Define para quem a carta foi jogada: monstro (esquerda) ou jogador (direita)';
COMMENT ON COLUMN mtkin.combate_cartas.id_combate IS 'UUID único para identificar um combate específico';

-- Criar tabela de mochila
CREATE TABLE IF NOT EXISTS mtkin.mochila (
    id SERIAL PRIMARY KEY,
    id_sala INTEGER REFERENCES mtkin.rooms(id) ON DELETE CASCADE,
    id_jogador INTEGER REFERENCES mtkin.users(id) ON DELETE CASCADE,
    id_carta INTEGER NOT NULL,
    origem_tabela VARCHAR(20)
);

CREATE INDEX IF NOT EXISTS idx_mochila_sala ON mtkin.mochila(id_sala);
CREATE INDEX IF NOT EXISTS idx_mochila_jogador ON mtkin.mochila(id_jogador);


-- Criar tabela de histórico de cartas
CREATE TABLE IF NOT EXISTS mtkin.historico_cartas (
    id SERIAL PRIMARY KEY,
    id_carta INTEGER,
    nome_carta VARCHAR(150),
    local VARCHAR(100),
    id_jogador INTEGER REFERENCES mtkin.users(id) ON DELETE CASCADE,
    nome_jogador VARCHAR(50),
    id_sala INTEGER REFERENCES mtkin.rooms(id) ON DELETE CASCADE,
    nome_sala VARCHAR(100),
    tipo_baralho VARCHAR(20),
    acao VARCHAR(50),
    origem_acao VARCHAR(50), -- 'abrir_porta', 'fechar_porta', 'combate_vitoria', 'combate_derrota', 'combate_fuga', 'recompensa'
    foi_combate BOOLEAN DEFAULT FALSE,
    resultado_combate VARCHAR(20), -- 'vitoria', 'derrota', 'fuga'
    quantidade_tesouros INTEGER DEFAULT 0, -- quantidade de tesouros ganhos no combate
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_historico_cartas_carta ON mtkin.historico_cartas(id_carta);
CREATE INDEX IF NOT EXISTS idx_historico_cartas_jogador ON mtkin.historico_cartas(id_jogador);
CREATE INDEX IF NOT EXISTS idx_historico_cartas_sala ON mtkin.historico_cartas(id_sala);
CREATE INDEX IF NOT EXISTS idx_historico_cartas_created ON mtkin.historico_cartas(created_at);

COMMENT ON TABLE mtkin.historico_cartas IS 'Histórico de movimentações de todas as cartas que apareceram no jogo';

-- ============================================================================
-- FUNÇÕES E TRIGGERS PARA CÁLCULO AUTOMÁTICO DE TABULEIRO
-- ============================================================================

-- Função que calcula o valor do tabuleiro baseado nas cartas equipadas (colunas 79 a 89)
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

COMMENT ON FUNCTION mtkin.calcular_tabuleiro IS 'Calcula o valor total das cartas equipadas (slots 79-89) somando forca de cada carta';

-- Função trigger que atualiza o tabuleiro quando a cartela muda
CREATE OR REPLACE FUNCTION mtkin.trigger_atualizar_tabuleiro()
RETURNS TRIGGER AS $$
DECLARE
  v_novo_tabuleiro INTEGER;
  v_id_sala INTEGER;
  v_id_jogador INTEGER;
BEGIN
  -- Determinar sala e jogador baseado na operação
  IF TG_OP = 'DELETE' THEN
    v_id_sala := OLD.id_sala;
    v_id_jogador := OLD.id_jogador;
  ELSE
    v_id_sala := NEW.id_sala;
    v_id_jogador := NEW.id_jogador;
  END IF;
  
  -- Calcular novo valor do tabuleiro
  v_novo_tabuleiro := mtkin.calcular_tabuleiro(v_id_sala, v_id_jogador);
  
  -- Atualizar sala_online
  UPDATE mtkin.sala_online
  SET tabuleiro = v_novo_tabuleiro
  WHERE id_player = v_id_jogador;
  
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION mtkin.trigger_atualizar_tabuleiro IS 'Trigger que atualiza o valor de tabuleiro em sala_online quando cartas_ativas muda';

-- Criar trigger na tabela cartas_ativas
DROP TRIGGER IF EXISTS trg_atualizar_tabuleiro_cartela ON mtkin.cartas_ativas;

CREATE TRIGGER trg_atualizar_tabuleiro_cartela
AFTER INSERT OR UPDATE OR DELETE ON mtkin.cartas_ativas
FOR EACH ROW
EXECUTE FUNCTION mtkin.trigger_atualizar_tabuleiro();

COMMENT ON TRIGGER trg_atualizar_tabuleiro_cartela ON mtkin.cartas_ativas IS 'Atualiza tabuleiro automaticamente quando cartas são equipadas/desequipadas';

-- Criar tabela de propostas de troca (sistema de negociação)
CREATE TABLE IF NOT EXISTS mtkin.propostas_troca (
    id SERIAL PRIMARY KEY,
    id_sala INTEGER NOT NULL REFERENCES mtkin.rooms(id) ON DELETE CASCADE,
    id_jogador_origem INTEGER NOT NULL REFERENCES mtkin.users(id) ON DELETE CASCADE,
    id_jogador_destino INTEGER NOT NULL REFERENCES mtkin.users(id) ON DELETE CASCADE,
    -- carta_origem e carta_destino mantidos por compatibilidade (obsoletos - usar propostas_troca_itens)
    carta_origem INTEGER REFERENCES mtkin.mochila(id) ON DELETE SET NULL,
    carta_destino INTEGER REFERENCES mtkin.mochila(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'aceita', 'recusada', 'contraoferta', 'concluida')),
    mensagem TEXT,
    criada_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    respondida_em TIMESTAMP,
    CONSTRAINT origem_diferente_destino CHECK (id_jogador_origem != id_jogador_destino)
);

CREATE INDEX IF NOT EXISTS idx_propostas_sala ON mtkin.propostas_troca(id_sala);
CREATE INDEX IF NOT EXISTS idx_propostas_origem ON mtkin.propostas_troca(id_jogador_origem);
CREATE INDEX IF NOT EXISTS idx_propostas_destino ON mtkin.propostas_troca(id_jogador_destino);
CREATE INDEX IF NOT EXISTS idx_propostas_status ON mtkin.propostas_troca(status);

COMMENT ON TABLE mtkin.propostas_troca IS 'Tabela para controlar propostas de troca entre jogadores';
COMMENT ON COLUMN mtkin.propostas_troca.status IS 'Status da proposta: pendente (aguardando resposta), aceita (aceita), recusada (recusada), contraoferta (counter-offer), concluida (troca finalizada)';

-- Tabela pivot: cartas de cada lado de uma proposta (many-to-many)
CREATE TABLE IF NOT EXISTS mtkin.propostas_troca_itens (
    id          SERIAL PRIMARY KEY,
    id_proposta INTEGER NOT NULL REFERENCES mtkin.propostas_troca(id) ON DELETE CASCADE,
    id_mochila  INTEGER NOT NULL REFERENCES mtkin.mochila(id) ON DELETE CASCADE,
    lado        VARCHAR(10) NOT NULL CHECK (lado IN ('origem', 'destino'))
);

CREATE INDEX IF NOT EXISTS idx_prop_itens_proposta ON mtkin.propostas_troca_itens(id_proposta);
CREATE INDEX IF NOT EXISTS idx_prop_itens_mochila  ON mtkin.propostas_troca_itens(id_mochila);

COMMENT ON TABLE mtkin.propostas_troca_itens IS 'Cartas de cada lado de uma proposta de troca (N origens x N destinos)';

-- Exemplo de inserção de usuário admin (senha: admin123)
-- IMPORTANTE: Trocar a senha após primeiro login!
-- Hash bcrypt para 'admin123' (10 rounds)
-- INSERT INTO mtkin.users (username, email, password_hash, is_admin) 
-- VALUES ('admin', 'admin@munchkin.com', '$2b$10$rBV2kKUBN7PQ5Gz7xGxvY.FwK6pU6OhQxL5qhN5qxR5qQXm5qN5qR', true);

-- ============================================================================
-- COLUNAS DO MODO SIMULADOR
-- Adicionadas via migrate-simulado-flags.js; incluídas aqui para deploy limpo
-- ============================================================================

-- Tabela deck_estado (rastreia localização de cada carta durante partida)
CREATE TABLE IF NOT EXISTS mtkin.deck_estado (
  id              SERIAL PRIMARY KEY,
  id_sala         INTEGER NOT NULL,
  id_carta        INTEGER NOT NULL,
  tipo_baralho    VARCHAR(20) NOT NULL CHECK (tipo_baralho IN ('cidade','item')),
  localizacao     VARCHAR(30) NOT NULL DEFAULT 'mao'
                  CHECK (localizacao IN ('mao','cartela','mochila','combate','descarte')),
  id_jogador      INTEGER,
  criado_em       TIMESTAMP DEFAULT NOW(),
  atualizado_em   TIMESTAMP DEFAULT NOW(),
  simulado        BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (id_sala, id_carta, tipo_baralho)
);
CREATE INDEX IF NOT EXISTS idx_deck_estado_sala ON mtkin.deck_estado (id_sala);
CREATE INDEX IF NOT EXISTS idx_deck_estado_sala_baralho ON mtkin.deck_estado (id_sala, tipo_baralho);
CREATE INDEX IF NOT EXISTS idx_deck_estado_sala_loc ON mtkin.deck_estado (id_sala, localizacao);

ALTER TABLE mtkin.cartas_no_jogo        ADD COLUMN IF NOT EXISTS simulado BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE mtkin.cartas_ativas         ADD COLUMN IF NOT EXISTS simulado BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE mtkin.combate_cartas        ADD COLUMN IF NOT EXISTS simulado BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE mtkin.mochila               ADD COLUMN IF NOT EXISTS simulado BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE mtkin.historico_cartas      ADD COLUMN IF NOT EXISTS simulado BOOLEAN NOT NULL DEFAULT FALSE;

-- Tabela de cartas descartadas (voltam para o monte em novo jogo)
CREATE TABLE IF NOT EXISTS mtkin.descarte (
  id            SERIAL PRIMARY KEY,
  id_sala       INTEGER NOT NULL REFERENCES mtkin.rooms(id) ON DELETE CASCADE,
  id_carta      INTEGER NOT NULL,
  nome_carta    VARCHAR(150) NOT NULL,
  tipo_baralho  VARCHAR(20) NOT NULL,
  caminho_imagem VARCHAR(255),
  id_jogador    INTEGER REFERENCES mtkin.users(id) ON DELETE SET NULL,
  nome_jogador  VARCHAR(50),
  descartado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_descarte_sala   ON mtkin.descarte(id_sala);
CREATE INDEX IF NOT EXISTS idx_descarte_carta  ON mtkin.descarte(id_carta);

-- Tabela estado_turno (fase da porta, turnos)
CREATE TABLE IF NOT EXISTS mtkin.estado_turno (
  id_sala       INTEGER NOT NULL REFERENCES mtkin.rooms(id) ON DELETE CASCADE,
  id_jogador    INTEGER NOT NULL REFERENCES mtkin.users(id)  ON DELETE CASCADE,
  turno_numero  INTEGER NOT NULL DEFAULT 0,
  fase_porta    VARCHAR(20) NOT NULL DEFAULT 'idle',
  carta_monstro JSONB,
  mensagem      TEXT,
  atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  simulado      BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (id_sala, id_jogador)
);
CREATE INDEX IF NOT EXISTS idx_estado_turno_sala ON mtkin.estado_turno(id_sala);

-- Tabela historico_eventos (log de eventos do jogo)
CREATE TABLE IF NOT EXISTS mtkin.historico_eventos (
  id          SERIAL PRIMARY KEY,
  id_sala     INTEGER REFERENCES mtkin.rooms(id) ON DELETE CASCADE,
  id_jogador  INTEGER REFERENCES mtkin.users(id) ON DELETE SET NULL,
  tipo        VARCHAR(50)  NOT NULL,
  descricao   TEXT,
  dados       JSONB,
  simulado    BOOLEAN NOT NULL DEFAULT FALSE,
  criado_em   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_historico_eventos_sala ON mtkin.historico_eventos(id_sala);

-- Tabela ajuda_combate (propostas de ajuda em combate)
CREATE TABLE IF NOT EXISTS mtkin.ajuda_combate (
  id              SERIAL        PRIMARY KEY,
  id_sala         INTEGER       NOT NULL,
  id_combate      TEXT,
  id_lutador      INTEGER       NOT NULL,
  id_proponente   INTEGER       NOT NULL,
  id_destinatario INTEGER       NOT NULL,
  tipo_proposta   VARCHAR(50)   NOT NULL,
  fluxo           VARCHAR(20)   NOT NULL DEFAULT 'direto',
  status          VARCHAR(30)   NOT NULL DEFAULT 'pendente',
  proposta_pai    INTEGER       REFERENCES mtkin.ajuda_combate(id),
  simulado        BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ   DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ajuda_combate_sala ON mtkin.ajuda_combate(id_sala, status);
CREATE INDEX IF NOT EXISTS idx_ajuda_combate_dest ON mtkin.ajuda_combate(id_destinatario, status);

-- Tabela combate_participacao (quem participa do combate)
CREATE TABLE IF NOT EXISTS mtkin.combate_participacao (
  id_sala         INTEGER      NOT NULL,
  id_combate      UUID,
  id_jogador_luta INTEGER      NOT NULL,
  id_jogador      INTEGER      NOT NULL,
  status          VARCHAR(20)  NOT NULL DEFAULT 'esperando',
  simulado        BOOLEAN      NOT NULL DEFAULT FALSE,
  updated_at      TIMESTAMPTZ  DEFAULT NOW(),
  PRIMARY KEY (id_sala, id_jogador)
);

ALTER TABLE mtkin.propostas_troca       ADD COLUMN IF NOT EXISTS simulado BOOLEAN NOT NULL DEFAULT FALSE;

-- Colunas de backup do sala_online para restaurar estado pré-simulação
ALTER TABLE mtkin.sala_online ADD COLUMN IF NOT EXISTS sim_mao_backup      INTEGER;
ALTER TABLE mtkin.sala_online ADD COLUMN IF NOT EXISTS sim_nivel_backup    INTEGER;
ALTER TABLE mtkin.sala_online ADD COLUMN IF NOT EXISTS sim_tabuleiro_backup INTEGER;

-- Tabela de combates
CREATE TABLE IF NOT EXISTS mtkin.combate (
  id               SERIAL PRIMARY KEY,
  id_combate       VARCHAR(64)  NOT NULL UNIQUE,
  id_sala          INTEGER      NOT NULL REFERENCES mtkin.rooms(id) ON DELETE CASCADE,
  id_jogador       INTEGER      NOT NULL REFERENCES mtkin.users(id) ON DELETE CASCADE,
  forca_jogador    INTEGER      NOT NULL DEFAULT 0,
  forca_monstro    INTEGER      NOT NULL DEFAULT 0,
  id_carta_monstro INTEGER      REFERENCES mtkin.cartas(id) ON DELETE SET NULL,
  simulado         BOOLEAN      NOT NULL DEFAULT FALSE,
  status           VARCHAR(30)  NOT NULL DEFAULT 'em_andamento',
  criado_em        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  atualizado_em    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_combate_id_combate ON mtkin.combate (id_combate);
CREATE INDEX IF NOT EXISTS idx_combate_id_sala    ON mtkin.combate (id_sala);
ALTER TABLE mtkin.combate ADD COLUMN IF NOT EXISTS botoes_jogador          TEXT NOT NULL DEFAULT '';
ALTER TABLE mtkin.combate ADD COLUMN IF NOT EXISTS botoes_outros_jogadores TEXT NOT NULL DEFAULT '';
ALTER TABLE mtkin.combate ADD COLUMN IF NOT EXISTS interferencia           TEXT NOT NULL DEFAULT '';
ALTER TABLE mtkin.combate ADD COLUMN IF NOT EXISTS id_helper               INTEGER;
ALTER TABLE mtkin.combate ADD COLUMN IF NOT EXISTS duo_prontos             TEXT NOT NULL DEFAULT '';
ALTER TABLE mtkin.combate ADD COLUMN IF NOT EXISTS tipo_acordo             TEXT;
ALTER TABLE mtkin.combate ADD COLUMN IF NOT EXISTS distribuicao_vez        INTEGER;

-- ============================================================================
-- COLUNAS DE MIGRATIONS AVULSAS (consolidadas para deploy limpo)
-- ============================================================================

-- rooms: turno e organização
ALTER TABLE mtkin.rooms ADD COLUMN IF NOT EXISTS ordem_turno         INTEGER[] DEFAULT '{}';
ALTER TABLE mtkin.rooms ADD COLUMN IF NOT EXISTS turno_atual_index   INTEGER DEFAULT 0;
ALTER TABLE mtkin.rooms ADD COLUMN IF NOT EXISTS turno_numero        INTEGER DEFAULT 0;
ALTER TABLE mtkin.rooms ADD COLUMN IF NOT EXISTS prontos_organizacao INTEGER[] NOT NULL DEFAULT '{}';

-- cartas: atributos extras
ALTER TABLE mtkin.cartas ADD COLUMN IF NOT EXISTS uso_em_combate BOOLEAN DEFAULT FALSE;
ALTER TABLE mtkin.cartas ADD COLUMN IF NOT EXISTS pesado         BOOLEAN DEFAULT FALSE;
ALTER TABLE mtkin.cartas ADD COLUMN IF NOT EXISTS qtd_max        INTEGER NOT NULL DEFAULT 1;
ALTER TABLE mtkin.cartas ADD COLUMN IF NOT EXISTS valor          INTEGER DEFAULT 0;
ALTER TABLE mtkin.cartas ADD COLUMN IF NOT EXISTS armadilha      TEXT;

-- historico_cartas: colunas de rastreamento
ALTER TABLE mtkin.historico_cartas ADD COLUMN IF NOT EXISTS tipo_evento         VARCHAR(50);
ALTER TABLE mtkin.historico_cartas ADD COLUMN IF NOT EXISTS turno_numero        INTEGER;
ALTER TABLE mtkin.historico_cartas ADD COLUMN IF NOT EXISTS descricao           TEXT;
ALTER TABLE mtkin.historico_cartas ADD COLUMN IF NOT EXISTS origem_acao         VARCHAR(50);
ALTER TABLE mtkin.historico_cartas ADD COLUMN IF NOT EXISTS foi_combate         BOOLEAN DEFAULT FALSE;
ALTER TABLE mtkin.historico_cartas ADD COLUMN IF NOT EXISTS resultado_combate   VARCHAR(20);
ALTER TABLE mtkin.historico_cartas ADD COLUMN IF NOT EXISTS quantidade_tesouros INTEGER DEFAULT 0;

-- estado_turno: modo duo
ALTER TABLE mtkin.estado_turno ADD COLUMN IF NOT EXISTS duo_modo      BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE mtkin.estado_turno ADD COLUMN IF NOT EXISTS duo_helper_id INTEGER;
ALTER TABLE mtkin.estado_turno ADD COLUMN IF NOT EXISTS duo_prontos   INTEGER[] NOT NULL DEFAULT '{}';

-- combate_participacao: duo
ALTER TABLE mtkin.combate_participacao ADD COLUMN IF NOT EXISTS duo_pronto_lutador BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE mtkin.combate_participacao ADD COLUMN IF NOT EXISTS duo_pronto_helper  BOOLEAN NOT NULL DEFAULT FALSE;

-- ajuda_combate: seleção
ALTER TABLE mtkin.ajuda_combate ADD COLUMN IF NOT EXISTS escolhido BOOLEAN NOT NULL DEFAULT FALSE;
