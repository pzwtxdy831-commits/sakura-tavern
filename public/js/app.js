// Sakura — main app: router, home, character page, chat.
import { h, icon, iconBtn, toast, modal, confirmBox, promptBox, pickFile, api, q, fmtTime, fmtSize, onLongPress } from './ui.js';
import { renderText, mountFrames, makeMacro } from './render.js';
import { initPanel, refreshPanel, openPromptViewer, setFabVisible } from './panel.js';
import { openWorlds, openPersonas, openSettings, openCharEditor, applyTheme } from './settings.js';
import { openWand, closeWand } from './wand.js';
import { startScripts, runSlash } from './scripts.js';

export const state = {
    boot: null,
    settings: null,
    chars: [],
    char: null,      // {file, data, persona, thumb}
    chat: null,      // {char, file, msgs: Map, start, total, chatVars, hiddenCount}
    regex: { global: [], preset: [], card: [] },
    generating: false,
    abort: null,
    route: '',
    prevRoute: '',
    selecting: null, // Set of indices while in delete mode
};

const app = document.getElementById('app');
const enc = encodeURIComponent;
export const isTouch = () => document.documentElement.classList.contains('mobile') || matchMedia('(pointer: coarse)').matches;

// ───────────────────────── boot ─────────────────────────

async function boot() {
    // card frontends (TavernHelper builds) expect zod v4 as a global `z`
    import('https://testingcf.jsdelivr.net/npm/zod@4.1.12/+esm').then(m => { window.z = m.z || m.default || m; })
        .catch(() => import('https://cdn.jsdelivr.net/npm/zod@4.1.12/+esm').then(m => { window.z = m.z || m.default || m; }).catch(() => { }));
    state.boot = await api('/api/boot');
    state.settings = state.boot.settings;
    if (state.boot.mobile) document.documentElement.classList.add('mobile');
    applyTheme();
    initPanel();
    setFabVisible(state.settings.ui?.fab !== false);
    startScripts();
    window.addEventListener('hashchange', route);
    route();
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
        navigator.serviceWorker.register('/sw.js').catch(() => { });
    }
}

export async function reloadSettings() {
    const b = await api('/api/boot');
    state.boot = b;
    state.settings = b.settings;
}

export function saveSettings(patch) {
    Object.assign(state.settings, patch);
    return api('/api/settings', patch);
}

// ───────────────────────── router ─────────────────────────

function parseHash() {
    return location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent).filter(x => x !== '');
}

async function route() {
    state.prevRoute = state.route;
    state.route = location.hash;
    state.selecting = null;
    closeWand();
    const p = parseHash();
    try {
        if (p[0] === 'c' && p[1]) await showChar(p[1]);
        else if (p[0] === 'chat' && p[1] && p[2]) await showChat(p[1], p[2]);
        else await showHome();
    } catch (e) {
        console.error(e);
        toast('出错了：' + e.message, true);
    }
    refreshPanel();
}

/** Go up one level; uses history.back when the previous entry is the parent so browser history stays clean. */
export function goUp(parentHash) {
    if (state.prevRoute === parentHash) history.back();
    else location.hash = parentHash;
}

function topbar(left, title, sub, right) {
    return h('div', { class: 'topbar' }, left, h('div', { class: 'grow' }, h('div', { class: 'title' }, title), sub ? h('div', { class: 'sub' }, sub) : null), right);
}

// ───────────────────────── home ─────────────────────────

async function showHome() {
    state.chat = null;
    document.title = 'Sakura';
    const grid = h('div', { class: 'grid' });
    const search = h('input', { type: 'search', placeholder: '搜索角色…', style: { maxWidth: '240px' } });
    const view = h('div', { class: 'view' },
        topbar(h('div', { class: 'brand' }, icon('sakura', 'brand-icon')), 'Sakura', '',
            h('div', { class: 'row' },
                iconBtn('book', '世界书', () => openWorlds()),
                iconBtn('user', '人设', () => openPersonas()),
                iconBtn('gear', '设置', () => openSettings()))),
        h('div', { class: 'scroll grow' },
            h('div', { class: 'home-body' },
                h('div', { class: 'home-head' },
                    h('h1', {}, '角色'),
                    h('div', { class: 'row wrap' }, search,
                        h('button', { class: 'btn', onclick: () => openWorlds() }, icon('book'), '全局世界书'),
                        h('button', { class: 'btn', onclick: importCards }, icon('upload'), '导入'))),
                grid)));
    app.replaceChildren(view);
    const render = () => {
        const kw = search.value.trim().toLowerCase();
        grid.replaceChildren(...state.chars
            .filter(c => !kw || c.name.toLowerCase().includes(kw) || c.intro.toLowerCase().includes(kw) || c.tags.join(' ').toLowerCase().includes(kw))
            .map(cardEl),
        h('div', { class: 'card add', onclick: importCards },
            h('div', { class: 'cover-box' }, h('div', { class: 'cover add-cover' }, '+')),
            h('div', { class: 'meta' }, h('div', { class: 'name muted' }, '导入角色卡'))));
    };
    search.oninput = render;
    if (state.chars.length) render();
    state.chars = await api('/api/chars');
    render();
}

