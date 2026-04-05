/**
 * Migração: Converter coluna 'forca' para coluna computada
 * 
 * Esta migração converte a coluna 'forca' da tabela mtkin.sala_online
 * para uma coluna computada (GENERATED ALWAYS AS).
 * 
 * Após esta migração:
 * - forca = tabuleiro + nivel (calculado automaticamente)
 * - Não é possível fazer UPDATE ou INSERT direto em 'forca'
 * - Sempre que tabuleiro ou nivel mudar, forca é recalculado
 * 
 * Como executar:
 * node backend/migrate-forca-computed.js
 * 
 * O script usa as credenciais do arquivo .env na raiz do projeto.
 */

const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

async function migrateForcaToComputed() {
  const client = await pool.connect();
  
  try {
    console.log('📊 Conectando ao banco de dados...');
    
    await client.query('BEGIN');
    
    // Verificar se a coluna já é computada
    const checkResult = await client.query(`
      SELECT is_generated
      FROM information_schema.columns
      WHERE table_schema = 'mtkin' 
      AND table_name = 'sala_online'
      AND column_name = 'forca';
    `);
    
    if (checkResult.rows.length > 0 && checkResult.rows[0].is_generated === 'ALWAYS') {
      console.log('ℹ️  Coluna forca já é computada. Nenhuma alteração necessária.');
      await client.query('ROLLBACK');
      return;
    }
    
    console.log('🔄 Convertendo coluna forca para coluna computada...');
    
    // Garantir que tabuleiro tenha valor padrão
    await client.query(`
      ALTER TABLE mtkin.sala_online 
      ALTER COLUMN tabuleiro SET DEFAULT 0;
    `);
    console.log('✅ Coluna tabuleiro com DEFAULT 0');
    
    // Atualizar valores NULL em tabuleiro para 0
    await client.query(`
      UPDATE mtkin.sala_online 
      SET tabuleiro = 0 
      WHERE tabuleiro IS NULL;
    `);
    console.log('✅ Valores NULL em tabuleiro convertidos para 0');
    
    // Remover a coluna forca atual
    await client.query(`
      ALTER TABLE mtkin.sala_online 
      DROP COLUMN IF EXISTS forca;
    `);
    console.log('✅ Coluna forca removida');
    
    // Adicionar coluna forca como computada
    await client.query(`
      ALTER TABLE mtkin.sala_online 
      ADD COLUMN forca INTEGER GENERATED ALWAYS AS (COALESCE(tabuleiro, 0) + nivel) STORED;
    `);
    console.log('✅ Coluna forca recriada como computada (tabuleiro + nivel)');
    
    // Atualizar comentário
    await client.query(`
      COMMENT ON COLUMN mtkin.sala_online.forca IS 'Força total do jogador (calculada: tabuleiro + nivel)';
    `);
    console.log('✅ Comentário atualizado');
    
    await client.query('COMMIT');
    
    // Mostrar estrutura atualizada
    const result = await client.query(`
      SELECT column_name, data_type, column_default, is_generated, generation_expression
      FROM information_schema.columns
      WHERE table_schema = 'mtkin' 
      AND table_name = 'sala_online'
      AND column_name IN ('nivel', 'tabuleiro', 'forca')
      ORDER BY ordinal_position;
    `);
    
    console.log('\n📋 Colunas relacionadas à força em mtkin.sala_online:');
    result.rows.forEach(row => {
      const generated = row.is_generated === 'ALWAYS' ? ' [COMPUTADA]' : '';
      const expression = row.generation_expression ? ` = ${row.generation_expression}` : '';
      console.log(`   ${row.column_name} (${row.data_type})${generated}${expression}`);
    });
    
    // Testar com dados de exemplo
    const testResult = await client.query(`
      SELECT nome_jogador, nivel, tabuleiro, forca
      FROM mtkin.sala_online
      LIMIT 5;
    `);
    
    if (testResult.rows.length > 0) {
      console.log('\n🧪 Teste com dados existentes:');
      testResult.rows.forEach(row => {
        console.log(`   ${row.nome_jogador}: nivel=${row.nivel}, tabuleiro=${row.tabuleiro}, forca=${row.forca}`);
      });
    } else {
      console.log('\nℹ️  Nenhum dado encontrado na tabela para teste.');
    }
    
    console.log('\n✅ Migração concluída com sucesso!');
    console.log('📝 A coluna forca agora é calculada automaticamente como: tabuleiro + nivel');
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Erro durante a migração:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrateForcaToComputed().catch(err => {
  console.error('❌ Falha na migração:', err);
  process.exit(1);
});
