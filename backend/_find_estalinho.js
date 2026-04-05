const { Pool } = require('pg');
const p = new Pool({ host: 'localhost', port: 5432, database: 'munchkin', user: 'postgres', password: '' });
p.query('SELECT id, nome_carta, tipo_carta, categoria FROM mtkin.cartas WHERE nome_carta ILIKE $1 OR categoria ILIKE $2', ['%estalinho%', '%isca%'])
  .then(r => { console.log(JSON.stringify(r.rows, null, 2)); p.end(); })
  .catch(e => { console.error(e.message); p.end(); });
