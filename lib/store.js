// Data store: settings, secrets, characters, chats, worlds, presets.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { dir, ensureDir, readJSON, writeJSON, writeJSONSync, writeFileAtomic, safeName, inside, humanDate, sendDate, uid } from './util.js';
import { readCard, writeCard } from './png.js';

for (const d of ['characters', 'thumbs', 'chats', 'worlds', 'presets', 'personas', 'fonts', 'novels', 'cache', 'backups']) ensureDir(dir(d));

// ───────────────────────── settings ─────────────────────────

export const DEFAULT_SETTINGS = {
    activePreset: '',
    activeProfile: '',
    profiles: [],
    globalWorlds: [],
    personas: {},
    personaBinding: {},
    defaultPersona: '',
    regex: [],
    globalVars: {},
    ui: { font: '', fontSize: 16, chatWidth: 880, showReasoning: true, showAvatars: false, showStats: true, fab: true },
    backup: { enabled: true, every: 3, keep: 30 },
    wand: { profiles: [], toggles: {} },
    scripts: [],
    qrSets: [],
    plugins: {
        tailNovel: { enabled: false, file: '', size: 13000 },
        summary: {
            enabled: false, url: '', model: '', secretId: '', keepRecent: 10, batch: 10, maxChars: 40000,
            resummaryThreshold: 8, summaryPrompt: '', resummaryPrompt: '', stripTags: ['options', 'snow'],
        },
        mvu: { enabled: true },
    },
    wi: { depth: 2, recursive: true, maxRecursion: 5 },
    reasoning: { autoParse: true, prefix: '<think>', suffix: '</think>' },
    qr: [],
    lastChat: {},
};

let settings = null;
export function getSettings() {
    if (!settings) {
        const s = readJSON(dir('settings.json'), {}) || {};
        settings = deepDefaults(s, DEFAULT_SETTINGS);
    }
    return settings;
}
function deepDefaults(obj, def) {
    for (const [k, v] of Object.entries(def)) {
        if (!(k in obj)) obj[k] = structuredClone(v);
        else if (v && typeof v === 'object' && !Array.isArray(v) && obj[k] && typeof obj[k] === 'object') deepDefaults(obj[k], v);
    }
    return obj;
}
let saveTimer = null;
export function saveSettings(now = false) {
    getSettings();
    if (now) { clearTimeout(saveTimer); writeJSONSync(dir('settings.json'), settings); return; }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => writeJSON(dir('settings.json'), settings), 300);
}

// ───────────────────────── secrets ─────────────────────────
// Same shape as SillyTavern secrets.json: { key: [{id, value, label, active}] }

let secrets = null;
export function getSecrets() {
    if (!secrets) secrets = readJSON(dir('secrets.json'), {});
    return secrets;
}
export function findSecret(id) {
    for (const list of Object.values(getSecrets())) {
        if (!Array.isArray(list)) continue;
        const s = list.find(x => x.id === id);
        if (s) return s.value;
    }
    return '';
}
export function listSecretLabels() {
    const out = [];
    for (const [k, list] of Object.entries(getSecrets())) {
        if (!Array.isArray(list)) continue;
        for (const s of list) out.push({ id: s.id, key: k, label: s.label, mask: maskSecret(s.value) });
    }
    return out;
}
function maskSecret(v) {
    v = String(v || '');
    if (v.trim().startsWith('{')) {
        try { const j = JSON.parse(v); return `服务账号 ${j.client_email || ''}`; } catch { return 'JSON'; }
    }
    return v.length > 8 ? v.slice(0, 3) + '…' + v.slice(-4) : '***';
}
export function addSecret(key, value, label) {
    const s = getSecrets();
    if (!Array.isArray(s[key])) s[key] = [];
    const id = crypto.randomUUID();
    s[key].push({ id, value, label: label || new Date().toLocaleString(), active: false });
    writeJSONSync(dir('secrets.json'), s);
    return id;
}

// ───────────────────────── characters ─────────────────────────

const cardCache = new Map(); // file -> {mtime, size, card}
const metaCachePath = dir('cache', 'chars.json');
let metaCache = readJSON(metaCachePath, {});
let metaDirty = false;

export function charPath(file) { return inside(dir('characters'), file); }

export function loadCard(file) {
    const p = charPath(file);
    const st = fs.statSync(p);
    const c = cardCache.get(file);
    if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.card;
    const card = readCard(fs.readFileSync(p));
    if (!card) throw new Error('no card data');
    normalizeCard(card);
    cardCache.set(file, { mtime: st.mtimeMs, size: st.size, card });
    if (cardCache.size > 6) cardCache.delete(cardCache.keys().next().value);
    return card;
}

