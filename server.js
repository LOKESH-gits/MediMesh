#!/usr/bin/env node
/* MediMesh — zero-dependency static server (Node 16+).  Usage: node server.js  [PORT=8080] */
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib'), os = require('os');
const ROOT = __dirname, PORT = +process.env.PORT || 8080;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const BLOCK = /^\/(node_modules|\.git|\.github|scripts|src|package(-lock)?\.json|server\.js|README\.md)(\/|$)/;
http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT) || BLOCK.test(p)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase(), type = MIME[ext] || 'application/octet-stream';
    const h = { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN', 'Cache-Control': ['.html', '.js'].includes(ext) && /sw\.js|index\.html/.test(file) ? 'no-cache' : 'public, max-age=300' };
    if (/text|json|javascript|svg|manifest/.test(type) && /gzip/.test(req.headers['accept-encoding'] || '')) { h['Content-Encoding'] = 'gzip'; res.writeHead(200, h); return res.end(zlib.gzipSync(buf)); }
    res.writeHead(200, h); res.end(buf);
  });
}).listen(PORT, () => {
  console.log('\n  MediMesh is running\n  Local:   http://localhost:' + PORT);
  Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).forEach((i) => console.log('  Network: http://' + i.address + ':' + PORT + '  (same Wi-Fi; install/offline needs https or localhost)'));
  console.log('\n  Press Ctrl+C to stop.\n');
});
