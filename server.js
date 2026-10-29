// Sakura server. Zero-framework Node http server.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ROOT, dir, inside, safeName, readJSON } from './lib/util.js';
import * as S from './lib/store.js';
import { readCard, blankPng } from './lib/png.js';
import { importFromST } from './lib/importer.js';
import { generate, dto, lastPrompts, promptFor, setSwipe, ensureSwipes, storeRegex, activeProfile } from './lib/generate.js';
import { listModels, SOURCES } from './lib/providers.js';
import { msgVars, setMsgVars, latestVars } from './lib/mvu.js';
import { summaryRoots } from './lib/summary.js';
import { resolvePersona } from './lib/prompt.js';

const PORT_DESKTOP = Number(process.env.SAKURA_PORT || 8290);
const PORT_MOBILE = Number(process.env.SAKURA_MOBILE_PORT || 8291);
const PUBLIC = path.join(ROOT, 'public');

// first run: import from old tavern
if (!fs.existsSync(dir('settings.json'))) {
    try {
        const r = importFromST({});
        console.log('[import] 从旧酒馆导入完成', r);
    } catch (e) {
        console.log('[import] 没有找到可导入的 SillyTavern 数据，从空白开始（' + e.message + '）');
        S.saveSettings(true);
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8',
};

function sendJSON(res, obj, code = 200) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
}

async function sendFile(res, p, cache = 'no-cache', req = null) {
    try {
        const st = await fsp.stat(p);
        const etag = `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
        if (req?.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache, ETag: etag });
        fs.createReadStream(p).pipe(res);
    } catch {
        res.writeHead(404); res.end('not found');
    }
}

async function readBody(req, limit = 200 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > limit) throw new Error('too large');
        chunks.push(c);
    }
    return Buffer.concat(chunks);
}
async function readJSONBody(req) {
    const b = await readBody(req);
    return b.length ? JSON.parse(b.toString('utf8')) : {};
}

function publicSettings() {
    const s = S.getSettings();
    return s;
}

// ───────────────────────── routes ─────────────────────────

const routes = new Map();
const route = (method, p, fn) => routes.set(method + ' ' + p, fn);

route('GET', '/api/boot', async (req, res, q) => {
    const s = S.getSettings();
    sendJSON(res, {
        settings: publicSettings(),
        presets: await S.listPresets(),
        worlds: await S.listWorlds(),
        secrets: S.listSecretLabels(),
        sources: SOURCES,
        fonts: (await fsp.readdir(dir('fonts')).catch(() => [])),
        novels: (await fsp.readdir(dir('novels')).catch(() => [])),
        mobile: Number(req.socket.localPort) === PORT_MOBILE,
        lan: lanAddresses(),
        ports: { desktop: PORT_DESKTOP, mobile: PORT_MOBILE },
    });
});

route('GET', '/api/chars', async (req, res) => sendJSON(res, await S.listCharacters()));

route('GET', '/api/char', async (req, res, q) => {
    const card = S.loadCard(q.file);
    const d = { ...card.data };
    const ext = { ...(d.extensions || {}) };
    delete ext.tavern_helper; delete ext.TavernHelper_scripts;
    d.extensions = ext;
    delete d.character_book;
    const s = S.getSettings();
    sendJSON(res, { file: q.file, data: d, spec: card.spec, persona: resolvePersona(s, q.file).id, hasBook: !!card.data.character_book });
});

route('POST', '/api/char/save', async (req, res) => {
    const b = await readJSONBody(req);
    const card = structuredClone(S.loadCard(b.file));
    for (const k of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions', 'alternate_greetings', 'tags']) {
        if (b.data[k] !== undefined) card.data[k] = b.data[k];
    }
    if (b.data.world !== undefined) card.data.extensions.world = b.data.world;
    if (b.data.fav !== undefined) card.data.extensions.fav = !!b.data.fav;
    if (b.data.regex_scripts !== undefined) card.data.extensions.regex_scripts = b.data.regex_scripts;
    await S.saveCard(b.file, card);
    sendJSON(res, { ok: true });
});

route('POST', '/api/char/import', async (req, res, q) => {
    const buf = await readBody(req);
    let card, png;
    if (buf[0] === 0x89) { card = readCard(buf); png = buf; }
    else { card = JSON.parse(buf.toString('utf8')); png = blankPng(); }
    if (!card) throw new Error('这个文件里没有角色卡数据');
    S.normalizeCard(card);
    if (card.spec !== 'chara_card_v3') card.spec = card.spec || 'chara_card_v2';
    const file = S.uniqueCharFile(card.data.name || q.name || 'card');
    // embedded lorebook -> world file
    const book = card.data.character_book;
    if (book?.entries?.length) {
        let wname = card.data.extensions.world || book.name || card.data.name;
        wname = safeName(wname);
        if (!fs.existsSync(S.worldPath(wname))) await S.saveWorld(wname, S.characterBookToWorld(book));
        card.data.extensions.world = wname;
    }
    await S.saveCard(file, card, png);
    sendJSON(res, { file, name: card.data.name });
});

route('POST', '/api/char/thumb', async (req, res, q) => {
    const buf = await readBody(req, 5 * 1024 * 1024);
    await fsp.writeFile(inside(dir('thumbs'), q.file), buf);
    sendJSON(res, { ok: true });
});

route('POST', '/api/char/avatar', async (req, res, q) => {
    const buf = await readBody(req, 30 * 1024 * 1024);
    const card = S.loadCard(q.file);
    await S.saveCard(q.file, card, buf);
    await fsp.rm(inside(dir('thumbs'), q.file), { force: true });
    sendJSON(res, { ok: true });
});

route('POST', '/api/char/delete', async (req, res) => {
    const b = await readJSONBody(req);
    await S.deleteCharacter(b.file);
    if (b.chats) await fsp.rm(S.chatDir(b.file), { recursive: true, force: true });
    sendJSON(res, { ok: true });
});

route('GET', '/api/char/export', async (req, res, q) => {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(q.file)}` });
    fs.createReadStream(S.charPath(q.file)).pipe(res);
});

