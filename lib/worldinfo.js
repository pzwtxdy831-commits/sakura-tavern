// World info (lorebook) scanning, SillyTavern-compatible subset.
import { renderEjs, hasEjs } from './ejs.js';
import { applyRegex, PLACEMENT, regexFromString } from '../public/js/regex.js';

const LOGIC = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function keyMatcher(key, entry, opts) {
    key = String(key).trim();
    if (!key) return null;
    if (/^\/.+\/[a-z]*$/is.test(key)) {
        const re = regexFromString(key);
        return re ? (t) => { re.lastIndex = 0; return re.test(t); } : null;
    }
    const cs = entry.caseSensitive ?? opts.caseSensitive ?? false;
    const ww = entry.matchWholeWords ?? opts.matchWholeWords ?? false;
    if (ww && !/\s/.test(key)) {
        const re = new RegExp(`(?:^|\\W)(${escapeRe(key)})(?:$|\\W)`, cs ? '' : 'i');
        return (t) => re.test(t);
    }
    const k = cs ? key : key.toLowerCase();
    return (t) => (cs ? t : t.toLowerCase()).includes(k);
}

function decorators(content) {
    const res = { activate: false, dontActivate: false, content };
    if (!content || !content.startsWith('@@')) return res;
    const lines = content.split('\n');
    let i = 0;
    for (; i < lines.length; i++) {
        const l = lines[i].trim();
        if (!l.startsWith('@@')) break;
        if (l === '@@activate') res.activate = true;
        else if (l === '@@dont_activate') res.dontActivate = true;
    }
    res.content = lines.slice(i).join('\n');
    return res;
}

/**
 * @param {object} p
 *  worlds: [{name, data}]
 *  chat: messages (newest last, hidden excluded)
 *  settings: {depth, recursive, maxRecursion}
 *  macro: (s)=>s
 *  ejsEnv: env for renderEjs
 *  regexScripts: list
 */
