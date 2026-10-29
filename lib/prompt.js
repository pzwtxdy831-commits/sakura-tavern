// Chat Completion prompt assembly, following SillyTavern's PromptManager behaviour.
import fs from 'node:fs';
import { createMacroEngine } from './macros.js';
import { renderEjs, hasEjs } from './ejs.js';
import { scanWorldInfo, lookupEntry } from './worldinfo.js';
import { applyRegex, PLACEMENT } from '../public/js/regex.js';
import { loadWorld, presetOrder, presetRegex, getSettings } from './store.js';
import { latestVars } from './mvu.js';
import { dir } from './util.js';

const MARKERS = new Set(['worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario', 'personaDescription', 'dialogueExamples', 'chatHistory']);

export function resolvePersona(settings, charFile) {
    const id = settings.personaBinding?.[charFile] || settings.defaultPersona;
    const p = settings.personas?.[id];
    if (p) return { id, ...p };
    const first = Object.entries(settings.personas || {})[0];
    if (first) return { id: first[0], ...first[1] };
    return { id: '', name: 'User', description: '', position: 0, depth: 2, role: 0 };
}

export function regexScriptsFor(settings, preset, card) {
    return [
        ...(settings.regex || []),
        ...presetRegex(preset),
        ...(card?.extensions?.regex_scripts || []),
    ];
}

export function worldsFor(settings, card, chat) {
    const names = [];
    const w = card?.extensions?.world;
    if (w) names.push(w);
    for (const g of settings.globalWorlds || []) if (!names.includes(g)) names.push(g);
    const cw = chat?.header?.chat_metadata?.world_info;
    if (cw && !names.includes(cw)) names.push(cw);
    return names.map(name => ({ name, data: loadWorld(name) })).filter(x => x.data);
}

function parseExamples(text) {
    if (!text || !text.trim()) return [];
    const blocks = text.split(/<START>/i).map(x => x.trim()).filter(Boolean);
    return blocks;
}

// Novel tail ("小说尾部样张"): split novel into ~size char slices on paragraph boundaries.
let novelCache = { file: '', size: 0, slices: [] };
function novelSlices(file, size) {
    if (novelCache.file === file && novelCache.size === size) return novelCache.slices;
    let raw = '';
    try { raw = fs.readFileSync(dir('novels', file), 'utf8'); } catch { return []; }
    const clean = raw.replace(/\r\n/g, '\n').trim();
    const slices = [];
    let start = 0;
    while (start < clean.length) {
        let end = Math.min(start + size, clean.length);
        if (end < clean.length) {
            const ws = Math.floor(start + size * 0.85);
            const nl = clean.slice(ws, end).lastIndexOf('\n');
            if (nl >= 0) end = ws + nl + 1;
        }
        const part = clean.slice(start, end).trim();
        if (part.length >= 2000 || !slices.length) slices.push(part);
        start = end;
    }
    novelCache = { file, size, slices };
    return slices;
}
function firstNovel() {
    try { return fs.readdirSync(dir('novels')).find(f => /\.txt$/i.test(f)) || ''; } catch { return ''; }
}
export const NOVEL_MARKER = '[SAKURA_TAIL_NOVEL_8000_MARKER]';

/**
 * @param {object} p
 *  chat        loaded chat object (header + messages)
 *  history     messages to include (already trimmed for regenerate etc.)
 *  card        card.data
 *  charFile
 *  preset
 *  type        'normal' | 'regenerate' | 'continue' | 'impersonate' | 'dry'
 *  extraInjections [{content, depth, role, order}]
 *  model
 */