function cardEl(c) {
    return h('div', { class: 'card', onclick: () => { location.hash = '#/c/' + enc(c.file); } },
        h('div', { class: 'cover-box' },
            h('img', { class: 'cover', src: c.thumb, loading: 'lazy', alt: c.name }),
            c.chats ? h('div', { class: 'badge' }, `${c.chats} 个聊天`) : null),
        h('div', { class: 'meta' },
            h('div', { class: 'name' }, c.name),
            c.intro ? h('div', { class: 'intro' }, c.intro) : null,
            c.tags.length ? h('div', { class: 'tags' }, c.tags.slice(0, 3).map(t => h('span', { class: 'tag' }, t))) : null));
}

/** Import anything: PNG/JSON cards, presets, worlds, regex, QR sets, TavernHelper scripts. */
export async function importAny() {
    const files = await pickFile('*/*', true);
    let cards = 0;
    for (const f of files) {
        try {
            const r = await api('/api/import' + q({ name: f.name }), f);
            if (r.file && /\.png$/i.test(f.name)) await makeThumb(f, r.file);
            if (r.file) cards++;
            toast(`已导入${r.kind || '角色卡'}：${r.name}`);
        } catch { /* toast shown */ }
    }
    if (files.length) {
        await reloadSettings();
        if (cards) state.chars = await api('/api/chars');
        startScripts();
        if (!location.hash || location.hash === '#/') showHome();
    }
}
const importCards = importAny;

