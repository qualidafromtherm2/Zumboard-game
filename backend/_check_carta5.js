const { Pool } = require('pg');
const pool = new Pool({ host: process.env.DB_HOST||'localhost', port: process.env.DB_PORT||5432, database: process.env.DB_NAME||'munchkin', user: process.env.DB_USER||'postgres', password: process.env.DB_PASSWORD||'', ssl: process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false });
pool.query('SELECT id,nome_carta,tipo_carta,categoria,equipar_onde,forca,valor,uso_em_combate,permite_mochila FROM mtkin.cartas WHERE id=5').then(r=>{console.log(JSON.stringify(r.rows,null,2));pool.end();}).catch(e=>{console.error(e.message);pool.end();});
