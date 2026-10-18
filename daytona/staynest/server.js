const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

function createDemoServer() {
  const files = new Map([
    ['/', ['legitimate.html', 'text/html; charset=utf-8']],
    ...['legitimate', 'malicious'].map((name) => [`/${name}.html`, [`${name}.html`, 'text/html; charset=utf-8']]),
    ...['legitimate', 'malicious'].map((name) => [`/${name}`, [`${name}.html`, 'text/html; charset=utf-8']]),
    ...['living', 'kitchen', 'bedroom', 'kitchen-front', 'kitchen-side'].map((name) => [`/assets/${name}.png`, [`assets/${name}.png`, 'image/png']]),
  ]);
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    const file = files.get(req.url);
    if (!file) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': file[1], 'x-content-type-options': 'nosniff', 'cache-control': 'no-store, no-transform' });
    res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(path.join(__dirname, 'public', file[0])));
  });
}
if (require.main === module) {
  createDemoServer().listen(3787, '127.0.0.1', () => {
    console.log('Local preview only (not reachable from Daytona):');
    console.log('http://127.0.0.1:3787/legitimate.html');
    console.log('http://127.0.0.1:3787/malicious.html');
  });
}
module.exports = { createDemoServer };