export function normalizeCard(card) {
    if (!card.data) {
        card.data = { ...card };
        card.spec = 'chara_card_v2';
    }
    const d = card.data;
    for (const k of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions']) d[k] ??= '';
    d.alternate_greetings ??= [];
    d.tags ??= [];
    d.extensions ??= {};
    return card;
}

export function chatDirName(file) { return file.replace(/\.png$/i, ''); }

function stripHtml(s) {
    return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\{\{[^}]*\}\}/g, '').replace(/\s+/g, ' ').trim();
}

export async function listCharacters() {
    const files = (await fsp.readdir(dir('characters'))).filter(f => /\.png$/i.test(f));
    const out = [];
    for (const f of files) {
        try {
            const st = await fsp.stat(charPath(f));
            let m = metaCache[f];
            if (!m || m.mtime !== st.mtimeMs) {
                const card = loadCard(f);
                const d = card.data;
                const intro = stripHtml(d.creator_notes) || stripHtml(d.description) || stripHtml(d.first_mes) || stripHtml(d.alternate_greetings?.[0]);
                m = {
                    mtime: st.mtimeMs,
                    name: d.name || f.replace(/\.png$/i, ''),
                    intro: intro.slice(0, 160),
                    tags: (d.tags || []).slice(0, 6),
                    creator: d.creator || '',
                    version: d.character_version || '',
                    world: d.extensions?.world || '',
                    fav: !!d.extensions?.fav,
                };
                metaCache[f] = m;
                metaDirty = true;
            }
            const chats = await listChatFiles(f).catch(() => []);
            out.push({
                file: f, name: m.name, intro: m.intro, tags: m.tags, creator: m.creator, version: m.version, world: m.world, fav: m.fav,
                chats: chats.length, last: chats[0]?.mtime || st.mtimeMs,
                thumb: fs.existsSync(dir('thumbs', f)) ? `/thumbs/${encodeURIComponent(f)}?v=${Math.round(st.mtimeMs)}` : `/chars/${encodeURIComponent(f)}`,
            });
        } catch (e) {
            console.warn('[chars] skip', f, e.message);
        }
    }
    if (metaDirty) { metaDirty = false; writeJSON(metaCachePath, metaCache, false); }
    out.sort((a, b) => (b.fav - a.fav) || (b.last - a.last));
    return out;
}

export async function saveCard(file, card, pngBuf = null) {
    const p = charPath(file);
    const base = pngBuf || await fsp.readFile(p);
    await writeFileAtomic(p, writeCard(base, card));
    cardCache.delete(file);
    delete metaCache[file];
}

export function uniqueCharFile(name) {
    let base = safeName(name);
    let f = base + '.png';
    let n = 1;
    while (fs.existsSync(dir('characters', f))) f = `${base}${n++}.png`;
    return f;
}

export async function deleteCharacter(file) {
    await fsp.rm(charPath(file), { force: true });
    await fsp.rm(dir('thumbs', file), { force: true });
    cardCache.delete(file);
    delete metaCache[file];
}

// ───────────────────────── chats ─────────────────────────

export function chatDir(charFile) { return inside(dir('chats'), chatDirName(charFile)); }

export async function listChatFiles(charFile) {
    const d = chatDir(charFile);
    let files = [];
    try { files = (await fsp.readdir(d)).filter(f => f.endsWith('.jsonl')); } catch { return []; }
    const out = [];
    for (const f of files) {
        const st = await fsp.stat(path.join(d, f));
        out.push({ file: f, size: st.size, mtime: st.mtimeMs });
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
}

/** Read the tail of a jsonl to get a preview without parsing the whole thing. */
export async function chatPreview(charFile, file) {
    const p = inside(chatDir(charFile), file);
    const fh = await fsp.open(p, 'r');
    try {
        const st = await fh.stat();
        const len = Math.min(st.size, 256 * 1024);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, st.size - len);
        const lines = buf.toString('utf8').split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const m = JSON.parse(lines[i]);
                if (m.mes !== undefined) return stripHtml(String(m.mes).replace(/<(think|thinking|sakura_planning~|planning|UpdateVariable)[\s\S]*?<\/\1>/gi, '')).slice(-120);
            } catch { /* partial line */ }
        }
    } finally { await fh.close(); }
    return '';
}

const chatCache = new Map(); // key -> chat
const CHAT_CACHE_MAX = 4;

function chatKey(charFile, file) { return charFile + '/' + file; }