// chats
route('GET', '/api/chats', async (req, res, q) => {
    const list = await S.listChatFiles(q.char);
    const out = [];
    for (const c of list) out.push({ ...c, preview: await S.chatPreview(q.char, c.file).catch(() => '') });
    sendJSON(res, out);
});

route('POST', '/api/chat/new', async (req, res) => {
    const b = await readJSONBody(req);
    const card = S.loadCard(b.char).data;
    const s = S.getSettings();
    const persona = resolvePersona(s, b.char);
    const sub = t => String(t || '').replace(/{{user}}/gi, persona.name).replace(/{{char}}/gi, card.name).replace(/<user>/gi, persona.name).replace(/<bot>/gi, card.name);
    const greetings = [card.first_mes, ...(card.alternate_greetings || [])].filter(x => x !== undefined && x !== null && String(x).length).map(sub);
    if (b.greeting > 0 && greetings[b.greeting]) greetings.unshift(greetings.splice(b.greeting, 1)[0]);
    const chat = await S.createChat(b.char, { userName: persona.name, charName: card.name, greeting: greetings.length ? greetings : null });
    s.lastChat[b.char] = chat.file;
    S.saveSettings();
    sendJSON(res, { file: chat.file });
});

route('POST', '/api/chat/delete', async (req, res) => {
    const b = await readJSONBody(req);
    await S.deleteChat(b.char, b.file);
    sendJSON(res, { ok: true });
});

route('POST', '/api/chat/rename', async (req, res) => {
    const b = await readJSONBody(req);
    sendJSON(res, { file: await S.renameChat(b.char, b.file, b.name) });
});

route('POST', '/api/chat/import', async (req, res, q) => {
    const buf = await readBody(req);
    const name = safeName(String(q.name || 'imported').replace(/\.jsonl$/i, '')) + '.jsonl';
    await fsp.mkdir(S.chatDir(q.char), { recursive: true });
    await fsp.writeFile(inside(S.chatDir(q.char), name), buf);
    sendJSON(res, { file: name });
});

