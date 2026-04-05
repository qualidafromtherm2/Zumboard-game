/**
 * Migração: Implementar cálculo automático da coluna 'tabuleiro'
 * 
 * Esta migração cria funções e triggers para calcular automaticamente
 * o valor da coluna 'tabuleiro' em mtkin.sala_online somando os valores
 * das cartas equipadas na cartela (linhas em mtkin.cartas_ativas com slots 81 a 89).
 * 
 * Lógica:
 * - Cartas de porta: soma a coluna 'forca_ganha'
 * - Cartas de tesouro: soma a coluna 'bonus'
 * 
 * Como executar:
 * node backend/migrate-tabuleiro-auto.js
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

async function migrateTabuleiro() {
  const client = await pool.connect();
  
  try {
    console.log('📊 Conectando ao banco de dados...');
    
    await client.query('BEGIN');
    
    console.log('🔧 Criando função para calcular tabuleiro...');
    
    // Função que calcula o valor do tabuleiro baseado nas cartas equipadas
    await client.query(`
      CREATE OR REPLACE FUNCTION mtkin.calcular_tabuleiro(
        p_id_sala INTEGER,
        p_id_jogador INTEGER
      ) RETURNS INTEGER AS $$
      DECLARE
        v_total INTEGER := 0;
        v_slots TEXT[] := ARRAY['81','82','83','84','85','86','87','88','89'];
      BEGIN
        -- Somar força das cartas de porta equipadas nos slots 81 a 89
        SELECT COALESCE(SUM(COALESCE(cp.forca_ganha, 0)), 0)
        INTO v_total
        FROM mtkin.cartas_ativas ca
        JOIN mtkin.cartas_porta cp ON cp.id = ca.id_carta
        WHERE ca.id_sala = p_id_sala
          AND ca.id_jogador = p_id_jogador
          AND ca.id_slot = ANY(v_slots);

        -- Somar bônus das cartas de tesouro equipadas nos slots 81 a 89
        SELECT v_total + COALESCE(SUM(COALESCE(ct.bonus, 0)), 0)
        INTO v_total
        FROM mtkin.cartas_ativas ca
        JOIN mtkin.cartas_tesouro ct ON ct.id = ca.id_carta
        WHERE ca.id_sala = p_id_sala
          AND ca.id_jogador = p_id_jogador
          AND ca.id_slot = ANY(v_slots);
        
        RETURN v_total;
      END;
      $$ LANGUAGE plpgsql;
    `);
    
    console.log('✅ Função calcular_tabuleiro criada');
    
    console.log('🔧 Criando função trigger...');
    
    // Função trigger que atualiza o tabuleiro quando a cartela muda
    await client.query(`
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
    `);
    
    console.log('✅ Função trigger criada');
    
    console.log('🔧 Criando trigger na tabela cartas_ativas...');
    
    // Remover trigger se já existir
    await client.query(`
      DROP TRIGGER IF EXISTS trg_atualizar_tabuleiro_cartela 
      ON mtkin.cartas_ativas;
    `);
    
    // Criar trigger
    await client.query(`
      CREATE TRIGGER trg_atualizar_tabuleiro_cartela
      AFTER INSERT OR UPDATE OR DELETE ON mtkin.cartas_ativas
      FOR EACH ROW
      EXECUTE FUNCTION mtkin.trigger_atualizar_tabuleiro();
    `);
    
    console.log('✅ Trigger criado');
    
    console.log('🔄 Recalculando tabuleiro para jogadores existentes...');
    
    // Recalcular para todos os jogadores existentes
    const playersResult = await client.query(`
      SELECT DISTINCT c.id_sala, c.id_jogador
      FROM mtkin.cartas_ativas c
      INNER JOIN mtkin.sala_online s ON s.id_player = c.id_jogador
    `);
    
    for (const player of playersResult.rows) {
      const newTabuleiro = await client.query(
        'SELECT mtkin.calcular_tabuleiro($1, $2) as total',
        [player.id_sala, player.id_jogador]
      );
      
      await client.query(
        'UPDATE mtkin.sala_online SET tabuleiro = $1 WHERE id_player = $2',
        [newTabuleiro.rows[0].total, player.id_jogador]
      );
      
      console.log(`   ✅ Jogador ${player.id_jogador}: tabuleiro = ${newTabuleiro.rows[0].total}`);
    }
    
    await client.query('COMMIT');
    
    console.log('\n✅ Migração concluída com sucesso!');
    console.log('📝 A coluna tabuleiro agora é atualizada automaticamente quando a cartela muda');
    console.log('📝 A coluna forca continua sendo: tabuleiro + nivel (calculada automaticamente)');
    
    // Testar com um exemplo
    const testResult = await client.query(`
      SELECT 
        so.nome_jogador,
        so.nivel,
        so.tabuleiro,
        so.forca
      FROM mtkin.sala_online so
      WHERE so.tabuleiro > 0
      LIMIT 3;
    `);
    
    if (testResult.rows.length > 0) {
      console.log('\n🧪 Exemplos de jogadores com equipamentos:');
      testResult.rows.forEach(row => {
        console.log(`   ${row.nome_jogador}: nivel=${row.nivel}, tabuleiro=${row.tabuleiro}, forca=${row.forca} (${row.nivel}+${row.tabuleiro})`);
      });
    } else {
      console.log('\nℹ️  Nenhum jogador com equipamentos encontrado para teste.');
    }
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Erro durante a migração:', error.message);
    console.error('Stack:', error.stack);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrateTabuleiro().catch(err => {
  console.error('❌ Falha na migração:', err);
  process.exit(1);
});
