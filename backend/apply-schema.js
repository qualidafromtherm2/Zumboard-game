const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const schemaPath = path.resolve(__dirname, '..', 'database', 'schema.sql');
const rawSchema = fs.readFileSync(schemaPath, 'utf8');

const withoutComments = rawSchema
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

// Dividir statements considerando dollar-quoted strings ($$)
function splitSQLStatements(sql) {
  const statements = [];
  let current = '';
  let inDollarQuote = false;
  let dollarTag = '';
  
  const lines = sql.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Detectar início/fim de dollar-quoted string
    const dollarMatches = trimmed.match(/\$\$|\$[a-zA-Z_][a-zA-Z0-9_]*\$/g);
    
    if (dollarMatches) {
      for (const match of dollarMatches) {
        if (!inDollarQuote) {
          inDollarQuote = true;
          dollarTag = match;
        } else if (match === dollarTag) {
          inDollarQuote = false;
          dollarTag = '';
        }
      }
    }
    
    current += line + '\n';
    
    // Se não está dentro de dollar-quote e encontrou ";", finalize o statement
    if (!inDollarQuote && trimmed.endsWith(';')) {
      const stmt = current.trim();
      if (stmt.length > 0) {
        statements.push(stmt);
        current = '';
      }
    }
  }
  
  // Adicionar último statement se houver
  if (current.trim().length > 0) {
    statements.push(current.trim());
  }
  
  return statements;
}

const statements = splitSQLStatements(withoutComments);

const sslEnabled = process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false };

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: sslEnabled
});

async function applySchema() {
  const client = await pool.connect();

  try {
    for (let i = 0; i < statements.length; i += 1) {
      const statement = statements[i];
      console.log(`\n--- Schema step ${i + 1}/${statements.length} ---`);
      console.log(statement.slice(0, 200).replace(/\s+/g, ' ').trim());
      await client.query(statement);
      console.log(`Schema step ${i + 1}/${statements.length} applied.`);
    }
    console.log('Schema applied successfully.');
  } catch (error) {
    console.error('Failed to apply schema:', error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

applySchema();