export async function loadChat(charFile, file) {
    const key = chatKey(charFile, file);
    if (chatCache.has(key)) {
        const c = chatCache.get(key);
        chatCache.delete(key); chatCache.set(key, c);
        return c;
    }
    const p = inside(chatDir(charFile), file);
    const text = await fsp.readFile(p, 'utf8');
    const lines = text.split('\n');
    let header = null;
    const messages = [];
    for (const line of lines) {
        if (!line.trim()) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (!header && o.chat_metadata !== undefined && o.mes === undefined) { header = o; continue; }
        messages.push(o);
    }
    if (!header) header = { user_name: 'User', character_name: '', chat_metadata: {} };
    header.chat_metadata ??= {};
    const chat = { key, charFile, file, header, messages, timer: null };
    chatCache.set(key, chat);
    while (chatCache.size > CHAT_CACHE_MAX) {
        const [k, c] = chatCache.entries().next().value;
        if (c.timer) await flushChat(c);
        chatCache.delete(k);
    }
    return chat;
}

export function markDirty(chat, delay = 600) {
    clearTimeout(chat.timer);
    chat.timer = setTimeout(() => flushChat(chat), delay);
}

export async function flushChat(chat) {
    clearTimeout(chat.timer);
    chat.timer = null;
    const p = inside(chatDir(chat.charFile), chat.file);
    const parts = [JSON.stringify(chat.header)];
    for (const m of chat.messages) parts.push(JSON.stringify(m));
    await writeFileAtomic(p, parts.join('\n'));
}

export async function flushAll() {
    for (const c of chatCache.values()) if (c.timer) await flushChat(c);
}

export async function createChat(charFile, { userName, charName, greeting, metadata = {} }) {
    ensureDir(chatDir(charFile));
    const file = `${charName} - ${humanDate()}.jsonl`;
    const header = { user_name: userName, character_name: charName, create_date: humanDate(), chat_metadata: { ...metadata } };
    const messages = [];
    if (greeting !== null && greeting !== undefined) {
        const g = Array.isArray(greeting) ? greeting : [greeting];
        messages.push({
            name: charName, is_user: false, is_system: false, send_date: sendDate(), mes: g[0] ?? '',
            extra: {}, swipes: g.slice(), swipe_id: 0, swipe_info: g.map(() => ({ send_date: sendDate(), extra: {} })),
        });
    }
    const key = chatKey(charFile, file);
    const chat = { key, charFile, file, header, messages, timer: null };
    chatCache.set(key, chat);
    await flushChat(chat);
    return chat;
}

export async function deleteChat(charFile, file) {
    const key = chatKey(charFile, file);
    const c = chatCache.get(key);
    if (c) { clearTimeout(c.timer); chatCache.delete(key); }
    await fsp.rm(inside(chatDir(charFile), file), { force: true });
}

export async function renameChat(charFile, file, newName) {
    let nf = safeName(newName.replace(/\.jsonl$/i, '')) + '.jsonl';
    const c = chatCache.get(chatKey(charFile, file));
    if (c?.timer) await flushChat(c);
    await fsp.rename(inside(chatDir(charFile), file), inside(chatDir(charFile), nf));
    chatCache.delete(chatKey(charFile, file));
    return nf;
}

export async function branchChat(chat, uptoIndex) {
    const file = `Branch #${uptoIndex} - ${humanDate()}.jsonl`;
    const header = structuredClone(chat.header);
    header.chat_metadata.main_chat = chat.file.replace(/\.jsonl$/, '');
    const messages = structuredClone(chat.messages.slice(0, uptoIndex + 1));
    const key = chatKey(chat.charFile, file);
    const nc = { key, charFile: chat.charFile, file, header, messages, timer: null };
    chatCache.set(key, nc);
    await flushChat(nc);
    return nc;
}

// ───────────────────────── backups ─────────────────────────
// Every N floors the whole chat file is copied to data/backups/<char>/<chat>/<time>.jsonl (kept: last K).

function backupDir(charFile, file) {
    return inside(dir('backups'), chatDirName(charFile), safeName(file.replace(/\.jsonl$/i, '')));
}

export async function backupChat(chat, reason = 'auto') {
    await flushChat(chat);
    const d = backupDir(chat.charFile, chat.file);
    ensureDir(d);
    const name = `${humanDate()}_${chat.messages.length}楼_${reason}.jsonl`;
    await fsp.copyFile(inside(chatDir(chat.charFile), chat.file), path.join(d, name));
    const keep = Number(getSettings().backup?.keep || 30);
    const files = (await fsp.readdir(d)).filter(f => f.endsWith('.jsonl')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) await fsp.rm(path.join(d, f), { force: true });
    return name;
}

export function maybeBackup(chat) {
    const b = getSettings().backup || {};
    if (b.enabled === false) return;
    const every = Math.max(1, Number(b.every || 3));
    const n = chat.messages.length;
    const last = chat.lastBackupAt ?? (chat.lastBackupAt = n - (n % every));
    if (n - last >= every) {
        chat.lastBackupAt = n;
        backupChat(chat).catch(e => console.warn('[backup]', e.message));
    }
}

