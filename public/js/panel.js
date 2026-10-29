// Floating panel: 预设 / 插头 / 快捷 / 正则, plus the prompt viewer.
import { h, icon, iconBtn, toast, modal, confirmBox, promptBox, pickFile, api, q, switchEl } from './ui.js';
import { state, saveSettings, generate, stopGen, reloadTail, reloadSettings } from './app.js';

const SRC_ORDER = ['vertex', 'openai', 'aistudio'];
const SRC_NAME = { vertex: 'Vertex AI', openai: 'OpenAI 兼容', aistudio: 'AI Studio' };
export const PP = {
    none: '不处理',
    merge: '合并同角色 · 不含工具 (merge)',
    merge_tools: '合并同角色 · 含工具 (merge_tools)',
    semi: '半严格 · 不含工具 (semi)',
    semi_tools: '半严格 · 含工具 (semi_tools)',
    strict: '严格 · 不含工具 (strict)',
    strict_tools: '严格 · 含工具 (strict_tools)',
    single: '单条 user (single)',
};
const MARKER_NAMES = { worldInfoBefore: '世界书（角色前）', worldInfoAfter: '世界书（角色后）', charDescription: '角色描述', charPersonality: '角色性格', scenario: '场景', personaDescription: '用户设定', dialogueExamples: '对话示例', chatHistory: '聊天记录' };
const NOVEL_MARKER = '[SAKURA_TAIL_NOVEL_8000_MARKER]';

let fab, panel, body, tab = localStorage.getItem('lt-panel-tab') || 'preset';
let presetCache = { name: '', data: null };

export function initPanel() {
    fab = h('button', { class: 'fab', title: '悬浮窗：预设 / 插头 / 快捷' });
    panel = h('div', { class: 'panel hidden' });
    document.body.append(fab, panel);
    // draggable fab
    let drag = null;
    fab.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, moved: false, r: fab.getBoundingClientRect() }; fab.setPointerCapture(e.pointerId); });
    fab.addEventListener('pointermove', e => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
        if (!drag.moved) return;
        fab.style.right = Math.max(4, window.innerWidth - drag.r.right - dx) + 'px';
        fab.style.bottom = Math.max(4, window.innerHeight - drag.r.bottom - dy) + 'px';
    });
    fab.addEventListener('pointerup', () => {
        if (drag && !drag.moved) toggle();
        else if (drag) try { localStorage.setItem('lt-fab', JSON.stringify({ r: fab.style.right, b: fab.style.bottom })); } catch { /* */ }
        drag = null;
    });
    try { const p = JSON.parse(localStorage.getItem('lt-fab')); if (p) { fab.style.right = p.r; fab.style.bottom = p.b; } } catch { /* */ }
    document.addEventListener('pointerdown', e => {
        if (!panel.classList.contains('hidden') && !panel.contains(e.target) && e.target !== fab && !e.target.closest('.modal-back')) panel.classList.add('hidden');
    });
}

function toggle() {
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) renderPanel();
}

export function refreshPanel() {
    if (panel && !panel.classList.contains('hidden')) renderPanel();
}

