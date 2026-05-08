// Copies web assets from project root into www/ for Capacitor sync.
// Run via: npm run build
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'www');

// Files/dirs to copy from root into www/
const ASSETS = [
  'index.html',
  'style.css',
  'app.js',
  'sw.js',
  'manifest.json',
  'icons',
];

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  const stat = fs.statSync(p);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(p)) rmrf(path.join(p, entry));
    fs.rmdirSync(p);
  } else {
    fs.unlinkSync(p);
  }
}

function copyRecursive(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
  } else {
    fs.copyFileSync(src, dst);
  }
}

console.log('[build-www] Cleaning www/');
rmrf(WWW);
fs.mkdirSync(WWW, { recursive: true });

for (const asset of ASSETS) {
  const src = path.join(ROOT, asset);
  const dst = path.join(WWW, asset);
  if (!fs.existsSync(src)) {
    console.warn('[build-www] Skipping missing: ' + asset);
    continue;
  }
  copyRecursive(src, dst);
  console.log('[build-www] Copied ' + asset);
}

console.log('[build-www] Done.');