async function makeThumb(blob, file) {
    try {
        const bmp = await createImageBitmap(blob);
        const s = Math.min(1, 520 / Math.max(bmp.width, bmp.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(bmp.width * s); cv.height = Math.round(bmp.height * s);
        cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
        const out = await new Promise(r => cv.toBlob(r, 'image/png'));
        await api('/api/char/thumb' + q({ file }), out, { silent: true });
    } catch { /* ignore */ }
}

// ───────────────────────── character page ─────────────────────────

async function loadChar(file) {
    if (state.char?.file === file) return state.char;
    const c = await api('/api/char' + q({ file }));
    state.char = c;
    state.regex = await api('/api/regex' + q({ char: file }));
    return c;
}

async function showChar(file) {
    state.chat = null;
    const c = await loadChar(file);
    const d = c.data;
    document.title = d.name + ' · Sakura';
    const meta = state.chars.find(x => x.file === file);
    const thumb = meta?.thumb || '/thumbs/' + enc(file);
    const list = h('div', { class: 'chat-list' }, h('div', { class: 'muted' }, '读取中…'));
    const personaSel = h('select', { style: { maxWidth: '220px' } });
    personaSel.append(h('option', { value: '' }, '（默认人设）'));
    for (const [id, p] of Object.entries(state.settings.personas || {})) personaSel.append(h('option', { value: id }, p.name));
    personaSel.value = state.settings.personaBinding?.[file] || '';
    personaSel.onchange = async () => {
        await api('/api/persona/bind', { char: file, persona: personaSel.value });
        if (personaSel.value) state.settings.personaBinding[file] = personaSel.value; else delete state.settings.personaBinding[file];
        toast('人设已绑定到这张卡');
    };
    const greetings = [d.first_mes, ...(d.alternate_greetings || [])].filter(x => x !== undefined && x !== null);
    const notes = renderText(d.creator_notes || d.description || '', { isUser: false, char: d.name, noFrames: true }).el;
    notes.classList.add('notes');

    const view = h('div', { class: 'view' },
        topbar(iconBtn('back', '返回', () => goUp('#/')), d.name, d.creator || '',
            h('div', { class: 'row' },
                iconBtn('edit', '编辑角色', () => openCharEditor(file, async () => { state.char = null; state.chars = await api('/api/chars'); showChar(file); })),
                iconBtn('download', '导出', () => { location.href = '/api/char/export' + q({ file }); }),
                iconBtn('trash', '删除角色', async () => {
                    if (!await confirmBox(`删除角色「${d.name}」？聊天记录也会一起删掉。`, '删除')) return;
                    await api('/api/char/delete', { file, chats: true });
                    state.chars = state.chars.filter(x => x.file !== file);
                    location.hash = '#/';
                }))),
        h('div', { class: 'scroll grow' },
            h('div', { class: 'char-body' },
                h('div', { class: 'char-hero' },
                    h('img', { class: 'hero-cover', src: thumb }),
                    h('div', { class: 'info' },
                        h('h2', {}, d.name),
                        h('div', { class: 'creator' }, [d.creator, d.character_version].filter(Boolean).join(' · ')),
                        d.tags?.length ? h('div', { class: 'tags', style: { marginTop: '6px' } }, d.tags.map(t => h('span', { class: 'tag' }, t))) : null,
                        notes,
                        h('div', { class: 'row wrap', style: { marginTop: '14px' } },
                            h('span', { class: 'muted', style: { fontSize: '.85em' } }, '我的人设'), personaSel,
                            d.extensions?.world ? h('span', { class: 'tag' }, '世界书：' + d.extensions.world) : null))),
                h('div', { class: 'section-title' }, h('span', {}, '聊天记录 · 长按（右键）管理和备份'),
                    h('div', { class: 'row' },
                        h('button', { class: 'btn small', onclick: () => importChat(file) }, '导入记录'),
                        h('button', { class: 'btn primary small', onclick: () => newChat(file, greetings) }, icon('plus'), '新聊天'))),
                list)));
    app.replaceChildren(view);

    const chats = await api('/api/chats' + q({ char: file }));
    const last = state.settings.lastChat?.[file];
    if (!chats.length) {
        list.replaceChildren(h('div', { class: 'empty' }, '还没有聊天，点「新聊天」开始吧'));
        return;
    }
    list.replaceChildren(...chats.map((ch) => {
        const item = h('div', { class: 'chat-item' + (ch.file === last ? ' current' : '') },
            h('div', { class: 'grow' },
                h('div', { class: 't1' }, ch.file.replace(/\.jsonl$/, '')),
                h('div', { class: 't2' }, `${fmtTime(ch.mtime)} · ${fmtSize(ch.size)} · ${ch.preview || ''}`)),
            iconBtn('more', '管理 / 备份', (e) => { e.stopPropagation(); chatMenu(file, ch.file); }));
        onLongPress(item, () => chatMenu(file, ch.file), () => { location.hash = `#/chat/${enc(file)}/${enc(ch.file)}`; });
        return item;
    }));
}

/** Long-press menu for one chat: backups, rename, export, delete. */
async function chatMenu(char, file) {
    const box = h('div', { class: 'list-plain' }, h('div', { class: 'muted' }, '读取备份…'));
    const m = modal({
        title: file.replace(/\.jsonl$/, ''),
        body: box,
        foot: [
            h('button', { class: 'btn', onclick: async () => { await api('/api/backup/now', { char, file }); toast('已备份'); load(); } }, '立即备份'),
            h('button', { class: 'btn', onclick: async () => { const n = await promptBox('重命名聊天', file.replace(/\.jsonl$/, '')); if (!n) return; await api('/api/chat/rename', { char, file, name: n }); m.close(); showChar(char); } }, '重命名'),
            h('button', { class: 'btn', onclick: () => { location.href = '/api/chat/export' + q({ char, file }); } }, '导出'),
            h('button', { class: 'btn danger', onclick: async () => { if (!await confirmBox('删除这个聊天记录？（备份会保留）', '删除')) return; await api('/api/chat/delete', { char, file }); m.close(); showChar(char); } }, '删除'),
        ],
    });
    async function load() {
        const list = await api('/api/backups' + q({ char, file }));
        box.replaceChildren(
            h('div', { class: 'muted', style: { fontSize: '.85em' } }, `自动备份：每 ${state.settings.backup?.every || 3} 楼一次，保留最近 ${state.settings.backup?.keep || 30} 份（设置 → 数据 里可改）`),
            list.length ? null : h('div', { class: 'empty' }, '还没有备份'),
            ...list.map(b => h('div', { class: 'chat-item' },
                h('div', { class: 'grow' }, h('div', { class: 't1' }, b.file.replace(/\.jsonl$/, '').replace(/_/g, ' · ')), h('div', { class: 't2' }, `${fmtTime(b.mtime)} · ${fmtSize(b.size)}`)),
                h('button', { class: 'btn small', onclick: async () => { const r = await api('/api/backup/restore', { char, file, backup: b.file, mode: 'new' }); toast('已恢复为新聊天'); m.close(); location.hash = `#/chat/${enc(char)}/${enc(r.file)}`; } }, '恢复为新聊天'),
                h('button', { class: 'btn small danger', onclick: async () => { if (!await confirmBox('用这个备份覆盖当前聊天？（覆盖前会先自动备份一份）', '覆盖')) return; await api('/api/backup/restore', { char, file, backup: b.file, mode: 'overwrite' }); toast('已覆盖'); m.close(); } }, '覆盖'))));
    }
    load();
}

async function newChat(file, greetings) {
    let gi = 0;
    if (greetings.length > 1) {
        gi = await new Promise(res => {
            let done = false;
            const m = modal({
                title: '选择开场白',
                body: h('div', { class: 'list-plain' }, greetings.map((g, i) => h('button', {
                    class: 'btn', style: { justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'left', borderRadius: '10px' },
                    onclick: () => { done = true; m.close(); res(i); },
                }, `#${i + 1}  ${String(g).replace(/<[^>]+>/g, '').slice(0, 120) || '（空）'}`))),
                onClose: () => { if (!done) res(-1); },
            });
        });
        if (gi < 0) return;
    }
    const r = await api('/api/chat/new', { char: file, greeting: gi });
    location.hash = `#/chat/${enc(file)}/${enc(r.file)}`;
}

async function importChat(file) {
    const [f] = await pickFile('*/*');
    if (!f) return;
    await api('/api/chat/import' + q({ char: file, name: f.name }), f);
    showChar(file);
}

// ───────────────────────── chat ─────────────────────────

export let els = {};

async function showChat(file, chatFile) {
    const c = await loadChar(file);
    const d = c.data;
    document.title = d.name + ' · Sakura';
    const r = await api('/api/chat' + q({ char: file, file: chatFile, limit: 24 }));
    const msgs = new Map();
    for (const m of r.messages) msgs.set(m.i, m);
    state.chat = { char: file, file: chatFile, msgs, start: r.start, total: r.total, chatVars: r.chatVars, hiddenCount: r.hiddenCount, user: r.user };
    const meta = state.chars.find(x => x.file === file);
    state.char.thumb = meta?.thumb || '/thumbs/' + enc(file);

    const inner = h('div', { class: 'messages-inner' });
    const scroller = h('div', { class: 'messages scroll' }, inner);
    const input = h('textarea', { rows: 1, placeholder: isTouch() ? '写点什么…' : '写点什么… (Enter 发送，Shift+Enter 换行)' });
    const sendBtn = h('button', { class: 'send-btn', title: '发送' }, icon('send'));
    const wandBtn = h('button', { class: 'wand-btn', title: '魔法棒' }, icon('wand'));
    const draftKey = 'lt-draft:' + file + '/' + chatFile;
    try { input.value = localStorage.getItem(draftKey) || ''; } catch { /* */ }
    input.oninput = () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px';
        try { localStorage.setItem(draftKey, input.value); } catch { /* */ }
    };
    input.onkeydown = e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouch()) { e.preventDefault(); send(); }
    };
    const send = () => {
        if (state.generating) return stopGen();
        const t = input.value;
        input.value = '';
        input.oninput();
        try { localStorage.removeItem(draftKey); } catch { /* */ }
        generate('normal', t);
    };
    sendBtn.onclick = send;
    wandBtn.onclick = (e) => { e.stopPropagation(); openWand(wandBtn); };

    const head = h('div', { class: 'chat-head' },
        iconBtn('back', '返回', () => goUp('#/c/' + enc(file))),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, d.name), h('div', { class: 'sub' }, chatFile.replace(/\.jsonl$/, ''))),
        iconBtn('wand', '提示词查看器', () => openPromptViewer()),
        iconBtn('gear', '插头 / 预设', () => openSettings('plug')));
    const selectBar = h('div', { class: 'select-bar hidden' });
    const composer = h('div', { class: 'composer' }, h('div', { class: 'composer-inner' }, wandBtn, input, sendBtn));
    const view = h('div', { class: 'view chat-view' }, head, h('div', { class: 'chat-wrap' }, scroller), selectBar, composer);
    app.replaceChildren(view);
    els = { inner, scroller, input, sendBtn, head, selectBar, composer, view, stick: true };
    setGenerating(state.generating);
    renderAll();
    toBottom();
    requestAnimationFrame(toBottom);

    // header: desktop shows it when the mouse nears the top; touch shows it when scrolling up
    let hideT;
    const showHead = (on) => { clearTimeout(hideT); head.classList.toggle('show', on); };
    view.addEventListener('mousemove', e => {
        if (isTouch()) return;
        if (e.clientY < 56) showHead(true);
        else if (!head.matches(':hover')) { clearTimeout(hideT); hideT = setTimeout(() => showHead(false), 600); }
    });
    let lastTop = scroller.scrollTop;
    scroller.addEventListener('scroll', () => {
        const t = scroller.scrollTop;
        if (isTouch()) {
            if (t < lastTop - 40) showHead(true);
            else if (t > lastTop + 12) showHead(false);
        }
        els.stick = nearBottom();
        if (Math.abs(t - lastTop) > 12) lastTop = t;
        if (t < 200) loadMore();
    }, { passive: true });
    LT.emit('chat_id_changed', chatFile);
}

