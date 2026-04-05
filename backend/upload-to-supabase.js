/**
 * Upload de assets estáticos para Supabase Storage
 * Uso: node upload-to-supabase.js
 *
 * Variáveis de ambiente necessárias:
 *   SUPABASE_URL          – URL do projeto (ex: https://xxx.supabase.co)
 *   SUPABASE_SERVICE_KEY  – service_role key (JWT)
 */

const { createClient } = require('@supabase/supabase-js');
const fs   = require('fs');
const path = require('path');

// ── Configuração ──────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://lrprmgvyggklrmrwhiai.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const BUCKET       = 'munchkin-assets';
const ROOT         = path.resolve(__dirname, '..');

// ── Mapeamento MIME simples ───────────────────────────────────────────────
const MIME_MAP = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png',  '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
};

function getMime(filePath) {
  return MIME_MAP[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// ── Arquivos NÃO utilizados (excluir do upload) ──────────────────────────
const EXCLUDE_PATTERNS = [
  /7d09d65c-.*\.jpg$/i,                  // UUID solto em Fundo da pagina
  /bd5722fe-.*\.png$/i,                  // UUID solto em Icones das cartas
  /grok-image-.*\.png$/i,               // imagens geradas não usadas
  /Fundo sala de espera [235]\.mp4$/i,  // vídeos reserva não referenciados
];

function isExcluded(relativePath) {
  return EXCLUDE_PATTERNS.some(rx => rx.test(relativePath));
}

// ── Diretórios e arquivos a enviar ───────────────────────────────────────
const UPLOAD_DIRS = [
  'Cartas/Cidade',
  'Cartas/Cidade/Icones das cartas',
  'Cartas/Cidade/Videos',
  'Cartas/Cidade/Foto fundo personagem',
  'Cartas/Cidade/Mochila',
  'Cartas/Itens',
  'Cartas/Itens/Icones das cartas',
  'Fundo da pagina',
  'Mini_card',
  'Personagens/Feminino',
  'Personagens/Masculino',
];

const UPLOAD_FILES = [
  'Mapa normal.png',
];

// ── Coletar arquivos ─────────────────────────────────────────────────────
function collectFiles() {
  const files = [];

  for (const dir of UPLOAD_DIRS) {
    const absDir = path.join(ROOT, dir);
    if (!fs.existsSync(absDir)) { console.warn(`SKIP dir ${dir} (não existe)`); continue; }
    for (const entry of fs.readdirSync(absDir)) {
      const absPath = path.join(absDir, entry);
      if (!fs.statSync(absPath).isFile()) continue;
      const relativePath = `${dir}/${entry}`;
      if (isExcluded(relativePath)) { console.log(`  EXCLUÍDO: ${relativePath}`); continue; }
      files.push({ absPath, storagePath: relativePath });
    }
  }

  for (const file of UPLOAD_FILES) {
    const absPath = path.join(ROOT, file);
    if (!fs.existsSync(absPath)) { console.warn(`SKIP file ${file} (não existe)`); continue; }
    files.push({ absPath, storagePath: file });
  }

  return files;
}

// ── Upload ───────────────────────────────────────────────────────────────
async function main() {
  if (!SUPABASE_KEY) {
    console.error('Defina SUPABASE_SERVICE_KEY no ambiente.');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // 1. Criar bucket (ignora se já existir)
  console.log(`\n📦 Criando bucket "${BUCKET}" (public)…`);
  const { error: bucketErr } = await supabase.storage.createBucket(BUCKET, {
    public: true,
  });
  if (bucketErr && !bucketErr.message.includes('already exists')) {
    console.error('Erro criando bucket:', bucketErr.message);
    process.exit(1);
  }
  console.log('  ✅ Bucket OK');

  // 2. Coletar arquivos
  const files = collectFiles();
  console.log(`\n📂 ${files.length} arquivos para upload\n`);

  let ok = 0, fail = 0;

  for (let i = 0; i < files.length; i++) {
    const { absPath, storagePath } = files[i];
    const contentType = getMime(absPath);
    const fileBuffer = fs.readFileSync(absPath);
    const sizeMB = (fileBuffer.length / 1048576).toFixed(2);

    process.stdout.write(`[${i + 1}/${files.length}] ${storagePath} (${sizeMB} MB) … `);

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, fileBuffer, {
        contentType,
        upsert: true,
      });

    if (error) {
      console.log(`❌ ${error.message}`);
      fail++;
    } else {
      console.log('✅');
      ok++;
    }
  }

  console.log(`\n─── Resultado ───`);
  console.log(`  ✅ Sucesso: ${ok}`);
  console.log(`  ❌ Falhas:  ${fail}`);
  console.log(`  📁 Total:   ${files.length}`);

  const publicBase = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}`;
  console.log(`\n🔗 URL base pública:\n   ${publicBase}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
