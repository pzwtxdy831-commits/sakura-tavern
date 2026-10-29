// Generation orchestration: build prompt, stream from provider, write result into chat.
import { getSettings, loadCard, loadPreset, loadChat, markDirty, sendDate, maybeBackup } from './store.js';
import { buildPrompt, postProcess, regexScriptsFor, worldsFor, resolvePersona } from './prompt.js';
import { streamFrom } from './providers.js';
import { applyRegex, PLACEMENT } from '../public/js/regex.js';
import { createMacroEngine } from './macros.js';
import { latestVars, applyUpdates, initVarsFromWorlds, setMsgVars, msgVars } from './mvu.js';
import { maybeSummarize, summaryInjection } from './summary.js';

export const lastPrompts = new Map();

export function activeProfile() {
    const s = getSettings();
    return s.profiles.find(p => p.id === s.activeProfile) || s.profiles[0] || null;
}

export function ensureSwipes(m) {
    if (!Array.isArray(m.swipes) || !m.swipes.length) {
        m.swipes = [m.mes ?? ''];
        m.swipe_id = 0;
        m.swipe_info = [{ send_date: m.send_date, extra: { ...(m.extra || {}) } }];
    }
    m.swipe_info ??= m.swipes.map(() => ({}));
    while (m.swipe_info.length < m.swipes.length) m.swipe_info.push({});
}

export function setSwipe(m, sid) {
    ensureSwipes(m);
    sid = Math.max(0, Math.min(m.swipes.length - 1, sid));
    m.swipe_id = sid;
    m.mes = m.swipes[sid] ?? '';
    const info = m.swipe_info[sid] || {};
    m.extra = { ...(m.extra || {}), reasoning: info.extra?.reasoning || '' };
    if (info.send_date) m.send_date = info.send_date;
}

function simpleMacro(card, persona) {
    return createMacroEngine({ user: persona.name || 'User', char: card.name || '', chat: [], local: {}, global: {} });
}

export function prepareContext(charFile, chat) {
    const settings = getSettings();
    const card = loadCard(charFile).data;
    const preset = loadPreset(settings.activePreset) || { prompts: [], prompt_order: [] };
    const persona = resolvePersona(settings, charFile);
    return { settings, card, preset, persona };
}

/** Apply "store" regex (neither markdownOnly nor promptOnly) to a new/edited message. */
export function storeRegex(charFile, text, isUser, isEdit = false) {
    const { settings, card, preset, persona } = prepareContext(charFile);
    const scripts = regexScriptsFor(settings, preset, card);
    return applyRegex(scripts, text, { placement: isUser ? PLACEMENT.USER : PLACEMENT.AI, mode: 'store', isEdit }, simpleMacro(card, persona));
}

/** Build the prompt for a chat as it is now (also used by the prompt viewer). */
export async function promptFor(chat, type, history) {
    const { settings, card, preset } = prepareContext(chat.charFile, chat);
    const profile = activeProfile();
    const meta = chat.header.chat_metadata;
    const extra = [];
    const sum = summaryInjection(meta);
    const hist = history.filter(m => !m.is_system);
    if (sum) extra.push({ role: 'system', content: sum, depth: hist.length });
    const built = await buildPrompt({ chat, history, card, charFile: chat.charFile, preset, type, model: profile?.model, extraInjections: extra });
    const final = postProcess(built.messages, profile?.postProcessing || 'none');
    return { built, final, profile, preset, card, settings };
}

/**
 * Run a generation. `send(event)` streams events to the client.
 * opts: {charFile, file, type: 'normal'|'regenerate'|'continue', text}
 */