export async function buildPrompt(p) {
    const settings = getSettings();
    const { chat, card, preset } = p;
    const history = p.history.filter(m => !m.is_system);
    const persona = resolvePersona(settings, p.charFile);
    const meta = chat.header.chat_metadata;
    if (!meta.variables || typeof meta.variables !== 'object') meta.variables = {};
    const local = meta.variables;
    const global = settings.globalVars;
    const lastVars = latestVars(p.history) || {};

    const mctx = {
        user: persona.name || 'User',
        char: card.name || '',
        persona: '',
        description: '', personality: '', scenario: '', mesExamples: '',
        charPrompt: card.system_prompt || '', charInstruction: card.post_history_instructions || '',
        charVersion: card.character_version || '',
        model: p.model || '',
        input: history.length && history[history.length - 1].is_user ? history[history.length - 1].mes : '',
        chat: history,
        local, global,
        msgVars: () => lastVars,
        outlets: {},
        genType: p.type,
        pickSeed: chat.file,
    };
    const macro = createMacroEngine(mctx);
    mctx.persona = macro(persona.description || '');
    mctx.description = macro(card.description || '');
    mctx.personality = macro(card.personality || '');
    mctx.scenario = macro(card.scenario || '');
    mctx.mesExamples = macro(card.mes_example || '');
    mctx.charPrompt = macro(mctx.charPrompt);
    mctx.charInstruction = macro(mctx.charInstruction);

    const worlds = worldsFor(settings, card, chat);
    const regexScripts = regexScriptsFor(settings, preset, card);
    const ejsErrors = [];
    const ejsEnv = {
        vars: { global, local, message: () => lastVars },
        chat: history,
        user: mctx.user, char: mctx.char,
        chatId: chat.file, genType: p.type,
        worldLookup: (world, name) => lookupEntry(worlds, world, name, macro, ejsEnv),
        onError: (e, tpl) => ejsErrors.push(`${e.message} @ ${String(tpl).slice(0, 60)}`),
    };
    const wi = await scanWorldInfo({ worlds, chat: history, settings: settings.wi, macro, ejsEnv, regexScripts });
    mctx.outlets = wi.outlets;

    const wiFmt = (s) => {
        if (!s) return '';
        const f = preset.wi_format || '{0}';
        return f.replace('{0}', s);
    };

    const render = async (s) => {
        if (!s) return '';
        if (hasEjs(s)) s = await renderEjs(s, ejsEnv);
        return macro(s);
    };

    // ── walk prompt order ──
    const order = presetOrder(preset).order || [];
    const defs = new Map((preset.prompts || []).map(x => [x.identifier, x]));
    const sequence = []; // {kind:'msg', role, content, name} | {kind:'history'}
    const injections = []; // {role, content, depth, order}

    for (const item of order) {
        if (!item.enabled) continue;
        const def = defs.get(item.identifier);
        const id = item.identifier;
        if (MARKERS.has(id)) {
            let content = '';
            switch (id) {
                case 'worldInfoBefore': content = wiFmt(wi.before.join('\n')); break;
                case 'worldInfoAfter': content = wiFmt(wi.after.join('\n')); break;
                case 'charDescription': content = mctx.description; break;
                case 'charPersonality': content = mctx.personality ? (preset.personality_format ? macro(preset.personality_format.replace(/{{personality}}/gi, mctx.personality)) : mctx.personality) : ''; break;
                case 'scenario': content = mctx.scenario ? (preset.scenario_format ? macro(preset.scenario_format.replace(/{{scenario}}/gi, mctx.scenario)) : mctx.scenario) : ''; break;
                case 'personaDescription': content = Number(persona.position ?? 0) === 0 ? mctx.persona : ''; break;
                case 'dialogueExamples': {
                    const blocks = parseExamples(mctx.mesExamples);
                    if (blocks.length) {
                        const head = preset.new_example_chat_prompt ? macro(preset.new_example_chat_prompt) : '';
                        content = [wi.emTop.join('\n'), ...blocks.map(b => (head ? head + '\n' : '') + b), wi.emBottom.join('\n')].filter(Boolean).join('\n');
                    }
                    break;
                }
                case 'chatHistory': sequence.push({ kind: 'history' }); continue;
            }
            if (content && content.trim()) sequence.push({ kind: 'msg', role: def?.role || 'system', content, id, name: def?.name || id });
            continue;
        }
        if (!def) continue;
        let raw = def.content || '';
        if (id === 'main' && card.system_prompt && !def.forbid_overrides) raw = card.system_prompt.replace(/{{original}}/gi, raw);
        if (id === 'jailbreak' && card.post_history_instructions && !def.forbid_overrides) raw = card.post_history_instructions.replace(/{{original}}/gi, raw);
        const content = await render(raw);
        if (!content || !content.trim()) continue;
        const role = def.role || 'system';
        if (Number(def.injection_position) === 1) {
            injections.push({ role, content, depth: Number(def.injection_depth ?? 4), order: Number(def.injection_order ?? 100), preset: true, name: def.name });
        } else {
            sequence.push({ kind: 'msg', role, content, id, name: def.name || id });
        }
    }

    // ── extension-style injections (order group 100) ──
    const ext = [];
    for (const d of wi.depth) ext.push({ role: d.role, content: d.content, depth: d.depth });
    const dp = card.extensions?.depth_prompt;
    if (dp?.prompt?.trim()) ext.push({ role: dp.role || 'system', content: macro(dp.prompt), depth: Number(dp.depth ?? 4) });
    if (Number(persona.position) === 4 && mctx.persona) ext.push({ role: ['system', 'user', 'assistant'][Number(persona.role || 0)], content: mctx.persona, depth: Number(persona.depth ?? 2) });
    const note = meta.note_prompt ? macro(meta.note_prompt) : '';
    if (note || wi.anTop.length || wi.anBottom.length) {
        const an = [wi.anTop.join('\n'), note, wi.anBottom.join('\n')].filter(Boolean).join('\n');
        if (an.trim() && (note || wi.anTop.length || wi.anBottom.length)) {
            ext.push({ role: ['system', 'user', 'assistant'][Number(meta.note_role || 0)], content: an, depth: Number(meta.note_depth ?? 4) });
        }
    }
    for (const x of p.extraInjections || []) ext.push(x);

    // ── chat history ──
    const histMsgs = [];
    if (preset.new_chat_prompt) {
        const ncp = macro(preset.new_chat_prompt);
        if (ncp.trim()) histMsgs.push({ role: 'system', content: ncp });
    }
    const n = history.length;
    history.forEach((m, i) => {
        const depth = n - 1 - i;
        let text = String(m.mes ?? '');
        text = applyRegex(regexScripts, text, { placement: m.is_user ? PLACEMENT.USER : PLACEMENT.AI, mode: 'prompt', depth }, macro);
        if (!text.trim() && !(p.type === 'continue' && i === n - 1)) return;
        histMsgs.push({ role: m.is_user ? 'user' : 'assistant', content: text, chat: true });
    });

    const injected = populateInjections(histMsgs, injections, ext);

    // ── assemble ──
    let messages = [];
    for (const s of sequence) {
        if (s.kind === 'history') messages.push(...injected);
        else messages.push({ role: s.role, content: s.content, name: s.name });
    }
    if (!sequence.some(s => s.kind === 'history')) messages.push(...injected);

    // ── novel tail marker ──
    const tail = settings.plugins?.tailNovel;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (typeof m.content !== 'string' || !m.content.includes(NOVEL_MARKER)) continue;
        const slices = novelSlices(tail?.file || firstNovel(), Number(tail?.size || 13000));
        const before = m.content.split(NOVEL_MARKER)[0].trim();
        const repl = [];
        if (before) repl.push({ role: m.role, content: before });
        if (slices.length) {
            let idx = Number(meta.lt_tail_index || 0);
            if (!(idx >= 0 && idx < slices.length)) idx = 0;
            if (p.type !== 'dry') meta.lt_tail_index = (idx + 1) % slices.length;
            repl.push({ role: 'assistant', content: '（已确认本轮输出结构与要求，等待文风样张校准。）' });
            repl.push({ role: 'user', content: '(下面这整段只是文风样张，用来校准笔感——不是这一回要写的内容，也和正题无关。读一眼就走，直接按规划写正文。)\n\n' + slices[idx] });
        }
        messages.splice(i, 1, ...repl);
        break;
    }

    messages = messages.filter(m => typeof m.content === 'string' && (m.content.trim() || m.chat));

    return {
        messages,
        info: {
            wi: wi.activated,
            ejsErrors,
            persona: persona.name,
            params: presetParams(preset),
        },
    };
}