route('GET', '/api/chat', async (req, res, q) => {
    const chat = await S.loadChat(q.char, q.file);
    const msgs = chat.messages;
    const total = msgs.length;
    const limit = Number(q.limit || 24);
    const end = q.before !== undefined ? Math.max(0, Number(q.before)) : total;
    const start = Math.max(0, end - limit);
    // skip hidden floors when paging so the user sees real content
    const out = [];
    for (let i = start; i < end; i++) out.push(dto(msgs[i], i, total, i >= total - 12));
    const s = S.getSettings();
    s.lastChat[q.char] = q.file;
    S.saveSettings();
    const meta = chat.header.chat_metadata;
    let firstVisible = msgs.findIndex(m => !m.is_system);
    sendJSON(res, {
        total, start, messages: out,
        hiddenCount: msgs.filter(m => m.is_system).length, firstVisible,
        summaries: summaryRoots(meta).length,
        note: { prompt: meta.note_prompt || '', depth: meta.note_depth ?? 4, role: meta.note_role ?? 0 },
        user: chat.header.user_name, charName: chat.header.character_name,
        chatVars: meta.variables || {},
    });
});

route('GET', '/api/chat/vars', async (req, res, q) => {
    const chat = await S.loadChat(q.char, q.file);
    const i = q.index === undefined || q.index === 'latest' ? chat.messages.length - 1 : Number(q.index);
    sendJSON(res, { index: i, vars: msgVars(chat.messages[i]) || latestVars(chat.messages, i + 1) || {}, chat: chat.header.chat_metadata.variables || {} });
});

route('POST', '/api/chat/vars', async (req, res) => {
    const b = await readJSONBody(req);
    const chat = await S.loadChat(b.char, b.file);
    if (b.type === 'chat') chat.header.chat_metadata.variables = b.vars || {};
    else if (b.type === 'global') { S.getSettings().globalVars = b.vars || {}; S.saveSettings(); }
    else {
        const i = b.index === undefined || b.index === 'latest' ? chat.messages.length - 1 : Number(b.index);
        if (chat.messages[i]) setMsgVars(chat.messages[i], b.vars || {});
    }
    S.markDirty(chat);
    sendJSON(res, { ok: true });
});

route('POST', '/api/chat/edit', async (req, res) => {
    const b = await readJSONBody(req);
    const chat = await S.loadChat(b.char, b.file);
    const m = chat.messages[b.index];
    if (!m) throw new Error('没有这条消息');
    const text = storeRegex(b.char, String(b.text ?? ''), m.is_user, true);
    m.mes = text;
    if (Array.isArray(m.swipes)) m.swipes[m.swipe_id ?? 0] = text;
    if (b.reasoning !== undefined) {
        m.extra = { ...(m.extra || {}), reasoning: b.reasoning };
        if (m.swipe_info?.[m.swipe_id ?? 0]) (m.swipe_info[m.swipe_id ?? 0].extra ??= {}).reasoning = b.reasoning;
    }
    S.markDirty(chat);
    sendJSON(res, dto(m, b.index, chat.messages.length, true));
});

route('POST', '/api/chat/add', async (req, res) => {
    // insert a message (used by frontends: createChatMessages / sendas)
    const b = await readJSONBody(req);
    const chat = await S.loadChat(b.char, b.file);
    const s = S.getSettings();
    const persona = resolvePersona(s, b.char);
    const card = S.loadCard(b.char).data;
    const m = { name: b.user ? persona.name : (b.name || card.name), is_user: !!b.user, is_system: false, send_date: S.sendDate(), mes: String(b.text || ''), extra: {} };
    const at = b.at === undefined ? chat.messages.length : Number(b.at);
    chat.messages.splice(at, 0, m);
    S.markDirty(chat);
    sendJSON(res, dto(m, at, chat.messages.length));
});

route('POST', '/api/chat/delete-msg', async (req, res) => {
    const b = await readJSONBody(req);
    const chat = await S.loadChat(b.char, b.file);
    const count = b.toEnd ? chat.messages.length - b.index : (b.count || 1);
    chat.messages.splice(b.index, count);
    S.markDirty(chat);
    sendJSON(res, { ok: true, total: chat.messages.length });
});

route('POST', '/api/chat/delete-many', async (req, res) => {
    const b = await readJSONBody(req);
    const chat = await S.loadChat(b.char, b.file);
    await S.backupChat(chat, '删除前');
    const idx = [...new Set(b.indices.map(Number))].sort((a, c) => c - a);
    for (const i of idx) if (i >= 0 && i < chat.messages.length) chat.messages.splice(i, 1);
    S.markDirty(chat);
    sendJSON(res, { ok: true, total: chat.messages.length });
});

