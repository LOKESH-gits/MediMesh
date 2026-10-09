#!/usr/bin/env node
/* Concatenates src/*.js (in order) into js/app.js. Run: npm run build */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const order = ['js1_core.js', 'js2_engine.js', 'js3_ui.js', 'js4_public.js', 'js5_pages_a.js', 'js6_pages_b.js'];
const out = order.map((f) => fs.readFileSync(path.join(root, 'src', f), 'utf8')).join('\n');
fs.writeFileSync(path.join(root, 'js', 'app.js'), out);
console.log('Built js/app.js (' + (out.length / 1024).toFixed(0) + ' KB) from ' + order.length + ' source files.');
console.log('Tip: bump VERSION in sw.js so installed copies refresh.');