export async function scanWorldInfo(p) {
    const { worlds, chat, settings, macro, ejsEnv, regexScripts } = p;
    const entries = [];
    for (const w of worlds) {
        if (!w?.data?.entries) continue;
        for (const e of Object.values(w.data.entries)) {
            if (!e || e.disable) continue;
            entries.push({ ...e, world: w.name });
        }
    }
    const depthDefault = Number(settings.depth ?? 2);
    const msgs = chat.filter(m => !m.is_system).map(m => String(m.mes ?? ''));
    const bufferFor = (depth) => msgs.slice(-Math.max(0, depth)).reverse().join('\n\x01');

    const activated = new Map(); // key -> entry
    const keyOf = e => e.world + '\u0000' + e.uid;
    let recursionBuffer = '';
    const maxSteps = settings.recursive === false ? 1 : Math.max(1, Number(settings.maxRecursion || 5));

    for (let step = 0; step < maxSteps; step++) {
        const isRecursion = step > 0;
        const newly = [];
        for (const e of entries) {
            const k = keyOf(e);
            if (activated.has(k)) continue;
            const dec = decorators(e.content || '');
            if (dec.dontActivate) continue;
            if (isRecursion && e.excludeRecursion) continue;
            if (!isRecursion && e.delayUntilRecursion) continue;
            let hit = false;
            if (dec.activate || e.constant) {
                hit = step === 0 || e.delayUntilRecursion;
            } else {
                const keys = (e.key || []).map(x => macro(String(x))).filter(Boolean);
                if (!keys.length) continue;
                const depth = e.scanDepth ?? depthDefault;
                const text = bufferFor(depth) + (recursionBuffer ? '\n\x01' + recursionBuffer : '');
                if (!text) continue;
                const primary = keys.some(key => keyMatcher(key, e, settings)?.(text));
                if (!primary) continue;
                const sec = (e.keysecondary || []).map(x => macro(String(x))).filter(Boolean);
                if (e.selective && sec.length) {
                    const res = sec.map(key => !!keyMatcher(key, e, settings)?.(text));
                    const logic = Number(e.selectiveLogic ?? 0);
                    if (logic === LOGIC.AND_ANY) hit = res.some(Boolean);
                    else if (logic === LOGIC.NOT_ALL) hit = !res.every(Boolean);
                    else if (logic === LOGIC.NOT_ANY) hit = !res.some(Boolean);
                    else if (logic === LOGIC.AND_ALL) hit = res.every(Boolean);
                } else hit = true;
            }
            if (!hit) continue;
            if (e.useProbability && Number(e.probability ?? 100) < 100 && Math.random() * 100 >= Number(e.probability)) continue;
            newly.push(e);
        }
        if (!newly.length) break;
        for (const e of newly) activated.set(keyOf(e), e);
        if (settings.recursive === false) break;
        const add = newly.filter(e => !e.preventRecursion).map(e => decorators(e.content || '').content).join('\n');
        if (!add) break;
        recursionBuffer += '\n' + add;
    }

    // inclusion groups
    let list = [...activated.values()];
    const groups = new Map();
    for (const e of list) {
        if (!e.group) continue;
        for (const g of String(e.group).split(/,\s*/).filter(Boolean)) {
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(e);
        }
    }
    const removed = new Set();
    for (const members of groups.values()) {
        if (members.length < 2) continue;
        let keep;
        const over = members.filter(e => e.groupOverride);
        if (over.length) keep = over.sort((a, b) => (b.order ?? 0) - (a.order ?? 0))[0];
        else {
            const total = members.reduce((s, e) => s + Number(e.groupWeight ?? 100), 0);
            let r = Math.random() * total;
            keep = members.find(e => (r -= Number(e.groupWeight ?? 100)) < 0) || members[0];
        }
        for (const e of members) if (e !== keep) removed.add(e);
    }
    list = list.filter(e => !removed.has(e));
    list.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));

    const out = { before: [], after: [], anTop: [], anBottom: [], depth: [], emTop: [], emBottom: [], outlets: {}, activated: [] };
    for (const e of list) {
        let content = decorators(e.content || '').content;
        if (hasEjs(content) && ejsEnv) content = await renderEjs(content, ejsEnv);
        content = macro(content);
        if (regexScripts?.length) {
            content = applyRegex(regexScripts, content, { placement: PLACEMENT.WORLD, mode: 'prompt' }, macro);
            content = applyRegex(regexScripts, content, { placement: PLACEMENT.WORLD, mode: 'store' }, macro);
        }
        if (!content || !content.trim()) continue;
        out.activated.push({ world: e.world, uid: e.uid, comment: e.comment, position: e.position, order: e.order, length: content.length });
        switch (Number(e.position ?? 0)) {
            case 0: out.before.push(content); break;
            case 1: out.after.push(content); break;
            case 2: out.anTop.push(content); break;
            case 3: out.anBottom.push(content); break;
            case 4: out.depth.push({ content, depth: Number(e.depth ?? 4), role: ['system', 'user', 'assistant'][Number(e.role ?? 0)] || 'system', order: e.order ?? 100 }); break;
            case 5: out.emTop.push(content); break;
            case 6: out.emBottom.push(content); break;
            case 7: {
                const n = e.outletName || '';
                (out.outlets[n] ??= []).push(content);
                break;
            }
            default: out.before.push(content);
        }
    }
    for (const k of Object.keys(out.outlets)) out.outlets[k] = out.outlets[k].join('\n');
    return out;
}

/** Find an entry by comment or uid across worlds and render it. */
export async function lookupEntry(worlds, worldName, name, macro, ejsEnv) {
    for (const w of worlds) {
        if (worldName && w.name !== worldName) continue;
        for (const e of Object.values(w.data?.entries || {})) {
            if (e.comment === name || String(e.uid) === String(name)) {
                let c = decorators(e.content || '').content;
                if (hasEjs(c)) c = await renderEjs(c, ejsEnv);
                return macro(c);
            }
        }
    }
    return null;
}