route('POST', '/api/chat/delete-swipe', async (req, res) => {
    const b = await readJSONBody(req);
    const chat = await S.loadChat(b.char, b.file);
    const m = chat.messages[b.index];
    ensureSwipes(m);
    if (m.swipes.length <= 1) throw new Error('只剩一个回复了');
    const sid = m.swipe_id ?? 0;
    m.swipes.splice(sid, 1);
    m.swipe_info.splice(sid, 1);
    if (Array.isArray(m.variables)) m.variables.splice(sid, 1);
    setSwipe(m, Math.min(sid, m.swipes.length - 1));
    S.markDirty(chat);
    sendJSON(res, dto(m, b.index, chat.messages.length, true));
});

route('POST', '/api/chat/swipe', async (req, res) => {
    const b = await readJSONBody(req);
    const chat = await S.loadChat(b.char, b.file);
    const m = chat.messages[b.index];
    ensureSwipes(m);
    setSwipe(m, b.to);
    S.markDirty(chat);
    sendJSON(res, dto(m, b.index, chat.messages.length, true));
});

route('POST', '/api/chat/hide', async (req, res) => {
    const b = await readJSONBody(req);
    const chat = await S.loadChat(b.char, b.file);
    const m = chat.messages[b.index];
    m.is_system = !!b.hidden;
    S.markDirty(chat);
    sendJSON(res, dto(m, b.index, chat.messages.length));
});

route('POST', '/api/chat/branch', async (req, res) => {
    const b = await readJSONBody(req);
    const chat = await S.loadChat(b.char, b.file);
    const nc = await S.branchChat(chat, b.index);
    sendJSON(res, { file: nc.file });
});

route('POST', '/api/chat/meta', async (req, res) => {
    const b = await readJSONBody(req);
    const chat = await S.loadChat(b.char, b.file);
    const meta = chat.header.chat_metadata;
    if (b.note !== undefined) { meta.note_prompt = b.note.prompt; meta.note_depth = Number(b.note.depth ?? 4); meta.note_role = Number(b.note.role ?? 0); }
    if (b.world !== undefined) meta.world_info = b.world || undefined;
    S.markDirty(chat);
    sendJSON(res, { ok: true });
});

route('POST', '/api/chat/unhide-all', async (req, res) => {
    const b = await readJSONBody(req);
    const chat = await S.loadChat(b.char, b.file);
    for (const m of chat.messages) m.is_system = false;
    S.markDirty(chat);
    sendJSON(res, { ok: true });
});