export function renderAll() {
    const ch = state.chat;
    const frag = document.createDocumentFragment();
    if (ch.start > 0) frag.append(h('div', { class: 'load-more' }, h('button', { class: 'btn small', onclick: loadMore }, `更早的 ${ch.start} 楼…`)));
    const ids = [...ch.msgs.keys()].sort((a, b) => a - b);
    for (const i of ids) frag.append(mesEl(ch.msgs.get(i)));
    els.inner.replaceChildren(frag);
}

let loadingMore = false;
async function loadMore() {
    const ch = state.chat;
    if (!ch || ch.start <= 0 || loadingMore) return;
    loadingMore = true;
    try {
        const r = await api('/api/chat' + q({ char: ch.char, file: ch.file, before: ch.start, limit: 20 }));
        if (state.chat !== ch) return;
        const sc = els.scroller;
        const prevH = sc.scrollHeight;
        for (const m of r.messages) ch.msgs.set(m.i, m);
        ch.start = r.start;
        renderAll();
        sc.scrollTop = sc.scrollHeight - prevH + sc.scrollTop;
    } finally { loadingMore = false; }
}

export function scripts() {
    return [...(state.regex.global || []), ...(state.regex.preset || []), ...(state.regex.card || [])];
}
export function names() {
    const pid = state.settings.personaBinding?.[state.chat?.char] || state.settings.defaultPersona;
    const p = state.settings.personas?.[pid];
    return { user: p?.name || state.chat?.user || 'User', char: state.char?.data?.name || '', avatar: p?.avatar ? '/personas/' + enc(p.avatar) : '' };
}

function statsLine(s) {
    if (!s || state.settings.ui?.showStats === false) return null;
    const parts = [];
    if (s.ttft !== null && s.ttft !== undefined) parts.push(`首字 ${(s.ttft / 1000).toFixed(1)}s`);
    if (s.tps) parts.push(`${s.tps} tok/s`);
    if (s.out) parts.push(`输出 ${s.estimated ? '≈' : ''}${s.out.toLocaleString()} tok`);
    if (s.in) parts.push(`输入 ${s.estimated ? '≈' : ''}${s.in.toLocaleString()} tok`);
    if (s.ms) parts.push(`用时 ${(s.ms / 1000).toFixed(1)}s`);
    return h('div', { class: 'stats' }, parts.join(' · '));
}

