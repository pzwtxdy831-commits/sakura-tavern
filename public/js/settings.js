// Settings (tabbed), worlds, personas, character editor, theme application.
import { h, icon, iconBtn, toast, modal, confirmBox, promptBox, pickFile, api, q, switchEl } from './ui.js';
import { state, saveSettings, reloadSettings, importAny } from './app.js';
import { plugEditor, PP, presetData, invalidatePreset, summarySettings, novelSettings } from './panel.js';
import { startScripts, restartScript } from './scripts.js';

const FONT_STACKS = {
    '': { name: '宋体·衬线（默认）', body: '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif' },
    hei: { name: '黑体', body: '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", "Noto Sans CJK SC", "Source Han Sans SC", "SimHei", sans-serif' },
    simhei: { name: '黑体（SimHei 经典）', body: '"SimHei", "Heiti SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif' },
    kai: { name: '楷体', body: '"KaiTi", "STKaiti", "Kaiti SC", serif' },
    system: { name: '系统默认', body: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
};

export function applyTheme() {
    const ui = state.settings.ui || {};
    const root = document.documentElement;
    root.style.setProperty('--fs', (ui.fontSize || 16) + 'px');
    root.style.setProperty('--chat-w', (ui.chatWidth || 880) + 'px');
    let css = '';
    const f = ui.font || '';
    if (f.startsWith('file:')) {
        const file = f.slice(5);
        css = `@font-face{font-family:"SakuraUserFont";src:url("/fonts/${encodeURIComponent(file)}");font-display:swap}
:root{--font-body:"SakuraUserFont",${FONT_STACKS[''].body};--font-title:"SakuraUserFont",${FONT_STACKS[''].body}}`;
    } else if (FONT_STACKS[f] && f) {
        css = `:root{--font-body:${FONT_STACKS[f].body};--font-title:${FONT_STACKS[f].body}}`;
    }
    document.getElementById('user-font').textContent = css;
}

// ───────────────────────── settings ─────────────────────────

const TABS = [
    ['plug', '插头'], ['preset', '预设'], ['look', '外观'], ['memory', '记忆总结'], ['plugins', '插件'],
    ['scripts', '脚本与导入'], ['data', '数据'], ['phone', '手机'],
];
const SRC_NAME = { vertex: 'Vertex AI', openai: 'OpenAI 兼容', aistudio: 'AI Studio' };

export function openSettings(start = 'plug') {
    let tab = start;
    const nav = h('div', { class: 'settings-nav' });
    const pane = h('div', { class: 'settings-pane' });
    const m = modal({ title: '设置', wide: true, body: h('div', { class: 'settings' }, nav, pane), onClose: () => applyTheme() });
    m.el.classList.add('settings-modal');
    const go = (k) => { tab = k; draw(); };
    async function draw() {
        nav.replaceChildren(...TABS.map(([k, n]) => h('button', { class: tab === k ? 'on' : '', onclick: () => go(k) }, n)));
        pane.replaceChildren(h('div', { class: 'muted' }, '读取中…'));
        const fn = { plug: tabPlug, preset: tabPreset, look: tabLook, memory: tabMemory, plugins: tabPlugins, scripts: tabScripts, data: tabData, phone: tabPhone }[tab];
        pane.replaceChildren(...[].concat(await fn(draw)).filter(Boolean));
    }
    draw();
}

const hint = (t) => h('div', { class: 'muted small' }, t);
const group = (title, ...kids) => h('div', { class: 'set-group' }, h('div', { class: 'set-title' }, title), ...kids);

// 插头：真正的管理（新增/编辑/删除/测试），并选哪些放进魔法棒
async function tabPlug(redraw) {
    const s = state.settings;
    const inWand = new Set(s.wand?.profiles || []);
    const toggleWand = async (id, on) => {
        const list = on ? [...new Set([...(s.wand?.profiles || []), id])] : (s.wand?.profiles || []).filter(x => x !== id);
        await saveSettings({ wand: { ...(s.wand || {}), profiles: list } });
    };
    return [
        hint('每个插头只对应一个地址和模型，和预设、角色卡互不绑定。打星的插头会出现在魔法棒里（一个都不打星就全部显示）。'),
        ...['vertex', 'openai', 'aistudio'].map(src => group(SRC_NAME[src],
            ...s.profiles.filter(p => p.source === src).map(p => h('div', { class: 'plug' + (p.id === s.activeProfile ? ' on' : '') },
                h('button', { class: 'star' + (inWand.has(p.id) ? ' on' : ''), title: '放进魔法棒', onclick: async (e) => { e.stopPropagation(); await toggleWand(p.id, !inWand.has(p.id)); redraw(); } }, inWand.has(p.id) ? '★' : '☆'),
                h('div', { class: 'grow', onclick: async () => { await api('/api/profile/select', { id: p.id }); s.activeProfile = p.id; toast('已切换到 ' + p.name); redraw(); } },
                    h('div', { class: 'pname' }, p.name + (p.id === s.activeProfile ? '  · 正在用' : '')),
                    h('div', { class: 'purl' }, [p.model, p.source === 'vertex' ? (p.region || 'global') : p.url, PP[p.postProcessing || 'none']].filter(Boolean).join(' · '))),
                iconBtn('edit', '编辑', () => plugEditor(p, async () => { await reloadSettings(); redraw(); })))),
            h('button', { class: 'btn small', onclick: () => plugEditor({ source: src }, async () => { await reloadSettings(); redraw(); }) }, icon('plus'), '新增 ' + SRC_NAME[src]))),
    ];
}

// 预设：切换/导入/删除，勾选要放进魔法棒的开关，生成参数
async function tabPreset(redraw) {
    const s = state.settings;
    const sel = h('select', { class: 'grow' }, state.boot.presets.map(n => h('option', { value: n }, n)));
    sel.value = s.activePreset;
    sel.onchange = async () => { await saveSettings({ activePreset: sel.value }); invalidatePreset(); redraw(); };
    const p = await presetData(true).catch(() => null);
    const po = p?.prompt_order || [];
    const order = (po.find(x => String(x.character_id) === '100001') || po.find(x => String(x.character_id) === '100000') || po[0] || { order: [] }).order;
    const pinned = new Set(s.wand?.toggles?.[s.activePreset] || []);
    const pin = async (id, on) => {
        const cur = new Set(s.wand?.toggles?.[s.activePreset] || []);
        if (on) cur.add(id); else cur.delete(id);
        await saveSettings({ wand: { ...(s.wand || {}), toggles: { ...(s.wand?.toggles || {}), [s.activePreset]: [...cur] } } });
    };
    return [
        group('当前预设', h('div', { class: 'row wrap' }, sel,
            h('button', {
                class: 'btn small', onclick: async () => {
                    const files = await pickFile('*/*', true);
                    for (const f of files) { const r = await api('/api/preset/import' + q({ name: f.name }), f); state.boot.presets = r.presets; toast('已导入：' + r.name); }
                    redraw();
                },
            }, icon('upload'), '导入'),
            h('button', { class: 'btn small danger', onclick: async () => { if (!await confirmBox(`删除预设「${s.activePreset}」？`)) return; const r = await api('/api/preset/delete', { name: s.activePreset }); state.boot.presets = r.presets; await saveSettings({ activePreset: r.presets[0] || '' }); invalidatePreset(); redraw(); } }, '删除'))),
        group('开关（☆ = 放进魔法棒，方便聊天时快速开关）',
            ...order.map(it => {
                const d = p.prompts.find(x => x.identifier === it.identifier) || {};
                if (d.marker || ['chatHistory', 'worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario', 'personaDescription', 'dialogueExamples'].includes(it.identifier)) return null;
                return h('div', { class: 'entry' + (it.enabled ? '' : ' off') },
                    h('button', { class: 'star' + (pinned.has(it.identifier) ? ' on' : ''), onclick: async () => { await pin(it.identifier, !pinned.has(it.identifier)); redraw(); } }, pinned.has(it.identifier) ? '★' : '☆'),
                    switchEl(it.enabled, async v => { it.enabled = v; await api('/api/preset/toggle', { name: s.activePreset, identifier: it.identifier, enabled: v }); invalidatePreset(); }),
                    h('div', { class: 'ename' }, d.name || it.identifier));
            })),
        hint('条目内容、顺序、生成参数在悬浮窗的「预设」页里编辑。'),
    ];
}

// 外观：字体、字号滑块、宽度、显示项
async function tabLook() {
    const s = state.settings;
    const ui = s.ui;
    const save = (patch) => { Object.assign(ui, patch); applyTheme(); return saveSettings({ ui }); };
    const font = h('select', { class: 'grow' });
    const fillFonts = () => {
        font.replaceChildren(...Object.entries(FONT_STACKS).map(([k, v]) => h('option', { value: k }, v.name)),
            ...(state.boot.fonts || []).map(f => h('option', { value: 'file:' + f }, '导入：' + f)));
        font.value = ui.font || '';
    };
    fillFonts();
    font.onchange = () => save({ font: font.value });
    const slider = (key, min, max, step, unit, def) => {
        const out = h('span', { class: 'slider-val' }, `${ui[key] || def}${unit}`);
        const r = h('input', { type: 'range', min, max, step, value: ui[key] || def });
        r.oninput = () => { out.textContent = r.value + unit; ui[key] = Number(r.value); applyTheme(); };
        r.onchange = () => save({ [key]: Number(r.value) });
        return h('div', { class: 'row' }, r, out);
    };
    const flag = (key, label, def = true) => h('div', { class: 'row' }, switchEl(ui[key] ?? def, v => save({ [key]: v })), h('span', {}, label));
    return [
        group('字体', h('div', { class: 'row' }, font, h('button', {
            class: 'btn small', onclick: async () => {
                const [f] = await pickFile('*/*');
                if (!f) return;
                if (!/\.(ttf|otf|woff2?|ttc)$/i.test(f.name)) return toast('请选择 ttf / otf / woff / woff2 字体文件', true);
                toast('上传中…');
                const r = await api('/api/font/upload' + q({ name: f.name }), f);
                state.boot.fonts = r.fonts;
                fillFonts();
                font.value = 'file:' + r.file;
                await save({ font: font.value });
                toast('字体已导入并启用（电脑和手机共用）');
            },
        }, icon('upload'), '导入字体')),
        hint('导入的字体存在电脑上，手机打开时会从电脑下载；中文字体通常 10MB 以上，第一次显示会慢一点。')),
        group('字号', slider('fontSize', 12, 26, 1, 'px', 16)),
        group('聊天宽度（电脑）', slider('chatWidth', 560, 1600, 20, 'px', 880)),
        group('显示', flag('showReasoning', '显示思考过程'), flag('showStats', '显示生成统计（首字时间 / 速度 / token / 用时）'), flag('showAvatars', '显示头像', false), flag('fab', '显示悬浮窗')),
    ];
}

async function tabMemory(redraw) {
    const s = state.settings;
    const c = s.plugins.summary || {};
    return [
        group('记忆总结', h('div', { class: 'row' }, switchEl(!!c.enabled, async v => { await saveSettings({ plugins: { ...s.plugins, summary: { ...c, enabled: v } } }); }), h('span', {}, '开启')),
            hint('最近的楼层原样发送；更早的每攒够一批，就用你指定的小模型写成摘要，原文隐藏不发送，摘要作为「前情提要」放在聊天记录最前面。'),
            h('div', { class: 'row' }, h('span', { class: 'grow' }, `${c.model || '（未设置模型）'} · ${c.url || ''}`), h('button', { class: 'btn small', onclick: () => summarySettings() }, '设置通道和批次'))),
    ];
}

async function tabPlugins() {
    const s = state.settings;
    return [
        group('MVU 变量', h('div', { class: 'row' }, switchEl(s.plugins.mvu?.enabled !== false, v => saveSettings({ plugins: { ...s.plugins, mvu: { enabled: v } } })), h('span', {}, '解析 AI 输出里的变量更新（UpdateVariable / JSONPatch / _.set）'))),
        group('小说尾部样张', hint('预设里内容含 [SAKURA_TAIL_NOVEL_8000_MARKER] 的条目会被替换成下一段小说（按聊天轮换）。开关在预设里。'),
            h('button', { class: 'btn small', onclick: () => novelSettings() }, '选小说文件 / 每段字数')),
    ];
}

async function tabScripts(redraw) {
    const s = state.settings;
    const saveScripts = async (list) => { await saveSettings({ scripts: list }); startScripts(); };
    return [
        group('导入', h('div', { class: 'row wrap' }, h('button', { class: 'btn primary', onclick: async () => { await importAny(); redraw(); } }, icon('upload'), '导入 JSON / PNG')),
            hint('自动识别：角色卡、预设、世界书、正则、快速回复（QR 集）、酒馆助手脚本。')),
        group('酒馆助手脚本',
            ...(s.scripts || []).map(sc => h('div', { class: 'entry' + (sc.enabled ? '' : ' off') },
                switchEl(sc.enabled, async v => { await saveScripts(s.scripts.map(x => x.id === sc.id ? { ...x, enabled: v } : x)); }),
                h('div', { class: 'ename', title: sc.info || '' }, sc.name),
                iconBtn('redo', '重新载入', () => restartScript(sc.id)),
                iconBtn('trash', '删除', async () => { if (!await confirmBox(`删除脚本「${sc.name}」？`)) return; await saveScripts(s.scripts.filter(x => x.id !== sc.id)); redraw(); }))),
            (s.scripts || []).length ? hint('脚本在后台隐藏框架里运行，按钮出现在魔法棒的「脚本」一栏。拦截旧酒馆接口的脚本（比如改请求的）在这里不起作用。') : hint('（还没有）')),
        group('快速回复集',
            ...(s.qrSets || []).map(set => h('div', { class: 'entry' + (set.enabled ? '' : ' off') },
                switchEl(set.enabled, async v => { await saveSettings({ qrSets: s.qrSets.map(x => x.id === set.id ? { ...x, enabled: v } : x) }); }),
                h('div', { class: 'ename' }, `${set.name}（${set.qrList.length} 个按钮）`),
                iconBtn('trash', '删除', async () => { await saveSettings({ qrSets: s.qrSets.filter(x => x.id !== set.id) }); redraw(); }))),
            (s.qrSets || []).length ? null : hint('（还没有）')),
        group('我的快捷回复', hint('在悬浮窗「快捷」页里新增和编辑（右键按钮编辑）。共 ' + (s.qr || []).length + ' 个。')),
    ];
}

async function tabData(redraw) {
    const s = state.settings;
    const b = s.backup || { enabled: true, every: 3, keep: 30 };
    const every = h('input', { type: 'number', min: 1, value: b.every ?? 3 });
    const keep = h('input', { type: 'number', min: 1, value: b.keep ?? 30 });
    return [
        group('聊天自动备份',
            h('div', { class: 'row' }, switchEl(b.enabled !== false, v => saveSettings({ backup: { ...b, enabled: v } })), h('span', {}, '开启')),
            h('div', { class: 'kv' }, h('label', { class: 'field' }, h('span', {}, '每几楼备份一次'), every), h('label', { class: 'field' }, h('span', {}, '每个聊天保留几份'), keep)),
            h('button', { class: 'btn small', onclick: async () => { await saveSettings({ backup: { ...b, every: Number(every.value), keep: Number(keep.value) } }); toast('已保存'); } }, '保存'),
            hint('在角色页长按（电脑右键）某个聊天记录，就能看到它的备份并恢复。')),
        group('从旧酒馆导入',
            h('div', { class: 'row wrap' },
                h('button', { class: 'btn', onclick: async () => { if (!await confirmBox('从旧酒馆（8288）再导入一次？已存在的文件不会被覆盖，只补新的。', '导入', false)) return; const r = await api('/api/import-st', { overwrite: false, settingsToo: false }); toast('导入完成：' + JSON.stringify(r)); } }, '补导入'),
                h('button', { class: 'btn danger', onclick: async () => { if (!await confirmBox('用旧酒馆的角色卡、聊天、世界书、预设覆盖这里的同名文件？', '覆盖导入')) return; const r = await api('/api/import-st', { overwrite: true, settingsToo: false }); toast('导入完成：' + JSON.stringify(r)); } }, '覆盖导入'))),
    ];
}

async function tabPhone() {
    const lan = (state.boot.lan || []).map(ip => `http://${ip}:${state.boot.ports.mobile}`);
    return [
        group('手机访问', hint('手机连同一个 Wi-Fi 后打开下面任一地址；装了 Sakura APK 的话直接点图标进入（全屏、没有地址栏）。'),
            ...lan.map(u => h('div', {}, h('code', {}, u)))),
    ];
}

// ───────────────────────── worlds ─────────────────────────

export async function openWorlds() {
    const box = h('div', { class: 'list-plain' });
    const m = modal({
        title: '世界书', wide: true, body: box,
        foot: [
            h('button', { class: 'btn', onclick: async () => { const n = await promptBox('新世界书名字'); if (!n) return; await api('/api/world/save', { name: n, data: { entries: {} } }); await render(); } }, '新建'),
            h('button', {
                class: 'btn primary', onclick: async () => {
                    const files = await pickFile('*/*', true);
                    for (const f of files) { const r = await api('/api/world/import' + q({ name: f.name }), f); toast('已导入：' + r.name); }
                    await render();
                },
            }, icon('upload'), '导入'),
        ],
    });
    async function render() {
        await reloadSettings();
        const s = state.settings;
        const worlds = state.boot.worlds;
        box.replaceChildren(
            h('div', { class: 'muted', style: { fontSize: '.85em' } }, '角色卡自带的世界书会自动生效，不用管。打开「全局」的世界书会对所有角色生效（一般不需要）。'),
            ...worlds.map(w => h('div', { class: 'entry' },
                switchEl(s.globalWorlds.includes(w), async v => {
                    const g = v ? [...new Set([...s.globalWorlds, w])] : s.globalWorlds.filter(x => x !== w);
                    await saveSettings({ globalWorlds: g });
                }),
                h('span', { class: 'emeta' }, '全局'),
                h('div', { class: 'ename', style: { cursor: 'pointer' }, onclick: () => openWorldEditor(w) }, w),
                iconBtn('edit', '编辑', () => openWorldEditor(w)),
                iconBtn('trash', '删除', async () => { if (!await confirmBox(`删除世界书「${w}」？`)) return; await api('/api/world/delete', { name: w }); render(); }))));
    }
    render();
}

const POS = { 0: '角色前', 1: '角色后', 2: '作者注释前', 3: '作者注释后', 4: '按深度插入', 5: '示例前', 6: '示例后', 7: 'Outlet' };
const LOGIC = { 0: '任一次要词', 1: '非全部次要词', 2: '无次要词', 3: '全部次要词' };

export async function openWorldEditor(name) {
    const data = await api('/api/world' + q({ name }));
    const entries = data.entries || {};
    const search = h('input', { type: 'search', placeholder: '搜索条目…' });
    const list = h('div', { class: 'list-plain' });
    let dirty = false;
    const render = () => {
        const kw = search.value.trim().toLowerCase();
        const arr = Object.values(entries).sort((a, b) => (a.displayIndex ?? a.uid) - (b.displayIndex ?? b.uid))
            .filter(e => !kw || (e.comment || '').toLowerCase().includes(kw) || (e.key || []).join(',').toLowerCase().includes(kw) || (e.content || '').toLowerCase().includes(kw));
        list.replaceChildren(...arr.slice(0, 400).map(e => h('div', { class: 'wi-entry entry' + (e.disable ? ' off' : '') },
            switchEl(!e.disable, v => { e.disable = !v; dirty = true; }),
            h('div', { class: 'ename', style: { cursor: 'pointer' }, onclick: () => entryEdit(e) }, (e.constant ? '🔵 ' : '🟢 ') + (e.comment || '(无标题)')),
            h('div', { class: 'emeta' }, `${POS[e.position] || ''}${e.position === 4 ? ' d' + e.depth : ''} · ${e.order ?? 100}`))),
        arr.length > 400 ? h('div', { class: 'muted' }, `还有 ${arr.length - 400} 条，用搜索缩小范围`) : null);
    };
    search.oninput = render;
    const entryEdit = (e) => {
        const comment = h('input', { type: 'text', value: e.comment || '' });
        const keys = h('input', { type: 'text', value: (e.key || []).join(', ') });
        const keys2 = h('input', { type: 'text', value: (e.keysecondary || []).join(', ') });
        const logic = h('select', {}, Object.entries(LOGIC).map(([k, v]) => h('option', { value: k }, v)));
        logic.value = String(e.selectiveLogic ?? 0);
        const pos = h('select', {}, Object.entries(POS).map(([k, v]) => h('option', { value: k }, v)));
        pos.value = String(e.position ?? 0);
        const depth = h('input', { type: 'number', value: e.depth ?? 4 });
        const role = h('select', {}, ['system', 'user', 'assistant'].map((r, i) => h('option', { value: i }, r)));
        role.value = String(e.role ?? 0);
        const order = h('input', { type: 'number', value: e.order ?? 100 });
        const prob = h('input', { type: 'number', value: e.probability ?? 100 });
        const constant = h('input', { type: 'checkbox' }); constant.checked = !!e.constant;
        const content = h('textarea', { rows: 14, style: { fontFamily: 'Consolas, monospace', fontSize: '.85em' } });
        content.value = e.content || '';
        const mm = modal({
            title: '条目', wide: true,
            body: h('div', { class: 'list-plain' },
                h('label', { class: 'field' }, h('span', {}, '标题 / 备注'), comment),
                h('div', { class: 'kv' },
                    h('label', { class: 'field' }, h('span', {}, '关键词（逗号分隔）'), keys),
                    h('label', { class: 'field' }, h('span', {}, '次要关键词'), keys2),
                    h('label', { class: 'field' }, h('span', {}, '次要词逻辑'), logic),
                    h('label', { class: 'field' }, h('span', {}, '位置'), pos),
                    h('label', { class: 'field' }, h('span', {}, '深度'), depth),
                    h('label', { class: 'field' }, h('span', {}, '角色'), role),
                    h('label', { class: 'field' }, h('span', {}, '顺序'), order),
                    h('label', { class: 'field' }, h('span', {}, '触发概率 %'), prob)),
                h('label', { class: 'row' }, constant, '常驻（不需要关键词）'),
                content),
            foot: [
                h('button', { class: 'btn danger', onclick: async () => { if (!await confirmBox('删除这个条目？')) return; delete entries[e.uid]; dirty = true; mm.close(); render(); } }, '删除'),
                h('button', {
                    class: 'btn primary', onclick: () => {
                        const split = s => s.split(/[,，]/).map(x => x.trim()).filter(Boolean);
                        Object.assign(e, {
                            comment: comment.value, key: split(keys.value), keysecondary: split(keys2.value), selective: split(keys2.value).length > 0,
                            selectiveLogic: Number(logic.value), position: Number(pos.value), depth: Number(depth.value), role: Number(role.value),
                            order: Number(order.value), probability: Number(prob.value), useProbability: Number(prob.value) < 100, constant: constant.checked, content: content.value,
                        });
                        dirty = true;
                        mm.close();
                        render();
                    },
                }, '确定'),
            ],
        });
    };
    const m = modal({
        title: '世界书 · ' + name, wide: true,
        body: h('div', { class: 'list-plain' }, search, list),
        foot: [
            h('button', {
                class: 'btn', onclick: () => {
                    const uid = Math.max(-1, ...Object.keys(entries).map(Number)) + 1;
                    entries[uid] = { uid, key: [], keysecondary: [], comment: '新条目', content: '', constant: false, selective: false, order: 100, position: 0, disable: false, depth: 4, role: 0, probability: 100, useProbability: false, displayIndex: uid };
                    dirty = true;
                    render();
                    entryEdit(entries[uid]);
                },
            }, '新增条目'),
            h('button', { class: 'btn primary', onclick: async () => { await api('/api/world/save', { name, data: { ...data, entries } }); dirty = false; toast('已保存'); m.close(); } }, '保存'),
        ],
        onClose: () => { if (dirty) toast('世界书有未保存的改动（已丢弃）', true); },
    });
    render();
}

// ───────────────────────── personas ─────────────────────────

export function openPersonas() {
    const box = h('div', { class: 'list-plain' });
    const m = modal({ title: '我的人设', body: box, foot: [h('button', { class: 'btn primary', onclick: () => edit(null) }, icon('plus'), '新增人设')] });
    function render() {
        const s = state.settings;
        box.replaceChildren(
            h('div', { class: 'muted', style: { fontSize: '.85em' } }, '人设在角色页里绑定到具体角色卡；没绑定的角色用「默认」。'),
            ...Object.entries(s.personas || {}).map(([id, p]) => h('div', { class: 'chat-item', onclick: () => edit(id) },
                p.avatar ? h('img', { src: '/personas/' + encodeURIComponent(p.avatar), style: { width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover' } }) : h('div', { class: 'disc' }),
                h('div', { class: 'grow' }, h('div', { class: 't1' }, p.name + (s.defaultPersona === id ? '  · 默认' : '')), h('div', { class: 't2' }, (p.description || '').slice(0, 80))))));
    }
    function edit(id) {
        const s = state.settings;
        const p = id ? { ...s.personas[id] } : { name: '', description: '', position: 0, depth: 2, role: 0 };
        const name = h('input', { type: 'text', value: p.name });
        const desc = h('textarea', { rows: 12 });
        desc.value = p.description || '';
        const pos = h('select', {}, h('option', { value: '0' }, '放在预设的「用户设定」位置'), h('option', { value: '4' }, '按深度插入聊天'));
        pos.value = String(p.position === 4 ? 4 : 0);
        const depth = h('input', { type: 'number', value: p.depth ?? 2 });
        const isDef = h('input', { type: 'checkbox' }); isDef.checked = s.defaultPersona === id;
        let pid = id;
        const mm = modal({
            title: id ? '编辑人设' : '新增人设',
            body: h('div', { class: 'list-plain' },
                h('label', { class: 'field' }, h('span', {}, '名字（{{user}}）'), name),
                h('label', { class: 'field' }, h('span', {}, '描述'), desc),
                h('div', { class: 'kv' }, h('label', { class: 'field' }, h('span', {}, '位置'), pos), h('label', { class: 'field' }, h('span', {}, '深度'), depth)),
                h('label', { class: 'row' }, isDef, '设为默认人设'),
                h('button', {
                    class: 'btn', onclick: async () => {
                        const [f] = await pickFile('image/*');
                        if (!f) return;
                        if (!pid) { const r = await api('/api/persona/save', { persona: { name: name.value || '我', description: desc.value } }); pid = r.id; }
                        await api('/api/persona/avatar' + q({ id: pid }), f);
                        await reloadSettings();
                        toast('头像已更新');
                    },
                }, '上传头像')),
            foot: [
                id ? h('button', { class: 'btn danger', onclick: async () => { if (!await confirmBox('删除这个人设？')) return; await api('/api/persona/delete', { id }); await reloadSettings(); mm.close(); render(); } }, '删除') : null,
                h('button', {
                    class: 'btn primary', onclick: async () => {
                        const r = await api('/api/persona/save', { id: pid, persona: { name: name.value || '我', description: desc.value, position: Number(pos.value), depth: Number(depth.value), role: p.role ?? 0 } });
                        if (isDef.checked) await saveSettings({ defaultPersona: r.id });
                        await reloadSettings();
                        mm.close();
                        render();
                    },
                }, '保存'),
            ],
        });
    }
    render();
}

// ───────────────────────── character editor ─────────────────────────

export async function openCharEditor(file, onSaved) {
    const c = await api('/api/char' + q({ file }));
    const d = c.data;
    const f = (k, rows = 4, label = k) => {
        const t = h('textarea', { rows });
        t.value = d[k] || '';
        t.dataset.k = k;
        return h('label', { class: 'field' }, h('span', {}, label), t);
    };
    const name = h('input', { type: 'text', value: d.name });
    const tags = h('input', { type: 'text', value: (d.tags || []).join(', ') });
    const world = h('select', {}, h('option', { value: '' }, '（无）'), state.boot.worlds.map(w => h('option', { value: w }, w)));
    world.value = d.extensions?.world || '';
    const greets = h('div', { class: 'list-plain' });
    const alts = [...(d.alternate_greetings || [])];
    const renderGreets = () => greets.replaceChildren(...alts.map((g, i) => {
        const t = h('textarea', { rows: 4 });
        t.value = g;
        t.oninput = () => { alts[i] = t.value; };
        return h('div', {}, h('div', { class: 'row' }, h('span', { class: 'muted grow' }, `备选开场白 #${i + 2}`), iconBtn('trash', '删除', () => { alts.splice(i, 1); renderGreets(); })), t);
    }), h('button', { class: 'btn small', onclick: () => { alts.push(''); renderGreets(); } }, '+ 备选开场白'));
    renderGreets();
    const fields = [f('description', 8, '角色描述'), f('personality', 3, '性格'), f('scenario', 3, '场景'), f('first_mes', 6, '开场白'), greets, f('mes_example', 4, '对话示例'), f('creator_notes', 4, '作者备注（主页简介）'), f('system_prompt', 3, '角色系统提示（覆盖预设 main）'), f('post_history_instructions', 3, '历史后指令（覆盖 jailbreak）')];
    const m = modal({
        title: '编辑角色 · ' + d.name, wide: true,
        body: h('div', { class: 'list-plain' },
            h('div', { class: 'kv' }, h('label', { class: 'field' }, h('span', {}, '名字'), name), h('label', { class: 'field' }, h('span', {}, '标签'), tags), h('label', { class: 'field' }, h('span', {}, '绑定世界书'), world)),
            h('button', {
                class: 'btn small', onclick: async () => {
                    const [img] = await pickFile('image/png,image/jpeg,image/webp');
                    if (!img) return;
                    const png = await toPng(img);
                    await api('/api/char/avatar' + q({ file }), png);
                    toast('头像已更新');
                },
            }, '更换头像'),
            fields),
        foot: [h('button', {
            class: 'btn primary', onclick: async () => {
                const data = { name: name.value, tags: tags.value.split(/[,，]/).map(x => x.trim()).filter(Boolean), world: world.value, alternate_greetings: alts };
                for (const t of m.el.querySelectorAll('textarea[data-k]')) data[t.dataset.k] = t.value;
                await api('/api/char/save', { file, data });
                m.close();
                toast('已保存');
                onSaved?.();
            },
        }, '保存')],
    });
}

async function toPng(blob) {
    if (blob.type === 'image/png') return blob;
    const bmp = await createImageBitmap(blob);
    const cv = document.createElement('canvas');
    cv.width = bmp.width; cv.height = bmp.height;
    cv.getContext('2d').drawImage(bmp, 0, 0);
    return new Promise(r => cv.toBlob(r, 'image/png'));
}
