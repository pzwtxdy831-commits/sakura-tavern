// Copies the publishable part of Sakura into a clean folder (no user data, keys, personal config or presets).
// Usage: node tools/stage-public.mjs <target-dir>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, '..', 'sakura-public'));

const INCLUDE = [
    'server.js', 'package.json',
    'lib', 'public',
    'android/AndroidManifest.xml', 'android/build-apk.sh', 'android/src',
    'tools/make-icons.mjs', 'tools/stage-public.mjs',
    'README.md', 'NOTICE.md', '.gitignore', 'sakura.config.example.json', 'start.bat', 'start.sh',
];
const SKIP = [/\.keystore$/i, /\.apk$/i, /sakura\.config\.json$/i, /[\\/]data[\\/]/, /node_modules/];

function copy(rel) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) return;
    const st = fs.statSync(src);
    if (st.isDirectory()) { for (const f of fs.readdirSync(src)) copy(path.join(rel, f)); return; }
    if (SKIP.some(re => re.test(src))) return;
    const dst = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
}

fs.mkdirSync(OUT, { recursive: true });
for (const r of INCLUDE) copy(r);

// public package.json: real dependencies instead of the vendored node_modules
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
delete pkg.private;
pkg.license = 'AGPL-3.0-only';
pkg.engines = { node: '>=20' };
pkg.dependencies = { lodash: '^4.17.21', yaml: '^2.8.0' };
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
console.log('staged to', OUT);