function mesEl(m) {
    const ch = state.chat;
    const n = names();
    const sel = state.selecting;
    const el = h('div', { class: 'mes' + (m.user ? ' user' : '') + (m.hidden ? ' hidden-mes' : '') + (sel?.has(m.i) ? ' selected' : ''), 'data-i': m.i });
    if (sel) {
        el.classList.add('selectable');
        el.onclick = () => toggleSelect(m.i);
    }
    const showAv = state.settings.ui?.showAvatars;
    const avatar = m.user ? (m.avatar || n.avatar) : state.char.thumb;
    const actions = h('div', { class: 'mes-actions' },
        iconBtn('edit', '编辑', () => editMes(m.i)),
        !m.user ? iconBtn('branch', '从这里分支', () => branchAt(m.i)) : null,
        iconBtn(m.hidden ? 'eye' : 'eyeoff', m.hidden ? '取消隐藏' : '隐藏（不发送）', () => toggleHide(m.i)),
        iconBtn('copy', '复制', () => { navigator.clipboard?.writeText(m.mes); toast('已复制'); }),
        iconBtn('trash', '删除', () => deleteMes(m.i)));
    const headRow = h('div', { class: 'mes-head' },
        sel ? h('span', { class: 'check' }, sel.has(m.i) ? '✓' : '') : null,
        showAv && avatar ? h('img', { class: 'avatar', src: avatar, loading: 'lazy', alt: '' }) : null,
        h('span', { class: 'who' }, m.user ? n.user : (m.name || n.char)),
        h('span', { class: 'floor' }, `#${m.i}`),
        sel ? null : actions);
    if (isTouch() && !sel) headRow.onclick = (e) => { if (!e.target.closest('.icon-btn')) el.classList.toggle('active'); };
    el.append(headRow);
    if (m.hidden && !sel) {
        el.append(h('div', { class: 'muted', style: { fontSize: '.85em', cursor: 'pointer' }, onclick: () => { el.replaceWith(mesEl({ ...m, hidden: false })); } },
            '（已隐藏 / 已总结，不发送给 AI · 点击查看）'));
        return el;
    }
    if (m.r && state.settings.ui?.showReasoning !== false) {
        el.append(h('details', { class: 'reasoning' }, h('summary', {}, '思考过程'), h('div', { class: 'r-body' }, m.r)));
    }
    const depth = ch.total - 1 - m.i;
    const { el: body, frames } = renderText(m.mes, { isUser: m.user, char: n.char, userName: n.user, scripts: scripts(), depth });
    el.append(body);
    if (frames.length) {
        // only the latest few floors get live frontends; older ones load on demand (keeps the chat fast)
        if (depth < 4) mountFrames(body, frames, m.i);
        else for (const slot of body.querySelectorAll('.th-slot')) {
            slot.append(h('button', { class: 'btn small', onclick: () => mountFrames(body, frames, m.i) }, '显示界面'));
        }
    }
    if (!m.user) {
        const sl = statsLine(m.stats);
        if (sl) el.append(sl);
    }
    if (!m.user && !sel && (m.sc > 1 || m.i === ch.total - 1)) {
        el.append(h('div', { class: 'swipes' },
            iconBtn('left', '上一个回复', () => swipe(m.i, m.sid - 1)),
            h('span', {}, `${m.sid + 1} / ${m.sc}`),
            iconBtn('right', m.sid < m.sc - 1 ? '下一个回复' : '重新生成', () => swipe(m.i, m.sid + 1)),
            m.sc > 1 ? iconBtn('x', '删除这个回复', () => deleteSwipe(m.i)) : null));
    }
    return el;
}

export function updateMes(i) {
    const m = state.chat.msgs.get(i);
    const old = els.inner.querySelector(`.mes[data-i="${i}"]`);
    const el = mesEl(m);
    if (old) old.replaceWith(el); else els.inner.append(el);
    return el;
}

function nearBottom() {
    const s = els.scroller;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 160;
}
export function toBottom() { if (els.scroller) els.scroller.scrollTop = els.scroller.scrollHeight; }

/** Scroll to the top of the floor being read; if already there, to the floor above it. */
export function toPrevFloorTop() {
    const sc = els.scroller;
    const top = sc.getBoundingClientRect().top;
    const list = [...els.inner.querySelectorAll('.mes')];
    let cur = -1;
    for (let k = 0; k < list.length; k++) {
        if (list[k].getBoundingClientRect().top - top <= 8) cur = k; else break;
    }
    if (cur < 0) return;
    let target = list[cur];
    if (target.getBoundingClientRect().top - top > -8 && cur > 0) target = list[cur - 1];
    sc.scrollTop += target.getBoundingClientRect().top - top - 4;
}

async function swipe(i, to) {
    const ch = state.chat;
    const m = ch.msgs.get(i);
    if (to < 0) return;
    if (to >= m.sc) {
        if (i !== ch.total - 1) return;
        return generate('regenerate');
    }
    const r = await api('/api/chat/swipe', { char: ch.char, file: ch.file, index: i, to });
    ch.msgs.set(i, r);
    updateMes(i);
    LT.emit('message_swiped', i);
}

async function deleteSwipe(i) {
    const ch = state.chat;
    const r = await api('/api/chat/delete-swipe', { char: ch.char, file: ch.file, index: i });
    ch.msgs.set(i, r);
    updateMes(i);
}

