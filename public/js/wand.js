// The magic wand: one menu next to the input box with everything used while chatting.
import { h, icon, toast, api, q, switchEl } from './ui.js';
import { state, generate, stopGen, saveSettings, reloadSettings, startSelect, toBottom, toPrevFloorTop } from './app.js';
import { openPromptViewer, setFabVisible, authorNote, presetData, invalidatePreset } from './panel.js';
import { openSettings } from './settings.js';
import { scriptButtons, pressButton, runSlash } from './scripts.js';

let menu = null;
const modelCache = new Map();

export function closeWand() {
    menu?.remove();
    menu = null;
    document.removeEventListener('pointerdown', outside, true);
}
function outside(e) {
    if (menu && !menu.contains(e.target) && !e.target.closest('.wand-btn') && !e.target.closest('.modal-back')) closeWand();
}

export function openWand(anchor) {
    if (menu) return closeWand();
    menu = h('div', { class: 'wand-menu' });
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.max(8, r.left) + 'px';
    menu.style.bottom = (window.innerHeight - r.top + 8) + 'px';
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    render();
}

function section(title, ...kids) {
    return h('div', { class: 'wand-sec' }, h('div', { class: 'wand-title' }, title), ...kids);
}
function act(label, ic, fn, opt = {}) {
    return h('button', { class: 'wand-act' + (opt.danger ? ' danger' : ''), disabled: opt.disabled, onclick: () => { if (opt.keep !== true) closeWand(); fn(); } }, icon(ic), h('span', {}, label));
}

async function render() {
    if (!menu) return;
    const s = state.settings;
    const inChat = !!state.chat;

    // ── 插头: quick switch (profiles chosen in 设置 → 插头; all if none chosen) ──
    const chosen = (s.wand?.profiles || []).filter(id => s.profiles.some(p => p.id === id));
    const plugs = (chosen.length ? chosen.map(id => s.profiles.find(p => p.id === id)) : s.profiles);
    const modelBox = h('div', { class: 'wand-models' });
    const plugRow = h('div', { class: 'chips' }, plugs.map(p => h('button', {
        class: 'chip' + (p.id === s.activeProfile ? ' on' : ''), title: `${p.model} · ${p.url || p.region || ''}`,
        onclick: async () => {
            if (p.id !== s.activeProfile) {
                await api('/api/profile/select', { id: p.id });
                s.activeProfile = p.id;
                toast('插头：' + p.name);
                render();
            }
            showModels(p, modelBox);
        },
    }, p.name)));
    const active = s.profiles.find(p => p.id === s.activeProfile);

    // ── 预设: selector + the entries pinned to the wand ──
    const preset = await presetData().catch(() => null);
    const pinned = s.wand?.toggles?.[s.activePreset] || [];
    const presetSel = h('select', { class: 'grow' }, state.boot.presets.map(n => h('option', { value: n }, n)));
    presetSel.value = s.activePreset;
    presetSel.onchange = async () => {
        await saveSettings({ activePreset: presetSel.value });
        invalidatePreset();
        state.regex = await api('/api/regex' + q(state.char ? { char: state.char.file } : {}));
        toast('预设：' + presetSel.value);
        render();
    };
    const order = preset ? orderOf(preset) : [];
    const toggles = pinned.map(id => {
        const it = order.find(x => x.identifier === id);
        const d = preset?.prompts?.find(x => x.identifier === id);
        if (!it || !d) return null;
        return h('div', { class: 'row wand-toggle' }, switchEl(it.enabled, async v => {
            it.enabled = v;
            await api('/api/preset/toggle', { name: s.activePreset, identifier: id, enabled: v });
        }), h('span', { class: 'grow' }, d.name || id));
    }).filter(Boolean);

    const qr = [
        ...(s.qr || []).map(x => ({ label: x.label, run: () => x.mode === 'input' ? window.LT.setInput(x.message) : generate('normal', x.message) })),
        ...(s.qrSets || []).filter(x => x.enabled).flatMap(set => set.qrList.filter(x => !x.isHidden).map(x => ({ label: x.label, run: () => runSlash(x.message) }))),
    ];
    const btns = scriptButtons();

    menu.replaceChildren(...[
        section('插头 · ' + (active ? `${active.name} / ${active.model}` : '未选择'), plugRow, modelBox),
        section('预设', h('div', { class: 'row' }, presetSel),
            toggles.length ? h('div', { class: 'list-plain' }, toggles) : h('div', { class: 'muted small' }, '在 设置 → 预设 里勾选要放到这里的开关')),
        section('操作', h('div', { class: 'wand-grid' },
            act('重新生成', 'redo', () => generate('regenerate'), { disabled: !inChat || state.generating }),
            act('继续写', 'cont', () => generate('continue'), { disabled: !inChat || state.generating }),
            act(state.generating ? '停止' : '让 AI 说', state.generating ? 'stop' : 'send', () => state.generating ? stopGen() : generate('normal'), { disabled: !inChat }),
            act('删除楼层', 'trash', startSelect, { disabled: !inChat || state.generating, danger: true }),
            act('到底部', 'bottom', toBottom, { disabled: !inChat, keep: true }),
            act('上一楼顶', 'top', toPrevFloorTop, { disabled: !inChat, keep: true }),
            act('提示词查看', 'eye', openPromptViewer, { disabled: !inChat }),
            act('作者注释', 'edit', authorNote, { disabled: !inChat }),
            act(s.ui?.fab !== false ? '隐藏悬浮窗' : '显示悬浮窗', 'layers', async () => {
                const on = s.ui?.fab === false;
                await saveSettings({ ui: { ...s.ui, fab: on } });
                setFabVisible(on);
            }),
            act('设置', 'gear', () => openSettings()))),
        qr.length ? section('快速回复', h('div', { class: 'chips' }, qr.map(x => h('button', { class: 'chip', onclick: () => { closeWand(); x.run(); } }, x.label)))) : null,
        btns.length ? section('脚本', h('div', { class: 'chips' }, btns.map(b => h('button', { class: 'chip', title: b.script, onclick: () => { closeWand(); pressButton(b.id, b.name); } }, b.name)))) : null,
    ].filter(Boolean));
}

function orderOf(p) {
    const po = p?.prompt_order || [];
    return (po.find(x => String(x.character_id) === '100001') || po.find(x => String(x.character_id) === '100000') || po[0] || { order: [] }).order;
}

async function showModels(p, box) {
    box.replaceChildren(h('div', { class: 'muted small' }, '读取模型列表…'));
    let list = modelCache.get(p.id);
    if (!list) {
        try { list = await api('/api/models' + q({ id: p.id }), undefined, { silent: true }); modelCache.set(p.id, list); }
        catch { list = []; }
    }
    if (!list.includes(p.model)) list = [p.model, ...list];
    const custom = h('input', { type: 'text', placeholder: '手动输入模型名，回车', class: 'grow' });
    const setModel = async (model) => {
        if (!model || model === p.model) return;
        const profile = { ...p, model };
        await api('/api/profile/save', { profile });
        await reloadSettings();
        toast(`${p.name} → ${model}`);
        render();
    };
    custom.onkeydown = e => { if (e.key === 'Enter') setModel(custom.value.trim()); };
    box.replaceChildren(
        h('div', { class: 'chips models' }, list.slice(0, 60).map(m => h('button', { class: 'chip small' + (m === p.model ? ' on' : ''), onclick: () => setModel(m) }, m))),
        h('div', { class: 'row' }, custom));
}
