const fs = require('fs');
const html = fs.readFileSync('../index.html', 'utf8');
const scriptRegex = /<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi;
let match;
let i = 0;
while ((match = scriptRegex.exec(html)) !== null) {
  i++;
  const code = match[1];
  const linesBefore = html.substring(0, match.index).split('\n').length;
  try {
    new Function(code);
  } catch (e) {
    console.log(`SCRIPT ${i} (começa na linha ~${linesBefore}): ${e.message}`);
  }
}
console.log(`Verificados ${i} scripts.`);