function editMes(i) {
    const ch = state.chat;
    const m = ch.msgs.get(i);
    const el = els.inner.querySelector(`.mes[data-i="${i}"]`);
    const ta = h('textarea', { class: 'edit-area' });
    ta.value = m.mes;
    const ra = m.r ? h('textarea', { class: 'edit-area', style: { minHeight: '80px' } }) : null;
    if (ra) ra.value = m.r;
    const box = h('div', {},
        ra ? h('div', { class: 'muted', style: { fontSize: '.8em' } }, '思考内容') : null, ra,
        ta,
        h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '6px' } },
            h('button', { class: 'btn', onclick: () => updateMes(i) }, '取消'),
            h('button', {
                class: 'btn primary', onclick: async () => {
                    const r = await api('/api/chat/edit', { char: ch.char, file: ch.file, index: i, text: ta.value, reasoning: ra ? ra.value : undefined });
                    ch.msgs.set(i, { ...m, ...r });
                    updateMes(i);
                    LT.emit('message_edited', i);
                    LT.emit('message_updated', i);
                },
            }, '保存')));
    el.querySelector('.reasoning')?.remove();
    el.querySelector('.swipes')?.remove();
    el.querySelector('.stats')?.remove();
    el.querySelector('.mes-text').replaceWith(box);
    ta.style.height = Math.min(window.innerHeight * 0.6, Math.max(160, ta.scrollHeight + 10)) + 'px';
    ta.focus();
}

async function deleteMes(i) {
    const ch = state.chat;
    const after = ch.total - 1 - i;
    let mode = 'one';
    if (after > 0) {
        mode = await new Promise(res => {
            let done = false;
            const m = modal({
                title: '删除消息',
                body: h('div', {}, `#${i} 后面还有 ${after} 楼。`),
                foot: [
                    h('button', { class: 'btn', onclick: () => { done = true; m.close(); res(null); } }, '取消'),
                    h('button', { class: 'btn', onclick: () => { done = true; m.close(); res('one'); } }, '只删这一楼'),
                    h('button', { class: 'btn danger', onclick: () => { done = true; m.close(); res('end'); } }, '删到最后'),
                ],
                onClose: () => { if (!done) res(null); },
            });
        });
        if (!mode) return;
    } else if (!await confirmBox(`删除 #${i}？`, '删除')) return;
    await api('/api/chat/delete-msg', { char: ch.char, file: ch.file, index: i, toEnd: mode === 'end' });
    await reloadTail();
    LT.emit('message_deleted', i);
}

// ── multi-select delete mode ──
export function startSelect() {
    if (!state.chat) return;
    state.selecting = new Set();
    els.composer.classList.add('hidden');
    els.selectBar.classList.remove('hidden');
    renderSelectBar();
    renderAll();
}
function stopSelect() {
    state.selecting = null;
    els.composer.classList.remove('hidden');
    els.selectBar.classList.add('hidden');
    renderAll();
}
function toggleSelect(i) {
    const s = state.selecting;
    if (s.has(i)) s.delete(i); else s.add(i);
    updateMes(i);
    renderSelectBar();
}
function renderSelectBar() {
    const s = state.selecting;
    const ch = state.chat;
    els.selectBar.replaceChildren(h('div', { class: 'composer-inner' },
        h('span', { class: 'grow' }, `已选 ${s.size} 楼`),
        h('button', {
            class: 'btn small', onclick: () => {
                const from = s.size ? Math.min(...s) : ch.start;
                for (let k = from; k < ch.total; k++) if (ch.msgs.has(k)) s.add(k);
                renderAll(); renderSelectBar();
            },
        }, '选到最后'),
        h('button', { class: 'btn small', onclick: () => { s.clear(); renderAll(); renderSelectBar(); } }, '清空'),
        h('button', { class: 'btn small', onclick: stopSelect }, '取消'),
        h('button', {
            class: 'btn small danger', disabled: !s.size, onclick: async () => {
                if (!await confirmBox(`删除选中的 ${s.size} 楼？（删除前会自动备份）`, '删除')) return;
                await api('/api/chat/delete-many', { char: ch.char, file: ch.file, indices: [...s] });
                state.selecting = null;
                els.composer.classList.remove('hidden');
                els.selectBar.classList.add('hidden');
                await reloadTail(true);
                toast('已删除');
            },
        }, '删除')));
}

async function toggleHide(i) {
    const ch = state.chat;
    const m = ch.msgs.get(i);
    const r = await api('/api/chat/hide', { char: ch.char, file: ch.file, index: i, hidden: !m.hidden });
    ch.msgs.set(i, { ...m, ...r });
    updateMes(i);
}

async function branchAt(i) {
    const ch = state.chat;
    const r = await api('/api/chat/branch', { char: ch.char, file: ch.file, index: i });
    toast('已创建分支');
    location.hash = `#/chat/${enc(ch.char)}/${enc(r.file)}`;
}

/** Re-fetch the last part of the chat (after delete/abort/error). */
export async function reloadTail(keepScroll = false) {
    const ch = state.chat;
    if (!ch) return;
    const r = await api('/api/chat' + q({ char: ch.char, file: ch.file, limit: Math.max(24, ch.total - ch.start) }));
    ch.msgs = new Map(r.messages.map(m => [m.i, m]));
    ch.start = r.start;
    ch.total = r.total;
    ch.chatVars = r.chatVars;
    const st = els.scroller.scrollTop;
    renderAll();
    if (keepScroll) els.scroller.scrollTop = st; else toBottom();
}

// ───────────────────────── generation ─────────────────────────

function setGenerating(on) {
    state.generating = on;
    document.querySelector('.fab')?.classList.toggle('busy', on);
    if (!els.sendBtn) return;
    els.sendBtn.classList.toggle('stop', on);
    els.sendBtn.replaceChildren(icon(on ? 'stop' : 'send'));
    els.sendBtn.title = on ? '停止' : '发送';
}

export function stopGen() {
    state.abort?.abort();
}

