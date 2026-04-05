const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { body, validationResult } = require('express-validator');
require('dotenv').config();
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: function(origin, callback) {
    // Permitir requests sem origin (curl, mobile, etc) e qualquer localhost/render
    if (!origin || origin.includes('localhost') || origin.includes('127.0.0.1') || origin.includes('.onrender.com')) {
      callback(null, true);
    } else {
      callback(null, true); // liberar para dev; restringir depois se necessário
    }
  },
  credentials: true
}));
app.use(express.json());

// Servir frontend estático (index.html, styles.css, .github/) a partir da raiz do projeto
app.use(express.static(path.resolve(__dirname, '..')));

// Servir arquivos estáticos (para as imagens das cartas)
// Priorizar acervo raiz Cartas; manter fallback para backend/Cartas
app.use('/Cartas', express.static(path.resolve(__dirname, '..', 'Cartas')));
app.use('/Cartas', express.static(path.resolve(__dirname, 'Cartas')));

// Configuração do Pool de conexão PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

const DOOR_IMAGES_ROOT = path.resolve(__dirname, '..', 'Cartas', 'Cidade');
const TREASURE_IMAGES_ROOT = path.resolve(__dirname, '..', 'Cartas', 'Itens');
const PERSONAGENS_DIR = path.resolve(__dirname, '..', 'Personagens');
const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
let cachedDoorImages = null;
const doorMonstrosIndexByRoomId = new Map();

// Store em memória para participação de combate
// { roomId => { combatId, fightingPlayerId, participants: { userId: 'esperando'|'participando'|'pronto'|'recusou' } } }
const combateParticipacaoByRoomId = new Map();

// Store em memória para modo "receber ofertas" do combate
// { roomId => { combatId, lutadorId, modoAberto: bool, bloqueados: Set<playerId> } }
const ajudaModoAbertoByRoomId = new Map();

// ── Logger de combate ─────────────────────────────────────────────────────────
function combateLog(tag, user, msg, extra = {}) {
  const ts   = new Date().toTimeString().slice(0,8);
  const nome = typeof user === 'string' ? user : (user?.username || user?.id || '?');
  const parts = [`[${ts}] ⚔️  [${tag}] [${nome}] ${msg}`];
  if (Object.keys(extra).length) {
    const info = Object.entries(extra).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join(' | ');
    parts.push(`    └─ ${info}`);
  }
  console.log(parts.join('\n'));
}
function combateModoSnapshot(roomId) {
  const modo = ajudaModoAbertoByRoomId.get(roomId);
  const combat = combateParticipacaoByRoomId.get(roomId);
  if (!modo && !combat) return;
  const nL = modo?.naoLutadores?.size ?? 0;
  const rp = modo?.responderam?.size ?? 0;
  console.log(`    📊 [MEMÓRIA sala=${roomId}] combatId=${combat?.combatId||modo?.combatId||'?'} | lutador=${modo?.lutadorId||combat?.fightingPlayerId||'?'} | naoLutadores=${nL} | responderam=${rp}/${nL}`);
}

function parseCombatInterferencia(rawValue) {
  const base = {
    ids: [],
    disable_run: false,
    retry_escape: false,
    retry_penalty: 0,
    retry_penalty_armed: false,
    reducao_itens: 0,
    multiplicador_itens: 1
  };

  if (!rawValue) return { ...base };
  const raw = String(rawValue).trim();
  if (!raw) return { ...base };

  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      return {
        ...base,
        ...parsed,
        ids: Array.isArray(parsed?.ids)
          ? parsed.ids.map((id) => String(id).trim()).filter(Boolean)
          : []
      };
    } catch (_) {
      return { ...base };
    }
  }

  return {
    ...base,
    ids: raw.split(';').map((value) => value.trim()).filter(Boolean)
  };
}

function serializeCombatInterferencia(state) {
  const parsed = parseCombatInterferencia(state);
  return JSON.stringify({
    ids: parsed.ids,
    disable_run: !!parsed.disable_run,
    retry_escape: !!parsed.retry_escape,
    retry_penalty: Number(parsed.retry_penalty) || 0,
    retry_penalty_armed: !!parsed.retry_penalty_armed,
    reducao_itens: Number(parsed.reducao_itens) || 0,
    multiplicador_itens: Number(parsed.multiplicador_itens) || 1
  });
}

async function appendCombatDecisionInterference(roomId, userId, dbClient) {
  const db = dbClient || pool;
  const current = await db.query(
    `SELECT id_combate, interferencia
     FROM mtkin.combate
     WHERE id_sala = $1 AND status NOT IN ('vitoria','fuga','derrota')
     ORDER BY criado_em DESC LIMIT 1`,
    [roomId]
  );
  if (!current.rows.length) return;

  const combate = current.rows[0];
  const state = parseCombatInterferencia(combate.interferencia);
  const idStr = String(userId);
  if (!state.ids.includes(idStr)) state.ids.push(idStr);

  await db.query(
    `UPDATE mtkin.combate
     SET interferencia = $1,
         atualizado_em = NOW()
     WHERE id_combate = $2`,
    [serializeCombatInterferencia(state), combate.id_combate]
  );
}
// ─────────────────────────────────────────────────────────────────────────────

// Helper: retorna true se o modo simulador está ativo para a sala
async function getSimFlag(roomId, db) {
  if (!roomId) return false;
  const q = db || pool;
  try {
    const r = await q.query('SELECT simulador FROM mtkin.rooms WHERE id = $1', [roomId]);
    return r.rows.length > 0 && r.rows[0].simulador === 'ativado';
  } catch (_) { return false; }
}

async function syncPersonagensFromDisk() {
  try {
    const root = path.resolve(__dirname, '..');
    const files = [];

    async function walk(dir) {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      await Promise.all(entries.map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
          return;
        }
        if (!entry.isFile()) return;
        const ext = path.extname(entry.name).toLowerCase();
        if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) return;
        const relPath = path.relative(root, fullPath).split(path.sep).join('/');
        files.push(relPath);
      }));
    }

    await walk(PERSONAGENS_DIR);

    if (files.length === 0) return;

    const placeholders = files.map((_, i) => `$${i + 1}`).join(',');
    await pool.query(
      `UPDATE mtkin.personagens 
       SET ativo = false 
       WHERE caminho_imagem NOT IN (${placeholders})`,
      files
    );

    for (const relPath of files) {
      const base = path.basename(relPath, path.extname(relPath));
      await pool.query(
        `INSERT INTO mtkin.personagens (nome, caminho_imagem, ativo)
         VALUES ($1, $2, true)
         ON CONFLICT (caminho_imagem) DO UPDATE SET ativo = EXCLUDED.ativo, nome = EXCLUDED.nome`,
        [base, relPath]
      );
    }
  } catch (error) {
    console.warn('Falha ao sincronizar personagens:', error.message);
  }
}

function sanitizeFilename(name) {
  if (!name) return 'upload';
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

const uploadStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const uploadDir = path.resolve(__dirname, 'uploads', 'personagens');
      await fs.promises.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const safeName = sanitizeFilename(file.originalname);
    cb(null, safeName);
  }
});

const uploadPersonagem = multer({
  storage: uploadStorage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
      return cb(new Error('Tipo de arquivo invalido'));
    }
    cb(null, true);
  }
});

async function collectDoorImages(dirPath, results) {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await collectDoorImages(fullPath, results);
      return;
    }
    if (!entry.isFile()) return;
    const ext = path.extname(entry.name).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return;
    results.push(fullPath);
  }));
}

async function getDoorImages() {
  if (cachedDoorImages) return cachedDoorImages;
  const results = [];
  await collectDoorImages(DOOR_IMAGES_ROOT, results);
  const root = path.resolve(__dirname, '..', 'Cartas');
  cachedDoorImages = results.map((filePath) => {
    const relativePath = path.relative(root, filePath).split(path.sep).join('/');
    return `/Cartas/${relativePath}`;
  });
  return cachedDoorImages;
}

async function getTreasureCategories() {
  try {
    const { rows } = await pool.query('SELECT nome FROM mtkin.categorias ORDER BY nome ASC');
    return rows.map((r) => r.nome);
  } catch (error) {
    console.warn('Falha ao ler categorias de item:', error.message);
    return [];
  }
}

async function ensureCategoryExists(nome) {
  if (!nome || !String(nome).trim()) return;
  const trimmed = String(nome).trim();
  try {
    await pool.query('INSERT INTO mtkin.categorias (nome) VALUES ($1) ON CONFLICT (nome) DO NOTHING', [trimmed]);
  } catch (error) {
    console.warn('Falha ao registrar categoria:', error.message);
  }
}

// Testar conexão
pool.connect((err, client, release) => {
  if (err) {
    console.error('Erro ao conectar ao banco de dados:', err.stack);
  } else {
    console.log('✓ Conectado ao banco de dados PostgreSQL');
    release();
  }
});

// Middleware de autenticação
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Token inválido' });
    }
    req.user = user;
    next();
  });
};

// Middleware simples para checar admin
const requireAdmin = (req, res, next) => {
  if (!req.user?.isAdmin) {
    return res.status(403).json({ error: 'Apenas administradores podem executar esta ação' });
  }
  next();
};

// ── Helper: registrar evento no historico_eventos ──────────────────────────────
// Mapeamento de rotas para tipo legível
const ROTA_TIPO_MAP = {
  '/api/rooms/create':                'sala_criada',
  '/api/rooms/join':                  'sala_entrou',
  '/api/rooms/leave':                 'sala_saiu',
  '/api/rooms/start-game':            'jogo_iniciado',
  '/api/rooms/ready':                 'jogador_pronto',
  '/api/rooms/end-turn':              'fim_turno',
  '/api/rooms/estado-turno':          'estado_turno',
  '/api/rooms/simulador':             'simulador_toggle',
  '/api/cards/add-to-hand':           'carta_comprada',
  '/api/cards/remove-from-hand':      'carta_removida_mao',
  '/api/cards/descartar-da-mao':      'carta_descartada',
  '/api/cards/dar-carta':             'carta_dada',
  '/api/cartela/slot':                'carta_equipada',
  '/api/cartela/move':                'carta_movida',
  '/api/cartela/descartar':           'carta_desequipada',
  '/api/mochila/add':                 'carta_mochila',
  '/api/mochila/to-cartela':          'mochila_para_cartela',
  '/api/mochila/dar-para-jogador':    'mochila_transferida',
  '/api/battle/fight':                'batalha_luta',
  '/api/battle/distribuir':           'batalha_distribuir',
  '/api/armadilha/aplicar':           'armadilha_aplicada',
  '/api/combate/add-card':            'combate_add_carta',
  '/api/combate/remove-card':         'combate_remove_carta',
  '/api/combate/resolve':             'combate_resolver',
  '/api/combate/iniciar-participacao':'combate_iniciar_part',
  '/api/combate/participar':          'combate_participar',
  '/api/combate/recusar':             'combate_recusar',
  '/api/combate/duo/pronto':          'duo_pronto',
  '/api/combate/duo/confirmar-pronto':'duo_confirmar_pronto',
  '/api/combate/pronto-fase2':        'combate_pronto_fase2',
  '/api/combate/pronto-participacao': 'combate_pronto_part',
  '/api/combate/ajuda/modo-aberto':   'ajuda_modo_aberto',
  '/api/combate/ajuda/proposta':      'ajuda_proposta',
  '/api/combate/ajuda/responder':     'ajuda_responder',
  '/api/combate/ajuda/escolher':      'ajuda_escolher',
  '/api/combate/ajuda/bloquear':      'ajuda_bloquear',
  '/api/combate/ajuda/recusar-ajudar':'ajuda_recusou',
  '/api/combate/resultado-fuga':      'combate_fuga',
  '/api/combate/penalidade-monstro':  'penalidade_monstro',
  '/api/propostas':                   'proposta_troca',
  '/api/historico/registrar':         'historico_registrar',
};
// Rotas de polling/leitura — NÃO registrar (GET ou POST de leitura frequente)
const ROTAS_IGNORAR = new Set([
  '/api/verify', '/api/rooms/check', '/api/rooms/players-light',
  '/api/rooms/online-players', '/api/cards/door-hand', '/api/cards/treasure-hand',
  '/api/cards/door-random', '/api/cards/treasure-random',
  '/api/combate/estado', '/api/combate/ajuda/status',
  '/api/historico/feed', '/api/propostas/pendentes',
  '/api/cards/door-image', '/api/cards/treasure-categories',
  '/api/mochila', '/api/regras-customizadas',
  '/api/armadilha/pendente',
  '/api/combate/isca',
  '/api/descarte',
]);

async function registrarEvento({ tipo, descricao, dados, userId, userName, roomId, roomName, turnoNumero, duracaoMs, eventoIdRef }) {
  try {
    const simFlag = roomId ? await getSimFlag(roomId) : false;
    await pool.query(
      `INSERT INTO mtkin.historico_eventos
         (id_sala, id_jogador, nome_jogador, nome_sala, tipo, descricao, dados, simulado, duracao_ms, turno_numero, evento_id_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [roomId || null, userId || null, userName || null, roomName || null,
       tipo, descricao || null, dados ? JSON.stringify(dados) : null,
       simFlag, duracaoMs || null, turnoNumero || null, eventoIdRef || null]
    );
  } catch (e) {
    // Silenciar — não quebrar o fluxo do jogo por falha de log
  }
}

// Helper: obter roomId a partir do user (para middleware)
async function getRoomIdFromUserFast(userId) {
  try {
    const r = await pool.query(
      "SELECT room_id FROM mtkin.room_participants WHERE user_id=$1 AND is_online=true LIMIT 1", [userId]);
    return r.rows[0]?.room_id || null;
  } catch (_) { return null; }
}

// ── Middleware de monitoramento de eventos ──────────────────────────────────────
app.use((req, res, next) => {
  // Só monitorar POST/PUT/DELETE (ações)
  if (req.method === 'GET') return next();
  // Ignorar rotas de polling/leitura
  const rota = req.path.replace(/\/\d+$/, ''); // normalizar /api/combate/remove-card/123 → /api/combate/remove-card
  if (ROTAS_IGNORAR.has(rota) || ROTAS_IGNORAR.has(req.path)) return next();
  // Ignorar rotas sem mapeamento (admin, personagens, etc.)
  const tipo = ROTA_TIPO_MAP[rota] || ROTA_TIPO_MAP[req.path];
  if (!tipo) return next();

  req._evtStart = Date.now();
  req._evtTipo = tipo;

  // Interceptar res.json para capturar resposta e registrar evento
  const originalJson = res.json.bind(res);
  res.json = function(body) {
    const duracao = Date.now() - req._evtStart;
    const userId = req.user?.id || null;
    const userName = req.user?.username || null;
    const statusCode = res.statusCode;

    // Fire-and-forget: registrar sem bloquear a resposta
    (async () => {
      try {
        let roomId = body?.roomId || body?.room?.id || body?.sala || req.body?.id_sala || null;
        if (!roomId && userId) roomId = await getRoomIdFromUserFast(userId);
        let roomName = body?.roomName || body?.room?.room_name || req.body?.nome_sala || null;
        const turno = body?.turno_numero || body?.turno || req.body?.turno_numero || null;

        const dados = {
          rota: req.path,
          method: req.method,
          status: statusCode,
          duracao_ms: duracao,
          body_keys: req.body ? Object.keys(req.body) : [],
        };
        // Adicionar info relevante do body da request
        if (req.body?.id_carta) dados.id_carta = req.body.id_carta;
        if (req.body?.nome_carta) dados.nome_carta = req.body.nome_carta;
        if (req.body?.id_slot) dados.id_slot = req.body.id_slot;
        if (req.body?.acao) dados.acao = req.body.acao;

        const desc = `${userName || '?'} → ${tipo} (${duracao}ms) [${statusCode}]`;
        await registrarEvento({
          tipo, descricao: desc, dados, userId, userName,
          roomId, roomName, turnoNumero: turno, duracaoMs: duracao
        });
      } catch (_) {}
    })();

    // Injetar _evento_ts na resposta para o frontend medir latência
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      body._evento_ts = Date.now();
    }
    return originalJson(body);
  };

  next();
});

// ROTAS

// 1. Cadastro de usuário
app.post('/api/register', [
  body('username').trim().isLength({ min: 3, max: 50 }).withMessage('Nome de usuário deve ter entre 3 e 50 caracteres'),
  body('email').isEmail().normalizeEmail().withMessage('Email inválido'),
  body('password').isLength({ min: 6 }).withMessage('Senha deve ter no mínimo 6 caracteres')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { username, email, password } = req.body;

  try {
    // Verificar se usuário já existe
    const userCheck = await pool.query(
      'SELECT id FROM mtkin.users WHERE username = $1 OR email = $2',
      [username, email]
    );

    if (userCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Usuário ou email já cadastrado' });
    }

    // Hash da senha
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Inserir usuário
    const result = await pool.query(
      'INSERT INTO mtkin.users (username, email, password_hash, is_admin) VALUES ($1, $2, $3, $4) RETURNING id, username, email, is_admin, created_at',
      [username, email, passwordHash, false]
    );

    const newUser = result.rows[0];

    // Gerar token JWT
    const token = jwt.sign(
      { id: newUser.id, username: newUser.username, isAdmin: newUser.is_admin },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(201).json({
      message: 'Usuário cadastrado com sucesso',
      token,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        isAdmin: newUser.is_admin
      }
    });

  } catch (error) {
    console.error('Erro no cadastro:', error);
    res.status(500).json({ error: 'Erro ao cadastrar usuário' });
  }
});

// 2. Login
app.post('/api/login', [
  body('username').trim().notEmpty().withMessage('Nome de usuário é obrigatório'),
  body('password').notEmpty().withMessage('Senha é obrigatória')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { username, password } = req.body;

  try {
    // Buscar usuário
    const result = await pool.query(
      'SELECT id, username, email, password_hash, is_admin, active FROM mtkin.users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    }

    const user = result.rows[0];

    // Verificar se conta está ativa
    if (!user.active) {
      return res.status(403).json({ error: 'Conta desativada' });
    }

    // Verificar senha
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    }

    // Atualizar último login
    await pool.query(
      'UPDATE mtkin.users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );

    // Gerar token JWT
    const token = jwt.sign(
      { id: user.id, username: user.username, isAdmin: user.is_admin },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      message: 'Login realizado com sucesso',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        isAdmin: user.is_admin
      }
    });

  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

// 3. Verificar token (rota protegida)
app.get('/api/verify', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, is_admin FROM mtkin.users WHERE id = $1 AND active = true',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    res.json({
      valid: true,
      user: {
        id: result.rows[0].id,
        username: result.rows[0].username,
        email: result.rows[0].email,
        isAdmin: result.rows[0].is_admin
      }
    });

  } catch (error) {
    console.error('Erro na verificação:', error);
    res.status(500).json({ error: 'Erro ao verificar token' });
  }
});

// 4. Logout (opcional - pode limpar token no frontend)
app.post('/api/logout', authenticateToken, (req, res) => {
  res.json({ message: 'Logout realizado com sucesso' });
});

// 5. Rota de teste
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'API funcionando' });
});

// ========== ROTAS DE SALAS ==========

// Função para gerar código único de sala
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// 6. Criar sala
app.post('/api/rooms/create', [
  authenticateToken,
  body('roomName').trim().isLength({ min: 3, max: 100 }).withMessage('Nome da sala deve ter entre 3 e 100 caracteres'),
  body('maxPlayers').isInt({ min: 3, max: 6 }).withMessage('Número de jogadores deve ser entre 3 e 6'),
  body('characterPath').optional().isString().isLength({ min: 1, max: 255 }).withMessage('Personagem inválido')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { roomName, maxPlayers, characterPath } = req.body;
  const userId = req.user.id;
  const username = req.user.username;

  try {
    // Verificar se usuário já está em uma sala ativa
    const existingRoom = await pool.query(
      `SELECT rp.room_id, r.room_name 
       FROM mtkin.room_participants rp
       JOIN mtkin.rooms r ON r.id = rp.room_id
       WHERE rp.user_id = $1 AND r.is_active = true`,
      [userId]
    );

    if (existingRoom.rows.length > 0) {
      return res.status(400).json({ 
        error: 'Você já está em uma sala ativa',
        currentRoom: existingRoom.rows[0]
      });
    }

    // Gerar código único
    let roomCode;
    let codeExists = true;
    
    while (codeExists) {
      roomCode = generateRoomCode();
      const checkCode = await pool.query(
        'SELECT id FROM mtkin.rooms WHERE room_code = $1',
        [roomCode]
      );
      codeExists = checkCode.rows.length > 0;
    }

    // Criar sala com jogador 1 já definido
    const result = await pool.query(
      `INSERT INTO mtkin.rooms (room_name, max_players, jog1, created_by, room_code, status, is_active) 
       VALUES ($1, $2, $3, $4, $5, 'waiting', true) 
       RETURNING id, room_name, max_players, jog1, jog2, jog3, jog4, jog5, jog6, room_code, status, created_at`,
      [roomName, maxPlayers, username, userId, roomCode]
    );

    const room = result.rows[0];

    // Adicionar criador como participante
    await pool.query(
      `INSERT INTO mtkin.room_participants (room_id, user_id, username, player_slot, is_online)
       VALUES ($1, $2, $3, 1, true)`,
      [room.id, userId, username]
    );

    // Registrar estado do jogador na sala (uma linha por jogador)
    await pool.query(
      'DELETE FROM mtkin.sala_online WHERE id_player = $1',
      [userId]
    );

    await pool.query(
      `INSERT INTO mtkin.sala_online (id_player, nome_jogador, nome_sala, mao, turno, nivel, tabuleiro, mochila, personagem_caminho)
       VALUES ($1, $2, $3, 0, 0, 1, 0, NULL, $4)`,
      [userId, username, room.room_name, characterPath || null]
    );

    res.status(201).json({
      message: 'Sala criada com sucesso',
      room: {
        id: room.id,
        roomName: room.room_name,
        maxPlayers: room.max_players,
        roomCode: room.room_code,
        status: room.status,
        players: {
          jog1: room.jog1,
          jog2: room.jog2,
          jog3: room.jog3,
          jog4: room.jog4,
          jog5: room.jog5,
          jog6: room.jog6
        },
        createdAt: room.created_at
      }
    });

  } catch (error) {
    console.error('Erro ao criar sala:', error);
    res.status(500).json({ error: 'Erro ao criar sala' });
  }
});

// 7. Listar salas disponíveis
app.get('/api/rooms', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, room_name, max_players, jog1, jog2, jog3, jog4, jog5, jog6, room_code, status, created_at 
       FROM mtkin.rooms 
       WHERE status = 'waiting' AND is_active = true
       ORDER BY created_at DESC`
    );

    const rooms = result.rows.map(room => ({
      id: room.id,
      roomName: room.room_name,
      maxPlayers: room.max_players,
      roomCode: room.room_code,
      status: room.status,
      currentPlayers: [room.jog1, room.jog2, room.jog3, room.jog4, room.jog5, room.jog6].filter(j => j !== null && !j.startsWith('*')).length,
      players: {
        jog1: room.jog1,
        jog2: room.jog2,
        jog3: room.jog3,
        jog4: room.jog4,
        jog5: room.jog5,
        jog6: room.jog6
      },
      createdAt: room.created_at
    }));

    res.json({ rooms });

  } catch (error) {
    console.error('Erro ao listar salas:', error);
    res.status(500).json({ error: 'Erro ao listar salas' });
  }
});

// 8. Verificar sala atual do usuário
app.get('/api/rooms/my-room', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const salaOnlineResult = await pool.query(
      'SELECT mao, turno, nivel, personagem_caminho, forca, tabuleiro FROM mtkin.sala_online WHERE id_player = $1',
      [userId]
    );

    const result = await pool.query(
      `SELECT r.id, r.room_name, r.max_players, r.jog1, r.jog2, r.jog3, r.jog4, r.jog5, r.jog6, r.room_code, r.status,
              r.created_by, r.simulador, rp.player_slot
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true
       LIMIT 1`,
      [userId]
    );

    let salaOnline = salaOnlineResult.rows[0] || null;
    const hasSalaOnline = Boolean(salaOnline);

    if (result.rows.length === 0) {
      if (salaOnline) {
        salaOnline = { ...salaOnline, mao: 0 };
      }
      return res.json({ inRoom: false, hasSalaOnline, salaOnline });
    }

    const room = result.rows[0];
    const countResult = await pool.query(
      'SELECT COUNT(*)::int AS total FROM mtkin.cartas_no_jogo WHERE id_sala = $1 AND id_jogador = $2',
      [room.id, userId]
    );
    const effectiveMao = countResult.rows[0]?.total ?? 0;
    if (salaOnline) {
      const currentMao = Number.isFinite(Number(salaOnline.mao)) ? Number(salaOnline.mao) : 0;
      if (currentMao !== effectiveMao) {
        await pool.query(
          'UPDATE mtkin.sala_online SET mao = $1 WHERE id_player = $2',
          [effectiveMao, userId]
        );
      }
      salaOnline = { ...salaOnline, mao: effectiveMao };
    }

    // Buscar participantes com status online
    const participants = await pool.query(
      `SELECT username, player_slot, is_online, last_seen
       FROM mtkin.room_participants
       WHERE room_id = $1
       ORDER BY player_slot`,
      [room.id]
    );

    res.json({
      inRoom: true,
      hasSalaOnline,
      salaOnline,
      room: {
        id: room.id,
        roomName: room.room_name,
        maxPlayers: room.max_players,
        roomCode: room.room_code,
        status: room.status,
        mySlot: room.player_slot,
        isCreator: room.created_by === userId,
        isJog1: room.jog1 === req.user.username,
        simulador: room.simulador || 'desativado',
        players: {
          jog1: room.jog1,
          jog2: room.jog2,
          jog3: room.jog3,
          jog4: room.jog4,
          jog5: room.jog5,
          jog6: room.jog6
        },
        participants: participants.rows
      }
    });

  } catch (error) {
    console.error('Erro ao verificar sala:', error);
    res.status(500).json({ error: 'Erro ao verificar sala' });
  }
});

app.get('/api/rooms/online-players', authenticateToken, async (req, res) => {
  const roomName = String(req.query.roomName || '').trim();
  if (!roomName) {
    return res.status(400).json({ error: 'Nome da sala é obrigatório' });
  }

  try {
    const accessResult = await pool.query(
      `SELECT r.id
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.room_name = $2 AND r.is_active = true`,
      [req.user.id, roomName]
    );

    if (accessResult.rows.length === 0) {
      return res.status(403).json({ error: 'Acesso negado a esta sala' });
    }

    const roomId = accessResult.rows[0].id;
    const playersResult = await pool.query(
      `SELECT so.id_player, so.nome_jogador, so.nome_sala, so.nivel, so.forca, so.mao, so.personagem_caminho,
              r.prontos_organizacao
       FROM mtkin.sala_online so
       JOIN mtkin.room_participants rp
         ON rp.user_id = so.id_player
        AND rp.room_id = $1
        AND rp.is_online = true
       JOIN mtkin.rooms r ON r.id = $1
       WHERE so.nome_sala = $2
       ORDER BY so.nivel ASC, so.nome_jogador ASC`,
      [roomId, roomName]
    );

    const prontos = playersResult.rows[0]?.prontos_organizacao || [];
    const players = playersResult.rows.map(p => ({
      id_player:          p.id_player,
      nome_jogador:       p.nome_jogador,
      nome_sala:          p.nome_sala,
      nivel:              p.nivel,
      forca:              p.forca,
      mao:                p.mao ?? 0,
      personagem_caminho: p.personagem_caminho,
      is_pronto:          prontos.includes(p.id_player)
    }));

    res.json({ players });
  } catch (error) {
    console.error('Erro ao buscar personagens da sala:', error);
    res.status(500).json({ error: 'Erro ao buscar personagens da sala' });
  }
});

app.get('/api/rooms/used-characters', authenticateToken, async (req, res) => {
  const roomCode = String(req.query.roomCode || '').trim();
  if (!roomCode) {
    return res.status(400).json({ error: 'Codigo da sala é obrigatorio' });
  }

  try {
    const roomResult = await pool.query(
      `SELECT room_name, is_active
       FROM mtkin.rooms
       WHERE room_code = $1`,
      [roomCode]
    );

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: 'Sala nao encontrada' });
    }

    if (!roomResult.rows[0].is_active) {
      return res.status(400).json({ error: 'Sala nao esta ativa' });
    }

    const roomName = roomResult.rows[0].room_name;
    const usedResult = await pool.query(
      `SELECT DISTINCT personagem_caminho
       FROM mtkin.sala_online
       WHERE nome_sala = $1 AND personagem_caminho IS NOT NULL`,
      [roomName]
    );

    const characters = usedResult.rows
      .map((row) => row.personagem_caminho)
      .filter((value) => typeof value === 'string' && value.trim());

    res.json({ characters });
  } catch (error) {
    console.error('Erro ao buscar personagens usados:', error);
    res.status(500).json({ error: 'Erro ao buscar personagens usados' });
  }
});

app.get('/api/personagens', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nome, caminho_imagem
       FROM mtkin.personagens
       WHERE ativo = true
       ORDER BY nome ASC`
    );
    res.json({ personagens: result.rows });
  } catch (error) {
    console.error('Erro ao buscar personagens:', error);
    res.status(500).json({ error: 'Erro ao buscar personagens' });
  }
});

app.post('/api/personagens/upload', authenticateToken, uploadPersonagem.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Arquivo nao enviado' });
    }

    const displayName = String(req.body?.name || '').trim();
    const baseName = displayName || path.parse(req.file.filename).name;
    const gender = String(req.body?.gender || 'Masculino').trim();
    const type = String(req.body?.type || 'Padrão').trim();
    const relativePath = `Personagens/${gender}/${type}/${req.file.filename}`;

    const result = await pool.query(
      `INSERT INTO mtkin.personagens (nome, caminho_imagem)
       VALUES ($1, $2)
       ON CONFLICT (caminho_imagem) DO UPDATE
       SET nome = EXCLUDED.nome
       RETURNING id, nome, caminho_imagem`,
      [baseName, relativePath]
    );

    res.json({ personagem: result.rows[0] });
  } catch (error) {
    console.error('Erro ao salvar personagem:', error);
    res.status(500).json({ error: 'Erro ao salvar personagem' });
  }
});

app.post('/api/personagens/sync', authenticateToken, async (req, res) => {
  try {
    await syncPersonagensFromDisk();
    res.json({ message: 'Sincronizacao concluida' });
  } catch (error) {
    console.error('Erro ao sincronizar personagens:', error);
    res.status(500).json({ error: 'Erro ao sincronizar personagens' });
  }
});

app.get('/api/cards/door-random-image', authenticateToken, async (req, res) => {
  try {
    const images = await getDoorImages();
    if (!images.length) {
      return res.status(404).json({ error: 'Nenhuma imagem encontrada' });
    }
    const pick = images[Math.floor(Math.random() * images.length)];
    res.json({ imageUrl: pick });
  } catch (error) {
    console.error('Erro ao buscar imagem de porta:', error);
    res.status(500).json({ error: 'Erro ao buscar imagem de porta' });
  }
});

app.get('/api/cards/door-monstros-sequence', authenticateToken, async (req, res) => {
  try {
    const roomResult = await pool.query(
      `SELECT r.id
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true
       LIMIT 1`,
      [req.user.id]
    );

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: 'Você não está em nenhuma sala ativa' });
    }

    const roomId = roomResult.rows[0].id;
    const countResult = await pool.query(
      "SELECT COUNT(*)::int AS total FROM mtkin.cartas WHERE tipo_carta = 'Cidade'"
    );

    const total = countResult.rows[0]?.total ?? 0;
    if (!total) {
      return res.status(404).json({ error: 'Nenhuma carta Monstros encontrada' });
    }

    let currentIndex = doorMonstrosIndexByRoomId.get(roomId) ?? 0;
    if (currentIndex >= total) {
      currentIndex = 0;
    }

    // Verificar se sala está em modo simulador — usar carta fixa ID 22 para testes
    const isSimulador = await getSimFlag(roomId);
    const cardResult = isSimulador
      ? await pool.query(
          `SELECT id, nome_carta, caminho_imagem FROM mtkin.cartas WHERE id = 22 LIMIT 1`
        )
      : await pool.query(
          `SELECT id, nome_carta, caminho_imagem
           FROM mtkin.cartas
           WHERE tipo_carta = 'Cidade'
           ORDER BY NULLIF(regexp_replace(split_part(nome_carta, '-', 1), '[^0-9]', '', 'g'), '')::int ASC,
                    nome_carta ASC
           LIMIT 1 OFFSET $1`,
          [currentIndex]
        );

    if (cardResult.rows.length === 0) {
      return res.status(404).json({ error: 'Carta nao encontrada' });
    }

    const card = cardResult.rows[0];
    const imageUrl = card.caminho_imagem.startsWith('/')
      ? card.caminho_imagem
      : `/${card.caminho_imagem}`;

    doorMonstrosIndexByRoomId.set(roomId, (currentIndex + 1) % total);
    res.json({
      id: card.id,
      nome_carta: card.nome_carta,
      tipo_carta: 'Cidade',
      imageUrl
    });
  } catch (error) {
    console.error('Erro ao buscar carta Monstros em sequencia:', error);
    res.status(500).json({ error: 'Erro ao buscar carta Monstros' });
  }
});

app.get('/api/treasure/categories', authenticateToken, async (req, res) => {
  try {
    const categories = await getTreasureCategories();
    res.json({ categories });
  } catch (error) {
    console.error('Erro ao buscar categorias de item:', error);
    res.status(500).json({ error: 'Erro ao buscar categorias de item' });
  }
});

app.get('/api/categories', authenticateToken, async (req, res) => {
  try {
    const categories = await getTreasureCategories();
    res.json({ categories });
  } catch (error) {
    console.error('Erro ao buscar categorias:', error);
    res.status(500).json({ error: 'Erro ao buscar categorias' });
  }
});

app.get('/api/treasure/types', authenticateToken, async (req, res) => {
  try {
    res.json({ types: ['Item'] });
  } catch (error) {
    console.error('Erro ao buscar tipos de item:', error);
    res.status(500).json({ error: 'Erro ao buscar tipos de item' });
  }
});

app.get('/api/treasure/cards', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM mtkin.cartas WHERE tipo_carta = $1 ORDER BY id',
      ['Item']
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar cartas de item:', error);
    res.status(500).json({ error: 'Erro ao buscar cartas de item' });
  }
});

app.put('/api/treasure/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      nome_carta,
      tipo_carta,
      caminho_imagem,
      bonus,
      uso_unico,
      permite_equipar,
      permite_mochila,
      equipar_onde,
      para_quem,
      descartar_apos_uso,
      preco_venda,
      bonus_tesouro,
      mostrar_carta,
      mostrar_descarte,
      valor_dado,
      cancela_maldicao,
      transfere_luta,
      fuga_automatica,
      ganha_tesouro_monstro,
      nao_pode_usar,
      so_pode_usar,
      ocupa_espaco,
      item_grande,
      nivel,
      so_em_combate,
      so_para_sexo,
      bonus_fuga,
      protecao_maldicao,
      contra_qual,
      n_pode_equipar,
      forca,
      item,
      fulga_minima,
      categoria,
      qtd_max,
      valor,
      texto_da_carta,
      uso_em_combate,
      pesado
    } = req.body;

    const toBool = (value) => value === true || value === 'true' || value === 1 || value === '1';
    const toInt = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

    await ensureCategoryExists(categoria);

    const setClauses = [
      'nome_carta = $1',
      'tipo_carta = $2',
      'caminho_imagem = $3',
      'equipar_onde = $4',
      'n_pode_equipar = $5',
      'permite_mochila = $6',
      'forca = $7',
      'item = $8',
      'nivel = $9',
      'fulga_minima = $10',
      'categoria = $11',
      'qtd_max = $12',
      'valor = $13',
      'texto_da_carta = $14',
      'uso_em_combate = $15',
      'armadilha = $16',
      'pesado = $17'
    ];
    const params = [
      nome_carta,
      tipo_carta,
      caminho_imagem,
      equipar_onde || null,
      n_pode_equipar || null,
      toBool(permite_mochila),
      toInt(forca),
      toInt(item),
      toInt(nivel),
      toInt(fulga_minima),
      categoria || null,
      toInt(qtd_max) || 1,
      toInt(valor),
      texto_da_carta || null,
      toBool(uso_em_combate),
      req.body.armadilha || null,
      toBool(pesado)
    ];

    params.push(id);
    const result = await pool.query(
      `UPDATE mtkin.cartas
       SET ${setClauses.join(', ')}
       WHERE id = $${params.length}
       RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Carta nao encontrada' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao atualizar carta de item:', error);
    res.status(500).json({ error: 'Erro ao atualizar carta de item' });
  }
});

// 9. Entrar em uma sala
app.post('/api/rooms/join', [
  authenticateToken,
  body('roomCode').trim().isLength({ min: 6, max: 10 }).withMessage('Código de sala inválido'),
  body('characterPath').optional().isString().isLength({ min: 1, max: 255 }).withMessage('Personagem inválido')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { roomCode, characterPath } = req.body;
  const userId = req.user.id;
  const username = req.user.username;

  try {
    // Buscar sala
    const roomResult = await pool.query(
      `SELECT id, room_name, max_players, jog1, jog2, jog3, jog4, jog5, jog6, status, is_active
       FROM mtkin.rooms
       WHERE room_code = $1`,
      [roomCode]
    );

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: 'Sala não encontrada' });
    }

    const room = roomResult.rows[0];

    if (!room.is_active) {
      return res.status(400).json({ error: 'Sala não está mais ativa' });
    }

    if (characterPath) {
      const usedCharacterResult = await pool.query(
        `SELECT id_player
         FROM mtkin.sala_online
         WHERE nome_sala = $1 AND personagem_caminho = $2 AND id_player != $3
         LIMIT 1`,
        [room.room_name, characterPath, userId]
      );

      if (usedCharacterResult.rows.length > 0) {
        return res.status(400).json({ error: 'Personagem ja esta em uso nesta sala' });
      }
    }

    // Verificar se usuário já está em outra sala
    const existingRoom = await pool.query(
      `SELECT rp.room_id, r.is_active 
       FROM mtkin.room_participants rp
       JOIN mtkin.rooms r ON r.id = rp.room_id
       WHERE rp.user_id = $1 AND rp.room_id != $2 AND r.is_active = true`,
      [userId, room.id]
    );

    if (existingRoom.rows.length > 0) {
      return res.status(400).json({ error: 'Você já está em outra sala' });
    }

    // Verificar se usuário já está nesta sala (verificar em todas as colunas jogX)
    const players = [room.jog1, room.jog2, room.jog3, room.jog4, room.jog5, room.jog6];
    let existingSlot = null;
    
    for (let i = 0; i < players.length; i++) {
      if (players[i] === username || players[i] === `*${username}`) {
        existingSlot = i + 1;
        break;
      }
    }

    let playerSlot;

    if (existingSlot) {
      // Usuário já está na sala, apenas reativar/remover *
      playerSlot = existingSlot;
      
      // Verificar se já existe na tabela participants
      const wasInRoom = await pool.query(
        `SELECT player_slot FROM mtkin.room_participants
         WHERE user_id = $1 AND room_id = $2`,
        [userId, room.id]
      );

      if (wasInRoom.rows.length > 0) {
        // Atualizar participante existente
        await pool.query(
          `UPDATE mtkin.room_participants
           SET is_online = true, last_seen = CURRENT_TIMESTAMP
           WHERE user_id = $1 AND room_id = $2`,
          [userId, room.id]
        );
      } else {
        // Adicionar na tabela participants (caso não exista)
        await pool.query(
          `INSERT INTO mtkin.room_participants (room_id, user_id, username, player_slot, is_online)
           VALUES ($1, $2, $3, $4, true)`,
          [room.id, userId, username, playerSlot]
        );
      }

      // Remover * do nome na sala
      const jogCol = `jog${playerSlot}`;
      await pool.query(
        `UPDATE mtkin.rooms
         SET ${jogCol} = $1
         WHERE id = $2`,
        [username, room.id]
      );

    } else {
      // Novo jogador, encontrar slot vazio
      playerSlot = players.findIndex((p, i) => i < room.max_players && (p === null || p.startsWith('*'))) + 1;

      if (playerSlot === 0) {
        return res.status(400).json({ error: 'Sala está cheia' });
      }

      // Adicionar participante
      await pool.query(
        `INSERT INTO mtkin.room_participants (room_id, user_id, username, player_slot, is_online)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (room_id, user_id) DO UPDATE
         SET is_online = true, player_slot = $4, last_seen = CURRENT_TIMESTAMP`,
        [room.id, userId, username, playerSlot]
      );

      // Atualizar slot na sala
      const jogCol = `jog${playerSlot}`;
      await pool.query(
        `UPDATE mtkin.rooms
         SET ${jogCol} = $1
         WHERE id = $2`,
        [username, room.id]
      );
    }

    await pool.query(
      `INSERT INTO mtkin.sala_online (id_player, nome_jogador, nome_sala, mao, turno, nivel, tabuleiro, mochila, personagem_caminho)
       VALUES ($1, $2, $3, 0, 0, 1, 0, NULL, $4)
       ON CONFLICT (id_player) DO UPDATE
       SET nome_jogador = EXCLUDED.nome_jogador,
           nome_sala = EXCLUDED.nome_sala,
           personagem_caminho = EXCLUDED.personagem_caminho`,
      [userId, username, room.room_name, characterPath || null]
    );

    res.json({
      message: 'Entrou na sala com sucesso',
      roomId: room.id,
      playerSlot
    });

  } catch (error) {
    console.error('Erro ao entrar na sala:', error);
    res.status(500).json({ error: 'Erro ao entrar na sala' });
  }
});

// 10. Sair da sala
app.post('/api/rooms/leave', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const client = await pool.connect();

  try {
    // Buscar sala do usuário
    const roomResult = await client.query(
      `SELECT r.id, rp.player_slot
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true`,
      [userId]
    );

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: 'Você não está em nenhuma sala' });
    }

    const { id: roomId } = roomResult.rows[0];

    await client.query('BEGIN');

    // Limpar todos os dados da sala
    const tablesToClear = [
      ['mtkin.armadilha_pendente',   'id_sala'],
      ['mtkin.ajuda_combate',        'id_sala'],
      ['mtkin.combate_participacao', 'id_sala'],
      ['mtkin.combate_cartas',       'id_sala'],
      ['mtkin.combate',              'id_sala'],
      ['mtkin.estado_turno',         'id_sala'],
      ['mtkin.propostas_troca_itens','id_proposta', `id_proposta IN (SELECT id FROM mtkin.propostas_troca WHERE id_sala = $1)`],
      ['mtkin.propostas_troca',      'id_sala'],
      ['mtkin.deck_estado',          'id_sala'],
      ['mtkin.historico_cartas',     'id_sala'],
      ['mtkin.descarte',             'id_sala'],
      ['mtkin.mochila',              'id_sala'],
      ['mtkin.cartas_ativas',        'id_sala'],
      ['mtkin.cartas_no_jogo',       'id_sala'],
    ];
    for (const [table, col, customWhere] of tablesToClear) {
      if (customWhere) {
        await client.query(`DELETE FROM ${table} WHERE ${customWhere}`, [roomId]);
      } else {
        await client.query(`DELETE FROM ${table} WHERE ${col} = $1`, [roomId]);
      }
    }

    // Remover sala_online de todos os participantes desta sala
    await client.query(
      `DELETE FROM mtkin.sala_online
       WHERE id_player IN (
         SELECT user_id FROM mtkin.room_participants WHERE room_id = $1
       )`,
      [roomId]
    );

    // Remover todos os participantes
    await client.query('DELETE FROM mtkin.room_participants WHERE room_id = $1', [roomId]);

    // Desativar a sala
    await client.query('UPDATE mtkin.rooms SET is_active = false WHERE id = $1', [roomId]);

    // Limpar estado em memória
    doorMonstrosIndexByRoomId.delete(roomId);

    await client.query('COMMIT');
    res.json({ message: 'Sala encerrada com sucesso' });

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Erro ao sair da sala:', error);
    res.status(500).json({ error: 'Erro ao sair da sala' });
  } finally {
    client.release();
  }
});

// Toggle simulador da sala (apenas criador)
app.post('/api/rooms/simulador', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const client = await pool.connect();
  try {
    const roomResult = await client.query(
      'SELECT id, created_by, simulador FROM mtkin.rooms WHERE id IN (SELECT room_id FROM mtkin.room_participants WHERE user_id = $1) AND is_active = true LIMIT 1',
      [userId]
    );
    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: 'Sala não encontrada' });
    }
    const room = roomResult.rows[0];
    if (room.created_by !== userId) {
      return res.status(403).json({ error: 'Apenas o criador da sala pode controlar o simulador' });
    }
    const novoEstado = room.simulador === 'ativado' ? 'desativado' : 'ativado';

    await client.query('BEGIN');

    if (novoEstado === 'ativado') {
      // Salvar backup do estado atual de sala_online para todos os jogadores da sala
      await client.query(
        `UPDATE mtkin.sala_online so
         SET sim_mao_backup      = so.mao,
             sim_nivel_backup    = so.nivel,
             sim_tabuleiro_backup = so.tabuleiro
         WHERE id_player IN (SELECT user_id FROM mtkin.room_participants WHERE room_id = $1)
           AND sim_mao_backup IS NULL`,
        [room.id]
      );
      console.log(`[SIMULADOR] Ativado na sala ${room.id} — backup sala_online salvo`);
    } else {
      // Apagar todos os registros simulados desta sala (ordem importa por FK)
      const simTables = [
        'propostas_troca_itens',  // FK para propostas_troca
        'propostas_troca',
        'ajuda_combate',
        'combate_participacao',
        'combate_cartas',
        'historico_eventos',
        'historico_cartas',
        'mochila',
        'cartas_ativas',
        'cartas_no_jogo',
        'deck_estado',
        'estado_turno',
      ];
      // propostas_troca_itens não tem coluna simulado — apagar via FK de propostas_troca
      await client.query(
        `DELETE FROM mtkin.propostas_troca_itens
         WHERE id_proposta IN (
           SELECT id FROM mtkin.propostas_troca WHERE id_sala = $1 AND simulado = true
         )`,
        [room.id]
      );
      for (const t of simTables.slice(1)) {
        await client.query(`DELETE FROM mtkin.${t} WHERE id_sala = $1 AND simulado = true`, [room.id]);
      }
      // Restaurar sala_online do backup
      await client.query(
        `UPDATE mtkin.sala_online so
         SET mao                 = sim_mao_backup,
             nivel               = sim_nivel_backup,
             tabuleiro           = sim_tabuleiro_backup,
             sim_mao_backup      = NULL,
             sim_nivel_backup    = NULL,
             sim_tabuleiro_backup = NULL
         WHERE id_player IN (SELECT user_id FROM mtkin.room_participants WHERE room_id = $1)
           AND sim_mao_backup IS NOT NULL`,
        [room.id]
      );
      console.log(`[SIMULADOR] Desativado na sala ${room.id} — dados simulados removidos e sala_online restaurado`);
    }

    await client.query('UPDATE mtkin.rooms SET simulador = $1 WHERE id = $2', [novoEstado, room.id]);
    await client.query('COMMIT');
    res.json({ simulador: novoEstado });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Erro ao alternar simulador:', error);
    res.status(500).json({ error: 'Erro ao alternar simulador' });
  } finally {
    client.release();
  }
});

// 11. Iniciar jogo (apenas criador da sala)
app.post('/api/rooms/start-game', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    // Buscar sala do usuário
    const roomResult = await pool.query(
      `SELECT r.id, r.room_name, r.created_by, r.status
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true`,
      [userId]
    );

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: 'Você não está em nenhuma sala' });
    }

    const room = roomResult.rows[0];

    // Verificar se é o criador da sala
    if (room.created_by !== userId) {
      return res.status(403).json({ error: 'Apenas o criador da sala pode iniciar o jogo' });
    }

    // Verificar se já está em jogo
    if (room.status === 'playing') {
      return res.status(400).json({ error: 'O jogo já foi iniciado' });
    }

    // Buscar todos os jogadores da sala (id + username)
    const participantsResult = await pool.query(
      `SELECT rp.user_id AS id, u.username
       FROM mtkin.room_participants rp
       JOIN mtkin.users u ON u.id = rp.user_id
       WHERE rp.room_id = $1`,
      [room.id]
    );
    const participants = participantsResult.rows;

    // Atualizar mão de todos os jogadores em sala_online (8 cartas na mão)
    await pool.query(
      'UPDATE mtkin.sala_online SET mao = 8, nivel = 1 WHERE nome_sala = $1',
      [room.room_name]
    );

    // Limpar estado anterior da sala
    await pool.query('DELETE FROM mtkin.cartas_no_jogo WHERE id_sala = $1', [room.id]);
    await pool.query('DELETE FROM mtkin.cartas_ativas WHERE id_sala = $1', [room.id]);
    await pool.query('DELETE FROM mtkin.deck_estado WHERE id_sala = $1', [room.id]);

    // Distribuir 8 cartas por jogador respeitando qtd_max global
    // globalPickCount: Map<cardId, quantas vezes foi sorteada para esta sala>
    const globalPickCount = new Map();

    // Helper que busca uma carta respeitando globalPickCount e qtd_max
    async function pickCard(whereClause, params) {
      // Montar lista de IDs que atingiram qtd_max (comparando count com qtd_max da própria carta)
      // Fazemos via subquery no banco
      const excludeEntries = [...globalPickCount.entries()];
      // Subquery de exclusão: cartas onde count_sorteado >= qtd_max
      const excludeSql = excludeEntries.length > 0
        ? `AND id NOT IN (
              SELECT t.cid
              FROM (VALUES ${excludeEntries.map(([id, cnt]) => `(${id},${cnt})`).join(',')}) AS t(cid,cnt)
              JOIN mtkin.cartas c ON c.id = t.cid
              WHERE t.cnt >= c.qtd_max
           )`
        : '';
      const sql = `SELECT id, nome_carta, tipo_carta, caminho_imagem, qtd_max
                   FROM mtkin.cartas
                   WHERE ${whereClause} ${excludeSql}
                   ORDER BY RANDOM() LIMIT 1`;
      const result = await pool.query(sql, params);
      const card = result.rows[0] || null;
      if (card) {
        globalPickCount.set(card.id, (globalPickCount.get(card.id) || 0) + 1);
      }
      return card;
    }

    // Helper multi-pick respeitando qtd_max global
    async function pickMultiCards(whereClause, params, limit) {
      const cards = [];
      let attempts = 0;
      while (cards.length < limit && attempts < limit * 10) {
        attempts++;
        const card = await pickCard(whereClause, params);
        if (!card) break;
        cards.push(card);
      }
      return cards;
    }

    const insertValues = [];
    const insertParams = [];
    let paramIndex = 1;
    // Rastrear cartas obrigatórias para auto-posicionar na cartela após distribuição
    const autoSlotData = [];

    for (const player of participants) {
      const pickedCards = [];

      const catSobrevivente = await pickCard(`categoria = $1`, ['Sobrevivente']);
      if (!catSobrevivente) {
        return res.status(400).json({ error: 'Nenhuma carta disponível da categoria Sobrevivente.' });
      }
      pickedCards.push(catSobrevivente);
      autoSlotData.push({
        playerId: player.id, playerName: player.username,
        cardId: catSobrevivente.id, cardName: catSobrevivente.nome_carta,
        deckType: catSobrevivente.tipo_carta === 'Cidade' ? 'cidade' : 'item', slot: '79',
        caminhoImagem: catSobrevivente.caminho_imagem
      });

      const catChacaras = await pickCard(`categoria = $1`, ['Chacaras']);
      if (!catChacaras) {
        return res.status(400).json({ error: 'Nenhuma carta disponível da categoria Chacaras.' });
      }
      pickedCards.push(catChacaras);
      autoSlotData.push({
        playerId: player.id, playerName: player.username,
        cardId: catChacaras.id, cardName: catChacaras.nome_carta,
        deckType: catChacaras.tipo_carta === 'Cidade' ? 'cidade' : 'item', slot: '80'
      });

      let itemCount = pickedCards.filter(c => c.tipo_carta === 'Item').length;
      let cidadeCount = pickedCards.filter(c => c.tipo_carta === 'Cidade').length;

      const needItems = Math.max(0, 4 - itemCount);
      const needCidades = Math.max(0, 4 - cidadeCount);

      if (needItems > 0) {
        const extraItems = await pickMultiCards(
          `tipo_carta = 'Item' AND (categoria IS NULL OR categoria NOT IN ('Sobrevivente','Chacaras'))`,
          [],
          needItems
        );
        if (extraItems.length < needItems) {
          return res.status(400).json({ error: 'Cartas insuficientes do tipo Item (categoria diferente de Sobrevivente/Chacaras).' });
        }
        extraItems.forEach(c => pickedCards.push(c));
      }

      if (needCidades > 0) {
        const extraCidades = await pickMultiCards(
          `tipo_carta = 'Cidade' AND (categoria IS NULL OR categoria NOT IN ('Sobrevivente','Chacaras'))`,
          [],
          needCidades
        );
        if (extraCidades.length < needCidades) {
          return res.status(400).json({ error: 'Cartas insuficientes do tipo Cidade (categoria diferente de Sobrevivente/Chacaras).' });
        }
        extraCidades.forEach(c => pickedCards.push(c));
      }

      if (pickedCards.length !== 8) {
        return res.status(400).json({ error: 'Distribuição inicial inconsistente (não chegou a 8 cartas).' });
      }

      pickedCards.forEach((card) => {
        const deckType = card.tipo_carta === 'Cidade' ? 'cidade' : 'item';
        insertValues.push(`($${paramIndex},$${paramIndex+1},$${paramIndex+2},$${paramIndex+3},$${paramIndex+4},$${paramIndex+5},$${paramIndex+6})`);
        insertParams.push(room.id, room.room_name, player.id, player.username, card.id, card.nome_carta, deckType);
        paramIndex += 7;
      });
    }

    if (insertValues.length > 0) {
      await pool.query(
        `INSERT INTO mtkin.cartas_no_jogo (id_sala, nome_sala, id_jogador, nome_jogador, id_carta, nome_carta, tipo_baralho)
         VALUES ${insertValues.join(', ')}`,
        insertParams
      );

      // Registrar cartas distribuídas no deck_estado (localizacao = 'mao')
      // insertParams layout: (sala, nome_sala, jogador, nome_jog, carta, nome_carta, baralho) × N
      const deckEstadoValues = [];
      const deckEstadoParams = [];
      let di = 1;
      for (let i = 0; i < insertParams.length; i += 7) {
        const salaId   = insertParams[i];
        const jogId    = insertParams[i + 2];
        const cartaId  = insertParams[i + 4];
        const baralho  = insertParams[i + 6];
        deckEstadoValues.push(`($${di},$${di+1},$${di+2},'mao',$${di+3})`);
        deckEstadoParams.push(salaId, cartaId, baralho, jogId);
        di += 4;
      }
      await pool.query(
        `INSERT INTO mtkin.deck_estado (id_sala, id_carta, tipo_baralho, localizacao, id_jogador)
         VALUES ${deckEstadoValues.join(', ')}
         ON CONFLICT (id_sala, id_carta, tipo_baralho) DO NOTHING`,
        deckEstadoParams
      );
    }

    // Auto-posicionar cartas obrigatórias: Sobrevivente → slot 79, Chacaras → slot 80
    for (const entry of autoSlotData) {
      await pool.query(
        `INSERT INTO mtkin.cartas_ativas
           (id_sala, nome_sala, id_jogador, nome_jogador, id_carta, nome_carta, id_slot, simulado)
         VALUES ($1, $2, $3, $4, $5, $6, $7, false)
         ON CONFLICT (id_sala, id_jogador, id_slot)
         DO UPDATE SET id_carta     = EXCLUDED.id_carta,
                       nome_carta   = EXCLUDED.nome_carta,
                       nome_sala    = EXCLUDED.nome_sala,
                       nome_jogador = EXCLUDED.nome_jogador`,
        [room.id, room.room_name, entry.playerId, entry.playerName, entry.cardId, entry.cardName, entry.slot]
      );
      // Remover apenas uma instância da mão (preserva duplicatas)
      await pool.query(
        `DELETE FROM mtkin.cartas_no_jogo WHERE ctid = (
           SELECT ctid FROM mtkin.cartas_no_jogo
           WHERE id_sala = $1 AND id_jogador = $2 AND id_carta = $3
           LIMIT 1
         )`,
        [room.id, entry.playerId, entry.cardId]
      );
      await upsertDeckEstado(room.id, entry.cardId, entry.deckType, 'cartela', entry.playerId, null, false);
    }
    // Atualizar personagem_caminho para cartas Sobrevivente auto-equipadas no slot 79
    for (const entry of autoSlotData) {
      if (entry.slot === '79' && entry.caminhoImagem) {
        const charPath = deriveCharacterPath(entry.caminhoImagem);
        if (charPath) {
          await pool.query(
            `UPDATE mtkin.sala_online SET personagem_caminho = $1 WHERE id_player = $2 AND nome_sala = $3`,
            [charPath, entry.playerId, room.room_name]
          );
        }
      }
    }
    // Recalcular tabuleiro de cada jogador após equipar slots iniciais
    for (const player of participants) {
      await recalcularTabuleiroJogador(player.id, room.id);
    }
    // Cartas na mão: 8 distribuídas - 2 auto-equipadas na cartela = 6 na mão
    await pool.query('UPDATE mtkin.sala_online SET mao = 6 WHERE nome_sala = $1', [room.room_name]);

    // Sortear ordem dos turnos (Fisher-Yates shuffle)
    const ordemIds = participants.map(p => p.id);
    for (let i = ordemIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ordemIds[i], ordemIds[j]] = [ordemIds[j], ordemIds[i]];
    }

    // Atualizar status + ordem num único UPDATE (evita race condition nos clientes):
    // quando status='playing' aparecer para os outros, ordem e turno_numero já estão prontos
    await pool.query(
      `UPDATE mtkin.rooms SET status='playing', ordem_turno=$1, turno_atual_index=0, turno_numero=0, prontos_organizacao='{}' WHERE id=$2`,
      [ordemIds, room.id]
    );

    // Montar descrição da ordem para o histórico
    const ordemNomes = ordemIds.map(uid => {
      const p = participants.find(x => x.id === uid);
      return p ? p.username : uid;
    });

    // Registrar evento: jogo iniciado
    await pool.query(
      `INSERT INTO mtkin.historico_eventos (id_sala, id_jogador, tipo, descricao, dados, simulado)
       VALUES ($1,$2,'jogo_iniciado','O jogo foi iniciado por ' || $3,$4,$5)`,
      [room.id, userId, req.user.username, JSON.stringify({ iniciado_por: req.user.username }), false]
    );

    // Registrar evento: sorteio de ordem (historico_eventos)
    await pool.query(
      `INSERT INTO mtkin.historico_eventos (id_sala, id_jogador, tipo, descricao, dados, simulado)
       VALUES ($1,$2,'sorteio_ordem',$3,$4,$5)`,
      [
        room.id, userId,
        `Ordem sorteada: ${ordemNomes.join(' → ')}. Começa: ${ordemNomes[0]}`,
        JSON.stringify({ ordem: ordemNomes, ids: ordemIds, primeiro: ordemNomes[0] }),
        false
      ]
    );

    // Registrar sorteio na historico_cartas (aparece no modal histórico)
    await pool.query(
      `INSERT INTO mtkin.historico_cartas
         (id_sala, nome_sala, id_jogador, nome_jogador, local, acao, tipo_evento, turno_numero, descricao, simulado)
       VALUES ($1,$2,$3,$4,'sala','sorteio_ordem','sorteio_ordem',0,$5,$6)`,
      [
        room.id, room.room_name, userId, req.user.username,
        `Ordem: ${ordemNomes.join(' → ')} — Começa: ${ordemNomes[0]}`,
        false
      ]
    );

    res.json({
      message: 'Jogo iniciado com sucesso',
      roomId: room.id,
      players: participants.length,
      mao: 6,
      nivel: 1,
      ordemTurno: ordemNomes,
      primeiroJogador: ordemNomes[0]
    });

  } catch (error) {
    console.error('Erro ao iniciar jogo:', error);
    res.status(500).json({ error: 'Erro ao iniciar jogo' });
  }
});

// 11.1 Reset geral do jogo (admin): limpa salas, estados e cartas distribuídas
app.post('/api/admin/reset-game', authenticateToken, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tablesToClear = [
      'mtkin.armadilha_pendente',
      'mtkin.combate_participacao',
      'mtkin.combate_cartas',
      'mtkin.combate',
      'mtkin.estado_turno',
      'mtkin.propostas_troca_itens',
      'mtkin.propostas_troca',
      'mtkin.deck_estado',
      'mtkin.historico_cartas',
      'mtkin.mochila',
      'mtkin.cartas_ativas',
      'mtkin.cartas_no_jogo',
      'mtkin.sala_online',
      'mtkin.room_participants',
      'mtkin.rooms'
    ];

    for (const table of tablesToClear) {
      await client.query(`DELETE FROM ${table}`);
    }

    // Resetar índice de monstros por sala (estado em memória)
    doorMonstrosIndexByRoomId.clear();

    await client.query('COMMIT');
    res.json({ message: 'Jogo resetado com sucesso' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao resetar jogo:', error);
    res.status(500).json({ error: 'Erro ao resetar jogo' });
  } finally {
    client.release();
  }
});

// GET /api/rooms/turn-state - Estado atual do turno
app.get('/api/rooms/turn-state', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const roomResult = await pool.query(
      `SELECT r.id, r.room_name, r.ordem_turno, r.turno_atual_index, r.turno_numero,
              r.prontos_organizacao, r.status, r.vencedor_id,
              (SELECT COUNT(*) FROM mtkin.room_participants rp2 WHERE rp2.room_id = r.id) AS total_jogadores
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id=$1 AND r.is_active=true AND r.status IN ('playing','finished')`,
      [userId]
    );
    if (roomResult.rows.length === 0) return res.status(404).json({ error: 'Sala não encontrada' });

    const room = roomResult.rows[0];

    // Jogo finalizado — retornar dados do vencedor para todos os jogadores via polling
    if (room.status === 'finished' && room.vencedor_id) {
      const winnerRow = await pool.query(
        `SELECT id_player, nome_jogador, personagem_caminho, nivel FROM mtkin.sala_online WHERE id_player = $1`,
        [room.vencedor_id]
      );
      const w = winnerRow.rows[0];
      return res.json({
        idSala: room.id,
        fase: 'finalizado',
        vencedor: w ? { id: w.id_player, nome: w.nome_jogador, personagem_caminho: w.personagem_caminho, nivel: w.nivel } : null
      });
    }

    const ordem = room.ordem_turno || [];
    const prontos = room.prontos_organizacao || [];
    const totalJogadores = parseInt(room.total_jogadores) || ordem.length;

    // Buscar nomes de todos na ordem
    let ordemNomes = [];
    if (ordem.length > 0) {
      const usersResult = await pool.query(
        `SELECT id, username FROM mtkin.users WHERE id = ANY($1::int[])`,
        [ordem]
      );
      const userMap = {};
      usersResult.rows.forEach(u => { userMap[u.id] = u.username; });
      ordemNomes = ordem.map(id => ({ id, nome: userMap[id] || id }));
    }

    // Turno 0 = fase de organização
    if (room.turno_numero === 0) {
      return res.json({
        idSala: room.id,
        fase: 'organizacao',
        turnoNumero: 0,
        ehMeuTurno: false,
        jogadorAtualId: null,
        ordemTurno: ordemNomes,
        indexAtual: 0,
        prontos: prontos.length,
        total: totalJogadores,
        jogadorPronto: prontos.includes(userId)
      });
    }

    const idx = room.turno_atual_index || 0;
    const jogadorAtualId = ordem[idx] || null;

    // Buscar estado de combate do jogador ativo (para mostrar zonas a todos)
    let combateAtivo = false;
    let cartaMonstroAtivo = null;
    let duoModo = false;
    let duoHelperId = null;
    let duoProntos = [];
    if (jogadorAtualId) {
      try {
        const estadoResult = await pool.query(
          `SELECT fase_porta, carta_monstro, duo_modo, duo_helper_id, duo_prontos FROM mtkin.estado_turno
           WHERE id_sala=$1 AND id_jogador=$2 AND turno_numero=$3`,
          [room.id, jogadorAtualId, room.turno_numero]
        );
        if (estadoResult.rows.length > 0 && estadoResult.rows[0].fase_porta === 'monster') {
          combateAtivo = true;
          cartaMonstroAtivo = estadoResult.rows[0].carta_monstro;
          duoModo     = !!estadoResult.rows[0].duo_modo;
          duoHelperId = estadoResult.rows[0].duo_helper_id || null;
          duoProntos  = estadoResult.rows[0].duo_prontos || [];
          // Enriquecer com campos da tabela cartas se não presentes
          if (cartaMonstroAtivo && cartaMonstroAtivo.id) {
            try {
              const enrichResult = await pool.query(
                'SELECT texto_da_carta, equipar_onde, forca, nivel, fulga_minima, pesado, valor, categoria FROM mtkin.cartas WHERE id = $1',
                [cartaMonstroAtivo.id]
              );
              if (enrichResult.rows.length > 0) {
                const r = enrichResult.rows[0];
                cartaMonstroAtivo = {
                  ...cartaMonstroAtivo,
                  texto_da_carta: cartaMonstroAtivo.texto_da_carta || r.texto_da_carta,
                  equipar_onde: cartaMonstroAtivo.equipar_onde ?? r.equipar_onde,
                  forca: cartaMonstroAtivo.forca ?? r.forca,
                  nivel: cartaMonstroAtivo.nivel ?? r.nivel,
                  fulga_minima: cartaMonstroAtivo.fulga_minima ?? r.fulga_minima,
                  pesado: cartaMonstroAtivo.pesado ?? r.pesado,
                  valor: cartaMonstroAtivo.valor ?? r.valor,
                  categoria: cartaMonstroAtivo.categoria || r.categoria
                };
              }
            } catch(_) {}
          }
        }
      } catch(_) {}
    }

    // Dados de participação no combate
    let combatePart = combateParticipacaoByRoomId.get(room.id);

    // Se combate ativo mas store vazio (servidor reiniciou), tentar restaurar do banco
    if (combateAtivo && !combatePart) {
      try {
        const dbPart = await pool.query(
          `SELECT id_jogador, id_jogador_luta, id_combate, status
           FROM mtkin.combate_participacao
           WHERE id_sala = $1`,
          [room.id]
        );
        if (dbPart.rows.length > 0) {
          const participants = {};
          let fightingPlayerId = dbPart.rows[0].id_jogador_luta;
          let combatId = dbPart.rows[0].id_combate;
          dbPart.rows.forEach(r => { participants[r.id_jogador] = r.status; });
          combatePart = { combatId, fightingPlayerId, participants };
          combateParticipacaoByRoomId.set(room.id, combatePart);
          console.log(`[turn-state] Participação restaurada do banco: ${dbPart.rows.length} jogadores`);
        }
      } catch(_) {}
    }

    // Se ainda vazio (dados não no banco), recriar com 'esperando'
    if (combateAtivo && !combatePart && ordem.length > 1) {
      const otherPlayers = ordem.filter(id => id !== jogadorAtualId);
      const participants = {};
      otherPlayers.forEach(id => { participants[id] = 'esperando'; });
      combatePart = { combatId: null, fightingPlayerId: jogadorAtualId, participants };
      combateParticipacaoByRoomId.set(room.id, combatePart);
      console.log(`[turn-state] Recriando participação em memória após reinício: ${otherPlayers.length} jogadores`);
    }

    let combateParticipacao = null;
    if (combatePart) {
      const parts = combatePart.participants;
      // Detectar helper a partir dos participants (status='participando' e não é o lutador)
      // duoHelperId pode estar null se estado_turno.duo_helper_id não foi set — derivar dos parts
      const helperEntry = Object.entries(parts)
        .find(([id, s]) => s === 'participando' && Number(id) !== combatePart.fightingPlayerId);
      const helperIdCalc = duoHelperId || (helperEntry ? Number(helperEntry[0]) : null);
      // Em modo duo, o helper fica com 'participando' — excluir do cálculo de allReady
      const decisionParts = helperIdCalc
        ? Object.entries(parts).filter(([id]) => Number(id) !== helperIdCalc)
        : Object.entries(parts);
      const allReady = decisionParts.length === 0 ||
        decisionParts.every(([, s]) => s === 'pronto' || s === 'recusou');
      const myStatus = parts.hasOwnProperty(userId) ? parts[userId] : null;
      const pendingCount = decisionParts.filter(([, s]) => s === 'esperando').length;
      combateParticipacao = {
        combatId: combatePart.combatId,
        fightingPlayerId: combatePart.fightingPlayerId,
        allReady,
        myStatus,
        pendingCount,
        iAmFighting: combatePart.fightingPlayerId === userId
      };
    }

    // Buscar cartas do combate ativo e força base do monstro
    let combateCartas = [];
    let forcaMonstroBase = 0;
    if (combateAtivo) {
      // Cartas jogadas nas zonas de combate (por sala, pois id_combate pode ser null após reinício)
      try {
        const cartasResult = await pool.query(
          `SELECT cc.id, cc.id_carta, cc.id_combate, cc.nome_carta, cc.caminho_imagem,
                  COALESCE(cc.bonus, 0) AS bonus, cc.lado, cc.id_jogador, cc.nome_jogador,
                  c.texto_da_carta, c.equipar_onde
           FROM mtkin.combate_cartas cc
           LEFT JOIN mtkin.cartas c ON c.id = cc.id_carta
           WHERE cc.id_sala = $1
           ORDER BY cc.id`,
          [room.id]
        );
        combateCartas = cartasResult.rows;
        // Se store não tem combatId mas DB tem, restaurar
        if (combatePart && !combatePart.combatId && combateCartas.length > 0) {
          combatePart.combatId = combateCartas[0].id_combate;
          if (combateParticipacao) combateParticipacao.combatId = combateCartas[0].id_combate;
        }
      } catch(_) {}

      // Força base do monstro — tentar campo direto, senão buscar na tabela
      forcaMonstroBase = cartaMonstroAtivo?.forca || 0;
      if (!forcaMonstroBase && cartaMonstroAtivo?.id) {
        try {
          const monstroResult = await pool.query(
            'SELECT forca FROM mtkin.cartas WHERE id = $1',
            [cartaMonstroAtivo.id]
          );
          if (monstroResult.rows.length > 0) {
            forcaMonstroBase = monstroResult.rows[0].forca || 0;
          }
        } catch(_) {}
      }
    }

    // Força base do jogador que está lutando (apenas o lutador — duo é gerenciado por pollCombateEstado)
    let forcaJogadorBase = 0;
    if (combateAtivo && jogadorAtualId) {
      try {
        // Força do lutador principal (nivel + tabuleiro)
        const jogResult = await pool.query(
          'SELECT forca FROM mtkin.sala_online WHERE id_player = $1',
          [jogadorAtualId]
        );
        if (jogResult.rows.length > 0) {
          forcaJogadorBase = Number(jogResult.rows[0].forca) || 0;
        }
      } catch(_) {}
    }

    // Ler dados do combate ativo direto de mtkin.combate (fonte de verdade para força do monstro)
    let combateForca = null;
    if (combateAtivo) {
      try {
        const combateRow = await pool.query(
          `SELECT id_combate, id_jogador, forca_jogador, forca_monstro, id_carta_monstro, status
           FROM mtkin.combate
           WHERE id_sala = $1
             AND status NOT IN ('vitoria','derrota','fuga','finalizado')
           ORDER BY criado_em DESC LIMIT 1`,
          [room.id]
        );
        if (combateRow.rows.length > 0) {
          combateForca = combateRow.rows[0];
          // Apenas força do monstro vem da tabela combate; força do jogador
          // já foi calculada acima somando lutador + helpers de sala_online
          forcaMonstroBase = Number(combateForca.forca_monstro) || forcaMonstroBase;
        }
      } catch(_) {}
    }

    res.json({
      idSala: room.id,
      fase: 'jogo',
      turnoNumero: room.turno_numero,
      jogadorAtualId,
      ehMeuTurno: jogadorAtualId === userId,
      ordemTurno: ordemNomes,
      indexAtual: idx,
      combateAtivo,
      cartaMonstroAtivo,
      combateParticipacao,
      combateCartas,
      forcaMonstroBase,
      forcaJogadorBase,
      combateForca,
      duoModo,
      duoHelperId,
      // duoProntos = [prontoLutador, prontoHelper] (booleans)
      duoProntoLutador: Array.isArray(duoProntos) ? !!duoProntos[0] : false,
      duoProntoHelper:  Array.isArray(duoProntos) ? !!duoProntos[1] : false
    });
  } catch (error) {
    console.error('Erro ao buscar estado do turno:', error);
    res.status(500).json({ error: 'Erro ao buscar estado do turno' });
  }
});

// POST /api/rooms/ready - Jogador avisa que está pronto na fase de organização
app.post('/api/rooms/ready', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const roomResult = await pool.query(
      `SELECT r.id, r.ordem_turno, r.prontos_organizacao, r.turno_numero, r.simulador,
              (SELECT COUNT(*) FROM mtkin.room_participants rp2 WHERE rp2.room_id = r.id) AS total_jogadores
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id=$1 AND r.is_active=true AND r.status='playing'`,
      [userId]
    );
    if (roomResult.rows.length === 0) return res.status(404).json({ error: 'Sala não encontrada' });

    const room = roomResult.rows[0];
    if (room.turno_numero !== 0) {
      return res.status(400).json({ error: 'Fase de organização já encerrada' });
    }

    const prontos = room.prontos_organizacao || [];
    const totalJogadores = parseInt(room.total_jogadores) || (room.ordem_turno || []).length;

    // Adicionar jogador à lista de prontos (evitar duplicatas)
    if (!prontos.includes(userId)) {
      await pool.query(
        `UPDATE mtkin.rooms SET prontos_organizacao = array_append(prontos_organizacao, $1) WHERE id=$2`,
        [userId, room.id]
      );
      prontos.push(userId);
    }

    // Verificar se todos estão prontos
    const ordem = room.ordem_turno || [];
    const todosProtos = ordem.length > 0 && ordem.every(id => prontos.includes(id));

    if (todosProtos) {
      // Avançar para o turno 1
      await pool.query(
        `UPDATE mtkin.rooms SET turno_numero=1 WHERE id=$1`,
        [room.id]
      );
      const simFlagReady = room.simulador === 'ativado';
      await pool.query(
        `INSERT INTO mtkin.historico_eventos (id_sala, id_jogador, tipo, descricao, dados, simulado)
         VALUES ($1,$2,'fase_organizacao_concluida','Todos prontos! Iniciando turno 1.','{}'::jsonb,$3)`,
        [room.id, userId, simFlagReady]
      );
    }

    res.json({
      success: true,
      prontos: prontos.length,
      total: totalJogadores,
      allReady: todosProtos
    });
  } catch (error) {
    console.error('Erro ao marcar jogador como pronto:', error);
    res.status(500).json({ error: 'Erro ao marcar pronto' });
  }
});

// POST /api/rooms/end-turn - Finalizar turno e passar para o próximo
app.post('/api/rooms/end-turn', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const roomResult = await pool.query(
      `SELECT r.id, r.room_name, r.ordem_turno, r.turno_atual_index, r.turno_numero, r.simulador
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id=$1 AND r.is_active=true AND r.status='playing'`,
      [userId]
    );
    if (roomResult.rows.length === 0) return res.status(404).json({ error: 'Sala não encontrada' });

    const room = roomResult.rows[0];
    const simFlagEndTurn = room.simulador === 'ativado';
    const ordem = room.ordem_turno || [];
    const idx   = room.turno_atual_index || 0;

    if (room.turno_numero === 0) {
      return res.status(400).json({ error: 'Use /api/rooms/ready na fase de organização' });
    }

    if (ordem[idx] !== userId) {
      return res.status(403).json({ error: 'Não é o seu turno' });
    }

    // Verificar limite de 5 cartas na mão (todas: porta + tesouro)
    // Duplicatas são válidas e contam normalmente para o limite
    const handCheck = await pool.query(
      `SELECT COUNT(*) AS total
       FROM mtkin.cartas_no_jogo
       WHERE id_sala=$1 AND id_jogador=$2`,
      [room.id, userId]
    );
    const handTotal = parseInt(handCheck.rows[0].total, 10);
    if (handTotal > 5) {
      return res.status(400).json({ error: `Você tem ${handTotal} cartas na mão. Descarte ou passe o excesso antes de finalizar o turno.` });
    }

    const proximoIdx  = (idx + 1) % ordem.length;
    const novoNumero  = room.turno_numero + 1;
    const proximoId   = ordem[proximoIdx];

    await pool.query(
      `UPDATE mtkin.rooms SET turno_atual_index=$1, turno_numero=$2 WHERE id=$3`,
      [proximoIdx, novoNumero, room.id]
    );

    // Buscar nomes do atual e próximo
    const usersResult = await pool.query(
      `SELECT id, username FROM mtkin.users WHERE id = ANY($1::int[])`,
      [[userId, proximoId]]
    );
    const userMap = {};
    usersResult.rows.forEach(u => { userMap[u.id] = u.username; });

    // Registrar evento no histórico de eventos
    await pool.query(
      `INSERT INTO mtkin.historico_eventos (id_sala, id_jogador, tipo, descricao, dados, simulado)
       VALUES ($1,$2,'fim_turno',$3,$4,$5)`,
      [
        room.id, userId,
        `${userMap[userId]} finalizou o turno ${room.turno_numero}. Vez de ${userMap[proximoId]}`,
        JSON.stringify({ turno: room.turno_numero, de: userMap[userId], para: userMap[proximoId] }),
        simFlagEndTurn
      ]
    );

    // Registrar fim de turno em historico_cartas (modal histórico)
    const roomNameResult = await pool.query(`SELECT room_name FROM mtkin.rooms WHERE id=$1`, [room.id]);
    const rName = roomNameResult.rows[0]?.room_name || '';
    await pool.query(
      `INSERT INTO mtkin.historico_cartas
         (id_sala, nome_sala, id_jogador, nome_jogador, local, acao, tipo_evento, turno_numero, descricao, simulado)
       VALUES ($1,$2,$3,$4,'sala','fim_turno','fim_turno',$5,$6,$7)`,
      [
        room.id, rName, userId, userMap[userId],
        room.turno_numero,
        `${userMap[userId]} finalizou o turno ${room.turno_numero}. Próximo: ${userMap[proximoId]}`,
        simFlagEndTurn
      ]
    );

    res.json({
      success: true,
      turnoNumero: novoNumero,
      jogadorAtualId: proximoId,
      jogadorAtualNome: userMap[proximoId]
    });
  } catch (error) {
    console.error('Erro ao finalizar turno:', error);
    res.status(500).json({ error: 'Erro ao finalizar turno' });
  }
});

// GET /api/rooms/estado-turno - Buscar estado persistido do jogador neste turno
app.get('/api/rooms/estado-turno', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Buscar sala e turno atual do jogador
    const roomResult = await pool.query(
      `SELECT r.id, r.turno_numero
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id=$1 AND r.is_active=true AND r.status='playing'`,
      [userId]
    );
    if (roomResult.rows.length === 0) {
      return res.json({ fase_porta: 'idle' });
    }
    const { id: salaId, turno_numero } = roomResult.rows[0];

    const estadoResult = await pool.query(
      `SELECT fase_porta, carta_monstro, mensagem, turno_numero AS turno_salvo
       FROM mtkin.estado_turno
       WHERE id_sala=$1 AND id_jogador=$2`,
      [salaId, userId]
    );

    if (estadoResult.rows.length === 0) {
      return res.json({ fase_porta: 'idle' });
    }

    const estado = estadoResult.rows[0];

    // Se o turno salvo é de um turno anterior, ignorar (novo turno = estado limpo)
    if (estado.turno_salvo !== turno_numero) {
      return res.json({ fase_porta: 'idle' });
    }

    // Enriquecer carta_monstro com texto_da_carta se não presente
    let cartaMonstro = estado.carta_monstro;
    if (cartaMonstro && cartaMonstro.id && !cartaMonstro.texto_da_carta) {
      cartaMonstro = await enriquecerCartaMonstro(cartaMonstro);
    }

    res.json({
      fase_porta:    estado.fase_porta,
      carta_monstro: cartaMonstro,
      mensagem:      estado.mensagem
    });
  } catch (error) {
    console.error('Erro ao buscar estado do turno:', error);
    res.status(500).json({ error: 'Erro ao buscar estado do turno' });
  }
});

// Enriquecer carta_monstro com texto_da_carta se necessario (usado acima e abaixo)
async function enriquecerCartaMonstro(carta) {
  if (!carta || !carta.id) return carta;
  try {
    const r = await pool.query('SELECT texto_da_carta, equipar_onde, forca, nivel, fulga_minima, pesado, valor, categoria FROM mtkin.cartas WHERE id = $1', [carta.id]);
    if (r.rows.length > 0) {
      const row = r.rows[0];
      return {
        ...carta,
        texto_da_carta: carta.texto_da_carta || row.texto_da_carta,
        equipar_onde: carta.equipar_onde ?? row.equipar_onde,
        forca: carta.forca ?? row.forca,
        nivel: carta.nivel ?? row.nivel,
        fulga_minima: carta.fulga_minima ?? row.fulga_minima,
        pesado: carta.pesado ?? row.pesado,
        valor: carta.valor ?? row.valor,
        categoria: carta.categoria || row.categoria
      };
    }
  } catch(_) {}
  return carta;
}

// POST /api/rooms/estado-turno - Salvar/atualizar estado do jogador neste turno
app.post('/api/rooms/estado-turno', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { fase_porta, carta_monstro, mensagem } = req.body;

    if (!fase_porta) return res.status(400).json({ error: 'fase_porta obrigatório' });

    // Buscar sala e turno atual
    const roomResult = await pool.query(
      `SELECT r.id, r.turno_numero, r.simulador
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id=$1 AND r.is_active=true AND r.status='playing'`,
      [userId]
    );
    if (roomResult.rows.length === 0) return res.status(404).json({ error: 'Sala não encontrada' });

    const { id: salaId, turno_numero, simulador: simEstado } = roomResult.rows[0];
    const simFlagEstado = simEstado === 'ativado';

    await pool.query(
      `INSERT INTO mtkin.estado_turno (id_sala, id_jogador, turno_numero, fase_porta, carta_monstro, mensagem, atualizado_em, simulado)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)
       ON CONFLICT (id_sala, id_jogador) DO UPDATE
         SET turno_numero  = EXCLUDED.turno_numero,
             fase_porta    = EXCLUDED.fase_porta,
             carta_monstro = EXCLUDED.carta_monstro,
             mensagem      = EXCLUDED.mensagem,
             atualizado_em = NOW(),
             simulado      = EXCLUDED.simulado`,
      [salaId, userId, turno_numero, fase_porta,
       carta_monstro ? JSON.stringify(carta_monstro) : null,
       mensagem || null, simFlagEstado]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao salvar estado do turno:', error);
    res.status(500).json({ error: 'Erro ao salvar estado do turno' });
  }
});

// GET /api/historico/eventos/:salaId - Buscar eventos de jogo da sala
app.get('/api/historico/eventos/:salaId', authenticateToken, async (req, res) => {
  try {
    const salaId = parseInt(req.params.salaId);
    const result = await pool.query(
      `SELECT he.id, he.tipo, he.descricao, he.dados, he.criado_em,
              u.username AS nome_jogador
       FROM mtkin.historico_eventos he
       LEFT JOIN mtkin.users u ON u.id = he.id_jogador
       WHERE he.id_sala=$1
       ORDER BY he.criado_em DESC
       LIMIT 100`,
      [salaId]
    );
    res.json({ eventos: result.rows });
  } catch (error) {
    console.error('Erro ao buscar eventos:', error);
    res.status(500).json({ error: 'Erro ao buscar eventos' });
  }
});

// 12. Mensagem inicial do tabuleiro
app.get('/api/messages/first', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, mensagem, acao FROM mtkin.card_mensagens WHERE id = 1'
    );
    const message = result.rows[0] || null;
    res.json({ message });
  } catch (error) {
    console.error('Erro ao buscar mensagem inicial:', error);
    res.status(500).json({ error: 'Erro ao buscar mensagem inicial' });
  }
});

// ========== ROTAS DE CARTAS ==========

// POST /api/rooms/trade-for-level — Trocar cartas com valor >= 1000 por +1 nível
app.post('/api/rooms/trade-for-level', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { cards: tradedCards } = req.body; // array de { cardId, source, sourceSlot?, mochilaId? }

  if (!Array.isArray(tradedCards) || tradedCards.length === 0) {
    return res.status(400).json({ error: 'Nenhuma carta enviada para troca' });
  }

  try {
    const roomResult = await pool.query(
      `SELECT r.id FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true`,
      [userId]
    );
    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: 'Você não está em nenhuma sala' });
    }
    const roomId = roomResult.rows[0].id;

    // Buscar nível atual
    const nivelResult = await pool.query(
      `SELECT nivel FROM mtkin.sala_online WHERE id_player = $1`,
      [userId]
    );
    if (nivelResult.rows.length === 0) {
      return res.status(404).json({ error: 'Jogador não encontrado' });
    }
    const currentNivel = nivelResult.rows[0].nivel;

    // Não pode subir para nível 10 via troca
    if (currentNivel >= 9) {
      return res.status(400).json({ error: 'Não pode subir para nível 10 via troca de cartas' });
    }

    // Validar cartas e somar valor
    const cardIds = tradedCards.map(c => Number(c.cardId)).filter(Number.isFinite);
    if (cardIds.length === 0) {
      return res.status(400).json({ error: 'IDs de cartas inválidos' });
    }

    const cardsResult = await pool.query(
      `SELECT id, nome_carta, valor FROM mtkin.cartas WHERE id = ANY($1::int[])`,
      [cardIds]
    );

    const cardMap = new Map(cardsResult.rows.map(c => [c.id, c]));
    let totalValor = 0;
    for (const tc of tradedCards) {
      const card = cardMap.get(Number(tc.cardId));
      if (!card || !card.valor || card.valor <= 0) {
        return res.status(400).json({ error: `Carta "${card?.nome_carta || tc.cardId}" não possui valor para troca` });
      }
      totalValor += card.valor;
    }

    if (totalValor < 1000) {
      return res.status(400).json({ error: `Valor total ${totalValor} é menor que 1000` });
    }

    // Remover cartas de suas origens e inserir no descarte
    for (const tc of tradedCards) {
      const cId = Number(tc.cardId);
      if (tc.source === 'mao') {
        await pool.query(
          `DELETE FROM mtkin.cartas_no_jogo
           WHERE ctid = (
             SELECT ctid FROM mtkin.cartas_no_jogo
             WHERE id_sala = $1 AND id_jogador = $2 AND id_carta = $3
             LIMIT 1
           )`,
          [roomId, userId, cId]
        );
      } else if (tc.source === 'cartela') {
        await pool.query(
          `DELETE FROM mtkin.cartas_ativas
           WHERE id_sala = $1 AND id_jogador = $2 AND id_carta = $3 AND id_slot = $4`,
          [roomId, userId, cId, tc.sourceSlot]
        );
      } else if (tc.source === 'mochila') {
        await pool.query(
          `DELETE FROM mtkin.mochila WHERE id = $1 AND id_jogador = $2`,
          [Number(tc.mochilaId), userId]
        );
      }
      // Colocar no descarte
      await pool.query(
        `INSERT INTO mtkin.descarte (id_sala, id_carta, origem)
         VALUES ($1, $2, 'troca_nivel')`,
        [roomId, cId]
      );
    }

    // Subir nível
    await pool.query(
      `UPDATE mtkin.sala_online SET nivel = nivel + 1 WHERE id_player = $1`,
      [userId]
    );

    // Recalcular tabuleiro
    const forceRows = await pool.query(
      `SELECT COALESCE(SUM(c.forca), 0)::int AS total
       FROM mtkin.cartas_ativas ca
       JOIN mtkin.cartas c ON c.id = ca.id_carta::int
       WHERE ca.id_sala = $1 AND ca.id_jogador = $2
         AND ca.id_slot IN ('79','80','81','82','83','84','85','86','87','88','89')`,
      [roomId, userId]
    );
    const tabuleiro = forceRows.rows[0]?.total ?? 0;
    await pool.query(
      `UPDATE mtkin.sala_online SET tabuleiro = $1 WHERE id_player = $2`,
      [tabuleiro, userId]
    );

    // Atualizar mao count
    const maoCount = await pool.query(
      `SELECT COUNT(*)::int AS total FROM mtkin.cartas_no_jogo
       WHERE id_sala = $1 AND id_jogador = $2`,
      [roomId, userId]
    );
    await pool.query(
      `UPDATE mtkin.sala_online SET mao = $1 WHERE id_player = $2`,
      [maoCount.rows[0].total, userId]
    );

    const newNivel = currentNivel + 1;
    res.json({ success: true, newNivel, totalValor });
  } catch (error) {
    console.error('Erro na troca por nível:', error);
    res.status(500).json({ error: 'Erro ao processar troca por nível' });
  }
});

// Contador de cartas do monte porta
app.get('/api/cards/door-count', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT COUNT(*)::int AS total FROM mtkin.cartas WHERE tipo_carta = 'Cidade'"
    );

    res.json({ count: result.rows[0]?.total ?? 0 });
  } catch (error) {
    console.error('Erro ao buscar contador de cartas:', error);
    res.status(500).json({ error: 'Erro ao buscar contador de cartas' });
  }
});

// Cartas da mao (porta) do jogador logado
app.get('/api/cards/door-hand', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const roomResult = await pool.query(
      `SELECT r.id
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true` ,
      [userId]
    );

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: 'Você não está em nenhuma sala' });
    }

    const roomId = roomResult.rows[0].id;

    const cardsResult = await pool.query(
      `SELECT cnj.id AS cnj_id, cnj.id_carta AS id, c.nome_carta, c.tipo_carta, c.caminho_imagem, cnj.tipo_baralho, c.equipar_onde, c.permite_mochila, c.texto_da_carta, c.categoria, c.uso_em_combate, c.valor, c.forca, c.fulga_minima, c.nivel, c.pesado
       FROM mtkin.cartas_no_jogo cnj
       JOIN mtkin.cartas c ON c.id = cnj.id_carta
       WHERE cnj.id_sala = $1 AND cnj.id_jogador = $2 AND cnj.tipo_baralho = 'cidade'
       ORDER BY cnj.id DESC` ,
      [roomId, userId]
    );

    const cards = cardsResult.rows.map(row => ({
      id: row.id,
      nome_carta: row.nome_carta,
      tipo_carta: row.tipo_carta,
      caminho_imagem: row.caminho_imagem,
      tipo_baralho: row.tipo_baralho,
      equipar_onde: row.equipar_onde,
      permite_mochila: row.permite_mochila,
      texto_da_carta: row.texto_da_carta || '',
      categoria: row.categoria || '',
      uso_em_combate: row.uso_em_combate === true || row.uso_em_combate === 'true' || row.uso_em_combate === 1,
      valor: row.valor || 0,
      forca: row.forca || 0,
      fulga_minima: row.fulga_minima || 0,
      nivel: row.nivel || 0,
      pesado: row.pesado === true
    }));

    res.json({ cards });
  } catch (error) {
    console.error('Erro ao buscar cartas da mao:', error);
    res.status(500).json({ error: 'Erro ao buscar cartas da mao' });
  }
});

// Cartas da mao (item) do jogador logado
app.get('/api/cards/treasure-hand', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const roomResult = await pool.query(
      `SELECT r.id
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true` ,
      [userId]
    );

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: 'Você não está em nenhuma sala' });
    }

    const roomId = roomResult.rows[0].id;

    const cardsResult = await pool.query(
      `SELECT
         cnj.id,
         cnj.id_carta AS original_id,
         cnj.nome_carta AS stored_name,
         COALESCE(ct.id, ct2.id) AS resolved_id,
         COALESCE(ct.nome_carta, ct2.nome_carta, cnj.nome_carta) AS nome_carta,
         COALESCE(ct.tipo_carta, ct2.tipo_carta) AS tipo_carta,
         COALESCE(ct.caminho_imagem, ct2.caminho_imagem) AS caminho_imagem,
         cnj.tipo_baralho,
         COALESCE(ct.texto_da_carta, ct2.texto_da_carta) AS texto_da_carta,
         COALESCE(ct.equipar_onde, ct2.equipar_onde) AS equipar_onde,
         COALESCE(ct.permite_mochila, ct2.permite_mochila) AS permite_mochila,
         COALESCE(ct.valor, ct2.valor, 0) AS valor,
         COALESCE(ct.forca, ct2.forca, 0) AS forca,
         COALESCE(ct.fulga_minima, ct2.fulga_minima, 0) AS fulga_minima,
         COALESCE(ct.nivel, ct2.nivel, 0) AS nivel,
         COALESCE(ct.pesado, ct2.pesado, false) AS pesado
       FROM mtkin.cartas_no_jogo cnj
       LEFT JOIN mtkin.cartas ct ON ct.id = cnj.id_carta
       LEFT JOIN mtkin.cartas ct2 ON ct.id IS NULL AND ct2.nome_carta = cnj.nome_carta
       WHERE cnj.id_sala = $1 AND cnj.id_jogador = $2 AND cnj.tipo_baralho = 'item'
       ORDER BY cnj.id DESC` ,
      [roomId, userId]
    );

    const missingRows = cardsResult.rows.filter((row) => !row.caminho_imagem);
    let replacements = [];

    if (missingRows.length > 0) {
      const replaceResult = await pool.query(
        "SELECT id, nome_carta, tipo_carta, caminho_imagem FROM mtkin.cartas WHERE tipo_carta = 'Item' ORDER BY RANDOM() LIMIT $1",
        [missingRows.length]
      );
      replacements = replaceResult.rows;

      const updateValues = [];
      const updateParams = [];
      let uidx = 1;
      missingRows.forEach((row, index) => {
        const replacement = replacements[index];
        if (!replacement) return;
        updateValues.push(`($${uidx}, $${uidx + 1}, $${uidx + 2})`);
        updateParams.push(row.id, replacement.id, replacement.nome_carta);
        uidx += 3;
      });

      if (updateValues.length > 0) {
        await pool.query(
          `UPDATE mtkin.cartas_no_jogo AS cnj
           SET id_carta = v.new_id::int, nome_carta = v.new_name
           FROM (VALUES ${updateValues.join(', ')}) AS v(id, new_id, new_name)
           WHERE cnj.id = v.id::int`,
          updateParams
        );
      }
    }

    const replacementMap = new Map(replacements.map((card, index) => [missingRows[index]?.id, card]));

    const cards = cardsResult.rows.map((row) => {
      const fallback = replacementMap.get(row.id);
      return {
        id: fallback?.id ?? row.resolved_id ?? row.original_id,
        nome_carta: fallback?.nome_carta ?? row.nome_carta,
        tipo_carta: fallback?.tipo_carta ?? row.tipo_carta,
        caminho_imagem: fallback?.caminho_imagem ?? row.caminho_imagem,
        tipo_baralho: row.tipo_baralho,
        equipar_onde: row.equipar_onde,
        permite_mochila: row.permite_mochila,
        texto_da_carta: fallback?.texto_da_carta ?? row.texto_da_carta ?? '',
        valor: row.valor || 0,
        forca: row.forca || 0,
        fulga_minima: row.fulga_minima || 0,
        nivel: row.nivel || 0,
        pesado: row.pesado === true
      };
    }).filter((card) => card.caminho_imagem);

    const updates = cardsResult.rows
      .filter((row) => row.resolved_id && row.original_id !== row.resolved_id)
      .map((row) => ({
        rowId: Number(row.id),
        resolvedId: Number(row.resolved_id)
      }))
      .filter((row) => Number.isInteger(row.rowId) && Number.isInteger(row.resolvedId));

    if (updates.length > 0) {
      const rowIds = updates.map((item) => item.rowId);
      const resolvedIds = updates.map((item) => item.resolvedId);

      await pool.query(
        `UPDATE mtkin.cartas_no_jogo AS cnj
         SET id_carta = v.resolved_id
         FROM (SELECT * FROM UNNEST($1::int[], $2::int[])) AS v(id, resolved_id)
         WHERE cnj.id = v.id`,
        [rowIds, resolvedIds]
      );
    }

    res.json({ cards });
  } catch (error) {
    console.error('Erro ao buscar cartas da mao de item:', error);
    res.status(500).json({ error: 'Erro ao buscar cartas da mao de item' });
  }
});

// Cartas aleatorias do monte porta (fallback/visualizacao)
app.get('/api/cards/door-random', authenticateToken, async (req, res) => {
  try {
    const count = Number.isFinite(Number(req.query.count))
      ? Math.max(1, Math.min(Number(req.query.count), 7))
      : 4;

    console.log(`\n[door-random] ---- user=${req.user.id} count=${count} ----`);

    // Descobrir a sala ativa do jogador para filtrar cartas já saídas
    const roomRow = await pool.query(
      `SELECT r.id FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true LIMIT 1`,
      [req.user.id]
    );
    const roomId = roomRow.rows[0]?.id ?? null;
    console.log(`[door-random] roomId=${roomId}`);

    // Simulator: se ativo, sempre retornar carta id=22
    if (roomId) {
      const simFlag = await getSimFlag(roomId, pool);
      if (simFlag) {
        console.log(`[door-random] simulador ativo — retornando carta id=22`);
        const simResult = await pool.query(
          `SELECT id, nome_carta, tipo_carta, caminho_imagem, texto_da_carta,
                  categoria, forca, armadilha, pesado, equipar_onde, fulga_minima, nivel, valor, 'cidade' AS tipo_baralho
           FROM mtkin.cartas WHERE id = 22 LIMIT 1`
        );
        return res.json({ cards: simResult.rows });
      }
    }

    // Quantas cartas tipo Cidade existem no banco?
    const totalCheck = await pool.query(`SELECT COUNT(*) FROM mtkin.cartas WHERE tipo_carta = 'Cidade'`);
    console.log(`[door-random] total cartas Cidade no banco: ${totalCheck.rows[0].count}`);

    let result = null;

    if (roomId) {
      // Tentar sortear cartas que ainda não atingiram qtd_max na sala
      result = await pool.query(
        `SELECT id, nome_carta, tipo_carta, caminho_imagem, texto_da_carta,
                categoria, forca, armadilha, pesado, equipar_onde, fulga_minima, nivel, valor, 'cidade' AS tipo_baralho
         FROM mtkin.cartas c
         WHERE c.tipo_carta = 'Cidade'
           AND NOT EXISTS (
             SELECT 1
             FROM mtkin.deck_estado de
             WHERE de.id_carta = c.id
               AND de.id_sala = $2
               AND de.tipo_baralho = 'cidade'
               AND de.localizacao <> 'descarte'
               AND c.qtd_max IS NOT NULL
             GROUP BY de.id_carta
             HAVING COUNT(*) >= c.qtd_max
           )
         ORDER BY RANDOM() LIMIT $1`,
        [count, roomId]
      );
      console.log(`[door-random] resultado filtrado: ${result.rows.length} carta(s)`);

      // Fallback: se todas as cartas foram usadas, sortear livremente
      if (!result.rows.length) {
        console.log(`[door-random] fallback: sorteando sem filtro de deck_estado`);
        result = await pool.query(
          `SELECT id, nome_carta, tipo_carta, caminho_imagem, texto_da_carta,
                  categoria, forca, armadilha, pesado, equipar_onde, fulga_minima, nivel, valor, 'cidade' AS tipo_baralho
           FROM mtkin.cartas
           WHERE tipo_carta = 'Cidade'
           ORDER BY RANDOM() LIMIT $1`,
          [count]
        );
        console.log(`[door-random] fallback resultado: ${result.rows.length} carta(s)`);
      }
    } else {
      console.log(`[door-random] sem sala ativa, sorteando livremente`);
      result = await pool.query(
        `SELECT id, nome_carta, tipo_carta, caminho_imagem, texto_da_carta,
                categoria, forca, armadilha, pesado, equipar_onde, fulga_minima, nivel, valor, 'cidade' AS tipo_baralho
         FROM mtkin.cartas
         WHERE tipo_carta = 'Cidade'
         ORDER BY RANDOM() LIMIT $1`,
        [count]
      );
    }

    if (result.rows.length > 0) {
      console.log(`[door-random] carta sorteada: id=${result.rows[0].id} nome="${result.rows[0].nome_carta}"`);
    } else {
      console.log(`[door-random] NENHUMA CARTA RETORNADA`);
    }

    res.json({ cards: result.rows });
  } catch (error) {
    console.error('[door-random] ERRO:', error.message, error.stack);
    res.status(500).json({ error: 'Erro ao buscar cartas aleatorias' });
  }
});

// Adicionar carta especifica a mao do jogador
app.post('/api/cards/add-to-hand', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { cardId, tipoBaralho } = req.body;

    if (!cardId || !tipoBaralho) {
      return res.status(400).json({ error: 'cardId e tipoBaralho sao obrigatorios' });
    }

    // Verificar se o jogador esta em uma sala
    const roomResult = await pool.query(
      'SELECT r.id, r.room_name, r.simulador FROM mtkin.rooms r JOIN mtkin.room_participants rp ON r.id = rp.room_id WHERE rp.user_id = $1 AND r.status != $2',
      [userId, 'finished']
    );

    if (roomResult.rows.length === 0) {
      return res.status(400).json({ error: 'Jogador nao esta em uma sala ativa' });
    }

    const room = roomResult.rows[0];
    const simFlagHand = room.simulador === 'ativado';

    // Buscar informacoes da carta
    const cardResult = await pool.query(
      'SELECT id, nome_carta, tipo_carta, caminho_imagem FROM mtkin.cartas WHERE id = $1',
      [cardId]
    );

    if (cardResult.rows.length === 0) {
      return res.status(404).json({ error: 'Carta nao encontrada' });
    }

    const card = cardResult.rows[0];

    // Adicionar a carta na mao do jogador (cartas_no_jogo)
    await pool.query(
      `INSERT INTO mtkin.cartas_no_jogo (id_sala, nome_sala, id_jogador, nome_jogador, id_carta, nome_carta, tipo_baralho, simulado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [room.id, room.room_name, userId, req.user.username, card.id, card.nome_carta, tipoBaralho, simFlagHand]
    );

    // Rastrear no deck_estado
    await upsertDeckEstado(room.id, card.id, tipoBaralho, 'mao', userId, null, simFlagHand);

    console.log(`✅ Carta ${card.nome_carta} adicionada a mao do jogador ${req.user.username}`);

    res.json({ 
      message: 'Carta adicionada a mao',
      card: {
        ...card,
        tipo_baralho: tipoBaralho
      }
    });
  } catch (error) {
    console.error('Erro ao adicionar carta a mao:', error);
    res.status(500).json({ error: 'Erro ao adicionar carta a mao' });
  }
});

// Remover carta da mao do jogador
app.post('/api/cards/remove-from-hand', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { cardId, tipoBaralho } = req.body;

    if (!cardId || !tipoBaralho) {
      return res.status(400).json({ error: 'cardId e tipoBaralho sao obrigatorios' });
    }

    // Verificar se o jogador esta em uma sala
    const roomResult = await pool.query(
      'SELECT r.id FROM mtkin.rooms r JOIN mtkin.room_participants rp ON r.id = rp.room_id WHERE rp.user_id = $1 AND r.status != $2',
      [userId, 'finished']
    );

    if (roomResult.rows.length === 0) {
      return res.status(400).json({ error: 'Jogador nao esta em uma sala ativa' });
    }

    const room = roomResult.rows[0];

    // Remover uma instância da carta da mão (LIMIT 1 para preservar duplicatas)
    const deleteResult = await pool.query(
      `DELETE FROM mtkin.cartas_no_jogo WHERE ctid = (
         SELECT ctid FROM mtkin.cartas_no_jogo
         WHERE id_sala = $1 AND id_jogador = $2 AND id_carta = $3 AND tipo_baralho = $4
         LIMIT 1
       )`,
      [room.id, userId, cardId, tipoBaralho]
    );

    if (deleteResult.rowCount === 0) {
      return res.status(404).json({ error: 'Carta nao encontrada na mao do jogador' });
    }

    // Marcar como descartada no deck_estado
    await upsertDeckEstado(room.id, cardId, tipoBaralho, 'descarte', null);

    console.log(`✅ Carta ${cardId} removida da mao do jogador ${req.user.username}`);

    res.json({ 
      message: 'Carta removida da mao',
      cardId: cardId
    });
  } catch (error) {
    console.error('Erro ao remover carta da mao:', error);
    res.status(500).json({ error: 'Erro ao remover carta da mao' });
  }
});

// Descartar carta da mão do próprio jogador (excesso no final do turno)
app.post('/api/cards/descartar-da-mao', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { cardId, tipoBaralho } = req.body;
    if (!cardId || !tipoBaralho) {
      return res.status(400).json({ error: 'cardId e tipoBaralho são obrigatórios' });
    }
    const roomResult = await pool.query(
      `SELECT r.id FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON r.id = rp.room_id
       WHERE rp.user_id = $1 AND r.status != 'finished' AND r.is_active = true
       LIMIT 1`,
      [userId]
    );
    if (roomResult.rows.length === 0) {
      return res.status(400).json({ error: 'Jogador não está em uma sala ativa' });
    }
    const roomId = roomResult.rows[0].id;
    const cardCheck = await pool.query(
      'SELECT id FROM mtkin.cartas_no_jogo WHERE id_sala = $1 AND id_jogador = $2 AND id_carta = $3 AND tipo_baralho = $4 LIMIT 1',
      [roomId, userId, cardId, tipoBaralho]
    );
    if (cardCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Carta não encontrada na mão' });
    }
    await pool.query('BEGIN');
    try {
      await pool.query(
        `DELETE FROM mtkin.cartas_no_jogo WHERE ctid = (
           SELECT ctid FROM mtkin.cartas_no_jogo
           WHERE id_sala = $1 AND id_jogador = $2 AND id_carta = $3 AND tipo_baralho = $4
           LIMIT 1
         )`,
        [roomId, userId, cardId, tipoBaralho]
      );
      await pool.query(
        'UPDATE mtkin.sala_online SET mao = GREATEST(COALESCE(mao, 0) - 1, 0) WHERE id_player = $1',
        [userId]
      );
      await pool.query('COMMIT');
    } catch (e) {
      await pool.query('ROLLBACK');
      throw e;
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('[CARDS/DESCARTAR-DA-MAO]', error);
    res.status(500).json({ error: 'Erro ao descartar carta da mão' });
  }
});

// Transferir carta da mão do jogador atual para outro jogador
app.post('/api/cards/dar-carta', authenticateToken, async (req, res) => {
  try {
    const senderId = req.user.id;
    const { cardId, tipoBaralho, targetPlayerId } = req.body;

    if (!cardId || !tipoBaralho || !targetPlayerId) {
      return res.status(400).json({ error: 'cardId, tipoBaralho e targetPlayerId sao obrigatorios' });
    }

    // Buscar sala ativa do remetente
    const roomResult = await pool.query(
      `SELECT r.id, r.room_name FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON r.id = rp.room_id
       WHERE rp.user_id = $1 AND r.status != 'finished' AND r.is_active = true
       LIMIT 1`,
      [senderId]
    );
    if (roomResult.rows.length === 0) {
      return res.status(400).json({ error: 'Jogador nao esta em uma sala ativa' });
    }
    const room = roomResult.rows[0];

    // Confirmar que o destinatário está na mesma sala
    const targetCheck = await pool.query(
      `SELECT rp.user_id FROM mtkin.room_participants rp
       WHERE rp.room_id = $1 AND rp.user_id = $2 AND rp.is_online = true`,
      [room.id, targetPlayerId]
    );
    if (targetCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Destinatario nao encontrado na sala' });
    }

    // Verificar se a carta existe na mão do remetente
    const cardInHand = await pool.query(
      'SELECT id, id_carta, nome_carta, tipo_baralho, nome_jogador FROM mtkin.cartas_no_jogo WHERE id_sala = $1 AND id_jogador = $2 AND id_carta = $3 AND tipo_baralho = $4 LIMIT 1',
      [room.id, senderId, cardId, tipoBaralho]
    );
    if (cardInHand.rows.length === 0) {
      return res.status(404).json({ error: 'Carta nao encontrada na mao do remetente' });
    }
    const cardRow = cardInHand.rows[0];

    // Buscar nome do destinatário
    const targetInfo = await pool.query(
      'SELECT nome_jogador FROM mtkin.sala_online WHERE id_player = $1',
      [targetPlayerId]
    );
    const targetNome = targetInfo.rows[0]?.nome_jogador || String(targetPlayerId);

    await pool.query('BEGIN');
    try {
      // Remover uma instância da carta da mão do remetente (LIMIT 1 para preservar duplicatas)
      await pool.query(
        `DELETE FROM mtkin.cartas_no_jogo WHERE ctid = (
           SELECT ctid FROM mtkin.cartas_no_jogo
           WHERE id_sala = $1 AND id_jogador = $2 AND id_carta = $3 AND tipo_baralho = $4
           LIMIT 1
         )`,
        [room.id, senderId, cardId, tipoBaralho]
      );
      // Adicionar à mão do destinatário
      await pool.query(
        `INSERT INTO mtkin.cartas_no_jogo (id_sala, nome_sala, id_jogador, nome_jogador, id_carta, nome_carta, tipo_baralho)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [room.id, room.room_name, targetPlayerId, targetNome, cardId, cardRow.nome_carta, tipoBaralho]
      );
      // Atualizar contagem de mão dos dois jogadores
      await pool.query(
        'UPDATE mtkin.sala_online SET mao = GREATEST(COALESCE(mao, 0) - 1, 0) WHERE id_player = $1',
        [senderId]
      );
      await pool.query(
        'UPDATE mtkin.sala_online SET mao = COALESCE(mao, 0) + 1 WHERE id_player = $1',
        [targetPlayerId]
      );
      await pool.query('COMMIT');
    } catch (txErr) {
      await pool.query('ROLLBACK');
      throw txErr;
    }

    res.json({ message: 'Carta transferida com sucesso', cardId, targetPlayerId });
  } catch (error) {
    console.error('Erro ao transferir carta:', error);
    res.status(500).json({ error: 'Erro ao transferir carta' });
  }
});

// Cartas aleatorias do monte de itens (fallback/visualizacao)
app.get('/api/cards/treasure-random', authenticateToken, async (req, res) => {
  try {
    const count = Number.isFinite(Number(req.query.count))
      ? Math.max(1, Math.min(Number(req.query.count), 7))
      : 4;

    const result = await pool.query(
      "SELECT id, nome_carta, tipo_carta, caminho_imagem, 'item' AS tipo_baralho FROM mtkin.cartas WHERE tipo_carta = 'Item' ORDER BY RANDOM() LIMIT $1",
      [count]
    );

    res.json({ cards: result.rows });
  } catch (error) {
    console.error('Erro ao buscar cartas aleatorias de item:', error);
    res.status(500).json({ error: 'Erro ao buscar cartas aleatorias de item' });
  }
});

// Buscar todas as cartas de porta
app.get('/api/cards', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM mtkin.cartas WHERE tipo_carta = $1 ORDER BY id',
      ['Cidade']
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar cartas:', error);
    res.status(500).json({ error: 'Erro ao buscar cartas' });
  }
});

// Buscar cartas por categoria (compatibilidade)
app.get('/api/cards/:category', authenticateToken, async (req, res) => {
  try {
    const { category } = req.params;
    const result = await pool.query(
      'SELECT * FROM mtkin.cartas WHERE tipo_carta = $1 ORDER BY id',
      [category]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar cartas:', error);
    res.status(500).json({ error: 'Erro ao buscar cartas' });
  }
});

// Forca de uma carta de porta (monstro)
app.get('/api/cards/door-forca/:id', authenticateToken, async (req, res) => {
  const cardId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(cardId)) {
    return res.status(400).json({ error: 'Id de carta invalido' });
  }

  try {
    const result = await pool.query(
      'SELECT id, forca FROM mtkin.cartas WHERE id = $1',
      [cardId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Carta nao encontrada' });
    }

    res.json({ id: cardId, forca: result.rows[0].forca || 0 });
  } catch (error) {
    console.error('Erro ao buscar forca da carta:', error);
    res.status(500).json({ error: 'Erro ao buscar forca da carta' });
  }
});

// Resolver batalha e premiar itens
app.post('/api/battle/fight', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const doorCardId = Number.parseInt(req.body?.doorCardId, 10);

  if (!Number.isFinite(doorCardId)) {
    return res.status(400).json({ error: 'Carta do monstro invalida' });
  }

  try {
    const roomResult = await pool.query(
      `SELECT r.id, r.room_name, r.simulador
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true
       LIMIT 1`,
      [userId]
    );

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: 'Voce nao esta em nenhuma sala' });
    }

    const room = roomResult.rows[0];
    const simFlagFight = room.simulador === 'ativado';

    const monsterResult = await pool.query(
      'SELECT id, item AS tesouros, nivel AS niveis FROM mtkin.cartas WHERE id = $1',
      [doorCardId]
    );

    if (monsterResult.rows.length === 0) {
      return res.status(404).json({ error: 'Carta do monstro nao encontrada' });
    }

    const monsterRow = monsterResult.rows[0];
    const treasureCount = Math.max(0, Number(monsterRow.tesouros) || 0);
    // Regra padrão do Munchkin: derrotar monstro = +1 nível (sempre)
    const levelGain = (monsterRow.niveis != null && Number(monsterRow.niveis) > 0) ? 1 : 0;
    console.log(`[battle/fight] doorCardId=${doorCardId} monsterRow=`, JSON.stringify(monsterRow), `treasureCount=${treasureCount} levelGain=${levelGain}`);
    if (treasureCount === 0 && levelGain === 0) {
      const statusResult = await pool.query(
        'SELECT mao, nivel FROM mtkin.sala_online WHERE id_player = $1',
        [userId]
      );
      return res.json({
        message: 'Monstro sem recompensa',
        cards: [],
        mao: statusResult.rows[0]?.mao ?? 0,
        nivel: statusResult.rows[0]?.nivel ?? 0,
        levelsGained: 0
      });
    }

    const treasureResult = await pool.query(
      `SELECT id, nome_carta, tipo_carta, caminho_imagem, texto_da_carta
       FROM mtkin.cartas ct
       WHERE ct.tipo_carta = 'Item'
         AND NOT EXISTS (
           SELECT 1
           FROM mtkin.cartas_no_jogo cnj
           WHERE cnj.id_sala = $1 AND cnj.tipo_baralho = 'item' AND cnj.id_carta = ct.id
         )
       ORDER BY RANDOM()
       LIMIT $2`,
      [room.id, treasureCount]
    );

    const cards = treasureResult.rows;
    if (cards.length === 0 && levelGain === 0) {
      const statusResult = await pool.query(
        'SELECT mao, nivel FROM mtkin.sala_online WHERE id_player = $1',
        [userId]
      );
      return res.json({
        message: 'Sem itens disponiveis',
        cards: [],
        mao: statusResult.rows[0]?.mao ?? 0,
        nivel: statusResult.rows[0]?.nivel ?? 0,
        levelsGained: 0
      });
    }

    // Verificar acordo de ajuda duo para distribuição dos tesouros
    let tipoAcordo = null;
    let helperId   = null;
    let combateId  = null;
    try {
      const acRow = await pool.query(
        `SELECT tipo_acordo, id_helper, id_combate, id_jogador FROM mtkin.combate
         WHERE id_sala = $1 AND status NOT IN ('vitoria','fuga','derrota')
         ORDER BY atualizado_em DESC LIMIT 1`,
        [room.id]
      );
      if (acRow.rows.length > 0) {
        tipoAcordo = acRow.rows[0].tipo_acordo;
        helperId   = acRow.rows[0].id_helper   ? Number(acRow.rows[0].id_helper)  : null;
        combateId  = acRow.rows[0].id_combate;
        // Em combate duo, somente o lutador (id_jogador) pode resolver o combate
        const fighterId = acRow.rows[0].id_jogador ? Number(acRow.rows[0].id_jogador) : null;
        if (fighterId && fighterId !== userId) {
          return res.status(403).json({ error: 'Apenas o lutador pode resolver este combate.' });
        }
      }
    } catch(_) {}

    // Helper para checar vitória pelo nível
    const checkWinner = async (playerId, nivel) => {
      if (nivel < 10) return null;
      try {
        await pool.query(
          `UPDATE mtkin.rooms SET status = 'finished', vencedor_id = $1 WHERE id = $2`,
          [playerId, room.id]
        );
        const wi = await pool.query(
          `SELECT id_player, nome_jogador, personagem_caminho FROM mtkin.sala_online WHERE id_player = $1`,
          [playerId]
        );
        if (wi.rows.length > 0) {
          return { id: wi.rows[0].id_player, nome: wi.rows[0].nome_jogador,
                   personagem_caminho: wi.rows[0].personagem_caminho, nivel };
        }
      } catch(_) {}
      return null;
    };

    // ── Todos os tesouros para o helper ──
    if (cards.length > 0 && helperId && tipoAcordo === 'todos-itens') {
      // Buscar info do helper para o INSERT
      const helperInfo = await pool.query(
        `SELECT nome_jogador FROM mtkin.sala_online WHERE id_player = $1`, [helperId]
      ).catch(() => ({ rows: [] }));
      const helperNome = helperInfo.rows[0]?.nome_jogador ?? '';

      const insertValues = [];
      const insertParams = [];
      let pIdx = 1;
      cards.forEach(card => {
        insertValues.push(`($${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++})`);
        insertParams.push(room.id, room.room_name, helperId, helperNome, card.id, card.nome_carta, 'item', simFlagFight);
      });
      await pool.query(
        `INSERT INTO mtkin.cartas_no_jogo (id_sala, nome_sala, id_jogador, nome_jogador, id_carta, nome_carta, tipo_baralho, simulado)
         VALUES ${insertValues.join(', ')}`,
        insertParams
      );
      // Incrementar mão do helper
      await pool.query(
        `UPDATE mtkin.sala_online SET mao = COALESCE(mao,0) + $1 WHERE id_player = $2`,
        [cards.length, helperId]
      );
      // Nível só para o lutador
      const su = await pool.query(
        `UPDATE mtkin.sala_online SET nivel = COALESCE(nivel,0) + $1 WHERE id_player = $2 RETURNING mao, nivel`,
        [levelGain, userId]
      );
      const newNivel = su.rows[0]?.nivel ?? 0;
      const winner   = await checkWinner(userId, newNivel);
      return res.json({
        message: 'Todos os tesouros foram para o parceiro',
        cards: [],
        todos_para_helper: true,
        helper_id: helperId,
        mao:  su.rows[0]?.mao  ?? 0,
        nivel: newNivel,
        levelsGained: levelGain,
        winner
      });
    }

    // ── Distribuição pendente (metade-eu-escolho | metade-vc-escolhe | intercalado) ──
    if (cards.length > 0 && helperId && tipoAcordo &&
        ['metade-eu-escolho','metade-vc-escolhe','intercalado'].includes(tipoAcordo) && combateId) {

      // Inserir cartas na fila de distribuição
      const insVals = [];
      const insPrms = [];
      let pIdx = 1;
      cards.forEach(card => {
        insVals.push(`($${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++})`);
        insPrms.push(room.id, combateId, card.id, card.nome_carta, card.caminho_imagem || '', 'item');
      });
      await pool.query(
        `INSERT INTO mtkin.distribuicao_pendente (id_sala, id_combate, id_carta, nome_carta, caminho_imagem, tipo_baralho)
         VALUES ${insVals.join(', ')}`,
        insPrms
      );

      // Determinar quem escolhe primeiro
      // metade-vc-escolhe → helper escolhe primeiro; os demais → lutador (userId) começa
      const vezDe = (tipoAcordo === 'metade-vc-escolhe') ? helperId : userId;

      await pool.query(
        `UPDATE mtkin.combate SET status='distribuindo', distribuicao_vez=$1, atualizado_em=NOW()
         WHERE id_sala=$2 AND status NOT IN ('vitoria','fuga','derrota')`,
        [vezDe, room.id]
      );

      // Só atualiza nível do lutador; mão só após distribuição
      const su = await pool.query(
        `UPDATE mtkin.sala_online SET nivel = COALESCE(nivel,0) + $1 WHERE id_player = $2 RETURNING mao, nivel`,
        [levelGain, userId]
      );
      const newNivel = su.rows[0]?.nivel ?? 0;
      const winner   = await checkWinner(userId, newNivel);

      return res.json({
        message: 'Distribuição de tesouros pendente',
        pending_distribution: cards,
        tipo_acordo: tipoAcordo,
        helper_id: helperId,
        distribuicao_vez: vezDe,
        combate_id: combateId,
        mao:  su.rows[0]?.mao  ?? 0,
        nivel: newNivel,
        levelsGained: levelGain,
        winner
      });
    }

    // ── Comportamento padrão: sem helper ou sem-recompensa — todos os tesouros para o lutador ──
    if (cards.length > 0) {
      const insertValues = [];
      const insertParams = [];
      let paramIndex = 1;

      cards.forEach((card) => {
        insertValues.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7})`);
        insertParams.push(room.id, room.room_name, userId, req.user.username, card.id, card.nome_carta, 'item', simFlagFight);
        paramIndex += 8;
      });

      await pool.query(
        `INSERT INTO mtkin.cartas_no_jogo (id_sala, nome_sala, id_jogador, nome_jogador, id_carta, nome_carta, tipo_baralho, simulado)
         VALUES ${insertValues.join(', ')}`,
        insertParams
      );
    }

    const statusUpdate = await pool.query(
      'UPDATE mtkin.sala_online SET mao = COALESCE(mao, 0) + $1, nivel = COALESCE(nivel, 0) + $2 WHERE id_player = $3 RETURNING mao, nivel',
      [cards.length, levelGain, userId]
    );

    const newNivel = statusUpdate.rows[0]?.nivel ?? 0;
    console.log(`[battle/fight] AFTER UPDATE userId=${userId} cardsGained=${cards.length} levelGain=${levelGain} newNivel=${newNivel}`);
    let winner = null;

    if (newNivel >= 10) {
      try {
        await pool.query(
          `UPDATE mtkin.rooms SET status = 'finished', vencedor_id = $1 WHERE id = $2`,
          [userId, room.id]
        );
        const winnerInfo = await pool.query(
          `SELECT id_player, nome_jogador, personagem_caminho FROM mtkin.sala_online WHERE id_player = $1`,
          [userId]
        );
        if (winnerInfo.rows.length > 0) {
          winner = {
            id: winnerInfo.rows[0].id_player,
            nome: winnerInfo.rows[0].nome_jogador,
            personagem_caminho: winnerInfo.rows[0].personagem_caminho,
            nivel: newNivel
          };
        }
      } catch (_) {}
    }

    res.json({
      message: 'Recompensas aplicadas',
      cards,
      mao: statusUpdate.rows[0]?.mao ?? 0,
      nivel: newNivel,
      levelsGained: levelGain,
      winner
    });
  } catch (error) {
    console.error('Erro ao resolver batalha:', error);
    res.status(500).json({ error: 'Erro ao resolver batalha' });
  }
});

// POST /api/battle/distribuir — move uma carta de distribuicao_pendente para cartas_no_jogo do destinatário
app.post('/api/battle/distribuir', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { combateId, cardId, recipientId } = req.body;
    if (!combateId || !cardId || !recipientId) {
      return res.status(400).json({ error: 'combateId, cardId e recipientId são obrigatórios' });
    }

    const roomId = await getRoomIdFromUser(userId);
    if (!roomId) return res.status(404).json({ error: 'Sala não encontrada' });

    // Remover carta da fila
    const deleted = await pool.query(
      `DELETE FROM mtkin.distribuicao_pendente
       WHERE id_sala=$1 AND id_combate=$2 AND id_carta=$3
       RETURNING id_carta, nome_carta, caminho_imagem, tipo_baralho`,
      [roomId, combateId, Number(cardId)]
    );
    if (deleted.rows.length === 0) {
      return res.status(404).json({ error: 'Carta não encontrada na fila de distribuição' });
    }
    const card = deleted.rows[0];
    const recipId = Number(recipientId);

    // Buscar nome do destinatário
    const recipInfo = await pool.query(
      `SELECT nome_jogador FROM mtkin.sala_online WHERE id_player = $1`, [recipId]
    ).catch(() => ({ rows: [] }));
    const recipNome = recipInfo.rows[0]?.nome_jogador ?? '';

    const simFlag = await getSimFlag(roomId);

    // Inserir na mão do destinatário
    await pool.query(
      `INSERT INTO mtkin.cartas_no_jogo (id_sala, nome_sala, id_jogador, nome_jogador, id_carta, nome_carta, tipo_baralho, simulado)
       SELECT $1, r.room_name, $2, $3, $4, $5, $6, $7 FROM mtkin.rooms r WHERE r.id = $1`,
      [roomId, recipId, recipNome, card.id_carta, card.nome_carta, card.tipo_baralho, simFlag]
    );
    // Incrementar mão do destinatário
    await pool.query(
      `UPDATE mtkin.sala_online SET mao = COALESCE(mao,0) + 1 WHERE id_player = $1`, [recipId]
    );

    // Verificar cartas restantes
    const remaining = await pool.query(
      `SELECT id_carta, nome_carta, caminho_imagem FROM mtkin.distribuicao_pendente
       WHERE id_sala=$1 AND id_combate=$2 ORDER BY id ASC`,
      [roomId, combateId]
    );

    // Se ainda há cartas: para intercalado, alternar vez_de; para metade-* a vez não muda
    let vezDe = null;
    if (remaining.rows.length > 0) {
      const combateRow = await pool.query(
        `SELECT tipo_acordo, id_jogador, id_helper, distribuicao_vez FROM mtkin.combate
         WHERE id_sala=$1 AND id_combate=$2 LIMIT 1`,
        [roomId, combateId]
      ).catch(() => ({ rows: [] }));
      const cr = combateRow.rows[0];
      if (cr) {
        vezDe = cr.distribuicao_vez; // padrão: mantém
        if (cr.tipo_acordo === 'intercalado') {
          const lutadorId = Number(cr.id_jogador);
          const hId = Number(cr.id_helper);
          const current = Number(cr.distribuicao_vez);
          const next = (current === lutadorId) ? hId : lutadorId;
          vezDe = next;
          await pool.query(
            `UPDATE mtkin.combate SET distribuicao_vez=$1 WHERE id_sala=$2 AND id_combate=$3`,
            [next, roomId, combateId]
          );
        }
      }
    } else {
      // Distribuição completa — não marca vitoria aqui; o lutador chama combate/resolve
      vezDe = null;
    }

    res.json({
      success: true,
      remaining: remaining.rows,
      vez_de: vezDe,
      done: remaining.rows.length === 0
    });
  } catch (error) {
    console.error('[battle/distribuir]', error.message);
    res.status(500).json({ error: 'Erro ao distribuir carta' });
  }
});

// GET /api/battle/distribuicao-status — estado atual da distribuição pendente para a sala
app.get('/api/battle/distribuicao-status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const roomId = await getRoomIdFromUser(userId);
    if (!roomId) return res.json({ done: true });

    const combateRow = await pool.query(
      `SELECT id_combate, tipo_acordo, id_jogador, id_helper, distribuicao_vez
       FROM mtkin.combate WHERE id_sala=$1 AND status='distribuindo' LIMIT 1`,
      [roomId]
    );
    if (!combateRow.rows.length) return res.json({ done: true });

    const cr = combateRow.rows[0];
    const pending = await pool.query(
      `SELECT dp.id_carta, dp.nome_carta, dp.caminho_imagem,
              c.texto_da_carta, c.equipar_onde, c.forca, c.nivel, c.fulga_minima, c.valor, c.pesado
       FROM mtkin.distribuicao_pendente dp
       LEFT JOIN mtkin.cartas c ON c.id = dp.id_carta
       WHERE dp.id_sala=$1 AND dp.id_combate=$2 ORDER BY dp.id ASC`,
      [roomId, cr.id_combate]
    );

    if (pending.rows.length === 0) return res.json({ done: true });

    res.json({
      done: false,
      cards: pending.rows,
      vez_de: cr.distribuicao_vez,
      tipo_acordo: cr.tipo_acordo,
      helper_id: cr.id_helper,
      lutador_id: cr.id_jogador,
      combate_id: cr.id_combate
    });
  } catch (error) {
    console.error('[battle/distribuicao-status]', error.message);
    res.status(500).json({ error: 'Erro ao verificar distribuição' });
  }
});

// Atualizar cartela do jogador com carta dropada
app.get('/api/cartela/me', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  // Slots visíveis no tabuleiro: 79 a 86
  const allowedSlots = ['79','80','81','82','83','84','85','86'];

  try {
    const roomResult = await pool.query(
      `SELECT r.id, r.room_name
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true`,
      [userId]
    );

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: 'Você não está em nenhuma sala' });
    }

    const room = roomResult.rows[0];
    const cartelaResult = await pool.query(
      `SELECT id_slot, id_carta, id_modificador, nome_modificador, caminho_modificador
       FROM mtkin.cartas_ativas
       WHERE id_sala = $1 AND id_jogador = $2
         AND id_slot = ANY($3::text[])`,
      [room.id, userId, allowedSlots]
    );

    if (cartelaResult.rows.length === 0) {
      return res.json({ slots: [] });
    }

    const slots = [];

    for (const row of cartelaResult.rows) {
      const slotNumber = row.id_slot;
      const cardId = Number.parseInt(row.id_carta, 10);
      if (!Number.isFinite(cardId)) continue;

      const cardResult = await pool.query(
        'SELECT id, nome_carta, texto_da_carta, caminho_imagem, equipar_onde, permite_mochila, tipo_carta, valor, categoria, forca, fulga_minima, nivel, pesado FROM mtkin.cartas WHERE id = $1',
        [cardId]
      );

      if (cardResult.rows.length === 0) continue;
      const deckType = cardResult.rows[0].tipo_carta === 'Item' ? 'item' : 'cidade';

      // Resolve modifier card data if present
      let modificadorData = null;
      if (row.id_modificador) {
        const modResult = await pool.query(
          'SELECT id, nome_carta, caminho_imagem, forca FROM mtkin.cartas WHERE id = $1',
          [row.id_modificador]
        );
        if (modResult.rows.length > 0) {
          modificadorData = {
            id: modResult.rows[0].id,
            nome_carta: modResult.rows[0].nome_carta,
            caminho_imagem: modResult.rows[0].caminho_imagem,
            forca: modResult.rows[0].forca || 0
          };
        }
      }

      slots.push({
        slotNumber,
        cardId,
        deckType,
        nome_carta: cardResult.rows[0].nome_carta,
        texto_da_carta: cardResult.rows[0].texto_da_carta,
        caminho_imagem: cardResult.rows[0].caminho_imagem,
        equipar_onde: cardResult.rows[0].equipar_onde,
        permite_mochila: cardResult.rows[0].permite_mochila,
        valor: cardResult.rows[0].valor || 0,
        categoria: cardResult.rows[0].categoria || '',
        forca: cardResult.rows[0].forca || 0,
        fulga_minima: cardResult.rows[0].fulga_minima || 0,
        nivel: cardResult.rows[0].nivel || 0,
        pesado: cardResult.rows[0].pesado === true,
        modificador: modificadorData
      });
    }

    res.json({
      roomId: room.id,
      roomName: room.room_name,
      slots
    });
  } catch (error) {
    console.error('Erro ao carregar cartela:', error);
    res.status(500).json({ error: 'Erro ao carregar cartela' });
  }
});

// Buscar cartela de outro jogador (oponente)
app.get('/api/cartela/player/:playerId', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const targetPlayerId = Number.parseInt(req.params.playerId, 10);

  if (!Number.isFinite(targetPlayerId)) {
    return res.status(400).json({ error: 'ID do jogador inválido' });
  }

  // Slots visíveis do oponente: 79 a 86
  const allowedSlots = ['79','80','81','82','83','84','85','86'];

  try {
    // Verificar se ambos os jogadores estão na mesma sala
    const roomCheck = await pool.query(
      `SELECT r.id, r.room_name
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp1 ON rp1.room_id = r.id
       JOIN mtkin.room_participants rp2 ON rp2.room_id = r.id
       WHERE rp1.user_id = $1 AND rp2.user_id = $2 AND r.is_active = true`,
      [userId, targetPlayerId]
    );

    if (roomCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Jogador não encontrado na mesma sala' });
    }

    const room = roomCheck.rows[0];
    const cartelaResult = await pool.query(
      `SELECT id_slot, id_carta
       FROM mtkin.cartas_ativas
       WHERE id_sala = $1 AND id_jogador = $2
         AND id_slot = ANY($3::text[])` ,
      [room.id, targetPlayerId, allowedSlots]
    );

    if (cartelaResult.rows.length === 0) {
      return res.json({ slots: [] });
    }

    const slots = [];

    for (const row of cartelaResult.rows) {
      const slotNumber = row.id_slot;
      const cardId = Number.parseInt(row.id_carta, 10);
      if (!Number.isFinite(cardId)) continue;

      const cardResult = await pool.query(
        'SELECT id, caminho_imagem, equipar_onde, tipo_carta, nome_carta, texto_da_carta, categoria, forca, fulga_minima, nivel, pesado, valor FROM mtkin.cartas WHERE id = $1',
        [cardId]
      );

      if (cardResult.rows.length === 0) continue;
      const deckType = cardResult.rows[0].tipo_carta === 'Item' ? 'item' : 'cidade';

      slots.push({
        slotNumber,
        cardId,
        deckType,
        nome_carta: cardResult.rows[0].nome_carta,
        texto_da_carta: cardResult.rows[0].texto_da_carta,
        caminho_imagem: cardResult.rows[0].caminho_imagem,
        equipar_onde: cardResult.rows[0].equipar_onde,
        categoria: cardResult.rows[0].categoria || '',
        forca: cardResult.rows[0].forca || 0,
        fulga_minima: cardResult.rows[0].fulga_minima || 0,
        nivel: cardResult.rows[0].nivel || 0,
        pesado: cardResult.rows[0].pesado === true,
        valor: cardResult.rows[0].valor || 0
      });
    }

    res.json({
      playerId: targetPlayerId,
      roomId: room.id,
      roomName: room.room_name,
      slots
    });
  } catch (error) {
    console.error('Erro ao carregar cartela do oponente:', error);
    res.status(500).json({ error: 'Erro ao carregar cartela do oponente' });
  }
});

// Mochila do jogador
app.get('/api/mochila', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const roomResult = await pool.query(
      `SELECT r.id
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true`,
      [userId]
    );

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: 'Você não está em nenhuma sala' });
    }

    const roomId = roomResult.rows[0].id;
    const bagResult = await pool.query(
      `SELECT id, id_carta, origem_tabela
       FROM mtkin.mochila
       WHERE id_sala = $1 AND id_jogador = $2
       ORDER BY id ASC`,
      [roomId, userId]
    );

    const cards = [];
    for (const row of bagResult.rows) {
      const cardResult = await pool.query(
        'SELECT id, caminho_imagem, equipar_onde, tipo_carta, valor, categoria, nome_carta, texto_da_carta, forca, fulga_minima, nivel, pesado FROM mtkin.cartas WHERE id = $1',
        [row.id_carta]
      );
      const deckType = cardResult.rows.length > 0
        ? (cardResult.rows[0].tipo_carta === 'Item' ? 'item' : 'cidade')
        : (row.origem_tabela === 'cartas_tesouro' ? 'item' : 'cidade');

      if (!cardResult || cardResult.rows.length === 0) {
        continue;
      }

      cards.push({
        mochilaId: row.id,
        cardId: row.id_carta,
        deckType,
        caminho_imagem: cardResult.rows[0].caminho_imagem,
        equipar_onde: cardResult.rows[0].equipar_onde || '',
        valor: cardResult.rows[0].valor || 0,
        categoria: cardResult.rows[0].categoria || '',
        nome_carta: cardResult.rows[0].nome_carta || '',
        texto_da_carta: cardResult.rows[0].texto_da_carta || '',
        forca: cardResult.rows[0].forca || 0,
        fulga_minima: cardResult.rows[0].fulga_minima || 0,
        nivel: cardResult.rows[0].nivel || 0,
        pesado: cardResult.rows[0].pesado === true
      });
    }

    res.json({ cards });
  } catch (error) {
    console.error('Erro ao carregar mochila:', error);
    res.status(500).json({ error: 'Erro ao carregar mochila' });
  }
});

// Mochila de outro jogador (oponente)
app.get('/api/mochila/player/:playerId', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const targetPlayerId = Number.parseInt(req.params.playerId, 10);

  if (!Number.isFinite(targetPlayerId)) {
    return res.status(400).json({ error: 'ID do jogador inválido' });
  }

  try {
    // Verificar se ambos estão na mesma sala
    const roomResult = await pool.query(
      `SELECT r.id
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp1 ON rp1.room_id = r.id
       JOIN mtkin.room_participants rp2 ON rp2.room_id = r.id
       WHERE rp1.user_id = $1 AND rp2.user_id = $2 AND r.is_active = true`,
      [userId, targetPlayerId]
    );

    if (roomResult.rows.length === 0) {
      return res.status(403).json({ error: 'Jogador não encontrado na mesma sala' });
    }

    const roomId = roomResult.rows[0].id;
    const bagResult = await pool.query(
      `SELECT id, id_carta, origem_tabela
       FROM mtkin.mochila
       WHERE id_sala = $1 AND id_jogador = $2
       ORDER BY id ASC`,
      [roomId, targetPlayerId]
    );

    const cards = [];
    for (const row of bagResult.rows) {
      let cardResult = null;
      cardResult = await pool.query(
        'SELECT id, caminho_imagem, equipar_onde, nome_carta, texto_da_carta, tipo_carta, categoria, forca, fulga_minima, nivel, pesado FROM mtkin.cartas WHERE id = $1',
        [row.id_carta]
      );
      const deckType = cardResult.rows.length > 0
        ? (cardResult.rows[0].tipo_carta === 'Item' ? 'item' : 'cidade')
        : (row.origem_tabela === 'cartas_tesouro' ? 'item' : 'cidade');

      if (!cardResult || cardResult.rows.length === 0) {
        continue;
      }

      cards.push({
        mochilaId: row.id,
        cardId: row.id_carta,
        deckType,
        caminho_imagem: cardResult.rows[0].caminho_imagem,
        equipar_onde: cardResult.rows[0].equipar_onde || '',
        nome_carta: cardResult.rows[0].nome_carta || '',
        texto_da_carta: cardResult.rows[0].texto_da_carta || '',
        categoria: cardResult.rows[0].categoria || '',
        forca: cardResult.rows[0].forca || 0,
        fulga_minima: cardResult.rows[0].fulga_minima || 0,
        nivel: cardResult.rows[0].nivel || 0,
        pesado: cardResult.rows[0].pesado === true
      });
    }

    res.json({ cards });
  } catch (error) {
    console.error('Erro ao carregar mochila do oponente:', error);
    res.status(500).json({ error: 'Erro ao carregar mochila do oponente' });
  }
});

app.post('/api/mochila/add', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { cardId, deckType, fromSlot } = req.body;

  if (!cardId) {
    return res.status(400).json({ error: 'Carta inválida' });
  }

  const slotMap = {
    '77': '77_Raça',
    '78': '78_Raça',
    '78L': '78L',
    '79': '79_Classe',
    '80': '80_Classe',
    '80L': '80L',
    '81': '81_Duas_mão',
    '82': '82_Escudeiro',
    '83': '83_Cabeça',
    '84': '84_Corpo',
    '85': '85_Pés',
    '86': '86_Mão_esquerda',
    '87': '87_Mão_direita',
    '88': '88_Montaria',
    '89': '89_Itens'
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const roomResult = await client.query(
      `SELECT r.id, r.room_name, r.simulador
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true`,
      [userId]
    );

    if (roomResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Você não está em nenhuma sala' });
    }

    const roomId = roomResult.rows[0].id;
    const simFlagMochila = roomResult.rows[0].simulador === 'ativado';

    let permiteMochila = null;
    {
      const cardCheck = await client.query(
        'SELECT permite_mochila FROM mtkin.cartas WHERE id = $1',
        [Number(cardId)]
      );
      if (cardCheck.rows.length) {
        permiteMochila = cardCheck.rows[0].permite_mochila;
      }
    }

    if (permiteMochila === null || permiteMochila === undefined) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Carta não encontrada' });
    }

    const allowsMochila =
      permiteMochila === true ||
      permiteMochila === 'true' ||
      permiteMochila === 1 ||
      permiteMochila === '1';

    if (!allowsMochila) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Carta não pode ir para a mochila' });
    }

    const insertResult = await client.query(
      `INSERT INTO mtkin.mochila (id_sala, id_jogador, id_carta, origem_tabela, simulado)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [roomId, userId, Number(cardId), 'cartas', simFlagMochila]
    );

    const mochilaId = insertResult.rows[0].id;

    // Rastrear no deck_estado: carta agora está na mochila
    await upsertDeckEstado(roomId, Number(cardId), deckType || 'item', 'mochila', userId, client, simFlagMochila);

    if (fromSlot) {
      await client.query(
        `DELETE FROM mtkin.cartas_ativas
         WHERE id_sala = $1 AND id_jogador = $2 AND id_slot = $3`,
        [roomId, userId, String(fromSlot)]
      );
    }

    if (deckType === 'cidade' || deckType === 'item') {
      await client.query(
        `DELETE FROM mtkin.cartas_no_jogo WHERE ctid = (
           SELECT ctid FROM mtkin.cartas_no_jogo
           WHERE id_sala = $1 AND id_jogador = $2 AND id_carta = $3 AND tipo_baralho = $4
           LIMIT 1
         )`,
        [roomId, userId, Number(cardId), deckType]
      );
    } else {
      await client.query(
        `DELETE FROM mtkin.cartas_no_jogo WHERE ctid = (
           SELECT ctid FROM mtkin.cartas_no_jogo
           WHERE id_sala = $1 AND id_jogador = $2 AND id_carta = $3
           LIMIT 1
         )`,
        [roomId, userId, Number(cardId)]
      );
    }

    await client.query('COMMIT');
    res.json({ message: 'Carta adicionada na mochila', mochilaId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao adicionar na mochila:', error);
    res.status(500).json({ error: 'Erro ao adicionar na mochila' });
  } finally {
    client.release();
  }
});

// ─── Helper: rastrear posição da carta no deck ─────────────────────────────────
async function upsertDeckEstado(salaId, cartaId, tipoBaralho, localizacao, jogadorId, client, simulado = false) {
  const db = client || pool;
  await db.query(
    `INSERT INTO mtkin.deck_estado (id_sala, id_carta, tipo_baralho, localizacao, id_jogador, simulado)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id_sala, id_carta, tipo_baralho)
     DO UPDATE SET localizacao    = EXCLUDED.localizacao,
                   id_jogador     = EXCLUDED.id_jogador,
                   atualizado_em  = NOW()`,
    [salaId, cartaId, tipoBaralho, localizacao, jogadorId ?? null, simulado]
  );
}

// ─── Helper: recalcular tabuleiro (bônus de itens equipados) ───────────────────
async function recalcularTabuleiroJogador(userId, roomId, client) {
  const db = client || pool;
  // Slots 79-80 (Cidade) e 81-89 (itens equipados) — todos podem dar bônus de força
  const equipSlots = ['79','80','81','82','83','84','85','86','87','88','89'];

  const cartelaResult = await db.query(
    `SELECT id_carta
     FROM mtkin.cartas_ativas
     WHERE id_sala = $1 AND id_jogador = $2 AND id_slot = ANY($3::text[])`,
    [roomId, userId, equipSlots]
  );

  if (cartelaResult.rows.length === 0) {
    await db.query('UPDATE mtkin.sala_online SET tabuleiro = 0 WHERE id_player = $1', [userId]);
    return 0;
  }

  const cardIds = cartelaResult.rows
    .map(r => Number.parseInt(r.id_carta, 10))
    .filter((id) => Number.isFinite(id));

  if (cardIds.length === 0) {
    await db.query('UPDATE mtkin.sala_online SET tabuleiro = 0 WHERE id_player = $1', [userId]);
    return 0;
  }

  // Soma o campo forca de todas as cartas equipadas (porta e tesouro)
  const bonusResult = await db.query(
    `SELECT COALESCE(SUM(COALESCE(c.forca, 0)), 0)::int AS total
     FROM unnest($1::int[]) AS u(card_id)
     JOIN mtkin.cartas c ON c.id = u.card_id`,
    [cardIds]
  );

  const newTabuleiro = bonusResult.rows[0]?.total ?? 0;
  await db.query('UPDATE mtkin.sala_online SET tabuleiro = $1 WHERE id_player = $2', [newTabuleiro, userId]);
  return newTabuleiro;
}

// Transferir carta da mochila do jogador para a mochila de outro jogador
app.post('/api/mochila/dar-para-jogador', authenticateToken, async (req, res) => {
  try {
    const senderId = req.user.id;
    const { mochilaId, targetPlayerId } = req.body;

    if (!mochilaId || !targetPlayerId) {
      return res.status(400).json({ error: 'mochilaId e targetPlayerId são obrigatórios' });
    }

    // Verificar se a entrada da mochila pertence ao remetente
    const bagEntry = await pool.query(
      'SELECT id, id_carta, id_sala FROM mtkin.mochila WHERE id = $1 AND id_jogador = $2',
      [Number(mochilaId), senderId]
    );
    if (bagEntry.rows.length === 0) {
      return res.status(404).json({ error: 'Carta não encontrada na mochila do remetente' });
    }
    const entry = bagEntry.rows[0];

    // Confirmar que o destinatário está na mesma sala
    const targetCheck = await pool.query(
      `SELECT rp.user_id FROM mtkin.room_participants rp
       WHERE rp.room_id = $1 AND rp.user_id = $2 AND rp.is_online = true`,
      [entry.id_sala, Number(targetPlayerId)]
    );
    if (targetCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Destinatário não encontrado na sala' });
    }

    await pool.query('BEGIN');
    try {
      await pool.query(
        'UPDATE mtkin.mochila SET id_jogador = $1 WHERE id = $2',
        [Number(targetPlayerId), entry.id]
      );
      await pool.query(
        'UPDATE mtkin.sala_online SET mochila = GREATEST(COALESCE(mochila, 0) - 1, 0) WHERE id_player = $1',
        [senderId]
      );
      await pool.query(
        'UPDATE mtkin.sala_online SET mochila = COALESCE(mochila, 0) + 1 WHERE id_player = $1',
        [Number(targetPlayerId)]
      );
      await pool.query('COMMIT');
    } catch (txErr) {
      await pool.query('ROLLBACK');
      throw txErr;
    }

    res.json({ message: 'Carta transferida para a mochila do oponente' });
  } catch (error) {
    console.error('Erro ao transferir carta da mochila:', error);
    res.status(500).json({ error: 'Erro ao transferir carta da mochila' });
  }
});

// ─── Helper: derivar caminho do personagem a partir de caminho_imagem da carta do slot 79 ───
// Mapa de personagens existentes no Supabase Storage (evita fs.existsSync que falha no Render)
const PERSONAGEM_MAP = {
  '39': 'Feminino', '41': 'Feminino', '43': 'Feminino',
  '40': 'Masculino', '42': 'Masculino', '44': 'Masculino',
};

function deriveCharacterPath(caminhoImagem) {
  if (!caminhoImagem) return null;
  const baseName = path.basename(caminhoImagem, path.extname(caminhoImagem));
  const num = baseName.replace(/\D/g, '');
  if (!num) return null;
  const gender = PERSONAGEM_MAP[num];
  if (gender) return `Personagens/${gender}/${num}.png`;
  return null;
}
// ──────────────────────────────────────────────────────────────────────────────

app.post('/api/mochila/to-cartela', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { mochilaId, slotNumber } = req.body;

  const allowedSlots = ['77','78','78L','79','80','80L','81','82','83','84','85','86','87','88','89'];
  if (!allowedSlots.includes(String(slotNumber))) {
    return res.status(400).json({ error: 'Slot inválido' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const roomResult = await client.query(
      `SELECT r.id, r.room_name, r.simulador
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true`,
      [userId]
    );

    if (roomResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Você não está em nenhuma sala' });
    }

    const room = roomResult.rows[0];
    const simFlagToCartela = room.simulador === 'ativado';

    async function hasAnotherHeavyEquipped() {
      const heavyCheck = await client.query(
        `SELECT ca.id_slot, ca.id_carta, c.nome_carta
         FROM mtkin.cartas_ativas ca
         JOIN mtkin.cartas c ON c.id = ca.id_carta
         WHERE ca.id_sala = $1
           AND ca.id_jogador = $2
           AND COALESCE(c.pesado, false) = true
         LIMIT 1`,
        [room.id, userId]
      );
      if (heavyCheck.rows.length === 0) return null;
      return heavyCheck.rows[0];
    }

    const bagResult = await client.query(
      `SELECT id, id_carta, origem_tabela
       FROM mtkin.mochila
       WHERE id = $1 AND id_sala = $2 AND id_jogador = $3`,
      [Number(mochilaId), room.id, userId]
    );

    if (bagResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Carta não encontrada na mochila' });
    }

    const cardId = bagResult.rows[0].id_carta;
    const origemTabela = bagResult.rows[0].origem_tabela;
    const cardResult = await client.query(
      'SELECT id, nome_carta, tipo_carta, caminho_imagem, equipar_onde, pesado FROM mtkin.cartas WHERE id = $1',
      [cardId]
    );
    const deckType = cardResult.rows.length > 0
      ? (cardResult.rows[0].tipo_carta === 'Item' ? 'item' : 'cidade')
      : (origemTabela === 'cartas_tesouro' ? 'item' : 'cidade');

    if (cardResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Carta não encontrada' });
    }

    const card = cardResult.rows[0];

    if (card.pesado === true) {
      const equippedHeavy = await hasAnotherHeavyEquipped();
      if (equippedHeavy) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Você só pode ter 1 carta com pesado ativado equipada na cartela.' });
      }
    }
    
    // Validar equipar_onde para TODOS os slots
    const equiparOndeDestino = card.equipar_onde || '';
    const allowedSlotsDestino = equiparOndeDestino.split(';').map(s => s.trim()).filter(Boolean);
    if (allowedSlotsDestino.length === 0 || !allowedSlotsDestino.includes(String(slotNumber))) {
      await client.query('ROLLBACK');
      console.log(`❌ [MOCHILA/TO-CARTELA] Carta não pode ser equipada no slot ${slotNumber}. Equipar apenas em: ${equiparOndeDestino || 'nenhum'}`);
      return res.status(400).json({ 
        error: `Esta carta não pode ser equipada aqui. Slots permitidos: ${equiparOndeDestino || 'nenhum'}.`,
        equipar_onde: equiparOndeDestino
      });
    }
    console.log(`✅ [MOCHILA/TO-CARTELA] Validação ${slotNumber}: carta autorizada`);

    // Verificar se o slot destino já está ocupado
    const destOccupied = await client.query(
      'SELECT id FROM mtkin.cartas_ativas WHERE id_sala = $1 AND id_jogador = $2 AND id_slot = $3',
      [room.id, userId, String(slotNumber)]
    );
    if (destOccupied.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Slot já está ocupado' });
    }

    // Salvar na cartela (linha por slot)
    await client.query(
      `INSERT INTO mtkin.cartas_ativas (id_sala, nome_sala, id_jogador, nome_jogador, id_carta, nome_carta, id_slot, simulado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id_sala, id_jogador, id_slot)
       DO UPDATE SET id_carta = EXCLUDED.id_carta,
                     nome_carta = EXCLUDED.nome_carta,
                     nome_sala = EXCLUDED.nome_sala,
                     nome_jogador = EXCLUDED.nome_jogador,
                     simulado = EXCLUDED.simulado`,
      [room.id, room.room_name, userId, req.user.username, card.id, card.nome_carta, String(slotNumber), simFlagToCartela]
    );

    await client.query(
      'DELETE FROM mtkin.mochila WHERE id = $1 AND id_sala = $2 AND id_jogador = $3',
      [Number(mochilaId), room.id, userId]
    );

    await client.query('COMMIT');
    await recalcularTabuleiroJogador(userId, room.id, client);

    // Atualizar personagem_caminho quando carta vai para o slot 79
    if (String(slotNumber) === '79') {
      const charPath = deriveCharacterPath(card.caminho_imagem);
      if (charPath) {
        await pool.query('UPDATE mtkin.sala_online SET personagem_caminho = $1 WHERE id_player = $2', [charPath, userId]);
        console.log(`✅ [MOCHILA/TO-CARTELA] personagem_caminho atualizado para slot 79: ${charPath}`);
      }
    }

    res.json({
      message: 'Carta movida para cartela',
      cardId: card.id,
      deckType,
      caminho_imagem: card.caminho_imagem
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao mover carta da mochila:', error);
    res.status(500).json({ error: 'Erro ao mover carta da mochila' });
  } finally {
    client.release();
  }
});

// Atualizar cartela do jogador com carta dropada
app.post('/api/cartela/slot', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { slotNumber, cardId, deckType } = req.body;

  console.log('📡 [CARTELA/SLOT] Requisição recebida:', {
    userId,
    slotNumber,
    cardId,
    deckType,
    username: req.user.username
  });

  const allowedSlots = ['77','78','78L','79','80','80L','81','82','83','84','85','86','87','88','89'];
  if (!allowedSlots.includes(String(slotNumber))) {
    console.log('❌ [CARTELA/SLOT] Slot inválido:', slotNumber);
    return res.status(400).json({ error: 'Slot inválido' });
  }

  if (!cardId || (deckType !== 'cidade' && deckType !== 'item')) {
    console.log('❌ [CARTELA/SLOT] Carta inválida:', { cardId, deckType });
    return res.status(400).json({ error: 'Carta inválida' });
  }

  try {
    async function hasAnotherHeavyEquipped(roomId, userIdParam) {
      const heavyCheck = await pool.query(
        `SELECT ca.id_slot, ca.id_carta, c.nome_carta
         FROM mtkin.cartas_ativas ca
         JOIN mtkin.cartas c ON c.id = ca.id_carta
         WHERE ca.id_sala = $1
           AND ca.id_jogador = $2
           AND COALESCE(c.pesado, false) = true
         LIMIT 1`,
        [roomId, userIdParam]
      );
      if (heavyCheck.rows.length === 0) return null;
      return heavyCheck.rows[0];
    }

    const roomResult = await pool.query(
      `SELECT r.id, r.room_name, r.simulador
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true` ,
      [userId]
    );

    if (roomResult.rows.length === 0) {
      console.log('❌ [CARTELA/SLOT] Nenhuma sala ativa encontrada para user:', userId);
      return res.status(404).json({ error: 'Você não está em nenhuma sala' });
    }

    const room = roomResult.rows[0];
    const simFlagSlot = room.simulador === 'ativado';
    console.log('✅ [CARTELA/SLOT] Sala encontrada:', { room_id: room.id, room_name: room.room_name });

    const cardResult = await pool.query(
      'SELECT id, nome_carta, tipo_carta, equipar_onde, caminho_imagem, pesado, categoria FROM mtkin.cartas WHERE id = $1',
      [cardId]
    );

    if (cardResult.rows.length === 0) {
      console.log('❌ [CARTELA/SLOT] Carta não encontrada:', { cardId });
      return res.status(404).json({ error: 'Carta não encontrada' });
    }

    const card = cardResult.rows[0];
    console.log('✅ [CARTELA/SLOT] Carta encontrada na BD:', {
      id: card.id,
      nome_carta: card.nome_carta,
      tipo_carta: card.tipo_carta,
      equipar_onde: card.equipar_onde
    });

    // Validar equipar_onde para TODOS os slots
    const equiparOndeCard = card.equipar_onde || '';
    const allowedSlotsCard = equiparOndeCard.split(';').map(s => s.trim()).filter(Boolean);
    if (allowedSlotsCard.length === 0 || !allowedSlotsCard.includes(String(slotNumber))) {
      console.log(`❌ [CARTELA/SLOT] Carta não pode ser equipada no slot ${slotNumber}. Equipar apenas em: ${equiparOndeCard || 'nenhum'}`);
      return res.status(400).json({ 
        error: `Esta carta não pode ser equipada aqui. Slots permitidos: ${equiparOndeCard || 'nenhum'}.`,
        equipar_onde: equiparOndeCard
      });
    }
    console.log(`✅ [CARTELA/SLOT] Validação ${slotNumber}: carta autorizada`);

    if (card.pesado === true) {
      const equippedHeavy = await hasAnotherHeavyEquipped(room.id, userId);
      if (equippedHeavy) {
        return res.status(400).json({ error: 'Você só pode ter 1 carta com pesado ativado equipada na cartela.' });
      }
    }

    // Verificar se o slot já está ocupado
    const occupiedCheck = await pool.query(
      'SELECT id FROM mtkin.cartas_ativas WHERE id_sala = $1 AND id_jogador = $2 AND id_slot = $3',
      [room.id, userId, String(slotNumber)]
    );
    const isModificador = String(card.categoria || '').toLowerCase() === 'isca';

    if (occupiedCheck.rows.length > 0) {
      if (!isModificador) {
        return res.status(400).json({ error: 'Slot já está ocupado' });
      }
      // Modificador: empilhar sobre a carta principal do slot
      console.log(`✅ [CARTELA/SLOT] Empilhando modificador id=${card.id} no slot ${slotNumber}`);
      await pool.query(
        `UPDATE mtkin.cartas_ativas
         SET id_modificador = $1, nome_modificador = $2, caminho_modificador = $3
         WHERE id_sala = $4 AND id_jogador = $5 AND id_slot = $6`,
        [card.id, card.nome_carta, card.caminho_imagem || null, room.id, userId, String(slotNumber)]
      );
    } else {
      // Salvar na cartela (linha por slot)
      await pool.query(
        `INSERT INTO mtkin.cartas_ativas (id_sala, nome_sala, id_jogador, nome_jogador, id_carta, nome_carta, id_slot, simulado)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id_sala, id_jogador, id_slot)
         DO UPDATE SET id_carta = EXCLUDED.id_carta,
                       nome_carta = EXCLUDED.nome_carta,
                       nome_sala = EXCLUDED.nome_sala,
                       nome_jogador = EXCLUDED.nome_jogador,
                       simulado = EXCLUDED.simulado`,
        [room.id, room.room_name, userId, req.user.username, card.id, card.nome_carta, String(slotNumber), simFlagSlot]
      );
    }

    console.log('✅ [CARTELA/SLOT] Cartela salva:', {
      slot: slotNumber,
      cardId: card.id,
      sala_id: room.id,
      usuario_id: userId
    });

    // Remover uma instância da carta da mão (LIMIT 1 para preservar duplicatas)
    await pool.query(
      `DELETE FROM mtkin.cartas_no_jogo WHERE ctid = (
         SELECT ctid FROM mtkin.cartas_no_jogo
         WHERE id_sala = $1 AND id_jogador = $2 AND id_carta = $3 AND tipo_baralho = $4
         LIMIT 1
       )`,
      [room.id, userId, card.id, deckType]
    );

    console.log('✅ [CARTELA/SLOT] Carta removida da mão (cartas_no_jogo)');

    // Rastrear no deck_estado: carta agora está na cartela
    await upsertDeckEstado(room.id, card.id, deckType, 'cartela', userId, null, simFlagSlot);

    await recalcularTabuleiroJogador(userId, room.id);

    // Atualizar personagem_caminho quando carta vai para o slot 79
    if (String(slotNumber) === '79') {
      const charPath = deriveCharacterPath(card.caminho_imagem);
      if (charPath) {
        await pool.query('UPDATE mtkin.sala_online SET personagem_caminho = $1 WHERE id_player = $2', [charPath, userId]);
        console.log(`✅ [CARTELA/SLOT] personagem_caminho atualizado para slot 79: ${charPath}`);
      }
    }

    res.json({ message: 'Cartela atualizada', slot: String(slotNumber), cardId: card.id });
  } catch (error) {
    console.error('❌ [CARTELA/SLOT] Erro:', error);
    res.status(500).json({ error: 'Erro ao atualizar cartela' });
  }
});

// Mover carta entre slots da cartela
app.post('/api/cartela/move', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { fromSlot, toSlot } = req.body;

  console.log('📡 [CARTELA/MOVE] Requisição recebida:', {
    userId,
    fromSlot,
    toSlot,
    username: req.user.username
  });

  const slotMap = {
    '77': '77_Raça',
    '78': '78_Raça',
    '78L': '78L',
    '79': '79_Classe',
    '80': '80_Classe',
    '80L': '80L',
    '81': '81_Duas_mão',
    '82': '82_Escudeiro',
    '83': '83_Cabeça',
    '84': '84_Corpo',
    '85': '85_Pés',
    '86': '86_Mão_esquerda',
    '87': '87_Mão_direita',
    '88': '88_Montaria',
    '89': '89_Itens'
  };

  const fromColumn = slotMap[String(fromSlot)];
  const toColumn = slotMap[String(toSlot)];

  console.log('📍 [CARTELA/MOVE] Mapeamento de slots:', {
    fromSlot: `"${fromSlot}" → "${fromColumn}"`,
    toSlot: `"${toSlot}" → "${toColumn}"`,
    fromColumnExists: !!fromColumn,
    toColumnExists: !!toColumn
  });

  if (!fromColumn || !toColumn) {
    const missingSlot = !fromColumn ? `fromSlot="${fromSlot}"` : `toSlot="${toSlot}"`;
    console.log(`❌ [CARTELA/MOVE] Slot inválido - ${missingSlot} não existe no slotMap`);
    return res.status(400).json({ 
      error: 'Slot inválido',
      details: `${missingSlot} não mapeado`
    });
  }

  if (fromColumn === toColumn) {
    console.log('⚠️  [CARTELA/MOVE] Tentativa de mover para o mesmo slot');
    return res.json({ message: 'Cartela inalterada', from: fromColumn, to: toColumn });
  }

  try {
    const roomResult = await pool.query(
      `SELECT r.id, r.room_name
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true`,
      [userId]
    );

    if (roomResult.rows.length === 0) {
      console.log('❌ [CARTELA/MOVE] Nenhuma sala ativa encontrada');
      return res.status(404).json({ error: 'Você não está em nenhuma sala' });
    }

    const room = roomResult.rows[0];
    console.log('✅ [CARTELA/MOVE] Sala encontrada:', { room_id: room.id, room_name: room.room_name });

    const cartelaResult = await pool.query(
      `SELECT id, id_carta, id_slot
       FROM mtkin.cartas_ativas
       WHERE id_sala = $1 AND id_jogador = $2 AND id_slot = $3`,
      [room.id, userId, String(fromSlot)]
    );

    if (cartelaResult.rows.length === 0) {
      console.log('❌ [CARTELA/MOVE] Slot de origem vazio');
      return res.status(400).json({ error: 'Slot de origem vazio' });
    }

    const fromRow = cartelaResult.rows[0];
    const cardId = fromRow.id_carta;

    // Validar equipar_onde do slot destino para todos os slots
    const cardForValidation = await pool.query(
      'SELECT equipar_onde, caminho_imagem FROM mtkin.cartas WHERE id = $1',
      [cardId]
    );
    if (cardForValidation.rows.length > 0) {
      const destEquiparOnde = cardForValidation.rows[0].equipar_onde || '';
      const allowedSlotsCard = destEquiparOnde.split(';').map(s => s.trim()).filter(Boolean);
      if (allowedSlotsCard.length === 0 || !allowedSlotsCard.includes(String(toSlot))) {
        console.log(`❌ [CARTELA/MOVE] Carta não pode ser movida para slot ${toSlot}. Equipar apenas em: ${destEquiparOnde || 'nenhum'}`);
        return res.status(400).json({ 
          error: `Esta carta não pode ser equipada no slot ${toSlot}. Slots permitidos: ${destEquiparOnde || 'nenhum'}.`,
          equipar_onde: destEquiparOnde
        });
      }
    }

    // Verificar se o slot destino já está ocupado
    const destOccupied = await pool.query(
      'SELECT id FROM mtkin.cartas_ativas WHERE id_sala = $1 AND id_jogador = $2 AND id_slot = $3',
      [room.id, userId, String(toSlot)]
    );
    if (destOccupied.rows.length > 0) {
      return res.status(400).json({ error: 'Slot destino já está ocupado. Remova a carta primeiro.' });
    }

    await pool.query(
      `UPDATE mtkin.cartas_ativas
       SET id_slot = $3, nome_sala = $4, nome_jogador = $5
       WHERE id = $6`,
      [room.id, userId, String(toSlot), room.room_name, req.user.username, fromRow.id]
    );

    console.log('✅ [CARTELA/MOVE] Cartela atualizada', {
      de: fromSlot,
      para: toSlot,
      cardId
    });

    await recalcularTabuleiroJogador(userId, room.id);

    // Sincronizar personagem_caminho quando slot 79 é origem ou destino
    if (String(toSlot) === '79') {
      const caminhoImagem = cardForValidation.rows[0]?.caminho_imagem;
      const charPath = deriveCharacterPath(caminhoImagem);
      if (charPath) {
        await pool.query('UPDATE mtkin.sala_online SET personagem_caminho = $1 WHERE id_player = $2', [charPath, userId]);
        console.log(`✅ [CARTELA/MOVE] personagem_caminho atualizado para slot 79: ${charPath}`);
      }
    } else if (String(fromSlot) === '79') {
      await pool.query("UPDATE mtkin.sala_online SET personagem_caminho = '' WHERE id_player = $1", [userId]);
      console.log('✅ [CARTELA/MOVE] personagem_caminho limpo (carta saiu do slot 79)');
    }

    res.json({ message: 'Cartela atualizada', from: String(fromSlot), to: String(toSlot), cardId });
  } catch (error) {
    console.error('❌ [CARTELA/MOVE] Erro:', error);
    res.status(500).json({ error: 'Erro ao mover carta da cartela' });
  }
});

// ─── Descartar carta dos slots 79 / 80 ────────────────────────────────────────
// Remove a carta de todas as tabelas de jogo e registra em mtkin.descarte
app.post('/api/cartela/descartar', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { slotNumber, cardId, deckType } = req.body;

  if (!slotNumber || !cardId) {
    return res.status(400).json({ error: 'slotNumber e cardId são obrigatórios' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Buscar sala ativa
    const roomResult = await client.query(
      `SELECT r.id, r.room_name FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true`,
      [userId]
    );
    if (roomResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Você não está em nenhuma sala' });
    }
    const room = roomResult.rows[0];

    // Buscar dados da carta no slot
    const slotResult = await client.query(
      'SELECT id_carta, nome_carta FROM mtkin.cartas_ativas WHERE id_sala = $1 AND id_jogador = $2 AND id_slot = $3',
      [room.id, userId, String(slotNumber)]
    );
    if (slotResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Carta não encontrada no slot' });
    }
    const { id_carta, nome_carta } = slotResult.rows[0];

    // Buscar caminho da imagem
    const cardInfo = await client.query(
      'SELECT caminho_imagem FROM mtkin.cartas WHERE id = $1',
      [id_carta]
    );
    const caminho_imagem = cardInfo.rows[0]?.caminho_imagem || null;
    const tipoBaralho = deckType || 'cidade';

    // Remover da cartela
    await client.query(
      'DELETE FROM mtkin.cartas_ativas WHERE id_sala = $1 AND id_jogador = $2 AND id_slot = $3',
      [room.id, userId, String(slotNumber)]
    );

    // Remover da mão (caso ainda esteja lá por algum motivo)
    await client.query(
      'DELETE FROM mtkin.cartas_no_jogo WHERE id_sala = $1 AND id_jogador = $2 AND id_carta = $3',
      [room.id, userId, id_carta]
    );

    // Remover da mochila
    await client.query(
      'DELETE FROM mtkin.mochila WHERE id_sala = $1 AND id_jogador = $2 AND id_carta = $3',
      [room.id, userId, id_carta]
    );

    // Registrar no descarte
    await client.query(
      `INSERT INTO mtkin.descarte (id_sala, id_carta, nome_carta, tipo_baralho, caminho_imagem, id_jogador, nome_jogador)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [room.id, id_carta, nome_carta, tipoBaralho, caminho_imagem, userId, req.user.username]
    );

    // Atualizar deck_estado
    await upsertDeckEstado(room.id, id_carta, tipoBaralho, 'descarte', null, client, false);

    // Limpar personagem se era slot 79
    if (String(slotNumber) === '79') {
      await client.query("UPDATE mtkin.sala_online SET personagem_caminho = '' WHERE id_player = $1", [userId]);
    }

    await client.query('COMMIT');

    await recalcularTabuleiroJogador(userId, room.id);

    console.log(`✅ [CARTELA/DESCARTAR] Slot ${slotNumber} carta ${id_carta} descartada por user ${userId}`);
    res.json({ message: 'Carta descartada com sucesso', slotNumber, cardId: id_carta });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ [CARTELA/DESCARTAR] Erro:', error);
    res.status(500).json({ error: 'Erro ao descartar carta' });
  } finally {
    client.release();
  }
});

// Atualizar carta
app.put('/api/cards/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      nome_carta,
      tipo_carta,
      caminho_imagem,
      forca,
      tesouros,
      niveis,
      coisa_boa,
      coisa_ruim,
      especial,
      forca_ganha,
      para_quem_porta,
      forca_perdida,
      fuga_automatica,
      nivel_fuga_automatica,
      morte,
      mais_forte_contra,
      mais_fraco_contra,
      perde_niveis,
      necessario_para_fugir,
      descartar_toda_mao,
      limite_mao,
      perde_equipamento,
      perde_item,
      permite_equipar,
      permite_mochila,
      equipar_onde,
      n_pode_equipar,
      item,
      nivel,
      fulga_minima,
      texto_da_carta,
      categoria,
      qtd_max,
      valor,
      uso_em_combate,
      pesado
    } = req.body;

    console.log('Atualizar carta payload:', {
      id,
      fuga_automatica,
      nivel_fuga_automatica,
      tipo_carta,
      nome_carta
    });

    const parsedFugaAutomatica =
      fuga_automatica === true ||
      fuga_automatica === 'true' ||
      fuga_automatica === 1 ||
      fuga_automatica === '1';

    const parsedNivelFugaAutomatica = Number.isFinite(Number(nivel_fuga_automatica))
      ? Number(nivel_fuga_automatica)
      : 0;

    const parsedMorte =
      morte === true ||
      morte === 'true' ||
      morte === 1 ||
      morte === '1';

    const parsedDescartarTodaMao =
      descartar_toda_mao === true ||
      descartar_toda_mao === 'true' ||
      descartar_toda_mao === 1 ||
      descartar_toda_mao === '1';

    const parsedPermiteEquipar =
      permite_equipar === true ||
      permite_equipar === 'true' ||
      permite_equipar === 1 ||
      permite_equipar === '1';

    const parsedPermiteMochila =
      permite_mochila === true ||
      permite_mochila === 'true' ||
      permite_mochila === 1 ||
      permite_mochila === '1';

    const parsedPerdeNiveis = Number.isFinite(Number(perde_niveis))
      ? Number(perde_niveis)
      : 0;

    const parsedNecessarioParaFugir = Number.isFinite(Number(necessario_para_fugir))
      ? Number(necessario_para_fugir)
      : 0;

    const parsedLimiteMao = Number.isFinite(Number(limite_mao))
      ? Number(limite_mao)
      : 0;

    const parsedForca = Number.isFinite(Number(forca)) ? Number(forca) : 0;
    const parsedItem = Number.isFinite(Number(item)) ? Number(item) : 0;
    const parsedNivel = Number.isFinite(Number(nivel)) ? Number(nivel) : 0;
    const parsedFulgaMinima = Number.isFinite(Number(fulga_minima)) ? Number(fulga_minima) : 0;

    console.log('Atualizar carta normalizado:', {
      id,
      parsedFugaAutomatica,
      parsedNivelFugaAutomatica
    });

    await ensureCategoryExists(categoria);

    const parsedUsoEmCombate =
      uso_em_combate === true ||
      uso_em_combate === 'true' ||
      uso_em_combate === 1 ||
      uso_em_combate === '1';

    const setClauses = [
      'nome_carta = $1',
      'tipo_carta = $2',
      'caminho_imagem = $3',
      'equipar_onde = $4',
      'n_pode_equipar = $5',
      'permite_mochila = $6',
      'forca = $7',
      'item = $8',
      'nivel = $9',
      'fulga_minima = $10',
      'categoria = $11',
      'texto_da_carta = $12',
      'qtd_max = $13',
      'valor = $14',
      'uso_em_combate = $15',
      'armadilha = $16',
      'pesado = $17'
    ];
    const params = [
      nome_carta,
      tipo_carta,
      caminho_imagem,
      equipar_onde || null,
      n_pode_equipar || null,
      parsedPermiteMochila,
      parsedForca,
      parsedItem,
      parsedNivel,
      parsedFulgaMinima,
      categoria || null,
      texto_da_carta || null,
      Number.isFinite(Number(qtd_max)) ? Number(qtd_max) : 1,
      Number.isFinite(Number(valor)) ? Number(valor) : 0,
      parsedUsoEmCombate,
      req.body.armadilha || null,
      pesado === true || pesado === 'true' || pesado === 1 || pesado === '1'
    ];

    params.push(id);
    const result = await pool.query(
      `UPDATE mtkin.cartas 
       SET ${setClauses.join(', ')}
         WHERE id = $${params.length}
       RETURNING *`,
        params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Carta não encontrada' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao atualizar carta:', error);
    res.status(500).json({ error: 'Erro ao atualizar carta' });
  }
});

// ============================================================================
// ENDPOINTS DE ARMADILHA
// ============================================================================

app.post('/api/armadilha/aplicar', authenticateToken, async (req, res) => {
  const actorUserId = req.user.id;
  const { cardId, targetUserId } = req.body;
  if (!cardId) return res.status(400).json({ error: 'cardId é obrigatório' });
  const effectiveTargetId = Number(targetUserId) || actorUserId;

  try {
    const cardResult = await pool.query(
      'SELECT id, nome_carta, tipo_carta, caminho_imagem, categoria, armadilha FROM mtkin.cartas WHERE id = $1',
      [cardId]
    );
    const card = cardResult.rows[0];
    if (!card) return res.status(404).json({ error: 'Carta não encontrada' });
    if (String(card.categoria || '').toLowerCase() !== 'armadilha') {
      return res.status(400).json({ error: 'Esta carta não é uma armadilha' });
    }

    let armadilha = null;
    try { armadilha = card.armadilha ? JSON.parse(card.armadilha) : null; } catch (e) { armadilha = null; }

    const targetRoomResult = await pool.query(
      `SELECT r.id FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true LIMIT 1`,
      [effectiveTargetId]
    );
    const targetRoomId = targetRoomResult.rows[0]?.id;
    if (!targetRoomId) return res.status(400).json({ error: 'Sala do alvo não encontrada' });

    const actorRoomResult = await pool.query(
      `SELECT r.id FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true LIMIT 1`,
      [actorUserId]
    );
    const actorRoomId = actorRoomResult.rows[0]?.id;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let effectApplied = false;
      let effectMessage = '';

      if (armadilha) {
        if (armadilha.tipo === 'perca_nivel') {
          const valor = Math.max(1, Number(armadilha.valor) || 1);
          await client.query(
            `UPDATE mtkin.sala_online SET nivel = GREATEST(nivel - $1, 1) WHERE id_player = $2`,
            [valor, effectiveTargetId]
          );
          effectApplied = true;
          effectMessage = `Perdeu ${valor} nível(is)`;

        } else if (armadilha.tipo === 'perca_item') {
          // itens pode ser um único slot ('79') ou múltiplos separados por ';' ('79;80')
          const slots = String(armadilha.itens || '').split(';').map(s => s.trim()).filter(Boolean);
          const perdidos = [];
          for (const slotNumber of slots) {
            const slotResult = await client.query(
              `SELECT ca.id_carta, ca.nome_carta, c.caminho_imagem, c.tipo_carta
               FROM mtkin.cartas_ativas ca
               JOIN mtkin.cartas c ON c.id = ca.id_carta
               WHERE ca.id_sala = $1 AND ca.id_jogador = $2 AND ca.id_slot = $3`,
              [targetRoomId, effectiveTargetId, slotNumber]
            );
            if (slotResult.rows.length > 0) {
              const { id_carta, nome_carta, caminho_imagem, tipo_carta } = slotResult.rows[0];
              const tipoBaralho = tipo_carta === 'Item' ? 'item' : 'cidade';
              await client.query(
                'DELETE FROM mtkin.cartas_ativas WHERE id_sala=$1 AND id_jogador=$2 AND id_slot=$3',
                [targetRoomId, effectiveTargetId, slotNumber]
              );
              await client.query(
                `INSERT INTO mtkin.descarte (id_sala, id_carta, nome_carta, tipo_baralho, caminho_imagem, id_jogador)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [targetRoomId, id_carta, nome_carta, tipoBaralho, caminho_imagem, effectiveTargetId]
              );
              await upsertDeckEstado(targetRoomId, id_carta, tipoBaralho, 'descarte', null, client, false);
              perdidos.push(nome_carta);
            }
          }
          if (perdidos.length > 0) {
            effectApplied = true;
            effectMessage = `Perdeu item(s): ${perdidos.join(', ')}`;
          } else if (slots.length === 0) {
            effectMessage = 'Nenhum slot configurado na armadilha';
          } else {
            effectMessage = `Nenhum item nos slot(s) ${slots.join(', ')}`;
          }

        } else if (armadilha.tipo === 'item_pesado') {
          const pesadoResult = await client.query(
            `SELECT ca.id_carta, ca.nome_carta, ca.id_slot, c.caminho_imagem, c.tipo_carta
             FROM mtkin.cartas_ativas ca
             JOIN mtkin.cartas c ON c.id = ca.id_carta
             WHERE ca.id_sala = $1 AND ca.id_jogador = $2 AND c.pesado = true
             ORDER BY RANDOM() LIMIT 1`,
            [targetRoomId, effectiveTargetId]
          );
          if (pesadoResult.rows.length > 0) {
            const { id_carta, nome_carta, id_slot, caminho_imagem, tipo_carta } = pesadoResult.rows[0];
            const tipoBaralho = tipo_carta === 'Item' ? 'item' : 'cidade';
            await client.query(
              'DELETE FROM mtkin.cartas_ativas WHERE id_sala=$1 AND id_jogador=$2 AND id_slot=$3',
              [targetRoomId, effectiveTargetId, id_slot]
            );
            await client.query(
              `INSERT INTO mtkin.descarte (id_sala, id_carta, nome_carta, tipo_baralho, caminho_imagem, id_jogador)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [targetRoomId, id_carta, nome_carta, tipoBaralho, caminho_imagem, effectiveTargetId]
            );
            await upsertDeckEstado(targetRoomId, id_carta, tipoBaralho, 'descarte', null, client, false);
            effectApplied = true;
            effectMessage = `Perdeu item pesado: ${nome_carta}`;
          } else {
            effectMessage = 'Nenhum item pesado equipado';
          }

        } else if (armadilha.tipo === 'customizado') {
          const regraId = Number(armadilha.regra_id) || 0;

          if (regraId === 1) {
            // ── Regra 1: perder item aleatório NÃO pesado (cartela ou mochila) ──
            const nPesadoCartela = await client.query(
              `SELECT ca.id_carta, ca.nome_carta, ca.id_slot, c.caminho_imagem, c.tipo_carta
               FROM mtkin.cartas_ativas ca
               JOIN mtkin.cartas c ON c.id = ca.id_carta
               WHERE ca.id_sala = $1 AND ca.id_jogador = $2
                 AND COALESCE(c.pesado, false) = false
                 AND ca.id_slot NOT IN ('79')
               ORDER BY RANDOM()`,
              [targetRoomId, effectiveTargetId]
            );
            const nPesadoMochila = await client.query(
              `SELECT m.id_carta, c.nome_carta, c.caminho_imagem, c.tipo_carta
               FROM mtkin.mochila m
               JOIN mtkin.cartas c ON c.id = m.id_carta
               WHERE m.id_sala = $1 AND m.id_jogador = $2
                 AND COALESCE(c.pesado, false) = false
               ORDER BY RANDOM()`,
              [targetRoomId, effectiveTargetId]
            );
            const allNPesado = [
              ...nPesadoCartela.rows.map(r => ({ ...r, origem: 'cartela' })),
              ...nPesadoMochila.rows.map(r => ({ ...r, origem: 'mochila' }))
            ];
            if (allNPesado.length > 0) {
              const chosen = allNPesado[Math.floor(Math.random() * allNPesado.length)];
              const tipoBaralho = chosen.tipo_carta === 'Item' ? 'item' : 'cidade';
              if (chosen.origem === 'cartela') {
                await client.query(
                  'DELETE FROM mtkin.cartas_ativas WHERE id_sala=$1 AND id_jogador=$2 AND id_slot=$3',
                  [targetRoomId, effectiveTargetId, chosen.id_slot]
                );
              } else {
                await client.query(
                  'DELETE FROM mtkin.mochila WHERE id_sala=$1 AND id_jogador=$2 AND id_carta=$3',
                  [targetRoomId, effectiveTargetId, chosen.id_carta]
                );
              }
              await client.query(
                `INSERT INTO mtkin.descarte (id_sala, id_carta, nome_carta, tipo_baralho, caminho_imagem, id_jogador)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [targetRoomId, chosen.id_carta, chosen.nome_carta, tipoBaralho, chosen.caminho_imagem, effectiveTargetId]
              );
              await upsertDeckEstado(targetRoomId, chosen.id_carta, tipoBaralho, 'descarte', null, client, false);
              effectApplied = true;
              effectMessage = `Perdeu item (não pesado): ${chosen.nome_carta}`;
            } else {
              effectMessage = 'Nenhum item não-pesado para perder';
            }

          } else if (regraId === 2) {
            // ── Regra 2: jogador alvo descarta carta com valor>0, depois outros descartam com valor>=min ──
            // Cria pendência — a resolução é via modal no frontend + polling
            await client.query(
              `INSERT INTO mtkin.armadilha_pendente (id_sala, regra_id, id_carta_armadilha, id_jogador_alvo, id_jogador_ator, dados, status)
               VALUES ($1, 2, $2, $3, $4, $5, 'aguardando_alvo')`,
              [targetRoomId, cardId, effectiveTargetId, actorUserId, JSON.stringify({ fase: 'alvo', valor_minimo: null })]
            );
            effectApplied = true;
            effectMessage = 'Maldição! Descarte uma carta com valor.';

          } else if (regraId === 3) {
            // ── Regra 3: trocar slot 79 por Sobrevivente do descarte ──
            const sobreviventeResult = await client.query(
              `SELECT d.id AS descarte_id, d.id_carta, d.nome_carta, d.caminho_imagem, d.tipo_baralho
               FROM mtkin.descarte d
               JOIN mtkin.cartas c ON c.id = d.id_carta
               WHERE d.id_sala = $1 AND LOWER(c.categoria) = 'sobrevivente'
               ORDER BY d.descartado_em DESC LIMIT 1`,
              [targetRoomId]
            );
            // Pegar carta atual no slot 79
            const slot79Result = await client.query(
              `SELECT ca.id_carta, ca.nome_carta, c.caminho_imagem, c.tipo_carta
               FROM mtkin.cartas_ativas ca
               JOIN mtkin.cartas c ON c.id = ca.id_carta
               WHERE ca.id_sala = $1 AND ca.id_jogador = $2 AND ca.id_slot = '79'`,
              [targetRoomId, effectiveTargetId]
            );
            if (slot79Result.rows.length > 0) {
              const old79 = slot79Result.rows[0];
              const tipoBaralho79 = old79.tipo_carta === 'Item' ? 'item' : 'cidade';
              // Remover carta antiga do slot 79
              await client.query(
                'DELETE FROM mtkin.cartas_ativas WHERE id_sala=$1 AND id_jogador=$2 AND id_slot=$3',
                [targetRoomId, effectiveTargetId, '79']
              );
              await client.query(
                `INSERT INTO mtkin.descarte (id_sala, id_carta, nome_carta, tipo_baralho, caminho_imagem, id_jogador)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [targetRoomId, old79.id_carta, old79.nome_carta, tipoBaralho79, old79.caminho_imagem, effectiveTargetId]
              );
              await upsertDeckEstado(targetRoomId, old79.id_carta, tipoBaralho79, 'descarte', null, client, false);
              effectApplied = true;
              effectMessage = `Perdeu personagem do slot 79: ${old79.nome_carta}`;
            }
            if (sobreviventeResult.rows.length > 0) {
              const sobrev = sobreviventeResult.rows[0];
              // Remover do descarte
              await client.query('DELETE FROM mtkin.descarte WHERE id = $1', [sobrev.descarte_id]);
              // Buscar nome do jogador
              const playerNameResult = await client.query('SELECT username FROM mtkin.users WHERE id = $1', [effectiveTargetId]);
              const playerName = playerNameResult.rows[0]?.username || 'jogador';
              // Inserir no slot 79
              const roomNameResult = await client.query('SELECT room_name FROM mtkin.rooms WHERE id = $1', [targetRoomId]);
              const roomName = roomNameResult.rows[0]?.room_name || '';
              await client.query(
                `INSERT INTO mtkin.cartas_ativas (id_sala, nome_sala, id_jogador, nome_jogador, id_carta, nome_carta, id_slot)
                 VALUES ($1, $2, $3, $4, $5, $6, '79')
                 ON CONFLICT (id_sala, id_jogador, id_slot) DO UPDATE SET id_carta = EXCLUDED.id_carta, nome_carta = EXCLUDED.nome_carta`,
                [targetRoomId, roomName, effectiveTargetId, playerName, sobrev.id_carta, sobrev.nome_carta]
              );
              await upsertDeckEstado(targetRoomId, sobrev.id_carta, sobrev.tipo_baralho, 'cartela', effectiveTargetId, client, false);
              effectApplied = true;
              effectMessage = `Personagem trocado! Novo: ${sobrev.nome_carta}`;
            } else if (!effectApplied) {
              effectMessage = 'Slot 79 vazio e nenhum Sobrevivente no descarte';
            } else {
              effectMessage += ' (nenhum Sobrevivente no descarte para substituir)';
            }

          } else if (regraId === 4) {
            // ── Regra 4: jogadores adjacentes podem pegar carta da mochila do alvo ──
            const roomInfoResult = await client.query(
              `SELECT ordem_turno, turno_atual_index FROM mtkin.rooms WHERE id = $1`,
              [targetRoomId]
            );
            const ordem = roomInfoResult.rows[0]?.ordem_turno || [];
            const targetIdx = ordem.indexOf(effectiveTargetId);
            // Jogadores adjacentes (próximo e anterior na ordem circular)
            const adjacentes = [];
            if (ordem.length >= 2 && targetIdx >= 0) {
              const nextIdx = (targetIdx + 1) % ordem.length;
              const prevIdx = (targetIdx - 1 + ordem.length) % ordem.length;
              adjacentes.push(ordem[nextIdx]); // próximo primeiro
              if (ordem[prevIdx] !== ordem[nextIdx]) {
                adjacentes.push(ordem[prevIdx]); // anterior (se diferente)
              }
            }
            // Verificar se tem cartas na mochila
            const mochilaCount = await client.query(
              `SELECT COUNT(*) AS total FROM mtkin.mochila WHERE id_sala=$1 AND id_jogador=$2`,
              [targetRoomId, effectiveTargetId]
            );
            const totalMochila = parseInt(mochilaCount.rows[0]?.total) || 0;
            if (totalMochila > 0 && adjacentes.length > 0) {
              // Se só 1 carta, só o próximo pode pegar
              const eligible = totalMochila === 1 ? [adjacentes[0]] : adjacentes;
              await client.query(
                `INSERT INTO mtkin.armadilha_pendente (id_sala, regra_id, id_carta_armadilha, id_jogador_alvo, id_jogador_ator, dados, status)
                 VALUES ($1, 4, $2, $3, $4, $5, 'aguardando_escolha')`,
                [targetRoomId, cardId, effectiveTargetId, actorUserId,
                 JSON.stringify({ jogadores_elegives: eligible, ja_pegaram: [], total_mochila: totalMochila })]
              );
              effectApplied = true;
              effectMessage = 'Maldição! Jogadores adjacentes podem pegar cartas da sua mochila.';
            } else {
              effectMessage = totalMochila === 0 ? 'Mochila vazia — nada a perder' : 'Sem jogadores adjacentes';
            }

          } else if (regraId === 5) {
            // ── Regra 5: perder item aleatório da mochila ──
            const mochilaRandom = await client.query(
              `SELECT m.id, m.id_carta, c.nome_carta, c.caminho_imagem, c.tipo_carta
               FROM mtkin.mochila m
               JOIN mtkin.cartas c ON c.id = m.id_carta
               WHERE m.id_sala = $1 AND m.id_jogador = $2
               ORDER BY RANDOM() LIMIT 1`,
              [targetRoomId, effectiveTargetId]
            );
            if (mochilaRandom.rows.length > 0) {
              const mItem = mochilaRandom.rows[0];
              const tipoBaralho = mItem.tipo_carta === 'Item' ? 'item' : 'cidade';
              await client.query('DELETE FROM mtkin.mochila WHERE id = $1', [mItem.id]);
              await client.query(
                `INSERT INTO mtkin.descarte (id_sala, id_carta, nome_carta, tipo_baralho, caminho_imagem, id_jogador)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [targetRoomId, mItem.id_carta, mItem.nome_carta, tipoBaralho, mItem.caminho_imagem, effectiveTargetId]
              );
              await upsertDeckEstado(targetRoomId, mItem.id_carta, tipoBaralho, 'descarte', null, client, false);
              effectApplied = true;
              effectMessage = `Perdeu item da mochila: ${mItem.nome_carta}`;
            } else {
              effectMessage = 'Mochila vazia — nada a perder';
            }

          } else {
            effectMessage = 'Regra customizada desconhecida';
          }
        }
      } else {
        effectMessage = 'Armadilha sem configuração';
      }

      // Descartar a carta de armadilha da mão/mochila do ator
      if (actorRoomId) {
        await client.query(
          'DELETE FROM mtkin.cartas_no_jogo WHERE id_sala=$1 AND id_jogador=$2 AND id_carta=$3',
          [actorRoomId, actorUserId, cardId]
        );
        await client.query(
          'DELETE FROM mtkin.mochila WHERE id_sala=$1 AND id_jogador=$2 AND id_carta=$3',
          [actorRoomId, actorUserId, cardId]
        );
        await client.query(
          `INSERT INTO mtkin.descarte (id_sala, id_carta, nome_carta, tipo_baralho, caminho_imagem, id_jogador)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [actorRoomId, card.id, card.nome_carta, 'cidade', card.caminho_imagem, actorUserId]
        );
        await upsertDeckEstado(actorRoomId, card.id, 'cidade', 'descarte', null, client, false);
      }

      if (effectApplied) {
        await recalcularTabuleiroJogador(effectiveTargetId, targetRoomId, client);
      }

      await client.query('COMMIT');
      res.json({ message: effectMessage, applied: effectApplied });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Erro ao aplicar armadilha:', error);
    res.status(500).json({ error: 'Erro ao aplicar armadilha' });
  }
});

// ============================================================================
// ENDPOINTS DE ARMADILHA PENDENTE (Regras Customizadas Cross-Player)
// ============================================================================

// Polling: verifica se o jogador tem alguma armadilha pendente para responder
app.get('/api/armadilha/pendente', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const roomResult = await pool.query(
      `SELECT r.id FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true AND r.status = 'playing' LIMIT 1`,
      [userId]
    );
    if (roomResult.rows.length === 0) return res.json({ pendentes: [] });
    const roomId = roomResult.rows[0].id;

    const pendentes = await pool.query(
      `SELECT id, regra_id, id_jogador_alvo, id_jogador_ator, dados, status, created_at
       FROM mtkin.armadilha_pendente
       WHERE id_sala = $1 AND status NOT IN ('concluido', 'cancelado')
       ORDER BY created_at ASC`,
      [roomId]
    );

    // Filtrar: mostrar apenas as que envolvem este jogador
    const result = pendentes.rows.filter(p => {
      if (p.regra_id === 2) {
        if (p.status === 'aguardando_alvo' && p.id_jogador_alvo === userId) return true;
        if (p.status === 'aguardando_outros') {
          const dados = p.dados || {};
          const jaResponderam = dados.ja_responderam || [];
          return p.id_jogador_alvo !== userId && !jaResponderam.includes(userId);
        }
        return false;
      }
      if (p.regra_id === 4) {
        if (p.status === 'aguardando_escolha') {
          const dados = p.dados || {};
          const eligible = dados.jogadores_elegives || [];
          const jaPegaram = dados.ja_pegaram || [];
          return eligible.includes(userId) && !jaPegaram.includes(userId);
        }
        return false;
      }
      // Isca 2 roubo: ator precisa escolher carta do alvo
      if (p.regra_id === 102) {
        return p.status === 'aguardando_escolha' && p.id_jogador_ator === userId;
      }
      // Isca 88/89: ator escolhe cartas do descarte
      if (p.regra_id === 188 || p.regra_id === 189) {
        return p.status === 'aguardando_escolha' && p.id_jogador_ator === userId;
      }
      return false;
    });

    // Enriquecer com dados necessários para o modal
    const enriched = [];
    for (const p of result) {
      const item = { ...p };
      if (p.regra_id === 2) {
        // Buscar cartas do jogador com valor conforme fase
        if (p.status === 'aguardando_alvo') {
          const cartas = await pool.query(
            `SELECT ca.id_carta, ca.id_slot, c.nome_carta, c.caminho_imagem, c.valor,
                    c.texto_da_carta, c.equipar_onde, c.forca, c.fulga_minima, c.nivel, c.pesado
             FROM mtkin.cartas_ativas ca
             JOIN mtkin.cartas c ON c.id = ca.id_carta
             WHERE ca.id_sala = $1 AND ca.id_jogador = $2 AND COALESCE(c.valor, 0) > 0`,
            [roomId, userId]
          );
          const mochilaCartas = await pool.query(
            `SELECT m.id_carta, c.nome_carta, c.caminho_imagem, c.valor,
                    c.texto_da_carta, c.equipar_onde, c.forca, c.fulga_minima, c.nivel, c.pesado
             FROM mtkin.mochila m
             JOIN mtkin.cartas c ON c.id = m.id_carta
             WHERE m.id_sala = $1 AND m.id_jogador = $2 AND COALESCE(c.valor, 0) > 0`,
            [roomId, userId]
          );
          item.cartas_disponiveis = [
            ...cartas.rows.map(r => ({ ...r, origem: 'cartela' })),
            ...mochilaCartas.rows.map(r => ({ ...r, origem: 'mochila' }))
          ];
        } else if (p.status === 'aguardando_outros') {
          const valorMinimo = (p.dados || {}).valor_minimo || 0;
          const cartas = await pool.query(
            `SELECT ca.id_carta, ca.id_slot, c.nome_carta, c.caminho_imagem, c.valor,
                    c.texto_da_carta, c.equipar_onde, c.forca, c.fulga_minima, c.nivel, c.pesado
             FROM mtkin.cartas_ativas ca
             JOIN mtkin.cartas c ON c.id = ca.id_carta
             WHERE ca.id_sala = $1 AND ca.id_jogador = $2 AND COALESCE(c.valor, 0) >= $3`,
            [roomId, userId, valorMinimo]
          );
          const mochilaCartas = await pool.query(
            `SELECT m.id_carta, c.nome_carta, c.caminho_imagem, c.valor,
                    c.texto_da_carta, c.equipar_onde, c.forca, c.fulga_minima, c.nivel, c.pesado
             FROM mtkin.mochila m
             JOIN mtkin.cartas c ON c.id = m.id_carta
             WHERE m.id_sala = $1 AND m.id_jogador = $2 AND COALESCE(c.valor, 0) >= $3`,
            [roomId, userId, valorMinimo]
          );
          item.cartas_disponiveis = [
            ...cartas.rows.map(r => ({ ...r, origem: 'cartela' })),
            ...mochilaCartas.rows.map(r => ({ ...r, origem: 'mochila' }))
          ];
          item.valor_minimo = valorMinimo;
        }
      } else if (p.regra_id === 4) {
        // Buscar mochila do alvo
        const mochilaAlvo = await pool.query(
          `SELECT m.id_carta, c.nome_carta, c.caminho_imagem, c.tipo_carta, c.valor,
                  c.texto_da_carta, c.equipar_onde, c.forca, c.fulga_minima, c.nivel, c.pesado
           FROM mtkin.mochila m
           JOIN mtkin.cartas c ON c.id = m.id_carta
           WHERE m.id_sala = $1 AND m.id_jogador = $2`,
          [roomId, p.id_jogador_alvo]
        );
        const alvoNome = await pool.query('SELECT username FROM mtkin.users WHERE id=$1', [p.id_jogador_alvo]);
        item.mochila_alvo = mochilaAlvo.rows;
        item.nome_alvo = alvoNome.rows[0]?.username || 'jogador';
      } else if (p.regra_id === 102) {
        // Buscar cartela + mochila do alvo para o ator escolher
        const cartelaAlvo = await pool.query(
          `SELECT ca.id_carta, ca.id_slot, c.nome_carta, c.caminho_imagem, c.tipo_carta, c.valor,
                  c.texto_da_carta, c.equipar_onde, c.forca, c.fulga_minima, c.nivel, c.pesado
           FROM mtkin.cartas_ativas ca
           JOIN mtkin.cartas c ON c.id = ca.id_carta
           WHERE ca.id_sala = $1 AND ca.id_jogador = $2`,
          [roomId, p.id_jogador_alvo]
        );
        const mochilaAlvo = await pool.query(
          `SELECT m.id_carta, c.nome_carta, c.caminho_imagem, c.tipo_carta, c.valor,
                  c.texto_da_carta, c.equipar_onde, c.forca, c.fulga_minima, c.nivel, c.pesado
           FROM mtkin.mochila m
           JOIN mtkin.cartas c ON c.id = m.id_carta
           WHERE m.id_sala = $1 AND m.id_jogador = $2`,
          [roomId, p.id_jogador_alvo]
        );
        const alvoNome = await pool.query('SELECT username FROM mtkin.users WHERE id=$1', [p.id_jogador_alvo]);
        item.cartas_alvo = [
          ...cartelaAlvo.rows.map(r => ({ ...r, origem: 'cartela' })),
          ...mochilaAlvo.rows.map(r => ({ ...r, origem: 'mochila' }))
        ];
        item.nome_alvo = alvoNome.rows[0]?.username || 'jogador';
      } else if (p.regra_id === 188 || p.regra_id === 189) {
        const apenasItem = p.regra_id === 188 || (p.dados && p.dados.only_item === true);
        const descarteParams = [roomId];
        let descarteWhere = 'WHERE d.id_sala = $1';
        if (apenasItem) {
          descarteParams.push('item');
          descarteWhere += ' AND d.tipo_baralho = $2';
        }
        const descarte = await pool.query(
          `SELECT d.id, d.id_carta, d.nome_carta, d.tipo_baralho,
                  COALESCE(c.caminho_imagem, d.caminho_imagem) AS caminho_imagem,
                  c.texto_da_carta, c.equipar_onde, c.forca, c.fulga_minima,
                  c.nivel, c.valor, c.pesado,
                  d.descartado_em
           FROM mtkin.descarte d
           LEFT JOIN mtkin.cartas c ON c.id = d.id_carta
           ${descarteWhere}
           ORDER BY d.descartado_em DESC`,
          descarteParams
        );
        item.cartas_descarte = descarte.rows;
        item.apenas_item = apenasItem;
      }
      enriched.push(item);
    }

    res.json({ pendentes: enriched });
  } catch (error) {
    console.error('Erro ao buscar armadilha pendente:', error);
    res.status(500).json({ error: 'Erro ao buscar armadilha pendente' });
  }
});

// Responder a regra_id:2 — jogador descarta carta com valor
app.post('/api/armadilha/pendente/regra2/responder', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { pendenteId, cardId, origem, slotId } = req.body;
  if (!pendenteId || !cardId) return res.status(400).json({ error: 'pendenteId e cardId são obrigatórios' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pendResult = await client.query(
      'SELECT * FROM mtkin.armadilha_pendente WHERE id=$1 FOR UPDATE', [pendenteId]
    );
    const pend = pendResult.rows[0];
    if (!pend) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Pendência não encontrada' }); }

    const roomId = pend.id_sala;

    // Buscar a carta que será descartada
    const cardResult = await client.query(
      'SELECT id, nome_carta, caminho_imagem, tipo_carta, valor FROM mtkin.cartas WHERE id=$1', [cardId]
    );
    const carta = cardResult.rows[0];
    if (!carta) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Carta não encontrada' }); }
    const tipoBaralho = carta.tipo_carta === 'Item' ? 'item' : 'cidade';

    if (pend.status === 'aguardando_alvo' && pend.id_jogador_alvo === userId) {
      // Alvo descartando — verificar valor > 0
      if ((carta.valor || 0) <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'A carta precisa ter valor maior que 0' });
      }
      // Remover a carta do jogador
      if (origem === 'cartela' && slotId) {
        await client.query('DELETE FROM mtkin.cartas_ativas WHERE id_sala=$1 AND id_jogador=$2 AND id_slot=$3', [roomId, userId, slotId]);
      } else {
        await client.query('DELETE FROM mtkin.mochila WHERE id_sala=$1 AND id_jogador=$2 AND id_carta=$3', [roomId, userId, cardId]);
      }
      await client.query(
        `INSERT INTO mtkin.descarte (id_sala, id_carta, nome_carta, tipo_baralho, caminho_imagem, id_jogador)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [roomId, cardId, carta.nome_carta, tipoBaralho, carta.caminho_imagem, userId]
      );
      await upsertDeckEstado(roomId, cardId, tipoBaralho, 'descarte', null, client, false);
      await recalcularTabuleiroJogador(userId, roomId, client);

      // Atualizar pendência para fase de outros jogadores
      const dados = { ...(pend.dados || {}), fase: 'outros', valor_minimo: carta.valor, ja_responderam: [] };
      await client.query(
        `UPDATE mtkin.armadilha_pendente SET status='aguardando_outros', dados=$1 WHERE id=$2`,
        [JSON.stringify(dados), pendenteId]
      );
      await client.query('COMMIT');
      res.json({ message: `Descartou: ${carta.nome_carta} (valor ${carta.valor})` });

    } else if (pend.status === 'aguardando_outros') {
      // Outros jogadores descartando — verificar valor >= minimo
      const valorMinimo = (pend.dados || {}).valor_minimo || 0;
      if ((carta.valor || 0) < valorMinimo) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `A carta precisa ter valor >= ${valorMinimo}` });
      }
      // Remover a carta do jogador
      if (origem === 'cartela' && slotId) {
        await client.query('DELETE FROM mtkin.cartas_ativas WHERE id_sala=$1 AND id_jogador=$2 AND id_slot=$3', [roomId, userId, slotId]);
      } else {
        await client.query('DELETE FROM mtkin.mochila WHERE id_sala=$1 AND id_jogador=$2 AND id_carta=$3', [roomId, userId, cardId]);
      }
      await client.query(
        `INSERT INTO mtkin.descarte (id_sala, id_carta, nome_carta, tipo_baralho, caminho_imagem, id_jogador)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [roomId, cardId, carta.nome_carta, tipoBaralho, carta.caminho_imagem, userId]
      );
      await upsertDeckEstado(roomId, cardId, tipoBaralho, 'descarte', null, client, false);
      await recalcularTabuleiroJogador(userId, roomId, client);

      // Registrar que este jogador já respondeu
      const dados = { ...(pend.dados || {}) };
      dados.ja_responderam = [...(dados.ja_responderam || []), userId];

      // Verificar se todos já responderam
      const roomPlayers = await client.query(
        `SELECT user_id FROM mtkin.room_participants WHERE room_id=$1`, [roomId]
      );
      const allPlayers = roomPlayers.rows.map(r => r.user_id).filter(id => id !== pend.id_jogador_alvo);
      const allResponded = allPlayers.every(id => dados.ja_responderam.includes(id));

      if (allResponded) {
        await client.query('UPDATE mtkin.armadilha_pendente SET status=$1, dados=$2 WHERE id=$3',
          ['concluido', JSON.stringify(dados), pendenteId]);
      } else {
        await client.query('UPDATE mtkin.armadilha_pendente SET dados=$1 WHERE id=$2',
          [JSON.stringify(dados), pendenteId]);
      }
      await client.query('COMMIT');
      res.json({ message: `Descartou: ${carta.nome_carta}` });
    } else {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Não é sua vez de responder' });
    }
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao responder regra 2:', error);
    res.status(500).json({ error: 'Erro ao processar resposta' });
  } finally {
    client.release();
  }
});

// Responder a regra_id:4 — jogador pega carta da mochila do alvo
app.post('/api/armadilha/pendente/regra4/pegar', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { pendenteId, cardId } = req.body;
  if (!pendenteId || !cardId) return res.status(400).json({ error: 'pendenteId e cardId são obrigatórios' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pendResult = await client.query(
      'SELECT * FROM mtkin.armadilha_pendente WHERE id=$1 FOR UPDATE', [pendenteId]
    );
    const pend = pendResult.rows[0];
    if (!pend || pend.status !== 'aguardando_escolha') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Pendência inválida ou já concluída' });
    }

    const dados = pend.dados || {};
    const eligible = dados.jogadores_elegives || [];
    const jaPegaram = dados.ja_pegaram || [];

    if (!eligible.includes(userId) || jaPegaram.includes(userId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Você não pode pegar uma carta' });
    }

    const roomId = pend.id_sala;
    const alvoId = pend.id_jogador_alvo;

    // Verificar se a carta está na mochila do alvo
    const mochilaResult = await client.query(
      `SELECT m.id, m.id_carta FROM mtkin.mochila WHERE m.id_sala=$1 AND m.id_jogador=$2 AND m.id_carta=$3`,
      [roomId, alvoId, cardId]
    );
    if (mochilaResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Carta não encontrada na mochila do alvo' });
    }

    // Remover da mochila do alvo
    await client.query(
      'DELETE FROM mtkin.mochila WHERE id_sala=$1 AND id_jogador=$2 AND id_carta=$3',
      [roomId, alvoId, cardId]
    );

    // Adicionar à mochila do jogador que pegou
    await client.query(
      `INSERT INTO mtkin.mochila (id_sala, id_jogador, id_carta, origem_tabela) VALUES ($1, $2, $3, 'maldição')`,
      [roomId, userId, cardId]
    );
    await upsertDeckEstado(roomId, cardId, 'item', 'mochila', userId, client, false);

    // Buscar nome da carta para mensagem
    const cartaResult = await client.query('SELECT nome_carta FROM mtkin.cartas WHERE id=$1', [cardId]);
    const nomeCarta = cartaResult.rows[0]?.nome_carta || 'carta';

    // Atualizar dados da pendência
    dados.ja_pegaram = [...jaPegaram, userId];
    const allDone = eligible.every(id => dados.ja_pegaram.includes(id));
    if (allDone) {
      await client.query('UPDATE mtkin.armadilha_pendente SET status=$1, dados=$2 WHERE id=$3',
        ['concluido', JSON.stringify(dados), pendenteId]);
    } else {
      await client.query('UPDATE mtkin.armadilha_pendente SET dados=$1 WHERE id=$2',
        [JSON.stringify(dados), pendenteId]);
    }

    await client.query('COMMIT');
    res.json({ message: `Pegou da mochila: ${nomeCarta}` });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao pegar carta regra 4:', error);
    res.status(500).json({ error: 'Erro ao processar' });
  } finally {
    client.release();
  }
});

// Pular regra_id:4 — jogador não quer pegar carta
app.post('/api/armadilha/pendente/regra4/pular', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { pendenteId } = req.body;
  if (!pendenteId) return res.status(400).json({ error: 'pendenteId é obrigatório' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pendResult = await client.query(
      'SELECT * FROM mtkin.armadilha_pendente WHERE id=$1 FOR UPDATE', [pendenteId]
    );
    const pend = pendResult.rows[0];
    if (!pend || pend.status !== 'aguardando_escolha') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Pendência inválida' });
    }
    const dados = pend.dados || {};
    const eligible = dados.jogadores_elegives || [];
    const jaPegaram = dados.ja_pegaram || [];
    if (!eligible.includes(userId) || jaPegaram.includes(userId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Ação não permitida' });
    }
    dados.ja_pegaram = [...jaPegaram, userId];
    const allDone = eligible.every(id => dados.ja_pegaram.includes(id));
    if (allDone) {
      await client.query('UPDATE mtkin.armadilha_pendente SET status=$1, dados=$2 WHERE id=$3',
        ['concluido', JSON.stringify(dados), pendenteId]);
    } else {
      await client.query('UPDATE mtkin.armadilha_pendente SET dados=$1 WHERE id=$2',
        [JSON.stringify(dados), pendenteId]);
    }
    await client.query('COMMIT');
    res.json({ message: 'Pulou' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao pular regra 4:', error);
    res.status(500).json({ error: 'Erro ao processar' });
  } finally {
    client.release();
  }
});

// Pular regra_id:2 — jogador não tem carta para descartar
app.post('/api/armadilha/pendente/regra2/pular', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { pendenteId } = req.body;
  if (!pendenteId) return res.status(400).json({ error: 'pendenteId é obrigatório' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pendResult = await client.query(
      'SELECT * FROM mtkin.armadilha_pendente WHERE id=$1 FOR UPDATE', [pendenteId]
    );
    const pend = pendResult.rows[0];
    if (!pend) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Pendência não encontrada' }); }
    const roomId = pend.id_sala;

    if (pend.status === 'aguardando_outros') {
      const dados = { ...(pend.dados || {}) };
      dados.ja_responderam = [...(dados.ja_responderam || []), userId];
      const roomPlayers = await client.query(
        `SELECT user_id FROM mtkin.room_participants WHERE room_id=$1`, [roomId]
      );
      const allPlayers = roomPlayers.rows.map(r => r.user_id).filter(id => id !== pend.id_jogador_alvo);
      const allResponded = allPlayers.every(id => dados.ja_responderam.includes(id));
      if (allResponded) {
        await client.query('UPDATE mtkin.armadilha_pendente SET status=$1, dados=$2 WHERE id=$3',
          ['concluido', JSON.stringify(dados), pendenteId]);
      } else {
        await client.query('UPDATE mtkin.armadilha_pendente SET dados=$1 WHERE id=$2',
          [JSON.stringify(dados), pendenteId]);
      }
      await client.query('COMMIT');
      res.json({ message: 'Pulou (sem carta com valor suficiente)' });
    } else {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Fase inválida para pular' });
    }
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao pular regra 2:', error);
    res.status(500).json({ error: 'Erro ao processar' });
  } finally {
    client.release();
  }
});

// ============================================================================
// ENDPOINTS DE REGRAS CUSTOMIZADAS
// ============================================================================

// Listar todas as regras customizadas
app.get('/api/regras-customizadas', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, texto FROM mtkin.regras_customizadas ORDER BY id'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar regras customizadas:', error);
    res.status(500).json({ error: 'Erro ao buscar regras customizadas' });
  }
});

// Criar nova regra customizada
app.post('/api/regras-customizadas', authenticateToken, async (req, res) => {
  const { texto } = req.body;
  if (!texto || typeof texto !== 'string' || texto.trim().length === 0) {
    return res.status(400).json({ error: 'Texto da regra é obrigatório' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO mtkin.regras_customizadas (texto) VALUES ($1) RETURNING id, texto',
      [texto.trim()]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao criar regra customizada:', error);
    res.status(500).json({ error: 'Erro ao criar regra customizada' });
  }
});

// ============================================================================
// ENDPOINTS DE COMBATE
// ============================================================================

// Buscar detalhes de uma carta de item
app.get('/api/cards/item/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await pool.query(
      'SELECT * FROM mtkin.cartas WHERE id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Carta não encontrada' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao buscar carta de item:', error);
    res.status(500).json({ error: 'Erro ao buscar carta' });
  }
});

// Adicionar carta ao combate
app.post('/api/combate/add-card', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { combatId, cardId, side, sourceSlot, sourceBag, mochilaId } = req.body;
  
  console.log('📡 [COMBATE/ADD] Requisição:', { userId, combatId, cardId, side, sourceSlot, sourceBag, mochilaId });
  
  if (!combatId || !cardId || !side || (side !== 'monstro' && side !== 'jogador')) {
    return res.status(400).json({ error: 'Dados inválidos' });
  }
  
  try {
    // Buscar sala do jogador
    const roomResult = await pool.query(
      `SELECT r.id, r.room_name, r.simulador
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true`,
      [userId]
    );
    
    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: 'Sala não encontrada' });
    }
    
    const room = roomResult.rows[0];
    const simFlagCombate = room.simulador === 'ativado';
    
    // Buscar informações da carta de item (forca = bônus de combate)
    const cardResult = await pool.query(
      'SELECT id, nome_carta, tipo_carta, forca AS bonus, forca, caminho_imagem, uso_em_combate AS descartar_apos_uso FROM mtkin.cartas WHERE id = $1',
      [cardId]
    );
    
    if (cardResult.rows.length === 0) {
      return res.status(404).json({ error: 'Carta não encontrada' });
    }
    
    const card = cardResult.rows[0];
    // forca é o bônus real de combate (a view tem bonus = NULL sempre)
    const bonusParaCombate = card.forca || card.bonus || 0;
    
    // Inserir no combate
    const insertResult = await pool.query(
      `INSERT INTO mtkin.combate_cartas 
       (id_sala, id_combate, id_jogador, nome_jogador, id_carta, nome_carta, tipo_carta, bonus, lado, caminho_imagem, descartar_apos_uso, simulado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [room.id, combatId, userId, req.user.username, card.id, card.nome_carta, card.tipo_carta, 
       bonusParaCombate, side, card.caminho_imagem, card.descartar_apos_uso, simFlagCombate]
    );
    
    // Se tem sourceSlot, remover da cartela e recalcular tabuleiro
    if (sourceSlot) {
      await pool.query(
        `DELETE FROM mtkin.cartas_ativas 
         WHERE id_sala = $1 AND id_jogador = $2 AND id_slot = $3`,
        [room.id, userId, String(sourceSlot)]
      );
      await recalcularTabuleiroJogador(userId, room.id);
    } else if (sourceBag && mochilaId) {
      // Remover da mochila
      console.log('🗑️ [COMBATE/ADD] Removendo carta da mochila:', mochilaId);
      await pool.query(
        'DELETE FROM mtkin.mochila WHERE id = $1 AND id_jogador = $2',
        [mochilaId, userId]
      );
    } else {
      // Remover da mão (apenas uma instância da carta, qualquer tipo_baralho)
      console.log('🗑️ [COMBATE/ADD] Removendo carta da mão (cartas_no_jogo)');
      await pool.query(
        `DELETE FROM mtkin.cartas_no_jogo 
         WHERE ctid = (
           SELECT ctid FROM mtkin.cartas_no_jogo 
           WHERE id_sala = $1 AND id_jogador = $2 AND id_carta = $3
           LIMIT 1
         )`,
        [room.id, userId, card.id]
      );
    }
    
    console.log('✅ [COMBATE/ADD] Carta adicionada:', insertResult.rows[0].id);

    // Rastrear no deck_estado: carta entrou no combate
    await upsertDeckEstado(room.id, card.id, 'item', 'combate', userId, null, simFlagCombate);

    res.json({
      message: 'Carta adicionada ao combate',
      combatCardId: insertResult.rows[0].id,
      card: card
    });
    
  } catch (error) {
    console.error('❌ [COMBATE/ADD] Erro:', error);
    res.status(500).json({ error: 'Erro ao adicionar carta ao combate' });
  }
});

// ============================================================================
// ENDPOINT DE CARTAS ISCA (categoria = 'Isca')
// ============================================================================
app.post('/api/combate/isca', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { cardId, combatId, targetPlayerId, side } = req.body;
  if (!cardId) return res.status(400).json({ error: 'cardId é obrigatório' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Buscar sala
    const roomResult = await client.query(
      `SELECT r.id, r.room_name, r.ordem_turno, r.simulador
       FROM mtkin.rooms r JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true LIMIT 1`,
      [userId]
    );
    if (roomResult.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Sala não encontrada' }); }
    const room = roomResult.rows[0];
    const roomId = room.id;
    const simFlag = room.simulador === 'ativado';

    // Buscar carta
    const cardResult = await client.query('SELECT * FROM mtkin.cartas WHERE id = $1', [cardId]);
    if (cardResult.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Carta não encontrada' }); }
    const card = cardResult.rows[0];
    const cardIdNum = Number(cardId);
    // Carta 50 (Item fake) tem categoria 'Descartavel' mas usa o endpoint de isca para forçar duo
    if (String(card.categoria || '').toLowerCase() !== 'isca' && cardIdNum !== 50) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Esta carta não pode ser usada aqui' });
    }

    // Buscar combate ativo
    let combate = null;
    if (combatId) {
      const cRes = await client.query(
        `SELECT * FROM mtkin.combate WHERE id_combate = $1 AND status NOT IN ('vitoria','fuga','derrota','Ganhou','Perdeu')`,
        [combatId]
      );
      combate = cRes.rows[0];
    } else {
      const cRes = await client.query(
        `SELECT * FROM mtkin.combate WHERE id_sala = $1 AND status NOT IN ('vitoria','fuga','derrota','Ganhou','Perdeu') ORDER BY criado_em DESC LIMIT 1`,
        [roomId]
      );
      combate = cRes.rows[0];
    }

    let resultMessage = '';
    let resultData = {};

    // Remover carta da mão/mochila do jogador
    async function removeCardFromPlayer() {
      await client.query(
        `DELETE FROM mtkin.cartas_no_jogo WHERE ctid = (
           SELECT ctid FROM mtkin.cartas_no_jogo WHERE id_sala=$1 AND id_jogador=$2 AND id_carta=$3 LIMIT 1)`,
        [roomId, userId, cardId]
      );
      await client.query('DELETE FROM mtkin.mochila WHERE id_sala=$1 AND id_jogador=$2 AND id_carta=$3', [roomId, userId, cardId]);
      // Descartar a carta (deck_estado aceita 'cidade' ou 'item'; descarte aceita qualquer valor)
      const descarteDeckTipo = String(card.tipo_carta || '').toLowerCase() === 'item' ? 'item' : 'cidade';
      const descarteTabTipo  = String(card.tipo_carta || '').toLowerCase() === 'item' ? 'tesouro' : 'cidade';
      await client.query(
        `INSERT INTO mtkin.descarte (id_sala, id_carta, nome_carta, tipo_baralho, caminho_imagem, id_jogador)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [roomId, card.id, card.nome_carta, descarteTabTipo, card.caminho_imagem, userId]
      );
      await upsertDeckEstado(roomId, card.id, descarteDeckTipo, 'descarte', null, client, simFlag);
    }

    const iscaId = card.id;

    if (iscaId === 44) {
      // ── Isca 44: Fugir do zumbi automaticamente + ganhar 2 cartas de Item ──
      if (!combate) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nenhum combate ativo' }); }

      // Devolver cartas das zonas de combate para as mãos dos jogadores
      const combateCartas = await client.query(
        `SELECT cc.id AS cc_id, cc.id_carta, cc.nome_carta, cc.tipo_carta, cc.id_jogador, cc.descartar_apos_uso
         FROM mtkin.combate_cartas cc WHERE cc.id_combate = $1`,
        [combate.id_combate]
      );
      for (const cc of combateCartas.rows) {
        const ccBaralho = String(cc.tipo_carta || '').toLowerCase() === 'item' ? 'item' : 'cidade';
        if (cc.descartar_apos_uso) {
          await client.query(
            `INSERT INTO mtkin.descarte (id_sala, id_carta, nome_carta, tipo_baralho, id_jogador)
             VALUES ($1, $2, $3, $4, $5)`,
            [roomId, cc.id_carta, cc.nome_carta, ccBaralho, cc.id_jogador]
          );
        } else {
          await client.query(
            `INSERT INTO mtkin.cartas_no_jogo (id_sala, nome_sala, id_jogador, nome_jogador, id_carta, nome_carta, tipo_baralho, simulado)
             SELECT $1, $2, $3, u.username, $4, $5, $6, $7
             FROM mtkin.users u WHERE u.id = $3`,
            [roomId, room.room_name || '', cc.id_jogador, cc.id_carta, cc.nome_carta, ccBaralho, simFlag]
          );
        }
      }
      await client.query('DELETE FROM mtkin.combate_cartas WHERE id_combate = $1', [combate.id_combate]);
      await client.query('DELETE FROM mtkin.combate_participacao WHERE id_sala = $1', [roomId]);

      // Marcar fuga automática
      await client.query(
        `UPDATE mtkin.combate SET status='fuga', botoes_jogador='', botoes_outros_jogadores='' WHERE id_combate=$1`,
        [combate.id_combate]
      );

      // Limpar estado_turno de todos os jogadores da sala
      await client.query(
        `UPDATE mtkin.estado_turno SET fase_porta='closed', carta_monstro=NULL, duo_modo=FALSE, duo_helper_id=NULL, duo_prontos='{}'
         WHERE id_sala=$1`,
        [roomId]
      );

      // Limpar memória de combate
      combateParticipacaoByRoomId.delete(roomId);
      ajudaModoAbertoByRoomId.delete(roomId);

      // Dar 2 cartas de Item ao jogador que usou Estalinho
      const playerInfo44 = await client.query('SELECT username FROM mtkin.users WHERE id=$1', [userId]);
      const playerName44 = playerInfo44.rows[0]?.username || 'jogador';
      const itemCards = await client.query(
        `SELECT id, nome_carta, tipo_carta, caminho_imagem
         FROM mtkin.cartas WHERE tipo_carta='Item'
         AND NOT EXISTS (SELECT 1 FROM mtkin.cartas_no_jogo cnj WHERE cnj.id_sala=$1 AND cnj.id_carta=mtkin.cartas.id)
         ORDER BY RANDOM() LIMIT 2`,
        [roomId]
      );
      for (const ic of itemCards.rows) {
        await client.query(
          `INSERT INTO mtkin.cartas_no_jogo (id_sala, nome_sala, id_jogador, nome_jogador, id_carta, nome_carta, tipo_baralho)
           VALUES ($1, $2, $3, $4, $5, $6, 'item')`,
          [roomId, room.room_name || '', userId, playerName44, ic.id, ic.nome_carta]
        );
        await upsertDeckEstado(roomId, ic.id, 'item', 'mao', userId, client, simFlag);
      }

      await removeCardFromPlayer();
      resultMessage = `Fuga automática! Ganhou ${itemCards.rows.length} carta(s) de Item.`;
      resultData = { tipo: 'fuga_automatica', cartas_ganhas: itemCards.rows.length };

    } else if (iscaId === 2) {
      // ── Isca 2: Modal para escolher carta da cartela/mochila do alvo ──
      if (!combate) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nenhum combate ativo' }); }
      const effectiveTarget = Number(targetPlayerId) || combate.id_jogador;
      // Criar pendência para o frontend mostrar modal
      await client.query(
        `INSERT INTO mtkin.armadilha_pendente (id_sala, regra_id, id_carta_armadilha, id_jogador_alvo, id_jogador_ator, dados, status)
         VALUES ($1, 102, $2, $3, $4, $5, 'aguardando_escolha')`,
        [roomId, cardId, effectiveTarget, userId,
         JSON.stringify({ tipo: 'isca_roubo', combate_id: combate.id_combate })]
      );
      await removeCardFromPlayer();
      resultMessage = 'Escolha uma carta do jogador!';
      resultData = { tipo: 'modal_roubo', target: effectiveTarget };

    } else if (iscaId === 3) {
      // ── Isca 3: Trocar o monstro atual por outro zumbi ──
      if (!combate) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nenhum combate ativo' }); }
      // A carta de isca 3 deve ter sido arrastada junto com o id do novo monstro (card.id da isca 3)
      // Na verdade a carta isca 3 substitui o monstro — buscar dados do que a carta representa
      // Como a carta é do tipo Isca, precisamos de um monstro aleatório ou a Isca funciona como carta-monstro
      // O pedido diz "troca o zumbi pela carta de zumbi que foi arrastada" — a isca 3 é uma carta que é um zumbi
      // Vamos buscar os dados de forca/itens desta carta isca como monstro
      const newForca = card.forca || 0;
      const newItem = card.item || 0;
      const newNivel = card.nivel || 0;

      await client.query(
        `UPDATE mtkin.combate SET forca_monstro=$1, id_carta_monstro=$2, atualizado_em=NOW() WHERE id_combate=$3`,
        [newForca, card.id, combate.id_combate]
      );
      // Atualizar carta_monstro no estado_turno para que o polling reflita
      await client.query(
        `UPDATE mtkin.estado_turno SET carta_monstro = $1 WHERE id_sala=$2 AND id_jogador=$3`,
        [JSON.stringify({ id: card.id, nome_carta: card.nome_carta, caminho_imagem: card.caminho_imagem, forca: newForca, item: newItem, nivel: newNivel, categoria: card.categoria }),
         roomId, combate.id_jogador]
      );

      await removeCardFromPlayer();
      resultMessage = `Monstro trocado por: ${card.nome_carta} (Força ${newForca})`;
      resultData = { tipo: 'troca_monstro', novo_monstro: card.nome_carta, nova_forca: newForca };

    } else if (iscaId === 4) {
      // ── Isca 4: Monstro perde 4 de força e -1 item de recompensa ──
      if (!combate) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nenhum combate ativo' }); }
      const newForca = Math.max(0, (combate.forca_monstro || 0) - 4);
      await client.query(
        `UPDATE mtkin.combate SET forca_monstro=$1, atualizado_em=NOW() WHERE id_combate=$2`,
        [newForca, combate.id_combate]
      );
      // Registrar redução de itens no combate via campo interferencia (JSONB-like text)
      let interferencia = parseCombatInterferencia(combate.interferencia);
      interferencia.reducao_itens = (interferencia.reducao_itens || 0) + 1;
      await client.query(
        `UPDATE mtkin.combate SET interferencia=$1 WHERE id_combate=$2`,
        [serializeCombatInterferencia(interferencia), combate.id_combate]
      );

      // Também adicionar como carta de combate para visualização
      await client.query(
        `INSERT INTO mtkin.combate_cartas (id_sala, id_combate, id_jogador, nome_jogador, id_carta, nome_carta, tipo_carta, bonus, lado, caminho_imagem, descartar_apos_uso, simulado)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'monstro', $9, true, $10)`,
        [roomId, combate.id_combate, userId, (await client.query('SELECT username FROM mtkin.users WHERE id=$1', [userId])).rows[0]?.username || '',
        card.id, card.nome_carta, card.tipo_carta, 0, card.caminho_imagem, simFlag]
      );

      await removeCardFromPlayer();
      resultMessage = `Monstro enfraquecido! Força: ${newForca} (era ${combate.forca_monstro}), -1 item de recompensa.`;
      resultData = { tipo: 'enfraquecimento', nova_forca: newForca, reducao_itens: 1 };

    } else if (iscaId === 5) {
      // ── Isca 5: +3 força no jogador se arrastado em item do slot 86 ──
      // O efeito é dar +3 ao tabuleiro do jogador (como bônus permanente neste combate)
      if (!combate) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nenhum combate ativo' }); }
      // Verificar se jogador tem carta no slot 86
      const slot86 = await client.query(
        `SELECT id_carta FROM mtkin.cartas_ativas WHERE id_sala=$1 AND id_jogador=$2 AND id_slot='86'`,
        [roomId, userId]
      );
      if (slot86.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Você não tem carta no slot 86' });
      }
      // Adicionar como carta de combate lado jogador com bônus +3
      await client.query(
        `INSERT INTO mtkin.combate_cartas (id_sala, id_combate, id_jogador, nome_jogador, id_carta, nome_carta, tipo_carta, bonus, lado, caminho_imagem, descartar_apos_uso, simulado)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 3, 'jogador', $8, true, $9)`,
        [roomId, combate.id_combate, userId, (await client.query('SELECT username FROM mtkin.users WHERE id=$1', [userId])).rows[0]?.username || '',
         card.id, card.nome_carta, card.tipo_carta, card.caminho_imagem, simFlag]
      );
      await removeCardFromPlayer();
      resultMessage = 'Bônus +3 de força aplicado!';
      resultData = { tipo: 'bonus_forca', bonus: 3 };

    } else if (iscaId === 6) {
      // ── Isca 6: +1 nível para jogador + jogadores com slot 80 carta de forca=0 ──
      if (!combate) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nenhum combate ativo' }); }

      // Subir 1 nível do jogador que usou
      await client.query(
        'UPDATE mtkin.sala_online SET nivel = COALESCE(nivel, 0) + 1 WHERE id_player = $1',
        [userId]
      );

      // Buscar todos jogadores da sala com slot 80 cujo carta tem forca=0
      const slot80Players = await client.query(
        `SELECT ca.id_jogador FROM mtkin.cartas_ativas ca
         JOIN mtkin.cartas c ON c.id = ca.id_carta
         WHERE ca.id_sala=$1 AND ca.id_slot='80' AND COALESCE(c.forca, 0) = 0
           AND ca.id_jogador != $2`,
        [roomId, userId]
      );
      const beneficiados = [];
      for (const row of slot80Players.rows) {
        await client.query(
          'UPDATE mtkin.sala_online SET nivel = COALESCE(nivel, 0) + 1 WHERE id_player = $1',
          [row.id_jogador]
        );
        beneficiados.push(row.id_jogador);
      }

      await removeCardFromPlayer();
      resultMessage = `+1 nível! ${beneficiados.length > 0 ? `Mais ${beneficiados.length} jogador(es) também subiram.` : ''}`;
      resultData = { tipo: 'nivel_up', beneficiados };

    } else if (iscaId === 7) {
      // ── Isca 7: Multiplicar força e itens do monstro por 2 ──
      if (!combate) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nenhum combate ativo' }); }
      const novaForca = (combate.forca_monstro || 0) * 2;
      await client.query(
        `UPDATE mtkin.combate SET forca_monstro=$1, atualizado_em=NOW() WHERE id_combate=$2`,
        [novaForca, combate.id_combate]
      );
      // Registrar multiplicação de itens
      let interferencia = parseCombatInterferencia(combate.interferencia);
      interferencia.multiplicador_itens = (interferencia.multiplicador_itens || 1) * 2;
      await client.query(
        `UPDATE mtkin.combate SET interferencia=$1 WHERE id_combate=$2`,
        [serializeCombatInterferencia(interferencia), combate.id_combate]
      );

      // Adicionar como carta de combate para visualização
      const bonusAdd = combate.forca_monstro || 0; // A diferença é igual ao valor original
      await client.query(
        `INSERT INTO mtkin.combate_cartas (id_sala, id_combate, id_jogador, nome_jogador, id_carta, nome_carta, tipo_carta, bonus, lado, caminho_imagem, descartar_apos_uso, simulado)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'monstro', $9, true, $10)`,
        [roomId, combate.id_combate, userId, (await client.query('SELECT username FROM mtkin.users WHERE id=$1', [userId])).rows[0]?.username || '',
         card.id, card.nome_carta, card.tipo_carta, bonusAdd, card.caminho_imagem, simFlag]
      );

      await removeCardFromPlayer();
      resultMessage = `Monstro fortalecido! Força: ${novaForca} (x2), itens x2.`;
      resultData = { tipo: 'multiplicar', nova_forca: novaForca, multiplicador: 2 };

    } else if (iscaId === 50) {
      if (!combate) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nenhum combate ativo' }); }
      if (!targetPlayerId) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'A carta 50 deve ser arrastada sobre um jogador durante o combate' }); }
      if (Number(combate.id_jogador) !== Number(userId)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'A carta 50 só pode ser usada pelo lutador deste combate' });
      }

      const helperId = Number(targetPlayerId);
      if (!Number.isInteger(helperId) || helperId <= 0 || helperId === Number(userId)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Jogador alvo inválido' });
      }
      if (combate.id_helper && Number(combate.id_helper) !== helperId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Este combate já possui um ajudante' });
      }

      const helperRoomRes = await client.query(
        `SELECT rp.user_id, rp.is_online, u.username
         FROM mtkin.room_participants rp
         JOIN mtkin.users u ON u.id = rp.user_id
         WHERE rp.room_id = $1 AND rp.user_id = $2
         LIMIT 1`,
        [roomId, helperId]
      );
      if (helperRoomRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Jogador alvo não está na sala' });
      }
      if (!helperRoomRes.rows[0].is_online) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'O jogador alvo está offline' });
      }
      const helperName = helperRoomRes.rows[0].username || `Jogador ${helperId}`;

      await ensureAjudaTable();
      await client.query(
        `UPDATE mtkin.ajuda_combate
         SET status = 'cancelado', escolhido = FALSE, updated_at = NOW()
         WHERE id_sala = $1
           AND COALESCE(id_combate, '') = COALESCE($2, '')
           AND status IN ('pendente', 'contra_proposta', 'aceito', 'contra_proposta_enviada')`,
        [roomId, combate.id_combate || null]
      );

      await client.query(
        `INSERT INTO mtkin.ajuda_combate
           (id_sala, id_combate, id_lutador, id_proponente, id_destinatario, tipo_proposta, fluxo, status, escolhido, simulado)
         VALUES ($1, $2, $3, $4, $5, 'sem-recompensa', 'direto', 'aceito', TRUE, $6)`,
        [roomId, combate.id_combate, combate.id_jogador, userId, helperId, simFlag]
      );

      await client.query(
        `INSERT INTO mtkin.combate_participacao (id_sala, id_combate, id_jogador_luta, id_jogador, status, simulado)
         VALUES ($1, $2, $3, $4, 'participando', $5)
         ON CONFLICT (id_sala, id_jogador) DO UPDATE
         SET status = 'participando', updated_at = NOW()`,
        [roomId, combate.id_combate, combate.id_jogador, helperId, simFlag]
      );

      await client.query(
        `UPDATE mtkin.estado_turno
         SET duo_modo = TRUE, duo_helper_id = $1, duo_prontos = '{}', atualizado_em = NOW()
         WHERE id_sala = $2 AND id_jogador = $3`,
        [helperId, roomId, combate.id_jogador]
      );

      await client.query(
        `UPDATE mtkin.combate
         SET status = 'Pedido de ajuda',
             id_helper = $1,
             tipo_acordo = 'sem-recompensa',
             botoes_jogador = 'pronto (duo)',
             botoes_outros_jogadores = '',
             interferencia = '',
             duo_prontos = '',
             atualizado_em = NOW()
         WHERE id_combate = $2`,
        [helperId, combate.id_combate]
      );

      const combatMem = combateParticipacaoByRoomId.get(roomId);
      if (combatMem) {
        combatMem.combatId = combate.id_combate;
        combatMem.fightingPlayerId = Number(combate.id_jogador);
        combatMem.participants = combatMem.participants || {};
        combatMem.participants[helperId] = 'participando';
      }
      const ajudaMem = ajudaModoAbertoByRoomId.get(roomId);
      if (ajudaMem) {
        ajudaMem.combatId = combate.id_combate;
        ajudaMem.lutadorId = Number(combate.id_jogador);
        ajudaMem.modoAberto = false;
        if (ajudaMem.responderam instanceof Set) ajudaMem.responderam.add(helperId);
      }

      await removeCardFromPlayer();
      resultMessage = `${helperName} foi obrigado a ajudar no combate sem recompensa.`;
      resultData = { tipo: 'ajuda_forcada', helper_id: helperId, helper_nome: helperName, tipo_acordo: 'sem-recompensa' };

    } else if (iscaId === 88 || iscaId === 89) {
      // ── Isca 88/89: escolher até 3 cartas do descarte ──
      const regraId = iscaId === 88 ? 188 : 189;
      const onlyItem = iscaId === 88;
      await client.query(
        `INSERT INTO mtkin.armadilha_pendente (id_sala, regra_id, id_carta_armadilha, id_jogador_alvo, id_jogador_ator, dados, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'aguardando_escolha')`,
        [roomId, regraId, cardId, userId, userId, JSON.stringify({ tipo: 'isca_descarte', only_item: onlyItem })]
      );
      await removeCardFromPlayer();
      resultMessage = onlyItem
        ? 'Escolha até 3 cartas de Item do descarte.'
        : 'Escolha até 3 cartas do descarte.';
      resultData = { tipo: 'modal_descarte', regra_id: regraId, only_item: onlyItem };

    } else if (iscaId === 91) {
      if (!combate) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nenhum combate ativo' }); }
      if (side !== 'jogador') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'A carta 91 só pode ser jogada para ajudar o jogador' }); }

      const interferencia = parseCombatInterferencia(combate.interferencia);
      interferencia.disable_run = true;
      await client.query(
        `UPDATE mtkin.combate SET interferencia=$1, atualizado_em=NOW() WHERE id_combate=$2`,
        [serializeCombatInterferencia(interferencia), combate.id_combate]
      );
      await client.query(
        `INSERT INTO mtkin.combate_cartas (id_sala, id_combate, id_jogador, nome_jogador, id_carta, nome_carta, tipo_carta, bonus, lado, caminho_imagem, descartar_apos_uso, simulado)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'jogador', $8, true, $9)`,
        [roomId, combate.id_combate, userId, req.user.username, card.id, card.nome_carta, card.tipo_carta, card.caminho_imagem, simFlag]
      );
      await removeCardFromPlayer();
      resultMessage = 'Neste combate, o lado do jogador fica sem opção de fuga.';
      resultData = { tipo: 'sem_fuga' };

    } else if (iscaId === 92 || iscaId === 48) {
      if (!combate) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nenhum combate ativo' }); }
      if (side !== 'jogador') { await client.query('ROLLBACK'); return res.status(400).json({ error: `A carta ${iscaId} só pode ser jogada para ajudar o jogador` }); }

      const interferencia = parseCombatInterferencia(combate.interferencia);
      interferencia.retry_escape = true;
      interferencia.retry_penalty = 1;
      if (typeof interferencia.retry_penalty_armed !== 'boolean') {
        interferencia.retry_penalty_armed = false;
      }
      await client.query(
        `UPDATE mtkin.combate SET interferencia=$1, atualizado_em=NOW() WHERE id_combate=$2`,
        [serializeCombatInterferencia(interferencia), combate.id_combate]
      );
      await client.query(
        `INSERT INTO mtkin.combate_cartas (id_sala, id_combate, id_jogador, nome_jogador, id_carta, nome_carta, tipo_carta, bonus, lado, caminho_imagem, descartar_apos_uso, simulado)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'jogador', $8, true, $9)`,
        [roomId, combate.id_combate, userId, req.user.username, card.id, card.nome_carta, card.tipo_carta, card.caminho_imagem, simFlag]
      );
      await removeCardFromPlayer();
      resultMessage = 'Depois de uma fuga bem-sucedida, o jogador volta ao combate. Na próxima tentativa de fuga, o dado vale -1.';
      resultData = { tipo: 'fuga_retornada', penalidade: 1 };

    } else if (iscaId === 46) {
      if (!combate) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nenhum combate ativo' }); }
      if (side !== 'jogador') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'A carta 46 só pode ser jogada para ajudar o jogador' }); }

      const monstroId = Number(combate.id_carta_monstro) || null;
      if (monstroId) {
        const monstroRes = await client.query(
          'SELECT id, nome_carta, caminho_imagem, tipo_carta FROM mtkin.cartas WHERE id = $1 LIMIT 1',
          [monstroId]
        );
        const monstro = monstroRes.rows[0];
        if (monstro) {
          const tipoBaralhoMonstro = monstro.tipo_carta === 'Item' ? 'item' : 'cidade';
          await client.query(
            `INSERT INTO mtkin.descarte (id_sala, id_carta, nome_carta, tipo_baralho, caminho_imagem, id_jogador, nome_jogador)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [roomId, monstro.id, monstro.nome_carta, tipoBaralhoMonstro, monstro.caminho_imagem, userId, req.user.username]
          );
          await upsertDeckEstado(roomId, monstro.id, tipoBaralhoMonstro, 'descarte', null, client, simFlag);
        }
      }

      await client.query(
        `UPDATE mtkin.combate
         SET status='fuga', botoes_jogador='', botoes_outros_jogadores='', atualizado_em=NOW()
         WHERE id_combate=$1`,
        [combate.id_combate]
      );
      await client.query(
        `UPDATE mtkin.estado_turno
         SET fase_porta = 'closed', duo_modo = FALSE, duo_helper_id = NULL, duo_prontos = '{}'
         WHERE id_sala = $1`,
        [roomId]
      );
      combateParticipacaoByRoomId.delete(roomId);
      ajudaModoAbertoByRoomId.delete(roomId);
      await removeCardFromPlayer();
      resultMessage = 'O monstro foi descartado e a fuga foi resolvida imediatamente.';
      resultData = { tipo: 'fuga_imediata' };

    } else {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Isca id=${iscaId} sem efeito configurado` });
    }

    await client.query('COMMIT');
    res.json({ message: resultMessage, data: resultData });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Erro ao aplicar Isca (iscaId=%s):', cardId, error?.message || error);
    console.error(error?.stack || error);
    res.status(500).json({ error: `Erro ao aplicar carta de Isca: ${error?.message || 'erro interno'}` });
  } finally {
    client.release();
  }
});

// Responder a Isca regra 102 (roubo de carta do alvo)
app.post('/api/combate/isca/roubo', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { pendenteId, cardId, origem, slotId } = req.body;
  if (!pendenteId || !cardId) return res.status(400).json({ error: 'pendenteId e cardId são obrigatórios' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pendResult = await client.query('SELECT * FROM mtkin.armadilha_pendente WHERE id=$1 FOR UPDATE', [pendenteId]);
    const pend = pendResult.rows[0];
    if (!pend || pend.regra_id !== 102 || pend.status !== 'aguardando_escolha') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Pendência inválida' });
    }
    if (pend.id_jogador_ator !== userId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Não é você quem deve escolher' });
    }

    const roomId = pend.id_sala;
    const alvoId = pend.id_jogador_alvo;

    // Buscar a carta
    const cartaRes = await client.query('SELECT id, nome_carta, caminho_imagem, tipo_carta FROM mtkin.cartas WHERE id=$1', [cardId]);
    const carta = cartaRes.rows[0];
    if (!carta) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Carta não encontrada' }); }

    // Remover do alvo
    if (origem === 'cartela' && slotId) {
      await client.query('DELETE FROM mtkin.cartas_ativas WHERE id_sala=$1 AND id_jogador=$2 AND id_slot=$3', [roomId, alvoId, slotId]);
      await recalcularTabuleiroJogador(alvoId, roomId, client);
    } else {
      await client.query('DELETE FROM mtkin.mochila WHERE id_sala=$1 AND id_jogador=$2 AND id_carta=$3', [roomId, alvoId, cardId]);
    }

    // Adicionar à mochila do ator
    await client.query(
      `INSERT INTO mtkin.mochila (id_sala, id_jogador, id_carta, origem_tabela) VALUES ($1, $2, $3, 'isca')`,
      [roomId, userId, cardId]
    );
    await upsertDeckEstado(roomId, cardId, carta.tipo_carta === 'Item' ? 'item' : 'cidade', 'mochila', userId, client, false);

    // Concluir pendência
    await client.query('UPDATE mtkin.armadilha_pendente SET status=$1 WHERE id=$2', ['concluido', pendenteId]);

    await client.query('COMMIT');
    res.json({ message: `Pegou: ${carta.nome_carta}` });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao processar isca roubo:', error);
    res.status(500).json({ error: 'Erro ao processar' });
  } finally {
    client.release();
  }
});

// Responder Isca 88/89: pegar até 3 cartas do descarte
app.post('/api/combate/isca/descarte-pegar', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { pendenteId, discardIds } = req.body;
  const ids = Array.isArray(discardIds)
    ? discardIds.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0)
    : [];

  if (!pendenteId) return res.status(400).json({ error: 'pendenteId é obrigatório' });
  if (ids.length < 1 || ids.length > 3) return res.status(400).json({ error: 'Selecione entre 1 e 3 cartas' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pendResult = await client.query('SELECT * FROM mtkin.armadilha_pendente WHERE id=$1 FOR UPDATE', [pendenteId]);
    const pend = pendResult.rows[0];

    if (!pend || (pend.regra_id !== 188 && pend.regra_id !== 189) || pend.status !== 'aguardando_escolha') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Pendência inválida' });
    }
    if (Number(pend.id_jogador_ator) !== Number(userId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Não é você quem deve escolher' });
    }

    const roomId = pend.id_sala;
    const onlyItem = pend.regra_id === 188 || (pend.dados && pend.dados.only_item === true);

    const roomMeta = await client.query('SELECT room_name, simulador FROM mtkin.rooms WHERE id=$1 LIMIT 1', [roomId]);
    const roomName = roomMeta.rows[0]?.room_name || 'Sala';
    const simFlag = roomMeta.rows[0]?.simulador === 'ativado';

    const placeholders = ids.map((_, idx) => `$${idx + 2}`).join(', ');
    const queryParams = [roomId, ...ids];
    let cardsSql =
      `SELECT d.id, d.id_carta, d.nome_carta, d.tipo_baralho, d.caminho_imagem
       FROM mtkin.descarte d
       WHERE d.id_sala = $1 AND d.id IN (${placeholders})`;
    if (onlyItem) cardsSql += ` AND d.tipo_baralho = 'item'`;
    cardsSql += ' ORDER BY d.descartado_em DESC FOR UPDATE';

    const cardsResult = await client.query(cardsSql, queryParams);
    if (cardsResult.rows.length !== ids.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Uma ou mais cartas não estão disponíveis no descarte' });
    }

    for (const row of cardsResult.rows) {
      await client.query(
        `INSERT INTO mtkin.cartas_no_jogo (id_sala, nome_sala, id_jogador, nome_jogador, id_carta, nome_carta, tipo_baralho)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [roomId, roomName, userId, req.user.username, row.id_carta, row.nome_carta, row.tipo_baralho]
      );
      await client.query('DELETE FROM mtkin.descarte WHERE id = $1', [row.id]);
      await upsertDeckEstado(roomId, row.id_carta, row.tipo_baralho, 'mao', userId, client, simFlag);
    }

    await client.query('UPDATE mtkin.armadilha_pendente SET status=$1 WHERE id=$2', ['concluido', pendenteId]);
    await client.query('COMMIT');

    return res.json({
      message: `${cardsResult.rows.length} carta(s) movida(s) do descarte para sua mão.`,
      quantidade: cardsResult.rows.length
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Erro ao pegar cartas do descarte (isca 88/89):', error?.message || error);
    console.error('Stack:', error?.stack);
    return res.status(500).json({ error: `Erro ao processar: ${error?.message || 'erro interno'}` });
  } finally {
    client.release();
  }
});

// GET /api/descarte — listar cartas do descarte da sala
app.get('/api/descarte', authenticateToken, async (req, res) => {
  try {
    const roomId = await getRoomIdFromUser(req.user.id);
    if (!roomId) return res.status(404).json({ error: 'Sala não encontrada' });

    const result = await pool.query(
      `SELECT d.id, d.id_carta, d.nome_carta, d.tipo_baralho,
              COALESCE(c.caminho_imagem, d.caminho_imagem) AS caminho_imagem,
              c.texto_da_carta, c.equipar_onde, c.forca, c.fulga_minima,
              c.nivel, c.valor, c.pesado
       FROM mtkin.descarte d
       LEFT JOIN mtkin.cartas c ON c.id = d.id_carta
       WHERE d.id_sala = $1
       ORDER BY d.descartado_em DESC`,
      [roomId]
    );
    res.json({ cartas: result.rows });
  } catch (error) {
    console.error('[GET /api/descarte]', error.message);
    res.status(500).json({ error: 'Erro ao buscar descarte' });
  }
});

// POST /api/descarte/pegar — pegar cartas do descarte consumindo carta 88 da mão
app.post('/api/descarte/pegar', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { discardIds } = req.body; // ids de mtkin.descarte
  const ids = Array.isArray(discardIds)
    ? discardIds.map(Number).filter(v => Number.isInteger(v) && v > 0)
    : [];

  if (ids.length < 1 || ids.length > 3) {
    return res.status(400).json({ error: 'Selecione entre 1 e 3 cartas' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const roomResult = await client.query(
      `SELECT r.id, r.room_name, r.simulador
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true LIMIT 1`,
      [userId]
    );
    if (!roomResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sala não encontrada' });
    }
    const room = roomResult.rows[0];
    const simFlag = room.simulador === 'ativado';

    // Verificar se carta 88 está na mão do jogador
    const carta88 = await client.query(
      `SELECT ctid FROM mtkin.cartas_no_jogo
       WHERE id_sala = $1 AND id_jogador = $2 AND id_carta = 88
       LIMIT 1`,
      [room.id, userId]
    );
    if (!carta88.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Carta 88 não encontrada na sua mão' });
    }

    // Buscar cartas selecionadas do descarte
    const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ');
    const cardsResult = await client.query(
      `SELECT d.id, d.id_carta, d.nome_carta, d.tipo_baralho, d.caminho_imagem
       FROM mtkin.descarte d
       WHERE d.id_sala = $1 AND d.id IN (${placeholders})
       FOR UPDATE`,
      [room.id, ...ids]
    );
    if (cardsResult.rows.length !== ids.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Uma ou mais cartas não estão disponíveis no descarte' });
    }

    // Remover carta 88 da mão
    await client.query(
      `DELETE FROM mtkin.cartas_no_jogo WHERE ctid = $1`,
      [carta88.rows[0].ctid]
    );

    // Adicionar cartas selecionadas à mão
    for (const row of cardsResult.rows) {
      await client.query(
        `INSERT INTO mtkin.cartas_no_jogo
           (id_sala, nome_sala, id_jogador, nome_jogador, id_carta, nome_carta, tipo_baralho, simulado)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [room.id, room.room_name, userId, req.user.username,
         row.id_carta, row.nome_carta, row.tipo_baralho, simFlag]
      );
      await client.query('DELETE FROM mtkin.descarte WHERE id = $1', [row.id]);
      await upsertDeckEstado(room.id, row.id_carta, row.tipo_baralho, 'mao', userId, client, simFlag);
    }

    // Registrar carta 88 como usada no descarte
    const carta88info = await pool.query('SELECT nome_carta FROM mtkin.cartas WHERE id = 88 LIMIT 1');
    await client.query(
      `INSERT INTO mtkin.descarte
         (id_sala, id_carta, nome_carta, tipo_baralho, id_jogador, nome_jogador)
       SELECT $1, 88, $2, $3, $4, $5`,
      [room.id, carta88info.rows[0]?.nome_carta || 'Carta 88', 'item', userId, req.user.username]
    );
    await upsertDeckEstado(room.id, 88, 'item', 'descarte', null, client, simFlag);

    // Atualizar contador de mão
    const maoCount = await client.query(
      `SELECT COUNT(*)::int AS total FROM mtkin.cartas_no_jogo
       WHERE id_sala = $1 AND id_jogador = $2`,
      [room.id, userId]
    );
    await client.query('UPDATE mtkin.sala_online SET mao = $1 WHERE id_player = $2',
      [maoCount.rows[0].total, userId]);

    await client.query('COMMIT');
    res.json({ message: `${cardsResult.rows.length} carta(s) do descarte adicionada(s) à sua mão.`, quantidade: cardsResult.rows.length });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[POST /api/descarte/pegar]', error?.message || error);
    console.error('Stack:', error?.stack);
    res.status(500).json({ error: `Erro ao pegar cartas: ${error?.message || 'erro interno'}` });
  } finally {
    client.release();
  }
});

// Consome a carta 90 para sobrescrever o valor do dado da fuga
app.post('/api/combate/isca/dado', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const novoValor = Number(req.body?.novoValorDado);
  if (!Number.isInteger(novoValor) || novoValor < 1 || novoValor > 6) {
    return res.status(400).json({ error: 'novoValorDado deve ser um inteiro entre 1 e 6' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const roomResult = await client.query(
      `SELECT r.id, r.room_name, r.simulador
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true
       LIMIT 1`,
      [userId]
    );
    if (!roomResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sala não encontrada' });
    }
    const room = roomResult.rows[0];
    const simFlag = room.simulador === 'ativado';

    const combateResult = await client.query(
      `SELECT id_combate FROM mtkin.combate
       WHERE id_sala = $1 AND status NOT IN ('vitoria','fuga','derrota','Ganhou','Perdeu')
       ORDER BY criado_em DESC
       LIMIT 1`,
      [room.id]
    );
    if (!combateResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Sem combate ativo para usar esta carta' });
    }

    const ownedCard = await client.query(
      `SELECT ctid
       FROM mtkin.cartas_no_jogo
       WHERE id_sala = $1 AND id_jogador = $2 AND id_carta = 90
       ORDER BY id DESC
       LIMIT 1`,
      [room.id, userId]
    );
    if (!ownedCard.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Você não possui a carta 90 na mão' });
    }

    const cardInfo = await client.query('SELECT id, nome_carta, caminho_imagem, tipo_carta FROM mtkin.cartas WHERE id = 90 LIMIT 1');
    const c90 = cardInfo.rows[0];
    if (!c90) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Carta 90 não encontrada' });
    }
    const tipoBaralho = c90.tipo_carta === 'Item' ? 'item' : 'cidade';

    await client.query('DELETE FROM mtkin.cartas_no_jogo WHERE ctid = $1', [ownedCard.rows[0].ctid]);
    await client.query(
      `INSERT INTO mtkin.descarte (id_sala, id_carta, nome_carta, tipo_baralho, caminho_imagem, id_jogador, nome_jogador)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [room.id, c90.id, c90.nome_carta, tipoBaralho, c90.caminho_imagem, userId, req.user.username]
    );
    await upsertDeckEstado(room.id, c90.id, tipoBaralho, 'descarte', null, client, simFlag);

    await client.query('COMMIT');
    return res.json({ message: 'Carta 90 usada com sucesso.', novoValorDado: novoValor });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao usar carta 90 no dado:', error);
    return res.status(500).json({ error: 'Erro ao usar carta 90' });
  } finally {
    client.release();
  }
});

// Remover carta do combate
app.delete('/api/combate/remove-card/:id', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;
  
  try {
    // Buscar carta do combate
    const cardResult = await pool.query(
      'SELECT * FROM mtkin.combate_cartas WHERE id = $1 AND id_jogador = $2',
      [id, userId]
    );
    
    if (cardResult.rows.length === 0) {
      return res.status(404).json({ error: 'Carta não encontrada' });
    }
    
    const combatCard = cardResult.rows[0];
    
    // Remover do combate
    await pool.query('DELETE FROM mtkin.combate_cartas WHERE id = $1', [id]);
    
    // Devolver para a mão do jogador
    await pool.query(
      `INSERT INTO mtkin.cartas_no_jogo (id_sala, nome_sala, id_jogador, nome_jogador, id_carta, nome_carta, tipo_baralho, simulado)
       SELECT $1, r.room_name, $2, $3, $4, $5, 'item', $6
       FROM mtkin.rooms r
       WHERE r.id = $1`,
      [combatCard.id_sala, userId, combatCard.nome_jogador, combatCard.id_carta, combatCard.nome_carta,
       await getSimFlag(combatCard.id_sala)]
    );

    await upsertDeckEstado(combatCard.id_sala, combatCard.id_carta, 'item', 'mao', userId, null, await getSimFlag(combatCard.id_sala));
    
    res.json({ message: 'Carta removida do combate' });
    
  } catch (error) {
    console.error('❌ [COMBATE/REMOVE] Erro:', error);
    res.status(500).json({ error: 'Erro ao remover carta' });
  }
});

// Resolver combate
app.post('/api/combate/resolve', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { combatId } = req.body;
  
  try {
    // Buscar todas as cartas do combate
    const cardsResult = await pool.query(
      'SELECT * FROM mtkin.combate_cartas WHERE id_combate = $1',
      [combatId]
    );
    
    const monsterBonus = cardsResult.rows
      .filter(c => c.lado === 'monstro')
      .reduce((sum, c) => sum + (c.bonus || 0), 0);
      
    const playerBonus = cardsResult.rows
      .filter(c => c.lado === 'jogador')
      .reduce((sum, c) => sum + (c.bonus || 0), 0);
    
    // As cartas já foram removidas da mão quando foram adicionadas ao combate
    // Então apenas limpamos o combate (as cartas com descartar_apos_uso não voltam para a mão)
    const cardsToDiscard = cardsResult.rows.filter(c => c.descartar_apos_uso);
    const cardsToReturn = cardsResult.rows.filter(c => !c.descartar_apos_uso);
    
    // Devolver para a mão as cartas que NÃO devem ser descartadas
    // Pegar simFlag do primeiro card disponível
    const resolveSimFlag = cardsToReturn.length > 0
      ? await getSimFlag(cardsToReturn[0].id_sala)
      : (cardsToDiscard.length > 0 ? await getSimFlag(cardsToDiscard[0].id_sala) : false);

    for (const card of cardsToReturn) {
      await pool.query(
        `INSERT INTO mtkin.cartas_no_jogo (id_sala, nome_sala, id_jogador, nome_jogador, id_carta, nome_carta, tipo_baralho, simulado)
         SELECT $1, r.room_name, $2, $3, $4, $5, 'item', $6
         FROM mtkin.rooms r
         WHERE r.id = $1`,
        [card.id_sala, card.id_jogador, card.nome_jogador, card.id_carta, card.nome_carta, resolveSimFlag]
      );
      await upsertDeckEstado(card.id_sala, card.id_carta, 'item', 'mao', card.id_jogador, null, resolveSimFlag);
    }

    // Marcar descartadas
    for (const card of cardsToDiscard) {
      await upsertDeckEstado(card.id_sala, card.id_carta, 'item', 'descarte', null, null, resolveSimFlag);
    }

    // Limpar participação de combate do store em memória
    const partRoom = await pool.query(
      `SELECT r.id FROM mtkin.rooms r JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true LIMIT 1`,
      [userId]
    );
    if (partRoom.rows.length > 0) {
      const roomIdToClean = partRoom.rows[0].id;
      combateParticipacaoByRoomId.delete(roomIdToClean);
      ajudaModoAbertoByRoomId.delete(roomIdToClean);
      try {
        await pool.query('DELETE FROM mtkin.combate_participacao WHERE id_sala = $1', [roomIdToClean]);
      } catch(_) {}
      // Resetar campos duo e fase_porta no estado_turno (encerrar combate para todos)
      try {
        await pool.query(
          `UPDATE mtkin.estado_turno
           SET duo_modo = FALSE, duo_helper_id = NULL, duo_prontos = '{}', fase_porta = 'closed'
           WHERE id_sala = $1`,
          [roomIdToClean]
        );
      } catch(_) {}
    }

    // Marcar combate como vitória (fonte de verdade para pollCombateEstado)
    if (combatId) {
      try {
        await pool.query(
          `UPDATE mtkin.combate SET status = 'vitoria', atualizado_em = NOW()
           WHERE id_combate = $1 AND status NOT IN ('vitoria','fuga','derrota')`,
          [combatId]
        );
      } catch(_) {}
    }

    // Limpar cartas do combate
    await pool.query('DELETE FROM mtkin.combate_cartas WHERE id_combate = $1', [combatId]);
    
    res.json({
      message: 'Combate resolvido!',
      monsterBonus,
      playerBonus,
      cardsDiscarded: cardsToDiscard.length,
      cardsReturned: cardsToReturn.length
    });
    
  } catch (error) {
    console.error('❌ [COMBATE/RESOLVE] Erro:', error);
    res.status(500).json({ error: 'Erro ao resolver combate' });
  }
});

// Helper: buscar roomId a partir do userId
async function getRoomIdFromUser(userId) {
  const result = await pool.query(
    `SELECT r.id FROM mtkin.rooms r JOIN mtkin.room_participants rp ON rp.room_id = r.id
     WHERE rp.user_id = $1 AND r.is_active = true AND r.status = 'playing' LIMIT 1`,
    [userId]
  );
  return result.rows.length > 0 ? result.rows[0].id : null;
}

// POST /api/combate/iniciar-participacao
app.post('/api/combate/iniciar-participacao', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { combatId, monsterId } = req.body;

    const roomResult = await pool.query(
      `SELECT r.id, r.ordem_turno, r.simulador FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true AND r.status = 'playing'`,
      [userId]
    );
    if (roomResult.rows.length === 0) return res.status(404).json({ error: 'Sala não encontrada' });
    const room = roomResult.rows[0];
    const simFlagParticipacao = room.simulador === 'ativado';

    // Calcular monstroDomina: usa monsterId do body (sempre disponível) + forca do jogador em sala_online
    let monstroDomina = false;
    try {
      // Força do jogador: sala_online é a fonte mais atualizada
      const soRes = await pool.query(
        `SELECT forca FROM mtkin.sala_online WHERE id_player = $1`, [userId]
      );
      const forcaJogador = Number(soRes.rows[0]?.forca) || 0;

      // ID do monstro: preferir monsterId do body; fallback: estado_turno.carta_monstro
      let monsterCardId = monsterId ? Number(monsterId) : null;
      if (!monsterCardId) {
        const estadoRes = await pool.query(
          `SELECT carta_monstro FROM mtkin.estado_turno WHERE id_sala = $1 AND id_jogador = $2`,
          [room.id, userId]
        );
        monsterCardId = estadoRes.rows[0]?.carta_monstro?.id || null;
      }

      if (monsterCardId) {
        const mRes = await pool.query('SELECT forca FROM mtkin.cartas WHERE id = $1', [monsterCardId]);
        const forcaMonstro = Number(mRes.rows[0]?.forca) || 0;
        monstroDomina = forcaMonstro >= forcaJogador;
        console.log(`[COMBATE] forca monstro=${forcaMonstro} forca jogador=${forcaJogador} monstroDomina=${monstroDomina}`);
      }
    } catch(e) { console.error('[COMBATE] Erro ao calcular monstroDomina:', e.message); }

    const allPlayers = room.ordem_turno || [];
    const otherPlayers = allPlayers.filter(id => id !== userId);
    // monstroDomina: monstro mais forte → outros auto-recusam
    // !monstroDomina: jogador mais forte → outros são convidados (esperando)
    const statusInicial = monstroDomina ? 'recusou' : 'esperando';
    const participants = {};
    otherPlayers.forEach(id => { participants[id] = statusInicial; });
    combateParticipacaoByRoomId.set(room.id, { combatId, fightingPlayerId: userId, participants });
    combateLog('INICIAR', req.user, `🗡️  Iniciou combate${monstroDomina ? ' (monstro domina — outros auto-recusados)' : ' (jogador domina — outros convidados)'}`, { combatId, sala: room.id, outrosJogadores: otherPlayers });
    // Inicializar (ou resetar) estado de ajuda — preservar responderam se for o mesmo combate
    const modoExistente = ajudaModoAbertoByRoomId.get(room.id);
    if (modoExistente && modoExistente.combatId === combatId) {
      // Mesmo combate: apenas atualizar naoLutadores, preservar responderam
      modoExistente.naoLutadores = new Set(otherPlayers);
      if (monstroDomina) otherPlayers.forEach(id => modoExistente.responderam.add(id));
    } else {
      ajudaModoAbertoByRoomId.set(room.id, {
        combatId,
        lutadorId:    userId,
        naoLutadores: new Set(otherPlayers),
        responderam:  monstroDomina ? new Set(otherPlayers) : new Set(),
        bloqueados:   new Set()
      });
    }
    // Limpar TODAS as propostas de ajuda desta sala ao iniciar novo combate
    try {
      await pool.query(
        `DELETE FROM mtkin.ajuda_combate WHERE id_sala = $1`,
        [room.id]
      );
    } catch(e) { console.error('[COMBATE] Erro ao limpar ajuda_combate:', e.message); }

    // Limpar cartas de combate residuais do combate anterior
    try {
      await pool.query('DELETE FROM mtkin.combate_cartas WHERE id_sala = $1', [room.id]);
    } catch(e) { console.error('[COMBATE] Erro ao limpar combate_cartas:', e.message); }

    // Limpar estado de combate anterior (participação + duo) para garantir início limpo
    try {
      await pool.query('DELETE FROM mtkin.combate_participacao WHERE id_sala = $1', [room.id]);
    } catch(e) { console.error('[COMBATE] Erro ao limpar combate_participacao:', e.message); }
    try {
      await pool.query(
        `UPDATE mtkin.estado_turno SET duo_modo = FALSE, duo_helper_id = NULL, duo_prontos = '{}' WHERE id_sala = $1`,
        [room.id]
      );
    } catch(e) { console.error('[COMBATE] Erro ao resetar duo em estado_turno:', e.message); }

    combateModoSnapshot(room.id);

    // Persistir participação do novo combate (INSERT limpo — old rows já foram deletados)
    try {
      for (const pid of otherPlayers) {
        await pool.query(
          `INSERT INTO mtkin.combate_participacao (id_sala, id_combate, id_jogador_luta, id_jogador, status, simulado)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [room.id, combatId, userId, pid, statusInicial, simFlagParticipacao]
        );
      }
      console.log(`[COMBATE] Participação persistida no banco: ${otherPlayers.length} jogadores`);
    } catch(e) { console.error('[COMBATE] Erro ao persistir participação:', e.message); }
    console.log(`[COMBATE] Participação iniciada sala ${room.id}, ${otherPlayers.length} outros jogadores`);

    // Registrar combate na tabela mtkin.combate
    try {
      // monsterId já disponível no escopo (vem de req.body no topo da função)
      // Força do jogador vem de sala_online (já atualizado antes do combate)
      const soRow = await pool.query(
        `SELECT forca FROM mtkin.sala_online WHERE id_player = $1`, [userId]
      );
      const forcaJogadorReg = Number(soRow.rows[0]?.forca) || 0;
      let forcaMonstroReg = 0, idCartaMonstro = monsterId ? Number(monsterId) : null;
      if (idCartaMonstro) {
        const mRes = await pool.query('SELECT forca FROM mtkin.cartas WHERE id = $1', [idCartaMonstro]);
        forcaMonstroReg = Number(mRes.rows[0]?.forca) || 0;
      }
      // id=29: se o jogador tem carta de categoria Personagem com forca>0 equipada → monstro ganha +3
      if (idCartaMonstro === 29) {
        const personagemCheck = await pool.query(
          `SELECT 1 FROM mtkin.cartas_ativas ca
           JOIN mtkin.cartas c ON c.id = ca.id_carta
           WHERE ca.id_sala = $1 AND ca.id_jogador = $2
             AND LOWER(TRIM(COALESCE(c.categoria,''))) = 'personagem'
             AND COALESCE(c.forca, 0) > 0
           LIMIT 1`,
          [room.id, userId]
        );
        if (personagemCheck.rows.length > 0) {
          forcaMonstroReg += 3;
          console.log(`[COMBATE][id=29] Jogador possui carta Personagem com forca>0 equipada → monstro +3 (forca_monstro=${forcaMonstroReg})`);
        }
      }
      // Calcular botões com base nas forças
      // jogador > monstro: Fase 1 (aguarda outros decidirem Entrar/Não entrar) → Fase 2 com 'Lutar'
      // jogador <= monstro: Fase 2 direta com 'Correr;Pedir ajuda' (monstro domina, outros auto-recusados)
      const jogadorMaisForte = forcaJogadorReg > forcaMonstroReg;
      const botoesJogador          = jogadorMaisForte ? '' : 'Correr;Pedir ajuda';
      const botoesOutrosJogadores  = jogadorMaisForte ? 'Entrar no combate;Não entrar' : '';
      const statusInicial          = jogadorMaisForte ? 'Fase 1' : 'Fase 2';
      // Limpar combates anteriores não-finalizados desta sala antes de inserir
      await pool.query(
        `UPDATE mtkin.combate SET status = 'derrota', atualizado_em = NOW()
         WHERE id_sala = $1 AND status NOT IN ('vitoria','fuga','derrota')`,
        [room.id]
      );
      await pool.query(
        `INSERT INTO mtkin.combate (id_combate, id_sala, id_jogador, forca_jogador, forca_monstro, id_carta_monstro, simulado, status, botoes_jogador, botoes_outros_jogadores)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $10, $8, $9)
         ON CONFLICT (id_combate) DO UPDATE SET
           id_jogador = EXCLUDED.id_jogador,
           id_sala = EXCLUDED.id_sala,
           forca_jogador = EXCLUDED.forca_jogador,
           forca_monstro = EXCLUDED.forca_monstro,
           id_carta_monstro = EXCLUDED.id_carta_monstro,
           status = EXCLUDED.status,
           botoes_jogador = EXCLUDED.botoes_jogador,
           botoes_outros_jogadores = EXCLUDED.botoes_outros_jogadores,
           interferencia = '',
           id_helper = NULL,
           duo_prontos = '',
           atualizado_em = NOW()`,
        [combatId, room.id, userId, forcaJogadorReg, forcaMonstroReg, idCartaMonstro, simFlagParticipacao, botoesJogador, botoesOutrosJogadores, statusInicial]
      );
      console.log(`[COMBATE] Registrado combatId=${combatId} forca_jogador=${forcaJogadorReg} forca_monstro=${forcaMonstroReg} status=${statusInicial} botoes_jogador="${botoesJogador}" botoes_outros="${botoesOutrosJogadores}"`);
    } catch(e) { console.error('[COMBATE] Erro ao registrar combate:', e.message); }

    // pendingCount: quando jogador domina, TODOS os outros precisam decidir
    const pendingCount = monstroDomina ? 0 : otherPlayers.length;
    res.json({ success: true, pendingCount, monstroDomina });
  } catch (error) {
    console.error('Erro ao iniciar participação:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// GET /api/combate/estado — retorna o combate ativo da sala com os botões que devem aparecer para este jogador
app.get('/api/combate/estado', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const roomResult = await pool.query(
      `SELECT r.id FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true AND r.status = 'playing' LIMIT 1`,
      [userId]
    );
    if (!roomResult.rows.length) return res.json({ combate: null });
    const roomId = roomResult.rows[0].id;

    const result = await pool.query(
      `SELECT id_combate, id_jogador, forca_jogador, forca_monstro, status,
              botoes_jogador, botoes_outros_jogadores, interferencia, id_helper, duo_prontos
       FROM mtkin.combate
       WHERE id_sala = $1 AND status NOT IN ('vitoria','fuga','derrota')
       ORDER BY criado_em DESC LIMIT 1`,
      [roomId]
    );
    if (!result.rows.length) return res.json({ combate: null });

    const c = result.rows[0];
    const efeitosCombate = parseCombatInterferencia(c.interferencia);
    const interferidos = efeitosCombate.ids;
    const souOLutador  = Number(c.id_jogador) === Number(userId);

    // Força ao vivo dos jogadores — quando há duo, somar ambas as forças
    // Fonte primária: id_helper em mtkin.combate; fallback: ajuda_combate com escolhido=TRUE
    let helperId_duo = c.id_helper ? Number(c.id_helper) : null;
    if (!helperId_duo && c.id_combate) {
      try {
        const ajudaRow = await pool.query(
          `SELECT id_destinatario FROM mtkin.ajuda_combate
           WHERE id_combate = $1 AND escolhido = TRUE LIMIT 1`,
          [c.id_combate]
        );
        if (ajudaRow.rows.length) helperId_duo = Number(ajudaRow.rows[0].id_destinatario);
      } catch(_) {}
    }
    // sou_helper: usar helperId_duo (com fallback ajuda_combate) para cobrir race condition
    const souOHelper = helperId_duo && Number(helperId_duo) === Number(userId);

    // Força ao vivo do lutador (atualizada a cada polling, sem depender de valor stale da tabela combate)
    let forcaLutadorLive = Number(c.forca_jogador) || 0;
    try {
      const soLive = await pool.query(
        `SELECT forca FROM mtkin.sala_online WHERE id_player = $1`, [Number(c.id_jogador)]
      );
      if (soLive.rows.length > 0) forcaLutadorLive = Number(soLive.rows[0].forca) || 0;
    } catch(_) {}

    let forca_duo = null;
    if (helperId_duo) {
      try {
        const duoForcaRes = await pool.query(
          `SELECT id_player, forca FROM mtkin.sala_online
           WHERE id_player = ANY($1::int[])`,
          [[Number(c.id_jogador), helperId_duo]]
        );
        const byId = Object.fromEntries(duoForcaRes.rows.map(r => [r.id_player, Number(r.forca) || 0]));
        const fLutador = byId[Number(c.id_jogador)] || 0;
        const fHelper  = byId[helperId_duo]          || 0;
        forcaLutadorLive = fLutador; // Atualizar com valor mais recente
        forca_duo = fLutador + fHelper;
      } catch(_) {}
    }

    // Somar bônus das cartas jogadas nas zonas de combate (lado jogador e lado monstro)
    let bonusCartasJogador = 0, bonusCartasMonstro = 0;
    try {
      const bonusRes = await pool.query(
        `SELECT lado, COALESCE(SUM(bonus), 0) AS total_bonus
         FROM mtkin.combate_cartas
         WHERE id_combate = $1
         GROUP BY lado`,
        [c.id_combate]
      );
      for (const row of bonusRes.rows) {
        if (row.lado === 'jogador')  bonusCartasJogador = Number(row.total_bonus) || 0;
        if (row.lado === 'monstro')  bonusCartasMonstro = Number(row.total_bonus) || 0;
      }
    } catch(_) {}

    async function countDecisionsByParticipation(excludedUserIds = []) {
      const excluded = (excludedUserIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0);
      const params = [roomId, c.id_combate, Number(c.id_jogador), excluded];
      const agg = await pool.query(
        `SELECT
           COUNT(*)::int AS total_online,
           COUNT(*) FILTER (WHERE cp.status IN ('pronto','recusou'))::int AS total_decididos
         FROM mtkin.room_participants rp
         LEFT JOIN mtkin.combate_participacao cp
           ON cp.id_sala = rp.room_id
          AND cp.id_jogador = rp.user_id
          AND (cp.id_combate = $2 OR cp.id_combate IS NULL)
         WHERE rp.room_id = $1
           AND rp.is_online = true
           AND rp.user_id != $3
           AND (cardinality($4::int[]) = 0 OR rp.user_id != ALL($4::int[]))`,
        params
      );
      return {
        totalOnline: Number(agg.rows[0]?.total_online || 0),
        totalDecididos: Number(agg.rows[0]?.total_decididos || 0)
      };
    }

    // Se em Fase 1, verificar se todos os outros já decidiram e promover para Fase 2
    if (c.status === 'Fase 1') {
      const decisaoAgg = await countDecisionsByParticipation();
      const totalOutros = decisaoAgg.totalOnline;
      const decididosViaSql = decisaoAgg.totalDecididos;
      const decididosViaInterferencia = interferidos.length;
      const todosDecidiram = totalOutros === 0 || Math.max(decididosViaSql, decididosViaInterferencia) >= totalOutros;

      if (todosDecidiram) {
        const forcaJogadorEfetiva = (forca_duo !== null ? forca_duo : forcaLutadorLive) + bonusCartasJogador;
        const forcaMonstroEfetiva = Number(c.forca_monstro) + bonusCartasMonstro;
        const novosBotoes = forcaJogadorEfetiva > forcaMonstroEfetiva
          ? 'Lutar'
          : (efeitosCombate.disable_run ? 'Pedir ajuda' : 'Correr;Pedir ajuda');
        await pool.query(
          `UPDATE mtkin.combate
           SET status = 'Fase 2',
               botoes_jogador = $1,
               botoes_outros_jogadores = '',
               interferencia = '',
               atualizado_em = NOW()
           WHERE id_combate = $2 AND status = 'Fase 1'`,
          [novosBotoes, c.id_combate]
        );
        c.status                   = 'Fase 2';
        c.botoes_jogador           = novosBotoes;
        c.botoes_outros_jogadores  = '';
        c.interferencia            = '';
      }
    }

    // Se em 'Pedido de ajuda' com botoes_jogador vazio, verificar se todos os outros (fora do duo) já decidiram
    if (c.status === 'Pedido de ajuda' && !c.botoes_jogador) {
      const duoHelper = c.id_helper || helperId_duo;
      const decisaoAgg = await countDecisionsByParticipation([duoHelper || 0]);
      const totalOutros = decisaoAgg.totalOnline;
      const decididosViaSql = decisaoAgg.totalDecididos;
      const decididosViaInterferencia = interferidos.length;
      const todosDecidiram = totalOutros === 0 || Math.max(decididosViaSql, decididosViaInterferencia) >= totalOutros;

      if (todosDecidiram) {
        const forcaTotal  = (forca_duo !== null ? forca_duo : forcaLutadorLive) + bonusCartasJogador;
        const forcaMonstroEfetiva = Number(c.forca_monstro) + bonusCartasMonstro;
        if (forcaTotal > forcaMonstroEfetiva) {
          // Duo mais forte — finalizar com Lutar
          await pool.query(
            `UPDATE mtkin.combate
             SET botoes_jogador = 'Lutar',
                 forca_jogador  = $1,
                 botoes_outros_jogadores = '',
                 atualizado_em = NOW()
             WHERE id_combate = $2 AND status = 'Pedido de ajuda' AND botoes_jogador = ''`,
            [forcaTotal, c.id_combate]
          );
          c.forca_jogador           = forcaTotal;
          c.botoes_jogador          = 'Lutar';
          c.botoes_outros_jogadores = '';
          combateLog('DUO_TODOS_DECIDIRAM', { id: userId }, `✅ Todos decidiram — Lutar (duo=${forcaTotal} vs monstro=${forcaMonstroEfetiva})`, { roomId });
        } else {
          // Monstro mais forte — resetar para nova rodada de cartas do duo
          await pool.query(
            `UPDATE mtkin.combate
             SET botoes_jogador = '',
                 botoes_outros_jogadores = '',
                 interferencia = '',
                 duo_prontos = '',
                 atualizado_em = NOW()
             WHERE id_combate = $1 AND status = 'Pedido de ajuda' AND botoes_jogador = ''`,
            [c.id_combate]
          );
          c.botoes_jogador          = '';
          c.botoes_outros_jogadores = '';
          c.interferencia           = '';
          c.duo_prontos             = '';
          combateLog('DUO_TODOS_DECIDIRAM', { id: userId }, `🔄 Monstro mais forte (duo=${forcaTotal} vs monstro=${forcaMonstroEfetiva}) — duo pode jogar mais cartas`, { roomId });
        }
      }
    }

    // ── Recalculação ao vivo: se cartas foram jogadas APÓS a decisão de botões,
    //    os botões precisam refletir as forças atuais ──
    // Não recalcular se o resultado de fuga já foi registrado (Ganhou/Perdeu)
    if (c.status === 'Fase 2' && c.botoes_jogador && c.botoes_jogador !== 'Ganhou' && c.botoes_jogador !== 'Perdeu') {
      const forcaJogEfetiva = (forca_duo !== null ? forca_duo : forcaLutadorLive) + bonusCartasJogador;
      const forcaMonEfetiva = Number(c.forca_monstro) + bonusCartasMonstro;
      if (forcaJogEfetiva > forcaMonEfetiva) {
        // Jogador ficou mais forte — se antes estava em Correr/Pedir ajuda, mostrar Pronto
        // para que os outros jogadores tenham chance de decidir antes de Lutar
        if (c.botoes_jogador === 'Correr;Pedir ajuda') {
          c.botoes_jogador = 'Pronto';
          await pool.query(
            `UPDATE mtkin.combate SET botoes_jogador = 'Pronto', atualizado_em = NOW()
             WHERE id_combate = $1 AND status = 'Fase 2'`,
            [c.id_combate]
          );
        }
        // Se já é 'Lutar' ou 'Pronto', manter como está
      } else {
        // Monstro mais forte — garantir Correr;Pedir ajuda
        const botoesFraqueza = efeitosCombate.disable_run ? 'Pedir ajuda' : 'Correr;Pedir ajuda';
        if (c.botoes_jogador !== botoesFraqueza) {
          c.botoes_jogador = botoesFraqueza;
          await pool.query(
            `UPDATE mtkin.combate SET botoes_jogador = $1, atualizado_em = NOW()
             WHERE id_combate = $2 AND status = 'Fase 2'`,
            [botoesFraqueza, c.id_combate]
          );
        }
      }
    }
    // Recalculação ao vivo para 'Pedido de ajuda' com botão 'Lutar' definido:
    // Se cartas foram removidas/adicionadas após a decisão, verificar se Lutar ainda é válido
    if (c.status === 'Pedido de ajuda' && c.botoes_jogador === 'Lutar') {
      const forcaJogEfetiva = (forca_duo !== null ? forca_duo : forcaLutadorLive) + bonusCartasJogador;
      const forcaMonEfetiva = Number(c.forca_monstro) + bonusCartasMonstro;
      if (forcaJogEfetiva <= forcaMonEfetiva) {
        // Monstro ficou mais forte — resetar para nova rodada de cartas
        c.botoes_jogador          = '';
        c.botoes_outros_jogadores = '';
        c.interferencia           = '';
        c.duo_prontos             = '';
        await pool.query(
          `UPDATE mtkin.combate
           SET botoes_jogador = '', botoes_outros_jogadores = '',
               interferencia = '', duo_prontos = '', atualizado_em = NOW()
           WHERE id_combate = $1 AND status = 'Pedido de ajuda'`,
          [c.id_combate]
        );
      }
    }

    // Determinar botões para cada perfil
    // Somente o lutador (sou_lutador) recebe botoes_jogador; helper e outros recebem botoes_outros_jogadores
    const meusBotoes = souOLutador ? c.botoes_jogador : c.botoes_outros_jogadores;

    // Quando há distribuição pendente, incluir cartas na resposta para o helper abrir o modal
    let distribuicaoInfo = null;
    if (c.status === 'distribuindo') {
      try {
        const distRow = await pool.query(
          `SELECT dp.id_carta, dp.nome_carta, dp.caminho_imagem,
                  ca.texto_da_carta, ca.equipar_onde, ca.forca, ca.nivel, ca.fulga_minima, ca.valor, ca.pesado
           FROM mtkin.distribuicao_pendente dp
           LEFT JOIN mtkin.cartas ca ON ca.id = dp.id_carta
           WHERE dp.id_sala=$1 AND dp.id_combate=$2 ORDER BY dp.id ASC`,
          [roomId, c.id_combate]
        );
        // Buscar distribuicao_vez e tipo_acordo da linha de combate
        const distMeta = await pool.query(
          `SELECT distribuicao_vez, tipo_acordo FROM mtkin.combate WHERE id_sala=$1 AND id_combate=$2 LIMIT 1`,
          [roomId, c.id_combate]
        );
        distribuicaoInfo = {
          cards:       distRow.rows,
          vez_de:      distMeta.rows[0]?.distribuicao_vez ?? null,
          tipo_acordo: distMeta.rows[0]?.tipo_acordo      ?? null,
          helper_id:   c.id_helper,
          lutador_id:  c.id_jogador,
          combate_id:  c.id_combate
        };
      } catch(_) {}
    }

    res.json({
      combate: {
        id_combate:    c.id_combate,
        id_jogador:    c.id_jogador,
        forca_jogador: forcaLutadorLive,
        forca_monstro: c.forca_monstro,
        status:        c.status,
        sou_lutador:   souOLutador,
        sou_helper:    !!souOHelper,
        interferencia: c.interferencia || '',
        efeitos:       efeitosCombate,
        duo_prontos:   c.duo_prontos  || '',
        forca_duo:     forca_duo,
        botoes:        meusBotoes ? meusBotoes.split(';').map(b => b.trim()).filter(Boolean) : [],
        distribuicao:  distribuicaoInfo
      }
    });
  } catch (err) {
    console.error('[combate/estado] Erro:', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/combate/participar
app.post('/api/combate/participar', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const roomId = await getRoomIdFromUser(userId);
    if (!roomId) return res.status(404).json({ error: 'Sala não encontrada' });

    // Garantir estrutura em memória (recupera do DB se necessário)
    let combat = combateParticipacaoByRoomId.get(roomId);
    if (!combat) {
      try {
        const dbRow = await pool.query(
          `SELECT id_jogador_luta, id_combate FROM mtkin.combate_participacao WHERE id_sala = $1 LIMIT 1`, [roomId]);
        if (dbRow.rows.length > 0) {
          combat = { combatId: dbRow.rows[0].id_combate, fightingPlayerId: dbRow.rows[0].id_jogador_luta, participants: {} };
          combateParticipacaoByRoomId.set(roomId, combat);
        }
      } catch(_) {}
    }
    if (combat && combat.participants.hasOwnProperty(userId)) combat.participants[userId] = 'participando';
    combateLog('PARTICIPAR', req.user, '✅ Jogador decidiu participar do combate', { sala: roomId, combatId: combat?.combatId });

    // UPSERT: garante que a linha exista mesmo se iniciar-participacao falhou
    try {
      const meta = combat || {};
      await pool.query(
        `INSERT INTO mtkin.combate_participacao (id_sala, id_combate, id_jogador_luta, id_jogador, status, simulado)
         VALUES ($1, $2, $3, $4, 'participando', $5)
         ON CONFLICT (id_sala, id_jogador) DO UPDATE SET status = 'participando', updated_at = NOW()`,
        [roomId, meta.combatId || null, meta.fightingPlayerId || null, userId, await getSimFlag(roomId)]
      );
    } catch(e) { console.error('[COMBATE/participar] DB upsert falhou:', e.message); }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/combate/recusar
app.post('/api/combate/recusar', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const roomId = await getRoomIdFromUser(userId);
    if (!roomId) return res.status(404).json({ error: 'Sala não encontrada' });

    let combat = combateParticipacaoByRoomId.get(roomId);
    if (!combat) {
      try {
        const dbRow = await pool.query(
          `SELECT id_jogador_luta, id_combate FROM mtkin.combate_participacao WHERE id_sala = $1 LIMIT 1`, [roomId]);
        if (dbRow.rows.length > 0) {
          combat = { combatId: dbRow.rows[0].id_combate, fightingPlayerId: dbRow.rows[0].id_jogador_luta, participants: {} };
          combateParticipacaoByRoomId.set(roomId, combat);
        }
      } catch(_) {}
    }
    if (combat && combat.participants.hasOwnProperty(userId)) combat.participants[userId] = 'recusou';
    combateLog('RECUSAR-PARTICIPAR', req.user, '🚫 Jogador recusou participar do combate', { sala: roomId, combatId: combat?.combatId });

    try {
      const meta = combat || {};
      await pool.query(
        `INSERT INTO mtkin.combate_participacao (id_sala, id_combate, id_jogador_luta, id_jogador, status, simulado)
         VALUES ($1, $2, $3, $4, 'recusou', $5)
         ON CONFLICT (id_sala, id_jogador) DO UPDATE SET status = 'recusou', updated_at = NOW()`,
        [roomId, meta.combatId || null, meta.fightingPlayerId || null, userId, await getSimFlag(roomId)]
      );
    } catch(e) { console.error('[COMBATE/recusar] DB upsert falhou:', e.message); }

    // Registrar em interferencia (Não entrar = decisão imediata)
    try {
      await appendCombatDecisionInterference(roomId, userId);
    } catch(e) { console.error('[COMBATE/recusar] interferencia falhou:', e.message); }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/combate/duo/pronto — lutador ou helper confirma que o duo está pronto
// Controla as colunas duo_pronto_lutador / duo_pronto_helper na linha do helper em combate_participacao
app.post('/api/combate/duo/pronto', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const roomId = await getRoomIdFromUser(userId);
    if (!roomId) return res.status(404).json({ error: 'Sala não encontrada' });

    // Buscar a linha do helper (status='participando') nesta sala
    const helperRow = await pool.query(
      `SELECT id_jogador, id_jogador_luta, duo_pronto_lutador, duo_pronto_helper
       FROM mtkin.combate_participacao
       WHERE id_sala = $1 AND status = 'participando'
       LIMIT 1`,
      [roomId]
    );
    if (helperRow.rows.length === 0) {
      return res.status(400).json({ error: 'Nenhum helper participando encontrado' });
    }
    const row        = helperRow.rows[0];
    const helperId   = row.id_jogador;
    const fighterId  = row.id_jogador_luta;
    const isLutador  = userId === fighterId;
    const isHelper   = userId === helperId;
    if (!isLutador && !isHelper) {
      return res.status(403).json({ error: 'Você não faz parte deste duo' });
    }

    // Marcar a coluna correspondente
    const coluna = isLutador ? 'duo_pronto_lutador' : 'duo_pronto_helper';
    await pool.query(
      `UPDATE mtkin.combate_participacao SET ${coluna}=TRUE, updated_at=NOW()
       WHERE id_sala=$1 AND id_jogador=$2`,
      [roomId, helperId]
    );

    // Reler para checar se ambos confirmaram
    const recheck = await pool.query(
      `SELECT duo_pronto_lutador, duo_pronto_helper FROM mtkin.combate_participacao
       WHERE id_sala=$1 AND id_jogador=$2`,
      [roomId, helperId]
    );
    const ambosProtos = recheck.rows[0]?.duo_pronto_lutador && recheck.rows[0]?.duo_pronto_helper;

    if (ambosProtos) {
      // Liberar outros jogadores (exceto lutador e helper) para verem Entrar/Não Entrar
      await pool.query(
        `UPDATE mtkin.combate_participacao SET status='esperando', updated_at=NOW()
         WHERE id_sala=$1 AND id_jogador!=$2 AND id_jogador!=$3`,
        [roomId, fighterId, helperId]
      ).catch(() => {});
      combateLog('DUO_PRONTO', req.user, `✅ Ambos confirmaram — outros liberados para Entrar/Não Entrar`, { roomId, fighterId, helperId });
      return res.json({ success: true, duoFinalizado: true });
    }
    combateLog('DUO_PRONTO', req.user, `⏳ ${coluna} marcado`, { roomId });
    res.json({ success: true, duoFinalizado: false });
  } catch (error) {
    console.error('[duo/pronto]', error.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/combate/duo/confirmar-pronto — lutador ou helper confirma pronto no modo 'Pedido de ajuda'
app.post('/api/combate/duo/confirmar-pronto', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const roomId = await getRoomIdFromUser(userId);
    if (!roomId) return res.status(404).json({ error: 'Sala não encontrada' });

    // Buscar combate ativo com status 'Pedido de ajuda'
    const combateRes = await pool.query(
      `SELECT id_combate, id_jogador, id_helper, duo_prontos, interferencia
       FROM mtkin.combate
       WHERE id_sala=$1 AND status='Pedido de ajuda'
       ORDER BY criado_em DESC LIMIT 1`,
      [roomId]
    );
    if (combateRes.rows.length === 0) {
      return res.status(400).json({ error: 'Nenhum combate em Pedido de ajuda encontrado' });
    }
    const c = combateRes.rows[0];
    const fighterId = Number(c.id_jogador);
    const helperId  = Number(c.id_helper);
    const isLutador = Number(userId) === fighterId;
    const isHelper  = Number(userId) === helperId;
    if (!isLutador && !isHelper) {
      return res.status(403).json({ error: 'Você não faz parte deste duo' });
    }

    // Registrar ID em duo_prontos (sem duplicatas) — fica visível no banco com os dois IDs
    await pool.query(
      `UPDATE mtkin.combate
       SET duo_prontos = CASE
         WHEN duo_prontos = '' THEN $1::text
         WHEN duo_prontos LIKE '%' || $1::text || '%' THEN duo_prontos
         ELSE duo_prontos || ';' || $1::text
       END,
       atualizado_em = NOW()
       WHERE id_sala=$2 AND status='Pedido de ajuda'`,
      [String(userId), roomId]
    );

    // Reler duo_prontos para checar se ambos confirmaram
    const recheckRes = await pool.query(
      `SELECT duo_prontos FROM mtkin.combate
       WHERE id_sala=$1 AND status='Pedido de ajuda'
       ORDER BY criado_em DESC LIMIT 1`,
      [roomId]
    );
    const prontos = (recheckRes.rows[0]?.duo_prontos || '').split(';').map(s => s.trim()).filter(Boolean);
    const ambosConfirmaram = prontos.includes(String(fighterId)) && prontos.includes(String(helperId));

    if (ambosConfirmaram) {
      // Sempre liberar para fase de interferência. O polling de /combate/estado detecta
      // automaticamente se não há outros jogadores e avança para Lutar/Correr.
      await pool.query(
        `UPDATE mtkin.combate
         SET botoes_jogador='', botoes_outros_jogadores='Entrar no combate;Não entrar', atualizado_em=NOW()
         WHERE id_sala=$1 AND status='Pedido de ajuda'`,
        [roomId]
      );
      combateLog('DUO_CONFIRMAR_PRONTO', req.user, `✅ Ambos confirmaram (duo_prontos=${prontos.join(';')}) — fase interferência`, { roomId, fighterId, helperId });
      return res.json({ success: true, duoFinalizado: true });
    }

    combateLog('DUO_CONFIRMAR_PRONTO', req.user, `⏳ ${isLutador ? 'Lutador' : 'Helper'} confirmou — duo_prontos=${prontos.join(';')}`, { roomId });
    res.json({ success: true, duoFinalizado: false });
  } catch (error) {
    console.error('[duo/confirmar-pronto]', error.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/combate/pronto-fase2
// Lutador clica Pronto após ficar mais forte em Fase 2 → reverte para Fase 1 para outros decidirem
app.post('/api/combate/pronto-fase2', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const roomId = await getRoomIdFromUser(userId);
    if (!roomId) return res.status(404).json({ error: 'Sala não encontrada' });

    const combatRes = await pool.query(
      `SELECT id_combate, id_jogador, status, botoes_jogador
       FROM mtkin.combate
       WHERE id_sala = $1 AND status = 'Fase 2' AND id_jogador = $2
       ORDER BY criado_em DESC LIMIT 1`,
      [roomId, userId]
    );
    if (combatRes.rows.length === 0) {
      return res.status(400).json({ error: 'Combate não encontrado ou jogador não é o lutador' });
    }

    const combat = combatRes.rows[0];

    // Reverter para Fase 1: outros jogadores decidem Entrar/Não entrar
    await pool.query(
      `UPDATE mtkin.combate
       SET status = 'Fase 1',
           botoes_jogador = '',
           botoes_outros_jogadores = 'Entrar no combate;Não entrar',
           interferencia = '',
           atualizado_em = NOW()
       WHERE id_combate = $1 AND status = 'Fase 2'`,
      [combat.id_combate]
    );

    // Limpar decisões de participação anteriores para que outros possam decidir novamente
    try {
      await pool.query(
        `DELETE FROM mtkin.combate_participacao WHERE id_sala = $1 AND id_jogador != $2`,
        [roomId, userId]
      );
    } catch(_) {}

    // Limpar participações em memória
    const mem = combateParticipacaoByRoomId.get(roomId);
    if (mem) {
      const newPart = {};
      for (const [k, v] of Object.entries(mem.participants)) {
        if (String(k) === String(userId)) continue;
        newPart[k] = null; // resetar decisão
      }
      mem.participants = newPart;
    }

    combateLog('PRONTO_FASE2', req.user, `✅ Lutador clicou Pronto em Fase 2 — revertendo para Fase 1 para outros decidirem`, { roomId, combatId: combat.id_combate });
    res.json({ success: true });
  } catch (error) {
    console.error('[combate/pronto-fase2]', error.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/combate/pronto-participacao
app.post('/api/combate/pronto-participacao', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const roomId = await getRoomIdFromUser(userId);
    if (!roomId) return res.status(404).json({ error: 'Sala não encontrada' });

    let combat = combateParticipacaoByRoomId.get(roomId);
    if (!combat) {
      try {
        const dbRow = await pool.query(
          `SELECT id_jogador_luta, id_combate FROM mtkin.combate_participacao WHERE id_sala = $1 LIMIT 1`, [roomId]);
        if (dbRow.rows.length > 0) {
          combat = { combatId: dbRow.rows[0].id_combate, fightingPlayerId: dbRow.rows[0].id_jogador_luta, participants: {} };
          combateParticipacaoByRoomId.set(roomId, combat);
        }
      } catch(_) {}
    }
    if (combat && combat.participants.hasOwnProperty(userId)) combat.participants[userId] = 'pronto';

    try {
      const meta = combat || {};
      await pool.query(
        `INSERT INTO mtkin.combate_participacao (id_sala, id_combate, id_jogador_luta, id_jogador, status, simulado)
         VALUES ($1, $2, $3, $4, 'pronto', $5)
         ON CONFLICT (id_sala, id_jogador) DO UPDATE SET status = 'pronto', updated_at = NOW()`,
        [roomId, meta.combatId || null, meta.fightingPlayerId || null, userId, await getSimFlag(roomId)]
      );
    } catch(e) { console.error('[COMBATE/pronto] DB upsert falhou:', e.message); }

    // Registrar em interferencia (Pronto = entrou no combate e concluiu sua parte)
    try {
      await appendCombatDecisionInterference(roomId, userId);
    } catch(e) { console.error('[COMBATE/pronto] interferencia falhou:', e.message); }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/historico/registrar
app.post('/api/historico/registrar', authenticateToken, async (req, res) => {
  try {
    const { id_carta, nome_carta, id_sala, nome_sala, tipo_baralho, acao, local, origem_acao, foi_combate, resultado_combate, quantidade_tesouros } = req.body;
    const userId = req.user.id;
    
    console.log('Requisição para registrar carta:', { id_carta, nome_carta, id_sala, nome_sala, tipo_baralho, acao, origem_acao, foi_combate, resultado_combate, quantidade_tesouros, userId });
    
    // Validar campos obrigatórios
    if (!id_carta || !nome_carta || !id_sala || !nome_sala || !tipo_baralho || !acao) {
      console.error('Campos faltando:', { id_carta, nome_carta, id_sala, nome_sala, tipo_baralho, acao });
      return res.status(400).json({ error: 'Campos obrigatórios faltando' });
    }
    
    // Buscar dados do usuário
    const userResult = await pool.query(
      'SELECT username FROM mtkin.users WHERE id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      console.error('Usuário não encontrado para ID:', userId);
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    const nome_jogador = userResult.rows[0].username;
    
    console.log('Inserindo no histórico com:', { id_carta, nome_carta, local: local || 'sala', userId, nome_jogador, id_sala, nome_sala, tipo_baralho, acao, origem_acao, foi_combate, resultado_combate, quantidade_tesouros });
    
    // Inserir no histórico
    const insertResult = await pool.query(
      `INSERT INTO mtkin.historico_cartas (
        id_carta, nome_carta, local, id_jogador, nome_jogador, id_sala, nome_sala, tipo_baralho, acao, origem_acao, foi_combate, resultado_combate, quantidade_tesouros, simulado
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [id_carta, nome_carta, local || 'sala', userId, nome_jogador, id_sala, nome_sala, tipo_baralho, acao, origem_acao || null, foi_combate || false, resultado_combate || null, quantidade_tesouros || 0, await getSimFlag(Number(id_sala))]
    );
    
    console.log('Carta registrada com sucesso no histórico');
    res.json({ success: true, message: 'Carta registrada no histórico' });
  } catch (error) {
    console.error('Erro ao registrar carta no histórico:', error);
    res.status(500).json({ error: 'Erro ao registrar carta no histórico', details: error.message });
  }
});

// Buscar histórico de cartas da sala
app.get('/api/historico/sala/:salaId', authenticateToken, async (req, res) => {
  try {
    const salaId = parseInt(req.params.salaId);
    
    if (!salaId) {
      return res.status(400).json({ error: 'ID da sala inválido' });
    }
    
    const result = await pool.query(
      `SELECT 
        h.*,
        c.caminho_imagem
       FROM mtkin.historico_cartas h
       LEFT JOIN mtkin.cartas c ON c.id = h.id_carta
       WHERE h.id_sala = $1 
       ORDER BY h.created_at DESC`,
      [salaId]
    );
    
    res.json({ historico: result.rows });
  } catch (error) {
    console.error('Erro ao buscar histórico:', error);
    res.status(500).json({ error: 'Erro ao buscar histórico' });
  }
});

// GET /api/historico/feed - Feed ao vivo para jogadores aguardando a sua vez
app.get('/api/historico/feed', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const since  = parseInt(req.query.since) || 0;
    const limit  = Math.min(parseInt(req.query.limit) || 20, 50);

    const roomResult = await pool.query(
      `SELECT r.id FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true`,
      [userId]
    );
    if (roomResult.rows.length === 0) return res.json({ items: [], lastId: since });

    const roomId = roomResult.rows[0].id;
    const result = await pool.query(
      `SELECT h.id, h.nome_carta, h.nome_jogador, h.tipo_baralho, h.acao, h.origem_acao
       FROM mtkin.historico_cartas h
       WHERE h.id_sala = $1 AND h.id > $2
       ORDER BY h.id DESC
       LIMIT $3`,
      [roomId, since, limit]
    );

    const items = result.rows;
    const lastId = items.length > 0 ? items[0].id : since;
    res.json({ items, lastId });
  } catch (error) {
    console.error('Erro ao buscar feed histórico:', error);
    res.status(500).json({ error: 'Erro ao buscar feed' });
  }
});

// ===== ENDPOINTS DE PROPOSTAS DE TROCA =====

// POST /api/propostas - Criar nova proposta de troca (many-to-many v2)
app.post('/api/propostas', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const { idJogadorDestino, idSala, cartasOrigemIds, cartasOrigemCartelaIds, cartasDestinoIds, cartasDestinoCartelaIds, mensagem } = req.body;
    const userId = req.user.id;

    const mochilaOrigem  = Array.isArray(cartasOrigemIds) ? cartasOrigemIds : [];
    const cartelaOrigem  = Array.isArray(cartasOrigemCartelaIds) ? cartasOrigemCartelaIds : [];
    const mochilaDest    = Array.isArray(cartasDestinoIds) ? cartasDestinoIds : [];
    const cartelaDest    = Array.isArray(cartasDestinoCartelaIds) ? cartasDestinoCartelaIds : [];

    if (!idJogadorDestino || !idSala || (mochilaOrigem.length + cartelaOrigem.length) === 0) {
      return res.status(400).json({ error: 'Dados faltando: idJogadorDestino, idSala e pelo menos uma carta origem são obrigatórios' });
    }

    // Verificar se ambos estão na mesma sala
    const [salaCheck, playerCheck] = await Promise.all([
      pool.query(`SELECT room_id FROM mtkin.room_participants WHERE room_id=$1 AND user_id=$2`, [idSala, userId]),
      pool.query(`SELECT room_id FROM mtkin.room_participants WHERE room_id=$1 AND user_id=$2`, [idSala, idJogadorDestino])
    ]);
    if (salaCheck.rows.length === 0) return res.status(403).json({ error: 'Você não está nesta sala' });
    if (playerCheck.rows.length === 0) return res.status(403).json({ error: 'Jogador destino não está nesta sala' });

    // Validar cartas origem da mochila
    if (mochilaOrigem.length > 0) {
      const cartasOrigemCheck = await pool.query(
        `SELECT m.id FROM mtkin.mochila m
         WHERE m.id = ANY($1::int[]) AND m.id_jogador=$2 AND m.id_sala=$3
           AND NOT EXISTS (
             SELECT 1 FROM mtkin.cartas_no_jogo cj
             WHERE cj.id_carta = m.id_carta AND cj.id_sala=$3 AND cj.id_jogador=$2
           )`,
        [mochilaOrigem, userId, idSala]
      );
      if (cartasOrigemCheck.rows.length !== mochilaOrigem.length) {
        return res.status(403).json({ error: 'Uma ou mais cartas origem da mochila não são válidas' });
      }
    }

    // Validar cartas origem da cartela (cartas_ativas)
    if (cartelaOrigem.length > 0) {
      const cartelaOrigemCheck = await pool.query(
        `SELECT id_carta FROM mtkin.cartas_ativas
         WHERE id_carta = ANY($1::int[]) AND id_jogador=$2 AND id_sala=$3`,
        [cartelaOrigem, userId, idSala]
      );
      if (cartelaOrigemCheck.rows.length !== cartelaOrigem.length) {
        return res.status(403).json({ error: 'Uma ou mais cartas origem da cartela não são válidas' });
      }
    }

    // Validar cartas destino da mochila
    if (mochilaDest.length > 0) {
      const cartasDestinoCheck = await pool.query(
        `SELECT m.id FROM mtkin.mochila m
         WHERE m.id = ANY($1::int[]) AND m.id_jogador=$2 AND m.id_sala=$3
           AND NOT EXISTS (
             SELECT 1 FROM mtkin.cartas_no_jogo cj
             WHERE cj.id_carta = m.id_carta AND cj.id_sala=$3 AND cj.id_jogador=$2
           )`,
        [mochilaDest, idJogadorDestino, idSala]
      );
      if (cartasDestinoCheck.rows.length !== mochilaDest.length) {
        return res.status(403).json({ error: 'Uma ou mais cartas destino da mochila não são válidas' });
      }
    }

    // Validar cartas destino da cartela (cartas_ativas do oponente)
    if (cartelaDest.length > 0) {
      const cartelaDestCheck = await pool.query(
        `SELECT id_carta FROM mtkin.cartas_ativas
         WHERE id_carta = ANY($1::int[]) AND id_jogador=$2 AND id_sala=$3`,
        [cartelaDest, idJogadorDestino, idSala]
      );
      if (cartelaDestCheck.rows.length !== cartelaDest.length) {
        return res.status(403).json({ error: 'Uma ou mais cartas destino da cartela não são válidas' });
      }
    }

    await client.query('BEGIN');

    // Criar cabeçalho da proposta
    const propostaResult = await client.query(
      `INSERT INTO mtkin.propostas_troca (id_sala, id_jogador_origem, id_jogador_destino, status, mensagem)
       VALUES ($1, $2, $3, 'pendente', $4) RETURNING id, status, criada_em`,
      [idSala, userId, idJogadorDestino, mensagem || null]
    );
    const propostaId = propostaResult.rows[0].id;

    // Inserir itens origem da mochila
    for (const cid of mochilaOrigem) {
      await client.query(
        `INSERT INTO mtkin.propostas_troca_itens (id_proposta, id_mochila, lado, fonte) VALUES ($1,$2,'origem','mochila')`,
        [propostaId, cid]
      );
    }
    // Inserir itens origem da cartela
    for (const cid of cartelaOrigem) {
      await client.query(
        `INSERT INTO mtkin.propostas_troca_itens (id_proposta, id_carta, lado, fonte) VALUES ($1,$2,'origem','cartela')`,
        [propostaId, cid]
      );
    }
    // Inserir itens destino da mochila
    for (const cid of mochilaDest) {
      await client.query(
        `INSERT INTO mtkin.propostas_troca_itens (id_proposta, id_mochila, lado, fonte) VALUES ($1,$2,'destino','mochila')`,
        [propostaId, cid]
      );
    }
    // Inserir itens destino da cartela
    for (const cid of cartelaDest) {
      await client.query(
        `INSERT INTO mtkin.propostas_troca_itens (id_proposta, id_carta, lado, fonte) VALUES ($1,$2,'destino','cartela')`,
        [propostaId, cid]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, proposta: propostaResult.rows[0], message: 'Proposta de troca criada com sucesso!' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Erro ao criar proposta:', error);
    res.status(500).json({ error: 'Erro ao criar proposta', details: error.message });
  } finally {
    client.release();
  }
});

// GET /api/propostas/pendentes - Listar propostas pendentes para o usuário
// GET /api/propostas/pendentes - Listar propostas pendentes (many-to-many v2)
app.get('/api/propostas/pendentes', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Buscar cabeçalhos das propostas
    const propostasResult = await pool.query(
      `SELECT p.id, p.id_sala, p.id_jogador_origem, p.id_jogador_destino,
              p.status, p.mensagem, p.criada_em,
              u_origem.username AS jogador_origem_nome,
              u_destino.username  AS jogador_destino_nome
       FROM mtkin.propostas_troca p
       JOIN mtkin.users u_origem ON p.id_jogador_origem = u_origem.id
       JOIN mtkin.users u_destino ON p.id_jogador_destino = u_destino.id
       WHERE (p.id_jogador_destino=$1 OR p.id_jogador_origem=$1)
         AND p.status IN ('pendente','contraoferta')
       ORDER BY p.criada_em DESC`,
      [userId]
    );

    if (propostasResult.rows.length === 0) {
      return res.json({ propostas: [] });
    }

    const propostaIds = propostasResult.rows.map(r => r.id);

    // Buscar todos os itens dessas propostas (mochila + cartela)
    const itensResult = await pool.query(
      `SELECT pti.id_proposta, pti.id_mochila, pti.id_carta AS carta_direta, pti.lado, pti.fonte,
              COALESCE(c_mochila.caminho_imagem, c_cartela.caminho_imagem) AS caminho_imagem,
              COALESCE(c_mochila.nome_carta, c_cartela.nome_carta) AS nome_carta,
              COALESCE(c_mochila.equipar_onde, c_cartela.equipar_onde) AS equipar_onde
       FROM mtkin.propostas_troca_itens pti
       LEFT JOIN mtkin.mochila m ON m.id = pti.id_mochila
       LEFT JOIN mtkin.cartas c_mochila ON c_mochila.id = m.id_carta
       LEFT JOIN mtkin.cartas c_cartela ON c_cartela.id = pti.id_carta
       WHERE pti.id_proposta = ANY($1::int[])`,
      [propostaIds]
    );

    // Agrupar itens por proposta
    const itensPorProposta = {};
    for (const item of itensResult.rows) {
      if (!itensPorProposta[item.id_proposta]) {
        itensPorProposta[item.id_proposta] = { origem: [], destino: [] };
      }
      itensPorProposta[item.id_proposta][item.lado].push({
        id_mochila: item.id_mochila,
        id_carta: item.carta_direta,
        fonte: item.fonte,
        caminho_imagem: item.caminho_imagem,
        nome_carta: item.nome_carta,
        equipar_onde: item.equipar_onde
      });
    }

    const propostas = propostasResult.rows.map(p => ({
      ...p,
      itens_origem:  (itensPorProposta[p.id] || {}).origem  || [],
      itens_destino: (itensPorProposta[p.id] || {}).destino || []
    }));

    res.json({ propostas });
  } catch (error) {
    console.error('Erro ao buscar propostas pendentes:', error);
    res.status(500).json({ error: 'Erro ao buscar propostas', details: error.message });
  }
});

// PUT /api/propostas/:id/aceitar - Aceitar proposta e executar troca
app.put('/api/propostas/:id/aceitar', authenticateToken, async (req, res) => {
  const client = await pool.connect();

  try {
    const propostaId = parseInt(req.params.id);
    const userId = req.user.id;

    const propostaResult = await client.query(
      `SELECT * FROM mtkin.propostas_troca WHERE id = $1`, [propostaId]
    );
    if (propostaResult.rows.length === 0) return res.status(404).json({ error: 'Proposta não encontrada' });

    const proposta = propostaResult.rows[0];
    if (proposta.id_jogador_destino !== userId) {
      return res.status(403).json({ error: 'Você não tem permissão para aceitar esta proposta' });
    }

    // Buscar itens envolvidos (mochila + cartela)
    const itensResult = await client.query(
      `SELECT pti.id_mochila, pti.id_carta AS carta_direta, pti.lado, pti.fonte,
              COALESCE(m.id_jogador,
                CASE WHEN pti.lado='origem' THEN $2 ELSE $3 END
              ) AS dono_atual,
              COALESCE(m.id_carta, pti.id_carta) AS id_carta
       FROM mtkin.propostas_troca_itens pti
       LEFT JOIN mtkin.mochila m ON m.id = pti.id_mochila
       WHERE pti.id_proposta = $1`,
      [propostaId, proposta.id_jogador_origem, proposta.id_jogador_destino]
    );

    await client.query('BEGIN');

    for (const item of itensResult.rows) {
      const novoJogador = item.lado === 'origem' ? proposta.id_jogador_destino : proposta.id_jogador_origem;
      const donoAtual  = item.dono_atual;
      const idCarta    = item.id_carta;

      if (item.fonte === 'mochila' && item.id_mochila) {
        // 1. Transferir dono na mochila
        await client.query(
          `UPDATE mtkin.mochila SET id_jogador=$1 WHERE id=$2`,
          [novoJogador, item.id_mochila]
        );
      }

      // 2. Se a carta estiver equipada na cartela do dono atual, desalocar o slot
      await client.query(
        `DELETE FROM mtkin.cartas_ativas WHERE id_jogador=$1 AND id_sala=$2 AND id_carta=$3`,
        [donoAtual, proposta.id_sala, idCarta]
      );

      // 3. Para cartas da cartela sem entrada na mochila, criar entrada na mochila do novo dono
      if (item.fonte === 'cartela' && !item.id_mochila) {
        await client.query(
          `INSERT INTO mtkin.mochila (id_jogador, id_sala, id_carta)
           VALUES ($1, $2, $3)`,
          [novoJogador, proposta.id_sala, idCarta]
        );
      }
    }

    await client.query(
      `UPDATE mtkin.propostas_troca SET status='aceita', respondida_em=CURRENT_TIMESTAMP WHERE id=$1`,
      [propostaId]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'Proposta aceita! Cartas trocadas com sucesso.' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Erro ao aceitar proposta:', error);
    res.status(500).json({ error: 'Erro ao aceitar proposta', details: error.message });
  } finally {
    client.release();
  }
});

// PUT /api/propostas/:id/recusar - Recusar proposta
app.put('/api/propostas/:id/recusar', authenticateToken, async (req, res) => {
  try {
    const propostaId = parseInt(req.params.id);
    const userId = req.user.id;

    const propostaResult = await pool.query(
      `SELECT * FROM mtkin.propostas_troca WHERE id = $1`,
      [propostaId]
    );

    if (propostaResult.rows.length === 0) {
      return res.status(404).json({ error: 'Proposta não encontrada' });
    }

    const proposta = propostaResult.rows[0];

    if (proposta.id_jogador_destino !== userId) {
      return res.status(403).json({ error: 'Você não tem permissão para recusar esta proposta' });
    }

    const updateResult = await pool.query(
      `UPDATE mtkin.propostas_troca 
       SET status = 'recusada', respondida_em = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [propostaId]
    );

    res.json({ 
      success: true, 
      proposta: updateResult.rows[0],
      message: 'Proposta recusada.' 
    });
  } catch (error) {
    console.error('Erro ao recusar proposta:', error);
    res.status(500).json({ error: 'Erro ao recusar proposta', details: error.message });
  }
});

// PUT /api/propostas/:id/contraoferta - Fazer contra-oferta
app.put('/api/propostas/:id/contraoferta', authenticateToken, async (req, res) => {
  try {
    const propostaId = parseInt(req.params.id);
    const { novaCartaDestinoId, mensagem } = req.body;
    const userId = req.user.id;

    const propostaResult = await pool.query(
      `SELECT * FROM mtkin.propostas_troca WHERE id = $1`,
      [propostaId]
    );

    if (propostaResult.rows.length === 0) {
      return res.status(404).json({ error: 'Proposta não encontrada' });
    }

    const proposta = propostaResult.rows[0];

    if (proposta.id_jogador_destino !== userId) {
      return res.status(403).json({ error: 'Você não tem permissão para fazer contra-oferta' });
    }

    const updateResult = await pool.query(
      `UPDATE mtkin.propostas_troca 
       SET status = 'contraoferta', 
           carta_destino = $1, 
           mensagem = $2,
           respondida_em = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING *`,
      [novaCartaDestinoId || null, mensagem || null, propostaId]
    );

    res.json({ 
      success: true, 
      proposta: updateResult.rows[0],
      message: 'Contra-oferta realizada!' 
    });
  } catch (error) {
    console.error('Erro ao fazer contra-oferta:', error);
    res.status(500).json({ error: 'Erro ao fazer contra-oferta', details: error.message });
  }
});

// ===== ENDPOINTS DE AJUDA EM COMBATE =====

// Helper: garantir que a tabela exista (criada no startup, mas fallback aqui)
async function ensureAjudaTable() {
  await pool.query(`
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
      escolhido       BOOLEAN       NOT NULL DEFAULT FALSE,
      proposta_pai    INTEGER       REFERENCES mtkin.ajuda_combate(id),
      created_at      TIMESTAMPTZ   DEFAULT NOW(),
      updated_at      TIMESTAMPTZ   DEFAULT NOW()
    )
  `);
  // Adicionar coluna escolhido se já existir tabela sem ela (migracao)
  await pool.query(`
    ALTER TABLE mtkin.ajuda_combate
    ADD COLUMN IF NOT EXISTS escolhido BOOLEAN NOT NULL DEFAULT FALSE
  `).catch(() => {});
}

// GET /api/combate/ajuda/status — polling: estado do combate de ajuda
app.get('/api/combate/ajuda/status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const roomId = await getRoomIdFromUser(userId);
    if (!roomId) return res.json({ combateAtivo: false });

    const combat = combateParticipacaoByRoomId.get(roomId);
    const modo   = ajudaModoAbertoByRoomId.get(roomId);

    // Determinar lutadorId e combatId: memória primeiro, depois DB (resistente a restart)
    let lutadorId = modo?.lutadorId || combat?.fightingPlayerId || null;
    let combatId  = combat?.combatId || modo?.combatId || null;

    if (!lutadorId || !combatId) {
      try {
        const dbLut = await pool.query(
          `SELECT id_jogador_luta, id_combate FROM mtkin.combate_participacao
           WHERE id_sala = $1 ORDER BY updated_at DESC LIMIT 1`,
          [roomId]
        );
        if (dbLut.rows.length > 0) {
          lutadorId = lutadorId || dbLut.rows[0].id_jogador_luta;
          combatId  = combatId  || dbLut.rows[0].id_combate;
        }
      } catch(e) { console.error('[status/dbLut]', e.message); }
    }

    const combateAtivo = !!(combatId && lutadorId);
    const souOLutador  = parseInt(lutadorId) === parseInt(userId);



    // ── LUTADOR: monitorar status das suas propostas enviadas ──────────────────
    let hasRetorno    = false;
    let jaEscolheu    = false;
    let minhasPropostas = [];
    if (souOLutador) {
      try {
        // Buscar propostas do lutador nesta sala filtradas pelo combate atual
        const queryParams = [roomId, userId];
        const combateFilter = combatId
          ? `AND (a.id_combate = $3 OR a.id_combate IS NULL)`
          : ``;
        if (combatId) queryParams.push(combatId);
        const r = await pool.query(
          `SELECT a.id, a.id_destinatario, a.id_proponente, a.tipo_proposta, a.fluxo, a.status, a.escolhido,
                  ud.username AS nome_destinatario,
                  up.username AS nome_proponente
           FROM mtkin.ajuda_combate a
           LEFT JOIN mtkin.users ud ON ud.id = a.id_destinatario
           LEFT JOIN mtkin.users up ON up.id = a.id_proponente
           WHERE a.id_sala = $1
             AND (a.id_proponente = $2 OR (a.id_destinatario = $2 AND a.fluxo = 'aberto'))
             AND a.status != 'cancelado'
             ${combateFilter}
           ORDER BY a.created_at ASC`,
          queryParams
        );
        minhasPropostas = r.rows;
        // hasRetorno = true quando:
        // - fluxo direto: pelo menos 1 proposta saiu do status 'pendente'
        // - fluxo aberto: qualquer proposta existe (outro jogador já escolheu condições)
        hasRetorno = r.rows.some(p =>
          (p.fluxo === 'aberto' && parseInt(p.id_proponente) !== parseInt(userId)) ||
          (p.fluxo !== 'aberto' && p.status !== 'pendente')
        );
        jaEscolheu = r.rows.some(p => p.escolhido);
        if (hasRetorno && !jaEscolheu) {
          combateLog('STATUS', req.user, `📋 Retorno de ajuda disponível`,
            { propostas: r.rows.map(x => `${x.nome_destinatario}:${x.status}`) });
        }
      } catch(e) { console.error('[status/minhasPropostas]', e.message); }
    }

    // ── NÃO-LUTADOR: verificar proposta direta pendente e se já respondeu ──────
    let jaRespondeu = false;
    let propostaDiretaPendente = null;
    let euSouEscolhido = false;
    if (!souOLutador) {
      // euSouEscolhido: o lutador me escolheu como helper
      try {
        const esc = await pool.query(
          `SELECT id FROM mtkin.ajuda_combate
           WHERE id_sala=$1 AND id_destinatario=$2 AND escolhido=TRUE LIMIT 1`,
          [roomId, userId]
        );
        euSouEscolhido = esc.rows.length > 0;
      } catch(e) { console.error('[status/euSouEscolhido]', e.message); }
      // jaRespondeu: verificar se já enviou alguma proposta nesta sala
      if (combatId) {
        try {
          const check = await pool.query(
            `SELECT 1 FROM mtkin.ajuda_combate
             WHERE id_sala=$1 AND id_proponente=$2
               AND (id_combate IS NOT DISTINCT FROM $3 OR id_combate IS NULL) LIMIT 1`,
            [roomId, userId, combatId]
          );
          jaRespondeu = check.rows.length > 0;
        } catch(_) {}
      }
      // propostaDiretaPendente: não depende de combatId, só id_sala + id_destinatario
      try {
        const pdp = await pool.query(
          `SELECT a.id, a.id_proponente, a.tipo_proposta, a.fluxo, a.status,
                  u.username AS nome_proponente
           FROM mtkin.ajuda_combate a
           JOIN mtkin.users u ON u.id = a.id_proponente
           WHERE a.id_sala = $1
             AND a.id_destinatario = $2
             AND a.status IN ('pendente','contra_proposta')
             AND a.fluxo = 'direto'
           ORDER BY a.created_at DESC LIMIT 1`,
          [roomId, userId]
        );
        if (pdp.rows.length > 0) propostaDiretaPendente = pdp.rows[0];
      } catch(e) { console.error('[status/pdp]', e.message); }
    }

    // Modo aberto: informar não-lutadores que o lutador quer que eles escolham condições
    let modoAberto = false;
    let lutadorNome = null;
    if (!souOLutador && combateAtivo) {
      const modoInfo = ajudaModoAbertoByRoomId.get(roomId);
      if (modoInfo?.modoAberto) {
        modoAberto = true;
        try {
          const luNome = await pool.query('SELECT username FROM mtkin.users WHERE id = $1', [lutadorId]);
          lutadorNome = luNome.rows[0]?.username || null;
        } catch(_) {}
      }
    }

    res.json({
      combateAtivo,
      souOLutador,
      lutadorId,
      hasRetorno,
      jaEscolheu,
      minhasPropostas,
      jaRespondeu,
      euSouEscolhido,
      propostaDiretaPendente,
      modoAberto,
      lutadorNome
    });
  } catch (error) {
    console.error('[ajuda/status]', error.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/combate/ajuda/modo-aberto — lutador ativa/desativa modo "receber ofertas"
app.post('/api/combate/ajuda/modo-aberto', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { ativo } = req.body;
    const roomId = await getRoomIdFromUser(userId);
    if (!roomId) return res.status(404).json({ error: 'Sala não encontrada' });

    // Verificar combate ativo
    const combat = combateParticipacaoByRoomId.get(roomId);
    const combatId = combat?.combatId || null;

    let modo = ajudaModoAbertoByRoomId.get(roomId);
    if (!modo) {
      modo = { combatId, lutadorId: userId, modoAberto: false, bloqueados: new Set() };
      ajudaModoAbertoByRoomId.set(roomId, modo);
    }
    modo.modoAberto = ativo !== false;
    modo.lutadorId  = userId;
    modo.combatId   = combatId;

    res.json({ success: true, modoAberto: modo.modoAberto });
  } catch (error) {
    console.error('[ajuda/modo-aberto]', error.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/combate/ajuda/proposta — envia uma proposta (fluxo direto ou aberto)
app.post('/api/combate/ajuda/proposta', authenticateToken, async (req, res) => {
  try {
    await ensureAjudaTable();
    const userId = req.user.id;
    const { tipo_proposta, fluxo, id_destinatario } = req.body;
    const roomId = await getRoomIdFromUser(userId);
    if (!roomId) return res.status(404).json({ error: 'Sala não encontrada' });

    const combat = combateParticipacaoByRoomId.get(roomId);
    const modo0 = ajudaModoAbertoByRoomId.get(roomId);
    // Se o servidor reiniciou, combatId pode estar ausente da memória — buscar no banco
    let combatId = combat?.combatId || modo0?.combatId || null;
    if (!combatId) {
      try {
        const dbC = await pool.query(
          `SELECT id_combate FROM mtkin.combate_participacao WHERE id_sala=$1 ORDER BY updated_at DESC LIMIT 1`,
          [roomId]
        );
        if (dbC.rows.length > 0) combatId = dbC.rows[0].id_combate;
      } catch(e) { console.error('[proposta/dbC]', e.message); }
    }
    const lutadorId  = fluxo === 'aberto'
      ? (modo0?.lutadorId || combat?.fightingPlayerId || userId)
      : userId; // fluxo direto: proponente é o lutador

    // No fluxo aberto, destinatário é o lutador
    const destinatario = fluxo === 'aberto'
      ? (modo0?.lutadorId || lutadorId)
      : parseInt(id_destinatario);

    if (!tipo_proposta) return res.status(400).json({ error: 'tipo_proposta obrigatório' });
    if (fluxo !== 'aberto' && !destinatario) return res.status(400).json({ error: 'id_destinatario obrigatório no fluxo direto' });

    // Verificar se destinatário está bloqueado (modo aberto)
    if (fluxo === 'aberto') {
      const modo = ajudaModoAbertoByRoomId.get(roomId);
      if (modo?.bloqueados?.has(userId)) {
        return res.status(403).json({ error: 'Você foi bloqueado de fazer propostas neste combate' });
      }
    }

    // Cancelar qualquer proposta pendente anterior entre estes dois jogadores neste combate
    await pool.query(
      `UPDATE mtkin.ajuda_combate
       SET status = 'cancelado', updated_at = NOW()
       WHERE id_sala = $1
         AND id_proponente = $2
         AND id_destinatario = $3
         AND status IN ('pendente','contra_proposta')`,
      [roomId, userId, destinatario]
    ).catch(() => {});

    const r = await pool.query(
      `INSERT INTO mtkin.ajuda_combate
         (id_sala, id_combate, id_lutador, id_proponente, id_destinatario, tipo_proposta, fluxo, simulado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [roomId, combatId, lutadorId, userId, destinatario, tipo_proposta, fluxo || 'direto', await getSimFlag(roomId)]
    );
    // Marcar proponente como tendo respondido (apenas não-lutadores)
    let modoAtual = ajudaModoAbertoByRoomId.get(roomId);
    if (!modoAtual) {
      // Criar entrada se não existir (ex: server restart durante combate)
      modoAtual = {
        combatId,
        lutadorId,
        naoLutadores: new Set(),
        responderam:  new Set(),
        bloqueados:   new Set()
      };
      ajudaModoAbertoByRoomId.set(roomId, modoAtual);
    }
    if (userId !== lutadorId) {
      modoAtual.responderam.add(userId);
    }
    combateLog('PROPOSTA', req.user,
      `📤 Proposta enviada → destinatário=${destinatario}`,
      { tipo: tipo_proposta, fluxo: fluxo || 'direto', id: r.rows[0].id, combatId });
    combateModoSnapshot(roomId);
    res.json({ success: true, proposta: r.rows[0] });
  } catch (error) {
    console.error('[ajuda/proposta]', error.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/combate/ajuda/responder — aceitar / recusar / contra-proposta
app.post('/api/combate/ajuda/responder', authenticateToken, async (req, res) => {
  try {
    await ensureAjudaTable();
    const userId = req.user.id;
    const { id_proposta, acao, tipo_proposta } = req.body;
    // acao: 'aceito' | 'recusado' | 'contra_proposta'
    if (!id_proposta || !acao) return res.status(400).json({ error: 'id_proposta e acao obrigatórios' });

    const r = await pool.query(`SELECT * FROM mtkin.ajuda_combate WHERE id = $1`, [id_proposta]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Proposta não encontrada' });
    const p = r.rows[0];
    if (p.id_destinatario !== userId) return res.status(403).json({ error: 'Sem permissão' });
    if (!['pendente','contra_proposta'].includes(p.status)) {
      return res.status(400).json({ error: `Proposta já está com status '${p.status}'` });
    }

    if (acao === 'aceito') {
      await pool.query(
        `UPDATE mtkin.ajuda_combate SET status='aceito', updated_at=NOW() WHERE id=$1`,
        [id_proposta]
      );
      combateLog('RESPONDER', req.user, `✅ Aceitou proposta #${id_proposta}`, { tipo: p.tipo_proposta, proponente: p.id_proponente, combatId: p.id_combate });
      // Marcar respondeu em memória
      const rm1 = await getRoomIdFromUser(userId).catch(() => null);
      if (rm1) { const m1 = ajudaModoAbertoByRoomId.get(rm1); if (m1 && userId !== m1.lutadorId) { m1.responderam.add(userId); combateModoSnapshot(rm1); } }
      return res.json({ success: true, status: 'aceito' });
    }

    if (acao === 'recusado') {
      await pool.query(
        `UPDATE mtkin.ajuda_combate SET status='recusado', updated_at=NOW() WHERE id=$1`,
        [id_proposta]
      );
      combateLog('RESPONDER', req.user, `❌ Recusou proposta #${id_proposta}`, { tipo: p.tipo_proposta, proponente: p.id_proponente, combatId: p.id_combate });
      // Marcar respondeu em memória
      const rm2 = await getRoomIdFromUser(userId).catch(() => null);
      if (rm2) { const m2 = ajudaModoAbertoByRoomId.get(rm2); if (m2 && userId !== m2.lutadorId) { m2.responderam.add(userId); combateModoSnapshot(rm2); } }
      return res.json({ success: true, status: 'recusado' });
    }

    if (acao === 'contra_proposta') {
      if (!tipo_proposta) return res.status(400).json({ error: 'tipo_proposta necessário para contra-proposta' });
      // Marcar a proposta atual como contra-respondida
      await pool.query(
        `UPDATE mtkin.ajuda_combate SET status='contra_proposta_enviada', updated_at=NOW() WHERE id=$1`,
        [id_proposta]
      );
      // Criar nova proposta de volta para o proponente original
      const nova = await pool.query(
        `INSERT INTO mtkin.ajuda_combate
           (id_sala, id_combate, id_lutador, id_proponente, id_destinatario, tipo_proposta, fluxo, proposta_pai, simulado)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [p.id_sala, p.id_combate, p.id_lutador, userId, p.id_proponente, tipo_proposta, p.fluxo, id_proposta,
         await getSimFlag(p.id_sala)]
      );
      // Marcar o remetente como tendo respondido (para todosResponderam fechar)
      const roomId2 = await getRoomIdFromUser(userId).catch(() => null);
      if (roomId2) {
        const modoResp = ajudaModoAbertoByRoomId.get(roomId2);
        if (modoResp && userId !== modoResp.lutadorId) modoResp.responderam.add(userId);
        combateLog('RESPONDER', req.user, `🔄 Contra-proposta enviada #${nova.rows[0].id} → destinatário=${p.id_proponente}`,
          { tipo: tipo_proposta, proposta_pai: id_proposta, combatId: p.id_combate });
        combateModoSnapshot(roomId2);
      }
      return res.json({ success: true, status: 'contra_proposta', proposta: nova.rows[0] });
    }

    res.status(400).json({ error: `Ação inválida: ${acao}` });
  } catch (error) {
    console.error('[ajuda/responder]', error.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/combate/ajuda/escolher — lutador confirma qual proposta aceita (marca escolhido=true)
app.post('/api/combate/ajuda/escolher', authenticateToken, async (req, res) => {
  try {
    await ensureAjudaTable();
    const userId = req.user.id;
    const { id_proposta } = req.body;
    if (!id_proposta) return res.status(400).json({ error: 'id_proposta obrigatório' });

    const roomId = await getRoomIdFromUser(userId);
    if (!roomId) return res.status(404).json({ error: 'Sala não encontrada' });

    // Verificar que a proposta pertence ao lutador desta sala (direto: proponente=userId; aberto: destinatario=userId)
    const check = await pool.query(
      `SELECT id, fluxo, id_proponente, id_destinatario FROM mtkin.ajuda_combate WHERE id=$1 AND id_sala=$2 AND (id_proponente=$3 OR id_destinatario=$3)`,
      [id_proposta, roomId, userId]
    );
    if (check.rows.length === 0) return res.status(403).json({ error: 'Sem permissão' });
    const proposta = check.rows[0];
    const isAberto = proposta.fluxo === 'aberto';

    // Desmarcar qualquer escolha anterior, marcar a nova
    if (isAberto) {
      await pool.query(
        `UPDATE mtkin.ajuda_combate SET escolhido=FALSE WHERE id_sala=$1 AND id_destinatario=$2`,
        [roomId, userId]
      );
    } else {
      await pool.query(
        `UPDATE mtkin.ajuda_combate SET escolhido=FALSE WHERE id_sala=$1 AND id_proponente=$2`,
        [roomId, userId]
      );
    }
    const updated = await pool.query(
      `UPDATE mtkin.ajuda_combate SET escolhido=TRUE, updated_at=NOW() WHERE id=$1 RETURNING id_proponente, id_destinatario`,
      [id_proposta]
    );

    // Confirmar helper no combate e resetar os demais
    if (updated.rows.length > 0) {
      // direto: helper é id_destinatario; aberto: helper é id_proponente
      const helperId = isAberto ? updated.rows[0].id_proponente : updated.rows[0].id_destinatario;

      // Helper escolhido → entra automaticamente como 'participando' (vê combatReadyBtn, sem joinCombatBtn)
      await pool.query(
        `UPDATE mtkin.combate_participacao SET status='participando', updated_at=NOW()
         WHERE id_sala=$1 AND id_jogador=$2`,
        [roomId, helperId]
      ).catch(() => {});

      // Ativar modo duo no estado_turno do lutador (comunicação via SQL para todos os pollings)
      await pool.query(
        `UPDATE mtkin.estado_turno
         SET duo_modo=TRUE, duo_helper_id=$1, duo_prontos='{}', atualizado_em=NOW()
         WHERE id_sala=$2 AND id_jogador=$3`,
        [helperId, roomId, userId]
      ).catch(e => console.error('[escolher] Erro ao ativar duo_modo:', e.message));

      // Salvar tipo_acordo no combate (vindo da proposta aceita)
      try {
        const tipoAcordoRow = await pool.query(
          `SELECT tipo_proposta FROM mtkin.ajuda_combate WHERE id = $1`, [id_proposta]
        );
        const tipoAcordo = tipoAcordoRow.rows[0]?.tipo_proposta;
        if (tipoAcordo) {
          await pool.query(
            `UPDATE mtkin.combate SET tipo_acordo = $1 WHERE id_sala = $2 AND status NOT IN ('vitoria','fuga','derrota')`,
            [tipoAcordo, roomId]
          );
        }
      } catch(e) { console.warn('[escolher] Falha ao salvar tipo_acordo:', e.message); }

      // Atualizar combate: status 'Pedido de ajuda', botões para duo, limpar interferencia
      await pool.query(
        `UPDATE mtkin.combate
         SET status='Pedido de ajuda', id_helper=$1,
             botoes_jogador='pronto (duo)', botoes_outros_jogadores='', interferencia='', duo_prontos='',
             atualizado_em=NOW()
         WHERE id_sala=$2 AND status NOT IN ('vitoria','fuga','derrota')`,
        [helperId, roomId]
      ).catch(e => console.error('[escolher] Erro ao atualizar combate:', e.message));

      // NÃO resetar outros para 'esperando' ainda — eles esperam o fim do duo
      combateLog('ESCOLHER', req.user,
        `✅ Escolheu proposta #${id_proposta} — helper=${helperId} agora 'participando'; modo duo ativado; combate → Pedido de ajuda`,
        { roomId });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('[ajuda/escolher]', error.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/combate/ajuda/bloquear — lutador bloqueia/desbloqueia um jogador de enviar propostas
app.post('/api/combate/ajuda/bloquear', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id_jogador, bloquear } = req.body;
    const roomId = await getRoomIdFromUser(userId);
    if (!roomId) return res.status(404).json({ error: 'Sala não encontrada' });

    let modo = ajudaModoAbertoByRoomId.get(roomId);
    if (!modo) {
      modo = { combatId: null, lutadorId: userId, modoAberto: false, bloqueados: new Set() };
      ajudaModoAbertoByRoomId.set(roomId, modo);
    }
    if (bloquear !== false) {
      modo.bloqueados.add(parseInt(id_jogador));
    } else {
      modo.bloqueados.delete(parseInt(id_jogador));
    }

    // Cancelar propostas pendentes deste jogador nesta sala
    await pool.query(
      `UPDATE mtkin.ajuda_combate SET status='cancelado', updated_at=NOW()
       WHERE id_sala=$1 AND id_proponente=$2 AND status IN ('pendente','contra_proposta')`,
      [roomId, id_jogador]
    ).catch(() => {});

    res.json({ success: true });
  } catch (error) {
    console.error('[ajuda/bloquear]', error.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/combate/ajuda/recusar-ajudar — jogador decide não ajudar no combate
app.post('/api/combate/ajuda/recusar-ajudar', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const roomId = await getRoomIdFromUser(userId);
    if (!roomId) return res.status(404).json({ error: 'Sala não encontrada' });

    const combat = combateParticipacaoByRoomId.get(roomId);
    const modo   = ajudaModoAbertoByRoomId.get(roomId);
    const lutadorId = modo?.lutadorId || combat?.fightingPlayerId || null;

    // Persistir recusa no banco para histórico
    if (combat?.combatId && lutadorId) {
      await pool.query(
        `INSERT INTO mtkin.ajuda_combate
           (id_sala, id_combate, id_lutador, id_proponente, id_destinatario, tipo_proposta, fluxo, status, simulado)
         VALUES ($1, $2, $3, $4, $3, 'recusa', 'aberto', 'recusado', $5)`,
        [roomId, combat.combatId, lutadorId, userId, await getSimFlag(roomId)]
      ).catch(() => {});
    }

    // Marcar este jogador como tendo respondido
    if (!modo) {
      // Criar modo se não existir (ex: server restart durante combate)
      const novoModo = {
        combatId:     combat?.combatId || null,
        lutadorId:    lutadorId,
        naoLutadores: new Set(),
        responderam:  new Set([userId]),
        bloqueados:   new Set()
      };
      ajudaModoAbertoByRoomId.set(roomId, novoModo);
    } else {
      modo.responderam.add(userId);
    }
    combateLog('RECUSAR-AJUDA', req.user, '🚫 Recusou ajudar no combate', { sala: roomId, combatId: combat?.combatId });
    combateModoSnapshot(roomId);

    res.json({ success: true });
  } catch (error) {
    console.error('[ajuda/recusar-ajudar]', error.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/combate/penalidade-monstro
// Aplica as penalidades especiais de cada Zumbi ao jogador que perdeu a fuga.
app.post('/api/combate/penalidade-monstro', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const monsterCardId = Number(req.body?.monsterCardId);
  const ZUMBI_IDS = [19, 20, 22, 24, 25, 29, 30, 32];
  if (!ZUMBI_IDS.includes(monsterCardId)) {
    return res.json({ applied: false, message: 'Nenhuma penalidade especial' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const roomResult = await client.query(
      `SELECT r.id, r.room_name, r.ordem_turno, r.turno_atual_index
       FROM mtkin.rooms r
       JOIN mtkin.room_participants rp ON rp.room_id = r.id
       WHERE rp.user_id = $1 AND r.is_active = true`,
      [userId]
    );
    if (!roomResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sala não encontrada' });
    }
    const room = roomResult.rows[0];
    const roomId = room.id;

    const playerResult = await client.query(
      `SELECT so.nivel FROM mtkin.sala_online so WHERE so.id_player = $1`,
      [userId]
    );
    let nivelAtual = Number(playerResult.rows[0]?.nivel) || 1;
    const messages = [];

    // ─── helpers ────────────────────────────────────────────────────────────
    async function perdaCartelaSlot(slotNum) {
      const r = await client.query(
        `SELECT ca.id, ca.id_carta, ca.nome_carta, c.caminho_imagem, c.tipo_carta
         FROM mtkin.cartas_ativas ca JOIN mtkin.cartas c ON c.id = ca.id_carta
         WHERE ca.id_sala = $1 AND ca.id_jogador = $2 AND ca.id_slot = $3`,
        [roomId, userId, String(slotNum)]
      );
      if (!r.rows.length) return null;
      const item = r.rows[0];
      const tipo = item.tipo_carta === 'Item' ? 'item' : 'cidade';
      await client.query('DELETE FROM mtkin.cartas_ativas WHERE id = $1', [item.id]);
      await client.query(
        `INSERT INTO mtkin.descarte (id_sala, id_carta, nome_carta, tipo_baralho, caminho_imagem, id_jogador)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [roomId, item.id_carta, item.nome_carta, tipo, item.caminho_imagem || '', userId]
      );
      await upsertDeckEstado(roomId, item.id_carta, tipo, 'descarte', null, client, false);
      return item.nome_carta;
    }

    async function perdaItemAleatorioMochila() {
      const r = await client.query(
        `SELECT m.id, m.id_carta, c.nome_carta, c.caminho_imagem, c.tipo_carta
         FROM mtkin.mochila m JOIN mtkin.cartas c ON c.id = m.id_carta
         WHERE m.id_sala = $1 AND m.id_jogador = $2 ORDER BY RANDOM() LIMIT 1`,
        [roomId, userId]
      );
      if (!r.rows.length) return null;
      const item = r.rows[0];
      const tipo = item.tipo_carta === 'Item' ? 'item' : 'cidade';
      await client.query('DELETE FROM mtkin.mochila WHERE id = $1', [item.id]);
      await client.query(
        `INSERT INTO mtkin.descarte (id_sala, id_carta, nome_carta, tipo_baralho, caminho_imagem, id_jogador)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [roomId, item.id_carta, item.nome_carta, tipo, item.caminho_imagem || '', userId]
      );
      await upsertDeckEstado(roomId, item.id_carta, tipo, 'descarte', null, client, false);
      return item.nome_carta;
    }

    async function perderNiveis(n) {
      const novo = Math.max(1, nivelAtual - n);
      const perdidos = nivelAtual - novo;
      await client.query('UPDATE mtkin.sala_online SET nivel = $1 WHERE id_player = $2', [novo, userId]);
      nivelAtual = novo;
      return perdidos;
    }

    async function perderTodasMao() {
      const r = await client.query(
        `SELECT cnj.id, cnj.id_carta, cnj.nome_carta, cnj.tipo_baralho, c.caminho_imagem
         FROM mtkin.cartas_no_jogo cnj JOIN mtkin.cartas c ON c.id = cnj.id_carta
         WHERE cnj.id_sala = $1 AND cnj.id_jogador = $2`,
        [roomId, userId]
      );
      for (const item of r.rows) {
        await client.query('DELETE FROM mtkin.cartas_no_jogo WHERE id = $1', [item.id]);
        await client.query(
          `INSERT INTO mtkin.descarte (id_sala, id_carta, nome_carta, tipo_baralho, caminho_imagem, id_jogador)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [roomId, item.id_carta, item.nome_carta, item.tipo_baralho || 'porta', item.caminho_imagem || '', userId]
        );
        await upsertDeckEstado(roomId, item.id_carta, item.tipo_baralho || 'item', 'descarte', null, client, false);
      }
      if (r.rows.length > 0) {
        await client.query('UPDATE mtkin.sala_online SET mao = 0 WHERE id_player = $1', [userId]);
      }
      return r.rows.length;
    }

    async function perderTodaMochila() {
      const r = await client.query(
        `SELECT m.id, m.id_carta, c.nome_carta, c.caminho_imagem, c.tipo_carta
         FROM mtkin.mochila m JOIN mtkin.cartas c ON c.id = m.id_carta
         WHERE m.id_sala = $1 AND m.id_jogador = $2`,
        [roomId, userId]
      );
      for (const item of r.rows) {
        const tipo = item.tipo_carta === 'Item' ? 'item' : 'cidade';
        await client.query('DELETE FROM mtkin.mochila WHERE id = $1', [item.id]);
        await client.query(
          `INSERT INTO mtkin.descarte (id_sala, id_carta, nome_carta, tipo_baralho, caminho_imagem, id_jogador)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [roomId, item.id_carta, item.nome_carta, tipo, item.caminho_imagem || '', userId]
        );
        await upsertDeckEstado(roomId, item.id_carta, tipo, 'descarte', null, client, false);
      }
      return r.rows.length;
    }

    async function perderTodasCartela(exceptSlots = []) {
      const r = await client.query(
        `SELECT ca.id, ca.id_carta, ca.nome_carta, ca.id_slot, c.caminho_imagem, c.tipo_carta
         FROM mtkin.cartas_ativas ca JOIN mtkin.cartas c ON c.id = ca.id_carta
         WHERE ca.id_sala = $1 AND ca.id_jogador = $2`,
        [roomId, userId]
      );
      const toRemove = r.rows.filter(row => !exceptSlots.includes(String(row.id_slot)));
      for (const item of toRemove) {
        const tipo = item.tipo_carta === 'Item' ? 'item' : 'cidade';
        await client.query('DELETE FROM mtkin.cartas_ativas WHERE id = $1', [item.id]);
        await client.query(
          `INSERT INTO mtkin.descarte (id_sala, id_carta, nome_carta, tipo_baralho, caminho_imagem, id_jogador)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [roomId, item.id_carta, item.nome_carta, tipo, item.caminho_imagem || '', userId]
        );
        await upsertDeckEstado(roomId, item.id_carta, tipo, 'descarte', null, client, false);
      }
      if (toRemove.length > 0) await recalcularTabuleiroJogador(userId, roomId, client);
      return toRemove.length;
    }
    // ─────────────────────────────────────────────────────────────────────────

    switch (monsterCardId) {
      case 19: {
        // Perder item do slot 81 + item aleatório da mochila; se slot 81 vazio → -1 nível
        const nome81 = await perdaCartelaSlot(81);
        if (nome81) {
          messages.push(`Perdeu '${nome81}' do slot mão dupla (81)`);
          await recalcularTabuleiroJogador(userId, roomId, client);
          const nomeMochila = await perdaItemAleatorioMochila();
          if (nomeMochila) messages.push(`Perdeu '${nomeMochila}' da mochila`);
          else messages.push('Mochila vazia — sem item extra a perder');
        } else {
          const perdidos = await perderNiveis(1);
          messages.push(`Slot 81 vazio — perdeu ${perdidos} nível`);
        }
        break;
      }
      case 20: {
        // Perder toda a mão; se vazia → -2 níveis
        const totalMao = await perderTodasMao();
        if (totalMao > 0) {
          messages.push(`Perdeu ${totalMao} carta(s) da mão`);
        } else {
          const perdidos = await perderNiveis(2);
          messages.push(`Mão vazia — perdeu ${perdidos} nível(is)`);
        }
        break;
      }
      case 22: {
        // Nível >= 5 e perdeu dados: perde toda mão e toda mochila
        const totalMao = await perderTodasMao();
        const totalMochila = await perderTodaMochila();
        messages.push(`Perdeu ${totalMao} carta(s) da mão e ${totalMochila} carta(s) da mochila`);
        break;
      }
      case 24: {
        // Perder item do slot 81 + -3 níveis
        const nome81 = await perdaCartelaSlot(81);
        if (nome81) {
          messages.push(`Perdeu '${nome81}' do slot mão dupla (81)`);
          await recalcularTabuleiroJogador(userId, roomId, client);
        } else {
          messages.push('Slot 81 vazio — sem item a perder');
        }
        const perdidos = await perderNiveis(3);
        messages.push(`Perdeu ${perdidos} nível(is)`);
        break;
      }
      case 25: {
        // Nível >= 6 e perdeu dados: perde toda mão + cartela (exceto 79 e 80) + toda mochila
        const totalMao = await perderTodasMao();
        const totalCartela = await perderTodasCartela(['79', '80']);
        const totalMochila = await perderTodaMochila();
        messages.push(`Perdeu ${totalMao} carta(s) da mão, ${totalCartela} da cartela (exceto personagem/raça) e ${totalMochila} da mochila`);
        break;
      }
      case 29: {
        // Perder item do slot 85 + -1 nível
        const nome85 = await perdaCartelaSlot(85);
        if (nome85) {
          messages.push(`Perdeu '${nome85}' do slot pés (85)`);
          await recalcularTabuleiroJogador(userId, roomId, client);
        } else {
          messages.push('Slot 85 vazio — sem item a perder');
        }
        const perdidos = await perderNiveis(1);
        messages.push(`Perdeu ${perdidos} nível`);
        break;
      }
      case 30: {
        // -2 níveis + perder tudo da mão + tudo da cartela
        const perdidos = await perderNiveis(2);
        const totalMao = await perderTodasMao();
        const totalCartela = await perderTodasCartela([]);
        messages.push(`Perdeu ${perdidos} nível(is), ${totalMao} carta(s) da mão e ${totalCartela} da cartela`);
        break;
      }
      case 32: {
        // Perder tudo da cartela + dar 1 carta aleatória (mão ou mochila) ao próximo jogador
        const totalCartela = await perderTodasCartela([]);
        messages.push(`Perdeu ${totalCartela} carta(s) da cartela`);

        // Escolher carta para dar ao próximo jogador na ordem de turno
        const ordem = room.ordem_turno || [];
        const currentIdx = room.turno_atual_index || 0;
        const nextIdx = (currentIdx + 1) % Math.max(ordem.length, 1);
        const nextPlayerId = ordem.length > 1 ? ordem[nextIdx] : null;

        if (nextPlayerId && Number(nextPlayerId) !== userId) {
          const maoCard = await client.query(
            `SELECT cnj.id, cnj.id_carta, cnj.nome_carta, cnj.tipo_baralho
             FROM mtkin.cartas_no_jogo cnj
             WHERE cnj.id_sala = $1 AND cnj.id_jogador = $2
             ORDER BY RANDOM() LIMIT 1`,
            [roomId, userId]
          );
          const mochilaCard = await client.query(
            `SELECT m.id AS mochila_id, m.id_carta, c.nome_carta, c.tipo_carta
             FROM mtkin.mochila m JOIN mtkin.cartas c ON c.id = m.id_carta
             WHERE m.id_sala = $1 AND m.id_jogador = $2
             ORDER BY RANDOM() LIMIT 1`,
            [roomId, userId]
          );
          const pool32 = [
            ...(maoCard.rows.map(r => ({ ...r, fonte: 'mao' }))),
            ...(mochilaCard.rows.map(r => ({ ...r, fonte: 'mochila' })))
          ];
          if (pool32.length > 0) {
            const chosen = pool32[Math.floor(Math.random() * pool32.length)];
            const nextInfo = await client.query(
              `SELECT username FROM mtkin.sala_online WHERE id_player = $1`, [nextPlayerId]
            );
            const nextNome = nextInfo.rows[0]?.username || 'próximo jogador';
            if (chosen.fonte === 'mao') {
              await client.query('DELETE FROM mtkin.cartas_no_jogo WHERE id = $1', [chosen.id]);
              await client.query('UPDATE mtkin.sala_online SET mao = GREATEST(0, COALESCE(mao,0) - 1) WHERE id_player = $1', [userId]);
              await client.query(
                `INSERT INTO mtkin.cartas_no_jogo (id_sala, nome_sala, id_jogador, nome_jogador, id_carta, nome_carta, tipo_baralho)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [roomId, room.room_name, nextPlayerId, nextNome, chosen.id_carta, chosen.nome_carta, chosen.tipo_baralho || 'item']
              );
              await client.query('UPDATE mtkin.sala_online SET mao = COALESCE(mao,0) + 1 WHERE id_player = $1', [nextPlayerId]);
              await upsertDeckEstado(roomId, chosen.id_carta, chosen.tipo_baralho || 'item', 'mao', nextPlayerId, client, false);
            } else {
              await client.query('DELETE FROM mtkin.mochila WHERE id = $1', [chosen.mochila_id]);
              const tipo32 = chosen.tipo_carta === 'Item' ? 'item' : 'cidade';
              await client.query(
                `INSERT INTO mtkin.mochila (id_sala, id_jogador, id_carta, origem_tabela) VALUES ($1,$2,$3,'penalidade')`,
                [roomId, nextPlayerId, chosen.id_carta]
              );
              await upsertDeckEstado(roomId, chosen.id_carta, tipo32, 'mochila', nextPlayerId, client, false);
            }
            messages.push(`Carta '${chosen.nome_carta}' transferida para ${nextNome}`);
          } else {
            messages.push('Sem cartas restantes para dar ao próximo jogador');
          }
        } else {
          messages.push('Nenhum próximo jogador disponível para receber a carta');
        }
        break;
      }
    }

    await client.query('COMMIT');
    console.log(`[PENALIDADE-MONSTRO] userId=${userId} monstroId=${monsterCardId}:`, messages);
    res.json({ applied: true, messages, nivelAtual });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[PENALIDADE-MONSTRO] Erro:', error.message);
    res.status(500).json({ error: 'Erro ao aplicar penalidade do zumbi' });
  } finally {
    client.release();
  }
});

// POST /api/combate/resultado-fuga
// Compara os dois dados (jogador vs monstro) e registra o resultado de fuga no combate.
// Regra: dado do jogador > dado do monstro → Ganhou; caso contrário → Perdeu.
// Apenas o lutador (ou helper em duo) pode chamar este endpoint.
app.post('/api/combate/resultado-fuga', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { dadoJogador, dadoMonstro } = req.body;

    if (typeof dadoJogador !== 'number' || typeof dadoMonstro !== 'number' ||
        dadoJogador < 1 || dadoJogador > 6 || dadoMonstro < 1 || dadoMonstro > 6) {
      return res.status(400).json({ error: 'Valores dos dados inválidos (esperado 1-6)' });
    }

    const roomId = await getRoomIdFromUser(userId);
    if (!roomId) return res.status(404).json({ error: 'Sala não encontrada' });

    const combateRes = await pool.query(
      `SELECT id_combate, id_jogador, id_helper, status, interferencia
       FROM mtkin.combate
       WHERE id_sala = $1 AND status NOT IN ('vitoria','fuga','derrota','Ganhou','Perdeu')
       ORDER BY criado_em DESC LIMIT 1`,
      [roomId]
    );
    if (!combateRes.rows.length) return res.status(404).json({ error: 'Combate ativo não encontrado' });

    const c = combateRes.rows[0];
    const souLutador = Number(c.id_jogador) === Number(userId);
    const souHelper  = c.id_helper && Number(c.id_helper) === Number(userId);

    if (!souLutador && !souHelper) {
      return res.status(403).json({ error: 'Apenas o lutador ou helper pode registrar resultado de fuga' });
    }

    const efeitos = parseCombatInterferencia(c.interferencia);
    const penalidadeAplicada = efeitos.retry_penalty_armed ? (Number(efeitos.retry_penalty) || 1) : 0;
    const dadoJogadorEfetivo = dadoJogador - penalidadeAplicada;

    // Regra: jogador > monstro → Ganhou; monstro >= jogador → Perdeu
    const resultado = dadoJogadorEfetivo > dadoMonstro ? 'Ganhou' : 'Perdeu';

    if (resultado === 'Ganhou' && efeitos.retry_escape && !efeitos.retry_penalty_armed) {
      efeitos.retry_penalty_armed = true;
      await pool.query(
        `UPDATE mtkin.combate
         SET interferencia = $1,
             atualizado_em = NOW()
         WHERE id_combate = $2`,
        [serializeCombatInterferencia(efeitos), c.id_combate]
      );

      console.log(`[FUGA] sala=${roomId} user=${req.user.username} dado_jog=${dadoJogador} dado_mon=${dadoMonstro} efetivo=${dadoJogadorEfetivo} → REPETE`);
      return res.json({
        resultado: 'Repetir',
        dadoJogador,
        dadoMonstro,
        dadoJogadorEfetivo,
        penalidadeAplicada,
        proximaPenalidade: Number(efeitos.retry_penalty) || 1,
        repetirCombate: true
      });
    }

    await pool.query(
      `UPDATE mtkin.combate SET botoes_jogador = $1, botoes_outros_jogadores = $1
       WHERE id_sala = $2 AND status NOT IN ('vitoria','fuga','derrota','Ganhou','Perdeu')`,
      [resultado, roomId]
    );

    console.log(`[FUGA] sala=${roomId} user=${req.user.username} dado_jog=${dadoJogador} dado_mon=${dadoMonstro} efetivo=${dadoJogadorEfetivo} → ${resultado}`);
    res.json({ resultado, dadoJogador, dadoMonstro, dadoJogadorEfetivo, penalidadeAplicada, repetirCombate: false });
  } catch (error) {
    console.error('[combate/resultado-fuga]', error.message);
    res.status(500).json({ error: 'Erro ao registrar resultado de fuga' });
  }
});

// POST /api/combate/finalizar-fuga
// Marca o combate como finalizado após o jogador clicar OK no resultado de fuga.
app.post('/api/combate/finalizar-fuga', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { resultado } = req.body; // 'fuga' ou 'derrota'

    if (!['fuga', 'derrota'].includes(resultado)) {
      return res.status(400).json({ error: 'Resultado inválido (esperado fuga ou derrota)' });
    }

    const roomId = await getRoomIdFromUser(userId);
    if (!roomId) return res.status(404).json({ error: 'Sala não encontrada' });

    // Marcar combate como finalizado
    await pool.query(
      `UPDATE mtkin.combate SET status = $1, atualizado_em = NOW()
       WHERE id_sala = $2 AND status NOT IN ('vitoria','fuga','derrota')`,
      [resultado, roomId]
    );

    // Devolver cartas do combate para a mão dos jogadores (não-descartáveis)
    const combateCartas = await pool.query(
      `SELECT cc.*, c.descartar_apos_uso
       FROM mtkin.combate_cartas cc
       LEFT JOIN mtkin.cartas c ON c.id = cc.id_carta
       WHERE cc.id_sala = $1`,
      [roomId]
    );
    const fugaSimFlag = await getSimFlag(roomId);
    for (const card of combateCartas.rows) {
      if (!card.descartar_apos_uso) {
        const tipoBaralho = card.tipo_baralho || 'item';
        await pool.query(
          `INSERT INTO mtkin.cartas_no_jogo (id_sala, nome_sala, id_jogador, nome_jogador, id_carta, nome_carta, tipo_baralho, simulado)
           SELECT $1, r.room_name, $2, $3, $4, $5, $6, $7
           FROM mtkin.rooms r WHERE r.id = $1`,
          [roomId, card.id_jogador, card.nome_jogador, card.id_carta, card.nome_carta, tipoBaralho, fugaSimFlag]
        );
        await upsertDeckEstado(roomId, card.id_carta, tipoBaralho, 'mao', card.id_jogador, null, fugaSimFlag);
      }
    }

    // Limpar cartas do combate
    await pool.query('DELETE FROM mtkin.combate_cartas WHERE id_sala = $1', [roomId]);

    // Limpar participação de combate
    combateParticipacaoByRoomId.delete(roomId);
    ajudaModoAbertoByRoomId.delete(roomId);
    await pool.query('DELETE FROM mtkin.combate_participacao WHERE id_sala = $1', [roomId]).catch(() => {});

    // Limpar estado de combate na sala
    await pool.query(
      `UPDATE mtkin.estado_turno SET fase_porta = 'closed', duo_modo = FALSE, duo_helper_id = NULL, duo_prontos = '{}'
       WHERE id_sala = $1`,
      [roomId]
    );

    console.log(`[FUGA-FINALIZAR] sala=${roomId} user=${req.user.username} resultado=${resultado} cartasDevolvidas=${combateCartas.rows.filter(c => !c.descartar_apos_uso).length}`);
    res.json({ success: true });
  } catch (error) {
    console.error('[combate/finalizar-fuga]', error.message);
    res.status(500).json({ error: 'Erro ao finalizar fuga' });
  }
});

// Iniciar servidor
app.listen(PORT, async () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  // Criar tabela de participação em combate se não existir
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mtkin.combate_participacao (
        id_sala         INTEGER      NOT NULL,
        id_combate      UUID,
        id_jogador_luta INTEGER      NOT NULL,
        id_jogador      INTEGER      NOT NULL,
        status          VARCHAR(20)  NOT NULL DEFAULT 'esperando',
        updated_at      TIMESTAMPTZ  DEFAULT NOW(),
        PRIMARY KEY (id_sala, id_jogador)
      )
    `);
    console.log('✅ Tabela combate_participacao pronta');
  } catch(e) {
    console.warn('⚠️ Não foi possível criar tabela combate_participacao:', e.message);
  }
  try {
    await ensureAjudaTable();
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ajuda_combate_sala ON mtkin.ajuda_combate(id_sala, status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ajuda_combate_dest ON mtkin.ajuda_combate(id_destinatario, status)`);
    console.log('✅ Tabela ajuda_combate pronta');
  } catch(e) {
    console.warn('⚠️ Não foi possível criar tabela ajuda_combate:', e.message);
  }
  // Adicionar colunas de modo duplo ao estado_turno (migração automática)
  try {
    await pool.query(`ALTER TABLE mtkin.estado_turno ADD COLUMN IF NOT EXISTS duo_modo BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE mtkin.estado_turno ADD COLUMN IF NOT EXISTS duo_helper_id INTEGER`);
    await pool.query(`ALTER TABLE mtkin.estado_turno ADD COLUMN IF NOT EXISTS duo_prontos INTEGER[] NOT NULL DEFAULT '{}'`);
    console.log('✅ Colunas duo_modo/duo_helper_id/duo_prontos prontas em estado_turno');
  } catch(e) {
    console.warn('⚠️ Migração duo_modo falhou:', e.message);
  }
  // Adicionar colunas de confirmação do duo em combate_participacao
  try {
    await pool.query(`ALTER TABLE mtkin.combate_participacao ADD COLUMN IF NOT EXISTS duo_pronto_lutador BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE mtkin.combate_participacao ADD COLUMN IF NOT EXISTS duo_pronto_helper  BOOLEAN NOT NULL DEFAULT FALSE`);
    console.log('✅ Colunas duo_pronto_lutador/duo_pronto_helper prontas em combate_participacao');
  } catch(e) {
    console.warn('⚠️ Migração duo_pronto falhou:', e.message);
  }
  // Adicionar coluna id_helper em mtkin.combate para rastrear o parceiro de duo
  try {
    await pool.query(`ALTER TABLE mtkin.combate ADD COLUMN IF NOT EXISTS id_helper INTEGER`);
    console.log('✅ Coluna id_helper pronta em mtkin.combate');
  } catch(e) {
    console.warn('⚠️ Migração id_helper falhou:', e.message);
  }
  // Adicionar coluna duo_prontos para rastrear os dois IDs que confirmaram pronto (duo)
  try {
    await pool.query(`ALTER TABLE mtkin.combate ADD COLUMN IF NOT EXISTS duo_prontos TEXT NOT NULL DEFAULT ''`);
    console.log('✅ Coluna duo_prontos pronta em mtkin.combate');
  } catch(e) {
    console.warn('⚠️ Migração duo_prontos falhou:', e.message);
  }
  // Distribuição de tesouros em combate duo
  try {
    await pool.query(`ALTER TABLE mtkin.combate ADD COLUMN IF NOT EXISTS tipo_acordo TEXT`);
    await pool.query(`ALTER TABLE mtkin.combate ADD COLUMN IF NOT EXISTS distribuicao_vez INTEGER`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mtkin.distribuicao_pendente (
        id             SERIAL PRIMARY KEY,
        id_sala        INTEGER NOT NULL,
        id_combate     TEXT    NOT NULL,
        id_carta       INTEGER NOT NULL,
        nome_carta     TEXT,
        caminho_imagem TEXT,
        tipo_baralho   TEXT NOT NULL DEFAULT 'item',
        criado_em      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ Colunas tipo_acordo/distribuicao_vez e tabela distribuicao_pendente prontas');
  } catch(e) {
    console.warn('⚠️ Migração distribuicao falhou:', e.message);
  }
  syncPersonagensFromDisk();
});

// Evitar que erros assíncronos não tratados derrubem o processo
process.on('uncaughtException', (err) => {
  console.error('❌ [uncaughtException] Erro não tratado — servidor continua:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ [unhandledRejection] Promise rejeitada não tratada — servidor continua:', reason);
});
