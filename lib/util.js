import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, 'data');
/**
 * Optional local config (not committed): sakura.config.json next to server.js
 *   { "stData": "<SillyTavern>/data/default-user", "extraVertexKeys": [{ "file": "...json", "name": "Vertex 2" }], "novelFiles": ["...txt"] }
 */
export const CONFIG = readJSONSafe(path.join(ROOT, 'sakura.config.json'));
export const ST_USER = path.resolve(process.env.SAKURA_ST_DATA || CONFIG.stData || path.join(ROOT, '..', 'SillyTavern', 'data', 'default-user'));

function readJSONSafe(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

export const dir = (...p) => path.join(DATA, ...p);

export function ensureDir(p) {
    fs.mkdirSync(p, { recursive: true });
}

export function readJSON(p, def = null) {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return def;
    }
}

export async function writeFileAtomic(p, data) {
    ensureDir(path.dirname(p));
    const tmp = p + '.tmp-' + process.pid + '-' + Date.now();
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, p);
}

export function writeJSONSync(p, obj) {
    ensureDir(path.dirname(p));
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, p);
}

export function writeJSON(p, obj, pretty = true) {
    return writeFileAtomic(p, JSON.stringify(obj, null, pretty ? 2 : 0));
}

/** File-name safe string (Windows). */
export function safeName(s) {
    return String(s ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 120) || 'unnamed';
}

/** Ensure the resolved path stays inside base. */
export function inside(base, ...parts) {
    const p = path.resolve(base, ...parts);
    const b = path.resolve(base);
    if (p !== b && !p.startsWith(b + path.sep)) throw new Error('bad path');
    return p;
}

export function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function humanDate(d = new Date()) {
    const z = (n, l = 2) => String(n).padStart(l, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}@${z(d.getHours())}h${z(d.getMinutes())}m${z(d.getSeconds())}s${z(d.getMilliseconds(), 3)}ms`;
}

export function sendDate(d = new Date()) {
    return d.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}
