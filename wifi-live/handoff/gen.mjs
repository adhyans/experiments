// Generates the wifi-live handoff artifact. Reads the real source files and
// HTML-escapes them into the template, so the embedded code can never drift
// from what is actually on disk and no hand-escaping bug slips through.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TPL  = path.join(HERE, 'handoff.tpl.html');
const OUT  = path.join(HERE, 'wifi-live-handoff.html');

const esc = (s) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

let html = fs.readFileSync(TPL, 'utf8');

const files = html.match(/\{\{FILE:[^}]+\}\}/g) ?? [];
for (const token of files) {
  const rel = token.slice(7, -2);
  const abs = path.join(ROOT, rel);
  const body = fs.readFileSync(abs, 'utf8').replace(/\n+$/, '');
  html = html.replace(token, esc(body));
  console.log(`inlined ${rel}  ${body.split('\n').length} lines`);
}

const leftover = html.match(/\{\{[^}]+\}\}/g);
if (leftover) {
  console.error('UNRESOLVED TOKENS:', leftover);
  process.exit(1);
}

fs.writeFileSync(OUT, html);
console.log(`\nwrote ${OUT}  ${(html.length / 1024).toFixed(1)}KB`);