export async function generate(type = 'normal', text = '') {
    const ch = state.chat;
    if (!ch || state.generating) return;
    setGenerating(true);
    const ac = new AbortController();
    state.abort = ac;
    const t0 = performance.now();
    let target = null, buf = '', rbuf = '', pending = false, lastPaint = 0, ttft = null;
    const liveStats = () => {
        const sec = (performance.now() - t0) / 1000;
        const parts = [];
        if (ttft === null) return `等待首字… ${sec.toFixed(1)}s`;
        parts.push(`首字 ${(ttft / 1000).toFixed(1)}s`);
        const out = Math.round((buf.length + rbuf.length) / 1.6);
        if (ttft !== null && sec > ttft / 1000) parts.push(`≈${(out / (sec - ttft / 1000)).toFixed(1)} tok/s`);
        parts.push(`≈${out.toLocaleString()} tok`, `${sec.toFixed(1)}s`);
        return parts.join(' · ');
    };
    const paint = (final = false) => {
        pending = false;
        if (!target || state.chat !== ch) return;
        const stick = nearBottom();
        const el = els.inner.querySelector(`.mes[data-i="${target.i}"]`);
        if (!el) return;
        const n = names();
        if (rbuf && state.settings.ui?.showReasoning !== false) {
            let det = el.querySelector('.reasoning');
            if (!det) { det = h('details', { class: 'reasoning', open: !buf }, h('summary', {}, '思考过程'), h('div', { class: 'r-body' })); el.querySelector('.mes-head').after(det); }
            det.querySelector('.r-body').textContent = rbuf;
            if (buf && det.open && !det._closed) { det.open = false; det._closed = true; }
        }
        const { el: body } = renderText(target.prefix + buf, { isUser: false, char: n.char, userName: n.user, scripts: scripts(), depth: 0, noFrames: !final });
        body.classList.add('typing');
        const old = el.querySelector('.mes-text');
        if (old) old.replaceWith(body); else el.append(body);
        let st = el.querySelector('.stats');
        if (!st) { st = h('div', { class: 'stats' }); body.after(st); }
        st.textContent = liveStats();
        lastPaint = performance.now();
        if (stick) toBottom();
    };
    const schedule = () => {
        if (pending) return;
        pending = true;
        const wait = Math.max(0, 90 - (performance.now() - lastPaint));
        setTimeout(() => paint(), wait);
    };
    const ticker = setInterval(() => {
        const el = target && els.inner?.querySelector(`.mes[data-i="${target.i}"]`);
        if (!el || state.settings.ui?.showStats === false) return;
        let st = el.querySelector('.stats');
        if (!st) { st = h('div', { class: 'stats' }); (el.querySelector('.mes-text') || el.lastChild).after(st); }
        st.textContent = liveStats();
    }, 500);
    LT.emit('generation_started', type);
    try {
        const res = await fetch('/api/gen', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ char: ch.char, file: ch.file, type, text }), signal: ac.signal,
        });
        if (!res.ok) throw new Error(await res.text());
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let sse = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            sse += dec.decode(value, { stream: true });
            let idx;
            while ((idx = sse.indexOf('\n\n')) >= 0) {
                const line = sse.slice(0, idx).replace(/^data: ?/, '');
                sse = sse.slice(idx + 2);
                if (!line) continue;
                const ev = JSON.parse(line);
                if (state.chat !== ch) continue;
                switch (ev.t) {
                    case 'user':
                        ch.msgs.set(ev.index, ev.message);
                        ch.total = ev.index + 1;
                        if (ch.msgs.has(ev.index - 1)) updateMes(ev.index - 1);
                        updateMes(ev.index);
                        toBottom();
                        LT.emit('message_sent', ev.index);
                        break;
                    case 'start': {
                        const prev = ch.msgs.get(ev.index);
                        if (ev.type === 'normal') {
                            target = { i: ev.index, name: state.char.data.name, user: false, mes: '', sid: 0, sc: 1, r: '', prefix: '' };
                            ch.total = ev.index + 1;
                            if (ch.msgs.has(ev.index - 1)) updateMes(ev.index - 1);
                        } else if (ev.type === 'continue') {
                            target = { ...prev, prefix: prev.mes, stats: null };
                        } else {
                            target = { ...prev, mes: '', r: '', sid: ev.swipe, sc: ev.swipes, prefix: '', stats: null };
                        }
                        ch.msgs.set(ev.index, target);
                        updateMes(ev.index);
                        if (ev.type !== 'continue') els.inner.querySelector(`.mes[data-i="${ev.index}"] .mes-text`)?.classList.add('typing');
                        toBottom();
                        break;
                    }
                    case 'ttft': ttft = ev.ms; break;
                    case 'd': buf += ev.d; schedule(); break;
                    case 'r': rbuf += ev.d; schedule(); break;
                    case 'warn': toast(ev.text, true); break;
                    case 'empty': toast('AI 返回了空内容' + (ev.finish ? '（' + ev.finish + '）' : ''), true); await reloadTail(true); break;
                    case 'err': toast('生成失败：' + ev.e, true); await reloadTail(true); break;
                    case 'done':
                        ch.msgs.set(ev.index, ev.message);
                        if (ev.finish) toast('结束原因：' + ev.finish, true);
                        updateMes(ev.index);
                        if (nearBottom()) toBottom();
                        LT.emit('message_received', ev.index);
                        LT.emit('character_message_rendered', ev.index);
                        LT.emit('message_updated', ev.index);
                        break;
                }
            }
        }
    } catch (e) {
        if (ac.signal.aborted) {
            toast('已停止');
            setTimeout(() => reloadTail(true), 400);
        } else {
            toast('生成失败：' + e.message, true);
            await reloadTail(true).catch(() => { });
        }
    } finally {
        clearInterval(ticker);
        setGenerating(false);
        state.abort = null;
        LT.emit('generation_ended', ch.total - 1);
    }
}