export async function generate(opts, send, signal) {
    const chat = await loadChat(opts.charFile, opts.file);
    const { settings, card, persona } = prepareContext(opts.charFile, chat);
    const profile = activeProfile();
    if (!profile) throw new Error('还没有连接配置（插头）');
    const msgs = chat.messages;
    let type = opts.type || 'normal';

    // user message
    if (type === 'normal' && opts.text && opts.text.trim()) {
        const text = storeRegex(opts.charFile, opts.text, true);
        msgs.push({ name: persona.name, is_user: true, is_system: false, send_date: sendDate(), mes: text, extra: {}, force_avatar: persona.avatar ? `/personas/${encodeURIComponent(persona.avatar)}` : undefined });
        send({ t: 'user', index: msgs.length - 1, message: dto(msgs[msgs.length - 1], msgs.length - 1, msgs.length) });
        markDirty(chat, 50);
    }

    let target, history, prefill = '';
    const last = msgs[msgs.length - 1];
    if (type === 'regenerate') {
        if (!last || last.is_user) type = 'normal';
        else {
            target = last;
            ensureSwipes(target);
            target.swipes.push('');
            target.swipe_info.push({ send_date: sendDate(), gen_started: new Date().toISOString(), extra: {} });
            setSwipe(target, target.swipes.length - 1);
            history = msgs.slice(0, -1);
        }
    }
    if (type === 'continue') {
        if (!last || last.is_user) type = 'normal';
        else {
            target = last;
            ensureSwipes(target);
            prefill = target.mes || '';
            history = msgs.slice();
        }
    }
    if (type === 'normal') {
        history = msgs.slice();
        target = {
            name: card.name, is_user: false, is_system: false, send_date: sendDate(), mes: '',
            extra: { api: profile.source, model: profile.model }, swipes: [''], swipe_id: 0,
            swipe_info: [{ send_date: sendDate(), gen_started: new Date().toISOString(), extra: {} }],
        };
        msgs.push(target);
    }
    const index = msgs.indexOf(target);
    send({ t: 'start', index, swipe: target.swipe_id, swipes: target.swipes.length, type });

    const { built, final, preset } = await promptFor(chat, type, history);
    lastPrompts.set(chat.key, { messages: final, raw: built.messages, info: built.info, profile: { name: profile.name, source: profile.source, model: profile.model, url: profile.url }, time: Date.now() });
    if (built.info.ejsErrors.length) send({ t: 'warn', text: 'EJS 出错 ' + built.info.ejsErrors.length + ' 处：' + built.info.ejsErrors[0] });

    const params = built.info.params;
    let text = '', reasoning = '';
    let finish = '';
    const started = Date.now();
    let firstAt = 0;
    let usage = null;
    const promptChars = final.reduce((s, m) => s + m.content.length, 0);
    console.log(`[gen] ${type} ${chat.charFile} → ${profile.name} (${profile.model}) prompt ${final.length} msgs / ${promptChars} chars`);
    const logDone = () => console.log(`[gen] done ${text.length} chars + ${reasoning.length} reasoning in ${((Date.now() - started) / 1000).toFixed(1)}s${finish ? ' finish=' + finish : ''}${signal.aborted ? ' (stopped)' : ''}`);
    const mark = () => { if (!firstAt) { firstAt = Date.now(); send({ t: 'ttft', ms: firstAt - started }); } };
    try {
        for await (const ev of streamFrom(profile, final, params, signal)) {
            if (ev.type === 'text') { mark(); text += ev.text; send({ t: 'd', d: ev.text }); }
            else if (ev.type === 'reasoning') { mark(); reasoning += ev.text; send({ t: 'r', d: ev.text }); }
            else if (ev.type === 'finish') finish = ev.text;
            else if (ev.type === 'usage') usage = ev.usage;
        }
    } catch (e) {
        if (!signal.aborted) {
            console.warn('[gen] error', e.message);
            // roll back an empty placeholder
            if (!text && type === 'normal') msgs.splice(index, 1);
            else if (!text && type === 'regenerate') { target.swipes.pop(); target.swipe_info.pop(); target.variables?.splice?.(target.swipes.length); setSwipe(target, target.swipes.length - 1); }
            markDirty(chat);
            throw e;
        }
    }

    logDone();
    // auto-parse <think> at start
    const rs = settings.reasoning;
    if (rs.autoParse && rs.prefix && text.trimStart().startsWith(rs.prefix)) {
        const t = text.trimStart();
        const end = t.indexOf(rs.suffix);
        if (end > 0) { reasoning += t.slice(rs.prefix.length, end).trim(); text = t.slice(end + rs.suffix.length).replace(/^\s+/, ''); }
    }
    if (!text && !reasoning) {
        if (type === 'normal') msgs.splice(index, 1);
        else if (type === 'regenerate') { target.swipes.pop(); target.swipe_info.pop(); setSwipe(target, target.swipes.length - 1); }
        markDirty(chat);
        send({ t: 'empty', finish });
        return;
    }
    let mes = type === 'continue' ? prefill + text : text;
    mes = storeRegex(opts.charFile, mes, false);
    const sid = target.swipe_id;
    target.mes = mes;
    target.swipes[sid] = mes;
    const stats = genStats(started, firstAt, usage, text, reasoning, promptChars);
    const info = target.swipe_info[sid] ||= {};
    info.extra = { ...(info.extra || {}), reasoning: (type === 'continue' ? (info.extra?.reasoning || '') : '') + reasoning, api: profile.source, model: profile.model, lt_stats: stats };
    info.gen_finished = new Date().toISOString();
    target.extra = { ...(target.extra || {}), reasoning: info.extra.reasoning, api: profile.source, model: profile.model, time_to_finish: Date.now() - started, lt_stats: stats };
    target.gen_finished = info.gen_finished;

    // MVU variables
    if (settings.plugins.mvu?.enabled !== false) {
        const prev = latestVars(msgs, index) || initVarsFromWorlds(worldsFor(settings, card, chat));
        if (prev || /<(UpdateVariable|update)>/i.test(mes)) {
            const { vars } = applyUpdates(prev || {}, mes);
            setMsgVars(target, vars);
        }
    }
    markDirty(chat);
    send({ t: 'done', index, message: dto(target, index, msgs.length, true), finish });

    maybeBackup(chat);
    maybeSummarize(chat, { user: persona.name, char: card.name }, () => { });
}

