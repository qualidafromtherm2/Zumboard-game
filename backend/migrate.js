const { Client } = require('pg');

async function migrate() {
  const client = new Client({
    host: 'dpg-d2d4b0a4d50c7385vm50-a.oregon-postgres.render.com',
    port: 5432,
    database: 'intranet_db_yd0w',
    user: 'intranet_db_yd0w_user',
    password: 'amLpOKjWzzDRhwcR1NF0eolJzzfCY0ho',
    ssl: {
      rejectUnauthorized: false
    }
  });

  try {
    console.log('🔌 Conectando ao banco de dados...');
    await client.connect();
    console.log('✓ Conectado com sucesso!\n');

    console.log('📝 Adicionando coluna is_active...');
    await client.query(`
      ALTER TABLE mtkin.rooms 
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE
    `);
    console.log('✓ Coluna is_active adicionada!\n');

    console.log('📝 Criando índice...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rooms_active ON mtkin.rooms(is_active)
    `);
    console.log('✓ Índice criado!\n');

    console.log('📝 Criando tabela room_participants...');
    await client.query(`
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
      )
    `);
    console.log('✓ Tabela room_participants criada!\n');

    console.log('📝 Criando índices para room_participants...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_room_participants_room ON mtkin.room_participants(room_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_room_participants_user ON mtkin.room_participants(user_id)
    `);
    console.log('✓ Índices criados!\n');

    console.log('📝 Criando tabela mochila...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS mtkin.mochila (
        id SERIAL PRIMARY KEY,
        id_sala INTEGER REFERENCES mtkin.rooms(id) ON DELETE CASCADE,
        id_jogador INTEGER REFERENCES mtkin.users(id) ON DELETE CASCADE,
        id_carta INTEGER NOT NULL
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_mochila_sala ON mtkin.mochila(id_sala)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_mochila_jogador ON mtkin.mochila(id_jogador)
    `);
    console.log('✓ Tabela mochila criada!\n');

    // Verificar tabelas
    const result = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'mtkin'
    `);

    console.log('📋 Tabelas no schema mtkin:');
    result.rows.forEach(row => {
      console.log('  - ' + row.table_name);
    });

  } catch (error) {
    console.error('❌ Erro na migração:', error.message);
    process.exit(1);
  } finally {
    await client.end();
    console.log('\n✓ Conexão fechada.');
  }
}

migrate();