// ───────────────────────── bridge for iframes (TavernHelper-compatible shim) ─────────────────────────

const bus = new Map();
const scriptButtons = new Map();
window.LT = {
    lastMessageId: () => (state.chat ? state.chat.total - 1 : 0),
    getMessage: (i) => state.chat?.msgs.get(i) || null,
    getMsgVars(i) {
        const ch = state.chat;
        if (!ch) return {};
        for (let k = i; k >= ch.start; k--) {
            const m = ch.msgs.get(k);
            if (m?.vars && Object.keys(m.vars).length) return m.vars;
        }
        return {};
    },
    setMsgVars(i, v) {
        const ch = state.chat;
        if (!ch) return;
        const m = ch.msgs.get(i);
        if (m) m.vars = v;
        api('/api/chat/vars', { char: ch.char, file: ch.file, index: i, vars: v }, { silent: true });
    },
    chatVars: () => state.chat?.chatVars || {},
    setChatVars(v) { const ch = state.chat; if (!ch) return; ch.chatVars = v; api('/api/chat/vars', { char: ch.char, file: ch.file, type: 'chat', vars: v }, { silent: true }); },
    globalVars: () => state.settings.globalVars || {},
    setGlobalVars(v) { state.settings.globalVars = v; api('/api/settings', { globalVars: v }, { silent: true }); },
    scriptVars(id) { try { return JSON.parse(localStorage.getItem('lt-sv:' + id) || '{}'); } catch { return {}; } },
    setScriptVars(id, v) { try { localStorage.setItem('lt-sv:' + id, JSON.stringify(v)); } catch { /* */ } },
    async editMessage(i, text) {
        const ch = state.chat;
        const r = await api('/api/chat/edit', { char: ch.char, file: ch.file, index: i, text });
        ch.msgs.set(i, { ...ch.msgs.get(i), ...r });
        updateMes(i);
    },
    async addMessage(isUser, text, name) {
        const ch = state.chat;
        if (!ch) return;
        const r = await api('/api/chat/add', { char: ch.char, file: ch.file, user: isUser, text, name });
        ch.msgs.set(r.i, r);
        ch.total = r.i + 1;
        updateMes(r.i);
        toBottom();
    },
    async deleteMessage(i) {
        const ch = state.chat;
        await api('/api/chat/delete-msg', { char: ch.char, file: ch.file, index: i });
        await reloadTail(true);
    },
    generate: (type) => generate(type || 'normal'),
    stop: stopGen,
    setInput(t) { if (els.input) { els.input.value = t; els.input.oninput(); els.input.focus(); } },
    toast: (m, e) => toast(String(m), e),
    macro: (t) => makeMacro({ user: names().user, char: names().char })(t),
    charData: () => ({ name: state.char?.data?.name, avatar: state.char?.file, description: state.char?.data?.description, world: state.char?.data?.extensions?.world, data: state.char?.data }),
    charAvatar: () => state.char ? '/chars/' + enc(state.char.file) : '',
    userAvatar: () => names().avatar,
    getWorld: (name) => api('/api/world' + q({ name }), undefined, { silent: true }),
    saveWorld: (name, data) => api('/api/world/save', { name, data }),
    worldNames: () => state.boot?.worlds || [],
    globalWorlds: () => state.settings.globalWorlds || [],
    reloadChat: () => reloadTail(true),
    // card frontends grow after load; keep the view pinned to the bottom if the reader was there
    frameResized: () => { if (els.stick && els.scroller) toBottom(); },
    runSlash: (cmd) => runSlash(cmd),
    setScriptButtons(id, list) { scriptButtons.set(id, list); },
    getScriptButtons: (id) => scriptButtons.get(id),
    stContext() {
        const ch = state.chat;
        const arr = [];
        if (ch) for (let i = 0; i < ch.total; i++) { const m = ch.msgs.get(i); arr.push(m ? { name: m.name, is_user: m.user, is_system: m.hidden, mes: m.mes, swipe_id: m.sid, variables: m.vars ? [m.vars] : [] } : { mes: '', is_user: false }); }
        return {
            chat: arr, name1: names().user, name2: names().char, characterId: state.char?.file, chatId: ch?.file,
            characters: state.char ? [{ name: state.char.data.name, avatar: state.char.file, data: state.char.data }] : [],
            this_chid: 0, groupId: null, getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            saveChat: async () => { }, reloadCurrentChat: async () => reloadTail(true),
            // Sakura renders EJS prompt templates natively, so report the template engine as present and on
            extensionSettings: { EjsTemplate: { enabled: true } },
            variables: { local: { get: (k) => (ch?.chatVars || {})[k] }, global: { get: (k) => (state.settings.globalVars || {})[k] } },
        };
    },
    parseMvu: async (text, old) => old,
    on(n, fn) { if (!bus.has(n)) bus.set(n, new Set()); bus.get(n).add(fn); },
    off(n, fn) { bus.get(n)?.delete(fn); },
    emit(n, ...a) { for (const fn of [...(bus.get(n) || [])]) { try { fn(...a); } catch (e) { console.warn('[LT event]', n, e); } } },
};

// card frontends look for the host app on window.top
window.SillyTavern = { getContext: () => window.LT.stContext() };

boot();