/** ST's populationInjectionPrompts: higher order goes later; per order system→user→assistant (reversed later). */
function populateInjections(history, presetInj, extInj) {
    const rev = [...history].reverse();
    let inserted = 0;
    const all = [...presetInj, ...extInj.map(x => ({ ...x, ext: true }))];
    const maxDepth = all.reduce((m, x) => Math.max(m, x.depth), 0);
    for (let d = 0; d <= maxDepth; d++) {
        const atDepth = all.filter(x => x.depth === d && x.content);
        if (!atDepth.length) continue;
        const groups = { '100': [] };
        for (const x of atDepth) {
            const o = x.ext ? 100 : (x.order ?? 100);
            (groups[o] ??= []).push(x);
        }
        const roleMsgs = [];
        for (const o of Object.keys(groups).sort((a, b) => +b - +a)) {
            for (const role of ['system', 'user', 'assistant']) {
                const presetPart = groups[o].filter(x => !x.ext && x.role === role).map(x => x.content).join('\n');
                const extPart = groups[o].filter(x => x.ext && x.role === role).map(x => x.content).join('\n');
                const joint = [presetPart, extPart].filter(Boolean).map(x => x.trim()).join('\n');
                if (joint) roleMsgs.push({ role, content: joint, injected: true });
            }
        }
        if (roleMsgs.length) {
            rev.splice(d + inserted, 0, ...roleMsgs);
            inserted += roleMsgs.length;
        }
    }
    return rev.reverse();
}