// backups
route('GET', '/api/backups', async (req, res, q) => sendJSON(res, await S.listBackups(q.char, q.file)));
route('POST', '/api/backup/now', async (req, res) => {
    const b = await readJSONBody(req);
    const chat = await S.loadChat(b.char, b.file);
    sendJSON(res, { file: await S.backupChat(chat, '手动') });
});
route('POST', '/api/backup/restore', async (req, res) => {
    const b = await readJSONBody(req);
    sendJSON(res, { file: await S.restoreBackup(b.char, b.file, b.backup, b.mode) });
});
route('GET', '/api/chat/export', async (req, res, q) => {
    const chat = await S.loadChat(q.char, q.file);
    await S.flushChat(chat);
    res.writeHead(200, { 'Content-Type': 'application/jsonl; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(q.file)}` });
    fs.createReadStream(inside(S.chatDir(q.char), q.file)).pipe(res);
});

// universal JSON import: detects card / preset / world / regex / QR set / TavernHelper script
route('POST', '/api/import', async (req, res, q) => {
    const buf = await readBody(req);
    const name = String(q.name || 'import').replace(/\.(json|png)$/i, '');
    if (buf[0] === 0x89) return routes.get('POST /api/char/import')({ [Symbol.asyncIterator]: async function* () { yield buf; } }, res, q);
    let data = JSON.parse(buf.toString('utf8').replace(/^﻿/, ''));
    const s = S.getSettings();
    const isRegex = x => x && typeof x === 'object' && 'findRegex' in x;
    const isScript = x => x && typeof x === 'object' && (x.type === 'script' || x.type === 'folder') && ('content' in x || 'scripts' in x);
    const flattenScripts = list => list.flatMap(x => x.type === 'folder' ? (x.scripts || []) : [x]);
    if (data.spec?.startsWith?.('chara_card') || (data.data?.name !== undefined && data.data?.first_mes !== undefined) || (data.name !== undefined && data.first_mes !== undefined && !data.entries)) {
        return routes.get('POST /api/char/import')({ [Symbol.asyncIterator]: async function* () { yield buf; } }, res, q);
    }
    if (Array.isArray(data.prompts) && data.prompt_order) {
        const n = safeName(name);
        await S.savePreset(n, data);
        return sendJSON(res, { kind: '预设', name: n });
    }
    if (data.entries && !Array.isArray(data.qrList)) {
        if (Array.isArray(data.entries)) data = S.characterBookToWorld(data);
        const n = safeName(data.name || name);
        await S.saveWorld(n, data);
        return sendJSON(res, { kind: '世界书', name: n });
    }
    if (Array.isArray(data.qrList)) {
        const set = { id: crypto.randomUUID(), name: data.name || name, enabled: true, qrList: data.qrList.map(x => ({ label: x.label, title: x.title, message: x.message, isHidden: !!x.isHidden })) };
        s.qrSets = [...(s.qrSets || []).filter(x => x.name !== set.name), set];
        S.saveSettings();
        return sendJSON(res, { kind: '快速回复', name: set.name });
    }
    const regexList = isRegex(data) ? [data] : (Array.isArray(data) && data.every(isRegex) ? data : null);
    if (regexList) {
        s.regex = [...(s.regex || []), ...regexList.map(r => ({ ...r, id: r.id || crypto.randomUUID() }))];
        S.saveSettings();
        return sendJSON(res, { kind: '正则', name: regexList.map(r => r.scriptName).join('、') });
    }
    const scriptList = isScript(data) ? flattenScripts([data]) : (Array.isArray(data) && data.every(isScript) ? flattenScripts(data) : (Array.isArray(data.scripts) ? flattenScripts(data.scripts) : null));
    if (scriptList) {
        for (const sc of scriptList) {
            const item = {
                id: sc.id || crypto.randomUUID(), name: sc.name || name, content: sc.content || '', info: sc.info || '', enabled: false,
                buttons: (sc.button?.buttons || sc.buttons || []).map(b => ({ name: b.name, visible: b.visible !== false })),
                data: sc.data || {},
            };
            s.scripts = [...(s.scripts || []).filter(x => x.id !== item.id), item];
        }
        S.saveSettings();
        return sendJSON(res, { kind: '脚本（默认关，在设置里打开）', name: scriptList.map(x => x.name).join('、') });
    }
    throw new Error('认不出这个 JSON 是什么（支持：角色卡、预设、世界书、正则、快速回复、酒馆助手脚本）');
});

// generation (SSE)
route('POST', '/api/gen', async (req, res) => {
    const b = await readJSONBody(req);
    const ac = new AbortController();
    let finished = false;
    res.on('close', () => { if (!finished) ac.abort(); });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (ev) => { if (!res.writableEnded) res.write('data: ' + JSON.stringify(ev) + '\n\n'); };
    try {
        await generate({ charFile: b.char, file: b.file, type: b.type, text: b.text }, send, ac.signal);
    } catch (e) {
        if (!ac.signal.aborted) send({ t: 'err', e: e.message || String(e) });
    }
    if (ac.signal.aborted) {
        // keep what we have (generate saved partial text through the stream loop)
    }
    finished = true;
    res.end();
});

route('GET', '/api/prompt/last', async (req, res, q) => {
    const chat = await S.loadChat(q.char, q.file);
    sendJSON(res, lastPrompts.get(chat.key) || null);
});

route('POST', '/api/prompt/dry', async (req, res) => {
    const b = await readJSONBody(req);
    const chat = await S.loadChat(b.char, b.file);
    const vars = structuredClone(chat.header.chat_metadata.variables || {});
    const { built, final, profile } = await promptFor(chat, 'dry', chat.messages.slice());
    chat.header.chat_metadata.variables = vars; // dry run must not change vars
    sendJSON(res, { messages: final, raw: built.messages, info: built.info, profile: profile && { name: profile.name, source: profile.source, model: profile.model, url: profile.url }, time: Date.now(), dry: true });
});

// settings
route('POST', '/api/settings', async (req, res) => {
    const b = await readJSONBody(req);
    const s = S.getSettings();
    for (const [k, v] of Object.entries(b)) {
        if (['profiles', 'personas'].includes(k)) continue;
        if (v && typeof v === 'object' && !Array.isArray(v) && s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) Object.assign(s[k], v);
        else s[k] = v;
    }
    S.saveSettings();
    sendJSON(res, { ok: true, settings: s });
});

route('POST', '/api/profile/save', async (req, res) => {
    const b = await readJSONBody(req);
    const s = S.getSettings();
    const p = b.profile;
    if (!p.name?.trim()) throw new Error('名字不能空');
    if (p.newKey) {
        const key = p.source === 'vertex' ? (String(p.newKey).trim().startsWith('{') ? 'vertexai_service_account_json' : 'api_key_vertexai') : p.source === 'aistudio' ? 'api_key_makersuite' : 'api_key_custom';
        p.secretId = S.addSecret(key, String(p.newKey).trim(), p.name);
        delete p.newKey;
    }
    if (s.profiles.some(x => x.name === p.name && x.id !== p.id)) throw new Error('已经有同名的插头了');
    if (!p.id) { p.id = crypto.randomUUID(); s.profiles.push(p); }
    else {
        const i = s.profiles.findIndex(x => x.id === p.id);
        if (i >= 0) s.profiles[i] = p; else s.profiles.push(p);
    }
    S.saveSettings();
    sendJSON(res, { ok: true, profile: p, secrets: S.listSecretLabels() });
});
route('POST', '/api/profile/delete', async (req, res) => {
    const b = await readJSONBody(req);
    const s = S.getSettings();
    s.profiles = s.profiles.filter(x => x.id !== b.id);
    if (s.activeProfile === b.id) s.activeProfile = s.profiles[0]?.id || '';
    S.saveSettings();
    sendJSON(res, { ok: true });
});
route('POST', '/api/profile/select', async (req, res) => {
    const b = await readJSONBody(req);
    S.getSettings().activeProfile = b.id;
    S.saveSettings();
    sendJSON(res, { ok: true });
});
route('GET', '/api/models', async (req, res, q) => {
    const s = S.getSettings();
    const p = s.profiles.find(x => x.id === q.id) || activeProfile();
    sendJSON(res, await listModels(p));
});
route('POST', '/api/profile/test', async (req, res) => {
    const b = await readJSONBody(req);
    const { streamFrom } = await import('./lib/providers.js');
    const s = S.getSettings();
    const p = b.profile || s.profiles.find(x => x.id === b.id);
    let text = '';
    const t0 = Date.now();
    for await (const ev of streamFrom(p, [{ role: 'user', content: '只回复两个字：在的' }], { temperature: 0.5, top_p: 1, max_tokens: 2048, stream: true, reasoning_effort: 'min', show_thoughts: false, seed: -1 }, AbortSignal.timeout(60000))) {
        if (ev.type === 'text') text += ev.text;
    }
    sendJSON(res, { ok: true, text, ms: Date.now() - t0 });
});

// presets
route('GET', '/api/preset', async (req, res, q) => sendJSON(res, S.loadPreset(q.name)));
route('POST', '/api/preset/save', async (req, res) => {
    const b = await readJSONBody(req);
    await S.savePreset(b.name, b.data);
    sendJSON(res, { ok: true });
});
route('POST', '/api/preset/import', async (req, res, q) => {
    const buf = await readBody(req);
    const data = JSON.parse(buf.toString('utf8'));
    const name = safeName(String(q.name || 'preset').replace(/\.json$/i, ''));
    await S.savePreset(name, data);
    sendJSON(res, { name, presets: await S.listPresets() });
});
route('POST', '/api/preset/delete', async (req, res) => {
    const b = await readJSONBody(req);
    await S.deletePreset(b.name);
    sendJSON(res, { ok: true, presets: await S.listPresets() });
});
route('POST', '/api/preset/toggle', async (req, res) => {
    const b = await readJSONBody(req);
    const p = structuredClone(S.loadPreset(b.name));
    const ord = S.presetOrder(p).order;
    const it = ord.find(x => x.identifier === b.identifier);
    if (it) it.enabled = !!b.enabled;
    await S.savePreset(b.name, p);
    sendJSON(res, { ok: true });
});
route('POST', '/api/preset/entry', async (req, res) => {
    // update one prompt entry (content/name/role/depth/order/position)
    const b = await readJSONBody(req);
    const p = structuredClone(S.loadPreset(b.name));
    let def = p.prompts.find(x => x.identifier === b.entry.identifier);
    if (!def) {
        def = { identifier: b.entry.identifier || crypto.randomUUID(), system_prompt: false, marker: false };
        p.prompts.push(def);
        S.presetOrder(p).order.push({ identifier: def.identifier, enabled: true });
    }
    Object.assign(def, b.entry);
    await S.savePreset(b.name, p);
    sendJSON(res, { ok: true });
});
route('POST', '/api/preset/reorder', async (req, res) => {
    const b = await readJSONBody(req);
    const p = structuredClone(S.loadPreset(b.name));
    const po = S.presetOrder(p);
    const map = new Map(po.order.map(x => [x.identifier, x]));
    po.order = b.order.map(id => map.get(id)).filter(Boolean);
    await S.savePreset(b.name, p);
    sendJSON(res, { ok: true });
});
route('POST', '/api/preset/params', async (req, res) => {
    const b = await readJSONBody(req);
    const p = structuredClone(S.loadPreset(b.name));
    Object.assign(p, b.params);
    await S.savePreset(b.name, p);
    sendJSON(res, { ok: true });
});
route('POST', '/api/preset/regex', async (req, res) => {
    const b = await readJSONBody(req);
    const p = structuredClone(S.loadPreset(b.name));
    p.extensions ??= {};
    p.extensions.regex_scripts = b.regex;
    if (p.extensions.SPreset?.RegexBinding) p.extensions.SPreset.RegexBinding.regexes = b.regex;
    await S.savePreset(b.name, p);
    sendJSON(res, { ok: true });
});

// regex for display (global + preset + card)
route('GET', '/api/regex', async (req, res, q) => {
    const s = S.getSettings();
    const preset = S.loadPreset(s.activePreset);
    const card = q.char ? S.loadCard(q.char).data : null;
    sendJSON(res, {
        global: s.regex || [],
        preset: S.presetRegex(preset),
        card: card?.extensions?.regex_scripts || [],
    });
});

// worlds
route('GET', '/api/world', async (req, res, q) => sendJSON(res, S.loadWorld(q.name)));
route('POST', '/api/world/save', async (req, res) => {
    const b = await readJSONBody(req);
    await S.saveWorld(b.name, b.data);
    sendJSON(res, { ok: true, worlds: await S.listWorlds() });
});
route('POST', '/api/world/import', async (req, res, q) => {
    const buf = await readBody(req);
    let data = JSON.parse(buf.toString('utf8'));
    if (data.entries && Array.isArray(data.entries)) data = S.characterBookToWorld(data);
    if (data.data?.character_book) data = S.characterBookToWorld(data.data.character_book);
    const name = safeName(String(q.name || data.name || 'world').replace(/\.json$/i, ''));
    await S.saveWorld(name, data);
    sendJSON(res, { name, worlds: await S.listWorlds() });
});
route('POST', '/api/world/delete', async (req, res) => {
    const b = await readJSONBody(req);
    await S.deleteWorld(b.name);
    const s = S.getSettings();
    s.globalWorlds = s.globalWorlds.filter(x => x !== b.name);
    S.saveSettings();
    sendJSON(res, { ok: true, worlds: await S.listWorlds() });
});

// personas
route('POST', '/api/persona/save', async (req, res) => {
    const b = await readJSONBody(req);
    const s = S.getSettings();
    const id = b.id || ('persona-' + Date.now() + '.png');
    s.personas[id] = { ...(s.personas[id] || {}), ...b.persona };
    S.saveSettings();
    sendJSON(res, { id, personas: s.personas });
});
route('POST', '/api/persona/delete', async (req, res) => {
    const b = await readJSONBody(req);
    const s = S.getSettings();
    delete s.personas[b.id];
    for (const [k, v] of Object.entries(s.personaBinding)) if (v === b.id) delete s.personaBinding[k];
    S.saveSettings();
    sendJSON(res, { ok: true });
});
route('POST', '/api/persona/bind', async (req, res) => {
    const b = await readJSONBody(req);
    const s = S.getSettings();
    if (b.persona) s.personaBinding[b.char] = b.persona; else delete s.personaBinding[b.char];
    S.saveSettings();
    sendJSON(res, { ok: true });
});
route('POST', '/api/persona/avatar', async (req, res, q) => {
    const buf = await readBody(req, 20 * 1024 * 1024);
    const f = safeName(q.id || ('persona-' + Date.now() + '.png'));
    await fsp.writeFile(inside(dir('personas'), f), buf);
    const s = S.getSettings();
    if (s.personas[q.id]) s.personas[q.id].avatar = f;
    S.saveSettings();
    sendJSON(res, { file: f });
});

// fonts & novels
route('POST', '/api/font/upload', async (req, res, q) => {
    const buf = await readBody(req, 60 * 1024 * 1024);
    const f = safeName(q.name || 'font.ttf');
    await fsp.writeFile(inside(dir('fonts'), f), buf);
    sendJSON(res, { file: f, fonts: await fsp.readdir(dir('fonts')) });
});
route('POST', '/api/font/delete', async (req, res) => {
    const b = await readJSONBody(req);
    await fsp.rm(inside(dir('fonts'), b.file), { force: true });
    sendJSON(res, { fonts: await fsp.readdir(dir('fonts')) });
});
route('POST', '/api/novel/upload', async (req, res, q) => {
    const buf = await readBody(req, 100 * 1024 * 1024);
    const f = safeName(q.name || 'novel.txt');
    await fsp.writeFile(inside(dir('novels'), f), buf);
    sendJSON(res, { file: f, novels: await fsp.readdir(dir('novels')) });
});

route('POST', '/api/secret/add', async (req, res) => {
    const b = await readJSONBody(req);
    const id = S.addSecret(b.key, b.value, b.label);
    sendJSON(res, { id, secrets: S.listSecretLabels() });
});

route('POST', '/api/import-st', async (req, res) => {
    const b = await readJSONBody(req);
    await S.flushAll();
    sendJSON(res, importFromST({ overwrite: !!b.overwrite, settingsToo: b.settingsToo !== false }));
});

// ───────────────────────── server ─────────────────────────

function lanAddresses() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
    return out;
}

async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    const q = Object.fromEntries(url.searchParams);
    try {
        const fn = routes.get(req.method + ' ' + p);
        if (fn) return await fn(req, res, q);
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(404); return res.end(); }
        if (p.startsWith('/chars/')) return sendFile(res, S.charPath(p.slice(7)), 'max-age=60', req);
        if (p.startsWith('/thumbs/')) {
            const f = p.slice(8);
            const tp = inside(dir('thumbs'), f);
            return sendFile(res, fs.existsSync(tp) ? tp : S.charPath(f), 'max-age=3600', req);
        }
        if (p.startsWith('/personas/')) return sendFile(res, inside(dir('personas'), p.slice(10)), 'max-age=3600', req);
        if (p.startsWith('/fonts/')) return sendFile(res, inside(dir('fonts'), p.slice(7)), 'max-age=86400', req);
        if (p === '/' || p === '/index.html' || p === '/m' || p === '/m/') return sendFile(res, path.join(PUBLIC, 'index.html'), 'no-cache', req);
        const fp = inside(PUBLIC, '.' + p);
        return sendFile(res, fp, p.startsWith('/vendor/') ? 'max-age=604800' : 'no-cache', req);
    } catch (e) {
        console.warn('[err]', req.method, p, e.message);
        if (!res.headersSent) sendJSON(res, { error: e.message || String(e) }, 500);
        else res.end();
    }
}

for (const port of [PORT_DESKTOP, PORT_MOBILE]) {
    const srv = http.createServer(handler);
    srv.keepAliveTimeout = 65000;
    srv.requestTimeout = 0;
    srv.listen(port, '0.0.0.0', () => console.log(`Sakura listening on http://127.0.0.1:${port}  (${port === PORT_MOBILE ? '手机版' : '电脑版'})`));
}
console.log('局域网地址:', lanAddresses().map(a => `http://${a}:${PORT_MOBILE}`).join('  '));

async function shutdown() {
    await S.flushAll().catch(() => { });
    S.saveSettings(true);
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', e => console.error('[uncaught]', e));
process.on('unhandledRejection', e => console.error('[unhandled]', e));
