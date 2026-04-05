const fs = require('fs');
const html = fs.readFileSync('../index.html', 'utf8');
const scriptRegex = /<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi;
let match;
let i = 0;
while ((match = scriptRegex.exec(html)) !== null) {
  i++;
  if (i !== 1) continue;
  const code = match[1];
  const linesBefore = html.substring(0, match.index).split('\n').length;
  const lines = code.split('\n');

  // Varredura linear: primeira linha que ao ser incluída causa erro novo
  let lastOk = 0;
  for (let L = 100; L <= lines.length; L += 100) {
    try {
      new Function(lines.slice(0, L).join('\n'));
      lastOk = L;
    } catch(e) {
      // Encontrou a janela de erro: refinar
      for (let k = lastOk + 1; k <= L; k++) {
        try {
          new Function(lines.slice(0, k).join('\n'));
        } catch(e2) {
          if (!e2.message.includes('Unexpected end of input')) {
            console.log('ERRO na linha JS', k, '= HTML linha ~', linesBefore + k);
            for (let j = Math.max(0, k-5); j <= Math.min(lines.length-1, k+2); j++) {
              console.log('  ' + (linesBefore + j) + ': ' + lines[j]);
            }
            process.exit(0);
          }
        }
      }
      lastOk = L;
    }
  }
  console.log('Nenhum erro de sintaxe encontrado na varredura linear.');
}