export function presetParams(preset) {
    return {
        temperature: preset.temperature ?? 1,
        top_p: preset.top_p ?? 1,
        top_k: preset.top_k ?? 0,
        max_tokens: preset.openai_max_tokens ?? 4096,
        frequency_penalty: preset.frequency_penalty ?? 0,
        presence_penalty: preset.presence_penalty ?? 0,
        reasoning_effort: preset.reasoning_effort ?? 'auto',
        show_thoughts: preset.show_thoughts ?? true,
        stream: preset.stream_openai ?? true,
        use_sysprompt: !!preset.use_sysprompt,
        seed: preset.seed ?? -1,
    };
}

/**
 * Prompt post-processing (ST: none / merge / semi / strict / single, each "_tools" variant keeps tool-call
 * messages intact; since Sakura never sends tool calls, the text handling is the same).
 */
export function postProcess(messages, mode) {
    let msgs = messages.map(m => ({ role: m.role, content: m.content }));
    if (!mode || mode === 'none') return msgs;
    if (mode === 'single') {
        return [{ role: 'user', content: msgs.map(m => m.content).join('\n\n') }];
    }
    const merge = (list) => {
        const out = [];
        for (const m of list) {
            const last = out[out.length - 1];
            if (last && last.role === m.role) last.content += '\n\n' + m.content;
            else out.push({ ...m });
        }
        return out;
    };
    if (mode === 'merge' || mode === 'merge_tools') return merge(msgs);
    if (mode === 'semi' || mode === 'semi_tools' || mode === 'strict' || mode === 'strict_tools') {
        // keep the first system message(s), turn the rest of system into user, then merge
        let i = 0;
        while (i < msgs.length && msgs[i].role === 'system') i++;
        msgs = msgs.map((m, k) => (k >= i && m.role === 'system') ? { role: 'user', content: m.content } : m);
        msgs = merge(msgs);
        if (mode.startsWith('strict')) {
            const firstNonSys = msgs.findIndex(m => m.role !== 'system');
            if (firstNonSys >= 0 && msgs[firstNonSys].role !== 'user') msgs.splice(firstNonSys, 0, { role: 'user', content: '[Start a new chat]' });
            if (firstNonSys < 0) msgs.push({ role: 'user', content: '[Start a new chat]' });
        }
        return msgs;
    }
    return msgs;
}