export async function listBackups(charFile, file) {
    const d = backupDir(charFile, file);
    let files = [];
    try { files = (await fsp.readdir(d)).filter(f => f.endsWith('.jsonl')); } catch { return []; }
    const out = [];
    for (const f of files) {
        const st = await fsp.stat(path.join(d, f));
        out.push({ file: f, size: st.size, mtime: st.mtimeMs });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
}

export async function restoreBackup(charFile, file, backup, mode) {
    const src = inside(backupDir(charFile, file), backup);
    if (mode === 'overwrite') {
        const c = chatCache.get(chatKey(charFile, file));
        if (c) { await backupChat(c, '覆盖前'); clearTimeout(c.timer); chatCache.delete(c.key); }
        await fsp.copyFile(src, inside(chatDir(charFile), file));
        return file;
    }
    const nf = `${file.replace(/\.jsonl$/i, '')} 备份恢复 ${humanDate()}.jsonl`;
    await fsp.copyFile(src, inside(chatDir(charFile), nf));
    return nf;
}

// ───────────────────────── worlds ─────────────────────────

const worldCache = new Map();
export function worldPath(name) { return inside(dir('worlds'), safeName(name) + '.json'); }
export async function listWorlds() {
    const files = (await fsp.readdir(dir('worlds'))).filter(f => f.endsWith('.json'));
    return files.map(f => f.slice(0, -5)).sort();
}
export function loadWorld(name) {
    if (!name) return null;
    const p = worldPath(name);
    let st;
    try { st = fs.statSync(p); } catch { return null; }
    const c = worldCache.get(name);
    if (c && c.mtime === st.mtimeMs) return c.data;
    const data = readJSON(p, null);
    if (!data) return null;
    data.entries ??= {};
    worldCache.set(name, { mtime: st.mtimeMs, data });
    return data;
}
export async function saveWorld(name, data) {
    await writeJSON(worldPath(name), data);
    worldCache.delete(name);
}
export async function deleteWorld(name) {
    await fsp.rm(worldPath(name), { force: true });
    worldCache.delete(name);
}

/** Convert a V2 character_book into a SillyTavern world file. */
export function characterBookToWorld(book) {
    const entries = {};
    (book.entries || []).forEach((e, i) => {
        const ext = e.extensions || {};
        entries[i] = {
            uid: i,
            key: e.keys || [],
            keysecondary: e.secondary_keys || [],
            comment: e.comment || e.name || '',
            content: e.content || '',
            constant: !!e.constant,
            selective: !!e.selective,
            selectiveLogic: ext.selectiveLogic ?? 0,
            order: e.insertion_order ?? 100,
            position: ext.position ?? (e.position === 'before_char' ? 0 : 1),
            disable: e.enabled === false,
            excludeRecursion: !!ext.exclude_recursion,
            preventRecursion: !!ext.prevent_recursion,
            delayUntilRecursion: !!ext.delay_until_recursion,
            probability: ext.probability ?? 100,
            useProbability: ext.useProbability ?? true,
            depth: ext.depth ?? 4,
            role: ext.role ?? 0,
            group: ext.group || '',
            groupOverride: !!ext.group_override,
            groupWeight: ext.group_weight ?? 100,
            scanDepth: ext.scan_depth ?? null,
            caseSensitive: ext.case_sensitive ?? null,
            matchWholeWords: ext.match_whole_words ?? null,
            displayIndex: ext.display_index ?? i,
        };
    });
    return { entries, name: book.name || '' };
}

// ───────────────────────── presets ─────────────────────────

const presetCache = new Map();
export function presetPath(name) { return inside(dir('presets'), safeName(name) + '.json'); }
export async function listPresets() {
    return (await fsp.readdir(dir('presets'))).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
}
export function loadPreset(name) {
    if (!name) return null;
    const p = presetPath(name);
    let st;
    try { st = fs.statSync(p); } catch { return null; }
    const c = presetCache.get(name);
    if (c && c.mtime === st.mtimeMs) return c.data;
    const data = readJSON(p, null);
    if (data) presetCache.set(name, { mtime: st.mtimeMs, data });
    return data;
}
export async function savePreset(name, data) {
    await writeJSON(presetPath(name), data, true);
    presetCache.delete(name);
}
export async function deletePreset(name) {
    await fsp.rm(presetPath(name), { force: true });
    presetCache.delete(name);
}

/** The prompt order list the preset actually uses (ST: character_id 100001 if present, else 100000). */
export function presetOrder(preset) {
    const po = preset?.prompt_order || [];
    return (po.find(x => String(x.character_id) === '100001') || po.find(x => String(x.character_id) === '100000') || po[0] || { order: [] });
}

/** Regex scripts embedded in a preset (ST stores them in extensions.regex_scripts; SPreset also). */
export function presetRegex(preset) {
    return preset?.extensions?.regex_scripts || preset?.extensions?.SPreset?.RegexBinding?.regexes || [];
}

export { uid, sendDate, humanDate };