/** Generation stats: ttft, total time, tokens (provider usage when available, else estimated), tokens/s. */
function genStats(started, firstAt, usage, text, reasoning, promptChars) {
    const end = Date.now();
    const est = (s) => Math.round(s.length / 1.6);
    let tin = null, tout = null, estimated = false;
    if (usage) {
        tin = usage.promptTokenCount ?? usage.prompt_tokens ?? null;
        tout = (usage.candidatesTokenCount ?? usage.completion_tokens ?? 0) + (usage.thoughtsTokenCount ?? 0);
        if (!tout) tout = null;
    }
    if (tout === null) { tout = est(text) + est(reasoning); estimated = true; }
    if (tin === null) tin = est({ length: promptChars });
    const genMs = end - (firstAt || started);
    return {
        ttft: firstAt ? firstAt - started : null,
        ms: end - started,
        in: tin, out: tout, estimated,
        tps: genMs > 0 ? Math.round((tout / (genMs / 1000)) * 10) / 10 : null,
    };
}

/** Lightweight message for the client. */
export function dto(m, i, total, withVars = false) {
    const o = {
        i,
        name: m.name,
        user: !!m.is_user,
        hidden: !!m.is_system,
        mes: m.mes ?? '',
        sid: m.swipe_id ?? 0,
        sc: Array.isArray(m.swipes) ? m.swipes.length : 1,
        r: m.extra?.reasoning || '',
        date: m.send_date || '',
        model: m.extra?.model || '',
        avatar: String(m.force_avatar || '').startsWith('/personas/') ? m.force_avatar : '',
        stats: m.swipe_info?.[m.swipe_id ?? 0]?.extra?.lt_stats || m.extra?.lt_stats || null,
    };
    if (withVars) {
        const v = msgVars(m);
        if (v) o.vars = v;
    }
    return o;
}