function renderPanel() {
    const tabs = [['preset', '预设'], ['plug', '插头'], ['quick', '快捷'], ['regex', '正则']];
    body = h('div', { class: 'panel-body' });
    panel.replaceChildren(
        h('div', { class: 'panel-tabs' }, tabs.map(([k, n]) => h('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; localStorage.setItem('lt-panel-tab', k); renderPanel(); } }, n))),
        body);
    ({ preset: presetTab, plug: plugTab, quick: quickTab, regex: regexTab })[tab]();
}

// ───────────────────────── 预设 ─────────────────────────

export function setFabVisible(on) {
    fab?.classList.toggle('hidden', !on);
    if (!on) panel?.classList.add('hidden');
}
export const presetData = (force) => getPreset(force);
export function invalidatePreset() { presetCache = {}; }

async function getPreset(force = false) {
    const name = state.settings.activePreset;
    if (!force && presetCache.name === name && presetCache.data) return presetCache.data;
    presetCache = { name, data: await api('/api/preset' + q({ name })) };
    return presetCache.data;
}
function orderOf(p) {
    const po = p?.prompt_order || [];
    return (po.find(x => String(x.character_id) === '100001') || po.find(x => String(x.character_id) === '100000') || po[0] || { order: [] }).order;
}

async function presetTab() {
    const sel = h('select', { class: 'grow' });
    for (const n of state.boot.presets) sel.append(h('option', { value: n }, n));
    sel.value = state.settings.activePreset;
    sel.onchange = async () => {
        await saveSettings({ activePreset: sel.value });
        presetCache = {};
        await refreshRegex();
        presetTab();
        toast('已切换预设');
    };
    const list = h('div', {}, h('div', { class: 'muted' }, '读取中…'));
    body.replaceChildren(
        h('div', { class: 'row' }, sel,
            iconBtn('upload', '导入预设', importPreset),
            iconBtn('gear', '生成参数', paramsEditor),
            iconBtn('plus', '新增条目', () => entryEditor(null))),
        h('div', { style: { height: '8px' } }),
        list);
    const p = await getPreset();
    if (!p) { list.replaceChildren(h('div', { class: 'empty' }, '预设不存在')); return; }
    const defs = new Map((p.prompts || []).map(x => [x.identifier, x]));
    list.replaceChildren(...orderOf(p).map(it => {
        const d = defs.get(it.identifier) || {};
        const marker = !!MARKER_NAMES[it.identifier] || d.marker;
        const meta = marker ? '' : (Number(d.injection_position) === 1 ? `${d.role || 'system'} @d${d.injection_depth ?? 4}·${d.injection_order ?? 100}` : (d.role || 'system'));
        const row = h('div', { class: 'entry' + (it.enabled ? '' : ' off') + (marker ? ' marker' : '') },
            switchEl(it.enabled, async v => {
                it.enabled = v;
                row.classList.toggle('off', !v);
                await api('/api/preset/toggle', { name: state.settings.activePreset, identifier: it.identifier, enabled: v });
            }),
            h('div', { class: 'ename', title: d.name || it.identifier, style: { cursor: marker ? 'default' : 'pointer' }, onclick: () => !marker && entryEditor(it.identifier) }, d.name || MARKER_NAMES[it.identifier] || it.identifier),
            h('div', { class: 'emeta' }, meta));
        return row;
    }));
}

async function importPreset() {
    const files = await pickFile('.json', true);
    for (const f of files) {
        const r = await api('/api/preset/import' + q({ name: f.name }), f);
        state.boot.presets = r.presets;
        toast('已导入预设：' + r.name);
    }
    if (files.length) presetTab();
}

async function paramsEditor() {
    const p = await getPreset();
    const fields = [
        ['temperature', '温度', 'number', 0.05], ['top_p', 'Top P', 'number', 0.01], ['top_k', 'Top K', 'number', 1],
        ['openai_max_tokens', '最大回复 tokens', 'number', 1], ['openai_max_context', '上下文上限', 'number', 1],
        ['frequency_penalty', '频率惩罚', 'number', 0.05], ['presence_penalty', '存在惩罚', 'number', 0.05], ['seed', '种子 (-1 随机)', 'number', 1],
    ];
    const inputs = {};
    const effort = h('select', {}, ['auto', 'min', 'low', 'medium', 'high', 'max'].map(v => h('option', { value: v }, v)));
    effort.value = p.reasoning_effort || 'auto';
    const checks = { stream_openai: ['流式输出', p.stream_openai !== false], show_thoughts: ['请求思考内容', !!p.show_thoughts], use_sysprompt: ['开头 system 作为系统指令 (Gemini)', !!p.use_sysprompt] };
    const checkEls = {};
    const m = modal({
        title: '生成参数（存在预设里）',
        body: h('div', {},
            h('div', { class: 'kv' }, fields.map(([k, n, t, step]) => {
                const i = h('input', { type: t, step });
                i.value = p[k] ?? '';
                inputs[k] = i;
                return h('label', { class: 'field' }, h('span', {}, n), i);
            }), h('label', { class: 'field' }, h('span', {}, '思考强度'), effort)),
            h('div', { class: 'list-plain', style: { marginTop: '12px' } }, Object.entries(checks).map(([k, [n, v]]) => {
                const sw = switchEl(v, x => { checkEls[k] = x; });
                checkEls[k] = v;
                return h('div', { class: 'row' }, sw, h('span', {}, n));
            }))),
        foot: [h('button', {
            class: 'btn primary', onclick: async () => {
                const params = { reasoning_effort: effort.value, ...checkEls };
                for (const [k, i] of Object.entries(inputs)) if (i.value !== '') params[k] = Number(i.value);
                await api('/api/preset/params', { name: state.settings.activePreset, params });
                presetCache = {};
                m.close();
                toast('已保存');
            },
        }, '保存')],
    });
}

async function entryEditor(identifier) {
    const p = await getPreset(true);
    const d = (p.prompts || []).find(x => x.identifier === identifier) || { identifier: '', name: '新条目', role: 'system', content: '', injection_position: 0, injection_depth: 4, injection_order: 100 };
    const name = h('input', { type: 'text', value: d.name || '' });
    const role = h('select', {}, ['system', 'user', 'assistant'].map(r => h('option', { value: r }, r)));
    role.value = d.role || 'system';
    const pos = h('select', {}, h('option', { value: '0' }, '相对位置（按顺序）'), h('option', { value: '1' }, '插入聊天（按深度）'));
    pos.value = String(Number(d.injection_position) || 0);
    const depth = h('input', { type: 'number', value: d.injection_depth ?? 4 });
    const order = h('input', { type: 'number', value: d.injection_order ?? 100 });
    const content = h('textarea', { rows: 16, style: { fontFamily: 'Consolas, monospace', fontSize: '.85em' } });
    content.value = d.content || '';
    const move = async (dir) => {
        const ord = orderOf(p);
        const i = ord.findIndex(x => x.identifier === identifier);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= ord.length) return;
        [ord[i], ord[j]] = [ord[j], ord[i]];
        await api('/api/preset/reorder', { name: state.settings.activePreset, order: ord.map(x => x.identifier) });
        presetCache = {};
        toast(dir < 0 ? '已上移' : '已下移');
    };
    const m = modal({
        title: identifier ? '编辑条目' : '新增条目', wide: true,
        body: h('div', { class: 'list-plain' },
            h('div', { class: 'kv' },
                h('label', { class: 'field' }, h('span', {}, '名称'), name),
                h('label', { class: 'field' }, h('span', {}, '角色'), role),
                h('label', { class: 'field' }, h('span', {}, '位置'), pos),
                h('label', { class: 'field' }, h('span', {}, '深度'), depth),
                h('label', { class: 'field' }, h('span', {}, '顺序 (越大越靠后)'), order)),
            content),
        foot: [
            identifier ? h('button', { class: 'btn', onclick: () => move(-1) }, '上移') : null,
            identifier ? h('button', { class: 'btn', onclick: () => move(1) }, '下移') : null,
            h('button', {
                class: 'btn primary', onclick: async () => {
                    await api('/api/preset/entry', {
                        name: state.settings.activePreset,
                        entry: { identifier: d.identifier || crypto.randomUUID(), name: name.value, role: role.value, content: content.value, injection_position: Number(pos.value), injection_depth: Number(depth.value), injection_order: Number(order.value) },
                    });
                    presetCache = {};
                    m.close();
                    presetTab();
                    toast('已保存');
                },
            }, '保存'),
        ],
    });
}

// ───────────────────────── 插头 ─────────────────────────

function plugTab() {
    const s = state.settings;
    const groups = SRC_ORDER.map(src => {
        const list = s.profiles.filter(p => p.source === src);
        return h('div', { class: 'src-group' },
            h('div', { class: 'row' }, h('h4', { class: 'grow' }, SRC_NAME[src]), iconBtn('plus', '新增', () => plugEditor({ source: src }))),
            list.length ? list.map(p => h('div', { class: 'plug' + (p.id === s.activeProfile ? ' on' : ''), onclick: async () => { await api('/api/profile/select', { id: p.id }); s.activeProfile = p.id; plugTab(); toast('已切换到 ' + p.name); } },
                h('div', { class: 'grow' },
                    h('div', { class: 'pname' }, p.name),
                    h('div', { class: 'purl' }, [p.model, p.source === 'vertex' ? (p.region || 'global') : p.url].filter(Boolean).join(' · '))),
                iconBtn('edit', '编辑', (e) => { e.stopPropagation(); plugEditor(p); })))
                : h('div', { class: 'muted', style: { fontSize: '.85em' } }, '（无）'));
    });
    body.replaceChildren(h('div', { class: 'muted', style: { fontSize: '.8em', marginBottom: '8px' } }, '插头和预设、角色卡互不绑定，点一下就切换。'), ...groups);
}

export function plugEditor(p0, onSaved) {
    const after = () => { if (onSaved) onSaved(); else if (body && !panel.classList.contains('hidden') && tab === 'plug') plugTab(); };
    const p = { postProcessing: 'none', region: 'global', vertexAuth: 'full', ...structuredClone(p0) };
    const name = h('input', { type: 'text', value: p.name || '' });
    const src = h('select', {}, SRC_ORDER.map(s => h('option', { value: s }, SRC_NAME[s])));
    src.value = p.source || 'openai';
    const url = h('input', { type: 'text', value: p.url || '', placeholder: 'http://127.0.0.1:8318/v1' });
    const model = h('input', { type: 'text', value: p.model || '', list: 'lt-models' });
    const dl = h('datalist', { id: 'lt-models' });
    const region = h('input', { type: 'text', value: p.region || 'global' });
    const project = h('input', { type: 'text', value: p.projectId || '', placeholder: '留空 = 用服务账号里的 project_id' });
    const pp = h('select', {}, Object.entries(PP).map(([k, v]) => h('option', { value: k }, v)));
    pp.value = p.postProcessing || 'none';
    const secretSel = h('select', {});
    const keyTypes = { openai: ['api_key_custom'], vertex: ['vertexai_service_account_json', 'api_key_vertexai'], aistudio: ['api_key_makersuite'] };
    const fillSecrets = () => {
        secretSel.replaceChildren(h('option', { value: '' }, '（无 / 不需要）'));
        for (const s of state.boot.secrets.filter(x => keyTypes[src.value].includes(x.key))) secretSel.append(h('option', { value: s.id }, `${s.label || ''}  ${s.mask}`));
        secretSel.value = p.secretId || '';
    };
    fillSecrets();
    const newKey = h('textarea', { rows: 2, placeholder: '粘贴新密钥（Vertex 可以直接粘贴服务账号 JSON）' });
    const include = h('textarea', { rows: 2, placeholder: '附加请求体 (YAML/JSON，可空)' });
    include.value = p.includeBody || '';
    const urlRow = h('label', { class: 'field' }, h('span', {}, '地址 URL'), url);
    const vRows = h('div', { class: 'kv' }, h('label', { class: 'field' }, h('span', {}, '区域'), region), h('label', { class: 'field' }, h('span', {}, '项目 ID'), project));
    const sync = () => {
        urlRow.classList.toggle('hidden', src.value === 'vertex');
        vRows.classList.toggle('hidden', src.value !== 'vertex');
        include.classList.toggle('hidden', src.value !== 'openai');
        fillSecrets();
    };
    src.onchange = sync;
    const collect = () => ({
        ...p, name: name.value.trim(), source: src.value, url: url.value.trim(), model: model.value.trim(), region: region.value.trim() || 'global',
        projectId: project.value.trim(), postProcessing: pp.value, secretId: secretSel.value, newKey: newKey.value.trim() || undefined, includeBody: include.value,
    });
    const m = modal({
        title: p.id ? '编辑插头' : '新增插头',
        body: h('div', { class: 'list-plain' },
            h('div', { class: 'kv' }, h('label', { class: 'field' }, h('span', {}, '名字'), name), h('label', { class: 'field' }, h('span', {}, '来源'), src)),
            urlRow, vRows,
            h('label', { class: 'field' }, h('span', {}, '模型'), h('div', { class: 'row' }, model, dl, h('button', {
                class: 'btn small', onclick: async () => {
                    try {
                        const saved = await api('/api/profile/save', { profile: collect() });
                        p.id = saved.profile.id; p.secretId = saved.profile.secretId; newKey.value = '';
                        state.boot.secrets = saved.secrets; fillSecrets();
                        await reloadProfiles();
                        const list = await api('/api/models' + q({ id: p.id }));
                        dl.replaceChildren(...list.map(x => h('option', { value: x })));
                        toast(`拿到 ${list.length} 个模型`);
                    } catch { /* toast */ }
                },
            }, '获取'))),
            h('label', { class: 'field' }, h('span', {}, '密钥'), secretSel), newKey,
            h('label', { class: 'field' }, h('span', {}, '提示词后处理'), pp),
            include),
        foot: [
            p.id ? h('button', { class: 'btn danger', onclick: async () => { if (!await confirmBox('删除这个插头？')) return; await api('/api/profile/delete', { id: p.id }); await reloadProfiles(); m.close(); after(); } }, '删除') : null,
            h('button', {
                class: 'btn', onclick: async () => {
                    const saved = await api('/api/profile/save', { profile: collect() });
                    p.id = saved.profile.id; p.secretId = saved.profile.secretId; newKey.value = '';
                    state.boot.secrets = saved.secrets; fillSecrets();
                    await reloadProfiles();
                    toast('测试中…');
                    try { const r = await api('/api/profile/test', { id: p.id }); toast(`连接正常 ${r.ms}ms：${r.text.slice(0, 30)}`); } catch { /* toast */ }
                },
            }, '测试'),
            h('button', {
                class: 'btn primary', onclick: async () => {
                    const saved = await api('/api/profile/save', { profile: collect() });
                    state.boot.secrets = saved.secrets;
                    await reloadProfiles();
                    m.close();
                    after();
                    toast('已保存');
                },
            }, '保存'),
        ],
    });
    sync();
}

async function reloadProfiles() {
    await reloadSettings();
}

// ───────────────────────── 快捷 ─────────────────────────

async function quickTab() {
    const s = state.settings;
    const inChat = !!state.chat;
    const p = await getPreset().catch(() => null);
    const novelEntry = p && (p.prompts || []).find(x => (x.content || '').includes(NOVEL_MARKER));
    const novelOn = novelEntry && orderOf(p).find(x => x.identifier === novelEntry.identifier)?.enabled;
    const qrBtns = (s.qr || []).map((x, i) => h('button', {
        class: 'btn', title: x.message,
        onclick: () => runQr(x),
        oncontextmenu: (e) => { e.preventDefault(); qrEditor(i); },
    }, x.label));
    body.replaceChildren(
        h('div', { class: 'qr-grid' },
            h('button', { class: 'btn', disabled: !inChat, onclick: () => generate('continue') }, '继续写'),
            h('button', { class: 'btn', disabled: !inChat, onclick: () => generate('regenerate') }, '重新生成'),
            h('button', { class: 'btn', disabled: !inChat, onclick: () => generate('normal') }, '让 AI 接着说'),
            h('button', { class: 'btn danger', disabled: !state.generating, onclick: stopGen }, '停止'),
            h('button', { class: 'btn', disabled: !inChat, onclick: openPromptViewer }, '提示词查看器'),
            h('button', { class: 'btn', disabled: !inChat, onclick: authorNote }, '作者注释')),
        h('h4', { class: 'muted', style: { margin: '14px 0 6px', fontSize: '.8em', letterSpacing: '.2em' } }, '插件'),
        h('div', { class: 'list-plain' },
            h('div', { class: 'row' }, switchEl(!!novelOn, async v => {
                if (!novelEntry) return toast('当前预设里没有「尾部小说」条目（内容含 ' + NOVEL_MARKER + '）', true);
                await api('/api/preset/toggle', { name: s.activePreset, identifier: novelEntry.identifier, enabled: v });
                presetCache = {};
                toast(v ? '小说尾部样张：开' : '小说尾部样张：关');
            }), h('span', { class: 'grow' }, '小说尾部 8000token 样张'), iconBtn('gear', '设置', novelSettings)),
            h('div', { class: 'row' }, switchEl(!!s.plugins.summary?.enabled, async v => {
                await saveSettings({ plugins: { ...s.plugins, summary: { ...s.plugins.summary, enabled: v } } });
                toast(v ? '记忆总结：开' : '记忆总结：关');
            }), h('span', { class: 'grow' }, '记忆总结（旧楼层自动总结并隐藏）'), iconBtn('gear', '设置', summarySettings)),
            h('div', { class: 'row' }, switchEl(s.plugins.mvu?.enabled !== false, async v => {
                await saveSettings({ plugins: { ...s.plugins, mvu: { enabled: v } } });
                toast(v ? 'MVU 变量：开' : 'MVU 变量：关');
            }), h('span', { class: 'grow' }, 'MVU 变量更新'), inChat ? iconBtn('eye', '查看变量', showVars) : null),
            h('div', { class: 'row' }, switchEl(s.ui?.showReasoning !== false, async v => {
                await saveSettings({ ui: { ...s.ui, showReasoning: v } });
                if (state.chat) reloadTail(true);
            }), h('span', { class: 'grow' }, '显示思考过程'))),
        h('div', { class: 'row', style: { margin: '14px 0 6px' } }, h('h4', { class: 'muted grow', style: { margin: 0, fontSize: '.8em', letterSpacing: '.2em' } }, '我的快捷回复（右键编辑）'), iconBtn('plus', '新增', () => qrEditor(-1))),
        qrBtns.length ? h('div', { class: 'qr-grid' }, qrBtns) : h('div', { class: 'muted', style: { fontSize: '.85em' } }, '（还没有）'));
}

function runQr(x) {
    if (!state.chat) return toast('先打开一个聊天', true);
    if (x.mode === 'input') window.LT.setInput(x.message);
    else generate('normal', x.message);
}

function qrEditor(i) {
    const s = state.settings;
    const x = i >= 0 ? { ...s.qr[i] } : { label: '', message: '', mode: 'send' };
    const label = h('input', { type: 'text', value: x.label });
    const msg = h('textarea', { rows: 5 });
    msg.value = x.message;
    const mode = h('select', {}, h('option', { value: 'send' }, '直接发送'), h('option', { value: 'input' }, '填进输入框'));
    mode.value = x.mode || 'send';
    const m = modal({
        title: '快捷回复',
        body: h('div', { class: 'list-plain' }, h('label', { class: 'field' }, h('span', {}, '按钮文字'), label), h('label', { class: 'field' }, h('span', {}, '内容'), msg), h('label', { class: 'field' }, h('span', {}, '点击后'), mode)),
        foot: [
            i >= 0 ? h('button', { class: 'btn danger', onclick: async () => { const qr = s.qr.filter((_, k) => k !== i); await saveSettings({ qr }); m.close(); quickTab(); } }, '删除') : null,
            h('button', {
                class: 'btn primary', onclick: async () => {
                    const qr = [...(s.qr || [])];
                    const v = { label: label.value || '快捷', message: msg.value, mode: mode.value };
                    if (i >= 0) qr[i] = v; else qr.push(v);
                    await saveSettings({ qr });
                    m.close();
                    quickTab();
                },
            }, '保存'),
        ],
    });
}

export async function authorNote() {
    const ch = state.chat;
    const r = await api('/api/chat' + q({ char: ch.char, file: ch.file, limit: 1 }));
    const ta = h('textarea', { rows: 6 });
    ta.value = r.note.prompt;
    const depth = h('input', { type: 'number', value: r.note.depth });
    const role = h('select', {}, ['system', 'user', 'assistant'].map((x, i) => h('option', { value: i }, x)));
    role.value = r.note.role;
    const m = modal({
        title: '作者注释（只对这个聊天生效）',
        body: h('div', { class: 'list-plain' }, ta, h('div', { class: 'kv' }, h('label', { class: 'field' }, h('span', {}, '深度'), depth), h('label', { class: 'field' }, h('span', {}, '角色'), role))),
        foot: [h('button', { class: 'btn primary', onclick: async () => { await api('/api/chat/meta', { char: ch.char, file: ch.file, note: { prompt: ta.value, depth: depth.value, role: role.value } }); m.close(); toast('已保存'); } }, '保存')],
    });
}

export function novelSettings() {
    const s = state.settings;
    const t = s.plugins.tailNovel || {};
    const sel = h('select', {}, (state.boot.novels || []).map(n => h('option', { value: n }, n)));
    sel.value = t.file || (state.boot.novels || [])[0] || '';
    const size = h('input', { type: 'number', value: t.size || 13000 });
    const m = modal({
        title: '小说尾部样张',
        body: h('div', { class: 'list-plain' },
            h('div', { class: 'muted', style: { fontSize: '.85em' } }, '预设里内容含 ' + NOVEL_MARKER + ' 的条目会被替换成下一段小说（每轮轮换，按聊天记进度）。'),
            h('label', { class: 'field' }, h('span', {}, '小说文件'), h('div', { class: 'row' }, sel, h('button', {
                class: 'btn small', onclick: async () => {
                    const [f] = await pickFile('.txt');
                    if (!f) return;
                    const r = await api('/api/novel/upload' + q({ name: f.name }), f);
                    state.boot.novels = r.novels;
                    sel.append(h('option', { value: r.file }, r.file));
                    sel.value = r.file;
                },
            }, '上传 txt'))),
            h('label', { class: 'field' }, h('span', {}, '每段字数（约 13000 字 ≈ 8000 token）'), size)),
        foot: [h('button', { class: 'btn primary', onclick: async () => { await saveSettings({ plugins: { ...s.plugins, tailNovel: { ...t, file: sel.value, size: Number(size.value) } } }); m.close(); toast('已保存'); } }, '保存')],
    });
}

export function summarySettings() {
    const s = state.settings;
    const c = s.plugins.summary || {};
    const url = h('input', { type: 'text', value: c.url || '' });
    const model = h('input', { type: 'text', value: c.model || '' });
    const key = h('select', {}, h('option', { value: '' }, '（无）'), state.boot.secrets.filter(x => x.key === 'api_key_custom').map(x => h('option', { value: x.id }, `${x.label} ${x.mask}`)));
    key.value = c.secretId || '';
    const keep = h('input', { type: 'number', value: c.keepRecent ?? 10 });
    const batch = h('input', { type: 'number', value: c.batch ?? 10 });
    const th = h('input', { type: 'number', value: c.resummaryThreshold ?? 8 });
    const m = modal({
        title: '记忆总结',
        body: h('div', { class: 'list-plain' },
            h('div', { class: 'muted', style: { fontSize: '.85em' } }, '最近的楼层原样发送；更早的每攒够一批就用下面的小模型总结，原文隐藏（不发送），总结作为「前情提要」放在聊天记录最前面。旧酒馆里已有的总结会直接沿用。'),
            h('div', { class: 'kv' },
                h('label', { class: 'field' }, h('span', {}, 'OpenAI 兼容地址'), url),
                h('label', { class: 'field' }, h('span', {}, '模型'), model),
                h('label', { class: 'field' }, h('span', {}, '密钥'), key),
                h('label', { class: 'field' }, h('span', {}, '保留最近楼层'), keep),
                h('label', { class: 'field' }, h('span', {}, '每批楼层'), batch),
                h('label', { class: 'field' }, h('span', {}, '超过多少条总结再压缩'), th))),
        foot: [h('button', {
            class: 'btn primary', onclick: async () => {
                await saveSettings({ plugins: { ...s.plugins, summary: { ...c, url: url.value, model: model.value, secretId: key.value, keepRecent: Number(keep.value), batch: Number(batch.value), resummaryThreshold: Number(th.value) } } });
                m.close();
                toast('已保存');
            },
        }, '保存')],
    });
}

async function showVars() {
    const ch = state.chat;
    const r = await api('/api/chat/vars' + q({ char: ch.char, file: ch.file, index: 'latest' }));
    const ta = h('textarea', { rows: 22, style: { fontFamily: 'Consolas, monospace', fontSize: '.8em' } });
    ta.value = JSON.stringify(r.vars?.stat_data ?? r.vars ?? {}, null, 2);
    const m = modal({
        title: `MVU 变量（#${r.index} 的 stat_data）`, wide: true, body: ta,
        foot: [h('button', {
            class: 'btn primary', onclick: async () => {
                let v;
                try { v = JSON.parse(ta.value); } catch (e) { return toast('JSON 格式不对：' + e.message, true); }
                const vars = { ...(r.vars || {}), stat_data: v };
                await api('/api/chat/vars', { char: ch.char, file: ch.file, index: r.index, vars });
                m.close();
                toast('变量已保存');
            },
        }, '保存')],
    });
}

// ───────────────────────── 正则 ─────────────────────────

export async function refreshRegex() {
    state.regex = await api('/api/regex' + q(state.char ? { char: state.char.file } : {}));
}

async function regexTab() {
    await refreshRegex();
    const sec = (title, list, save, kind) => h('div', { class: 'src-group' },
        h('div', { class: 'row' }, h('h4', { class: 'grow' }, `${title}（${list.length}）`), iconBtn('plus', '新增', () => regexEditor(null, list, save))),
        list.map((r, i) => h('div', { class: 'entry' + (r.disabled ? ' off' : '') },
            switchEl(!r.disabled, async v => { r.disabled = !v; await save(list); }),
            h('div', { class: 'ename', style: { cursor: 'pointer' }, onclick: () => regexEditor(i, list, save) }, r.scriptName || '(未命名)'),
            h('div', { class: 'emeta' }, [r.markdownOnly ? '显示' : '', r.promptOnly ? '发送' : '', !r.markdownOnly && !r.promptOnly ? '改原文' : ''].filter(Boolean).join('+')))));
    body.replaceChildren(
        sec('全局正则', state.regex.global, async l => { await saveSettings({ regex: l }); }),
        sec('预设正则 · ' + state.settings.activePreset, state.regex.preset, async l => { await api('/api/preset/regex', { name: state.settings.activePreset, regex: l }); presetCache = {}; }),
        state.char ? sec('角色卡正则 · ' + state.char.data.name, state.regex.card, async l => { await api('/api/char/save', { file: state.char.file, data: { regex_scripts: l } }); }) : null);
}

function regexEditor(i, list, save) {
    const r = i === null ? { id: crypto.randomUUID(), scriptName: '', findRegex: '', replaceString: '', trimStrings: [], placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null } : { ...list[i] };
    const name = h('input', { type: 'text', value: r.scriptName || '' });
    const find = h('textarea', { rows: 3, style: { fontFamily: 'Consolas, monospace' } });
    find.value = r.findRegex || '';
    const rep = h('textarea', { rows: 6, style: { fontFamily: 'Consolas, monospace' } });
    rep.value = r.replaceString || '';
    const pl = { 1: '用户输入', 2: 'AI 输出', 5: '世界书', 6: '思考' };
    const plChecks = Object.entries(pl).map(([k, n]) => { const c = h('input', { type: 'checkbox' }); c.checked = (r.placement || []).includes(Number(k)); c.dataset.k = k; return h('label', { class: 'row' }, c, n); });
    const md = h('input', { type: 'checkbox' }); md.checked = !!r.markdownOnly;
    const po = h('input', { type: 'checkbox' }); po.checked = !!r.promptOnly;
    const minD = h('input', { type: 'number', value: r.minDepth ?? '' });
    const maxD = h('input', { type: 'number', value: r.maxDepth ?? '' });
    const m = modal({
        title: '正则', wide: true,
        body: h('div', { class: 'list-plain' },
            h('label', { class: 'field' }, h('span', {}, '名称'), name),
            h('label', { class: 'field' }, h('span', {}, '查找（/正则/标志）'), find),
            h('label', { class: 'field' }, h('span', {}, '替换为（$1、{{match}}）'), rep),
            h('div', { class: 'row wrap' }, plChecks),
            h('div', { class: 'row wrap' }, h('label', { class: 'row' }, md, '只改显示'), h('label', { class: 'row' }, po, '只改发送')),
            h('div', { class: 'kv' }, h('label', { class: 'field' }, h('span', {}, '最小深度'), minD), h('label', { class: 'field' }, h('span', {}, '最大深度'), maxD))),
        foot: [
            i !== null ? h('button', { class: 'btn danger', onclick: async () => { list.splice(i, 1); await save(list); m.close(); regexTab(); } }, '删除') : null,
            h('button', {
                class: 'btn primary', onclick: async () => {
                    Object.assign(r, {
                        scriptName: name.value, findRegex: find.value, replaceString: rep.value, markdownOnly: md.checked, promptOnly: po.checked,
                        placement: plChecks.map(l => l.querySelector('input')).filter(c => c.checked).map(c => Number(c.dataset.k)),
                        minDepth: minD.value === '' ? null : Number(minD.value), maxDepth: maxD.value === '' ? null : Number(maxD.value),
                    });
                    if (i === null) list.push(r); else list[i] = r;
                    await save(list);
                    m.close();
                    regexTab();
                    if (state.chat) reloadTail(true);
                },
            }, '保存'),
        ],
    });
}

// ───────────────────────── prompt viewer ─────────────────────────

export async function openPromptViewer() {
    const ch = state.chat;
    if (!ch) return toast('先打开一个聊天', true);
    const box = h('div', { class: 'list-plain' }, h('div', { class: 'muted' }, '读取中…'));
    const m = modal({
        title: '提示词查看器', wide: true, body: box,
        foot: [
            h('button', { class: 'btn', onclick: () => load(true) }, '按当前状态重新预览'),
            h('button', { class: 'btn primary', onclick: () => { navigator.clipboard?.writeText(window.__ltPrompt || ''); toast('已复制'); } }, '复制全部'),
        ],
    });
    async function load(dry) {
        box.replaceChildren(h('div', { class: 'muted' }, '读取中…'));
        let r = dry ? null : await api('/api/prompt/last' + q({ char: ch.char, file: ch.file }));
        if (!r) r = await api('/api/prompt/dry', { char: ch.char, file: ch.file });
        const total = r.messages.reduce((s, x) => s + x.content.length, 0);
        window.__ltPrompt = r.messages.map(x => `[${x.role}]\n${x.content}`).join('\n\n');
        box.replaceChildren(
            h('div', { class: 'muted', style: { fontSize: '.85em' } },
                `${r.dry ? '预览（未发送）' : '上次实际发送'} · ${new Date(r.time).toLocaleTimeString()} · ${r.profile?.name || ''} ${r.profile?.model || ''} · ${r.messages.length} 条 · ${total.toLocaleString()} 字 · 约 ${Math.round(total / 1.6).toLocaleString()} tokens`),
            r.info?.ejsErrors?.length ? h('div', { class: 'toast err', style: { borderRadius: '10px' } }, 'EJS 出错：' + r.info.ejsErrors.join(' | ')) : null,
            h('details', { class: 'pv-msg' }, h('summary', {}, h('span', { class: 'role' }, 'WORLD'), `触发的世界书条目 ${r.info?.wi?.length || 0} 条`),
                h('pre', {}, (r.info?.wi || []).map(w => `${w.comment || w.uid}  [${w.world}] pos${w.position} order${w.order} · ${w.length}字`).join('\n'))),
            ...r.messages.map((x, i) => h('details', { class: 'pv-msg' },
                h('summary', {}, h('span', { class: 'role' }, x.role), h('span', { class: 'grow muted' }, `#${i} · ${x.content.length} 字 · ${x.content.slice(0, 60).replace(/\s+/g, ' ')}`)),
                h('pre', {}, x.content))));
    }
    load(false);
}
