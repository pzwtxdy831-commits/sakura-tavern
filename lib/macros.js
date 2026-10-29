// SillyTavern-style {{macro}} substitution. Nested macros are evaluated inner-first, left to right,
// so {{setvar}}/{{getvar}} side effects happen in document order like ST.
import _ from 'lodash';
import YAML from 'yaml';

const TRIM = '\u0000TRIM\u0000';

function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

function toStr(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

function numOr(v) {
    const n = Number(v);
    return (v !== '' && v !== null && !Number.isNaN(n)) ? n : null;
}

/**
 * ctx: {
 *   user, char, persona, description, personality, scenario, mesExamples, charPrompt, charInstruction, charVersion,
 *   model, input, chat: [{mes,is_user,is_system}], local: {}, global: {}, msgVars: () => object, outlets: {}
 * }
 */
export function createMacroEngine(ctx) {
    const local = ctx.local || (ctx.local = {});
    const global = ctx.global || (ctx.global = {});
    let pickSeed = ctx.pickSeed || 'lt';

    function lastMes(pred) {
        const chat = ctx.chat || [];
        for (let i = chat.length - 1; i >= 0; i--) if (!chat[i].is_system && pred(chat[i])) return chat[i].mes || '';
        return '';
    }

    function setVar(store, k, v) { _.set(store, k, v); }
    function getVar(store, k) {
        const v = k in store ? store[k] : _.get(store, k);
        return v;
    }
    function addVar(store, k, v) {
        const cur = getVar(store, k);
        const nc = numOr(cur), nv = numOr(v);
        if (Array.isArray(cur)) { cur.push(v); return; }
        if (cur === undefined || cur === '' ) { setVar(store, k, nv !== null ? nv : v); return; }
        if (nc !== null && nv !== null) setVar(store, k, nc + nv);
        else setVar(store, k, String(cur) + String(v));
    }

    function evalMacro(raw) {
        const body = raw.trim();
        const sep = body.indexOf('::');
        let name = (sep >= 0 ? body.slice(0, sep) : body).trim().toLowerCase();
        let args = sep >= 0 ? body.slice(sep + 2).split('::') : [];
        const legacy = sep < 0 && body.match(/^(roll|random|pick)[ :](.+)$/is);
        if (legacy) { name = legacy[1].toLowerCase(); args = [legacy[2]]; }
        const a0 = args[0] !== undefined ? args[0].trim() : '';
        switch (name) {
            case 'user': return ctx.user ?? 'User';
            case 'char': case 'group': case 'charifnotgroup': case 'groupnotmuted': return ctx.char ?? '';
            case 'notchar': return ctx.user ?? '';
            case 'persona': return ctx.persona ?? '';
            case 'description': case 'chardescription': return ctx.description ?? '';
            case 'personality': case 'charpersonality': return ctx.personality ?? '';
            case 'scenario': case 'charscenario': return ctx.scenario ?? '';
            case 'mesexamples': case 'mesexamplesraw': return ctx.mesExamples ?? '';
            case 'charprompt': return ctx.charPrompt ?? '';
            case 'charinstruction': case 'charjailbreak': return ctx.charInstruction ?? '';
            case 'charversion': case 'char_version': return ctx.charVersion ?? '';
            case 'model': return ctx.model ?? '';
            case 'input': return ctx.input ?? '';
            case 'original': return '';
            case 'newline': return '\n';
            case 'noop': case 'banned': return '';
            case 'trim': return TRIM;
            case 'lastmessage': return lastMes(() => true);
            case 'lastusermessage': return lastMes(m => m.is_user);
            case 'lastcharmessage': return lastMes(m => !m.is_user);
            case 'lastmessageid': return String(Math.max(0, (ctx.chat?.length || 1) - 1));
            case 'lastgenerationtype': return ctx.genType || 'normal';
            case 'maxprompt': return String(ctx.maxContext || 0);
            case 'idle_duration': return 'just now';
            case 'time': return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
            case 'date': return new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
            case 'weekday': return new Date().toLocaleDateString('en-US', { weekday: 'long' });
            case 'isotime': return new Date().toTimeString().slice(0, 5);
            case 'isodate': return new Date().toISOString().slice(0, 10);
            case 'reverse': return [...args.join('::')].reverse().join('');
            case 'random': {
                const list = args.length ? (args.length === 1 ? args[0].split(',') : args) : [];
                if (!list.length) return '';
                return list[Math.floor(Math.random() * list.length)].trim();
            }
            case 'pick': {
                const list = args.length === 1 ? args[0].split(',') : args;
                if (!list.length) return '';
                return list[hashStr(pickSeed + raw) % list.length].trim();
            }
            case 'roll': {
                const m = String(a0).match(/^(\d*)d(\d+)([+-]\d+)?$/i) || String('1d' + a0).match(/^(\d*)d(\d+)([+-]\d+)?$/i);
                if (!m) return '';
                let n = Number(m[1] || 1), s = Number(m[2]), t = Number(m[3] || 0);
                for (let i = 0; i < n; i++) t += 1 + Math.floor(Math.random() * s);
                return String(t);
            }
            case 'setvar': setVar(local, a0, args.slice(1).join('::')); return '';
            case 'getvar': return toStr(getVar(local, a0));
            case 'addvar': addVar(local, a0, args.slice(1).join('::')); return '';
            case 'incvar': { const v = (numOr(getVar(local, a0)) || 0) + 1; setVar(local, a0, v); return String(v); }
            case 'decvar': { const v = (numOr(getVar(local, a0)) || 0) - 1; setVar(local, a0, v); return String(v); }
            case 'hasvar': case 'varexists': return String(getVar(local, a0) !== undefined);
            case 'deletevar': case 'flushvar': _.unset(local, a0); return '';
            case 'setglobalvar': setVar(global, a0, args.slice(1).join('::')); return '';
            case 'getglobalvar': return toStr(getVar(global, a0));
            case 'addglobalvar': addVar(global, a0, args.slice(1).join('::')); return '';
            case 'incglobalvar': { const v = (numOr(getVar(global, a0)) || 0) + 1; setVar(global, a0, v); return String(v); }
            case 'decglobalvar': { const v = (numOr(getVar(global, a0)) || 0) - 1; setVar(global, a0, v); return String(v); }
            case 'outlet': return ctx.outlets?.[a0] ?? '';
            case 'get_message_variable': case 'get_chat_variable': case 'get_global_variable': {
                const store = name === 'get_message_variable' ? (ctx.msgVars?.() || {}) : name === 'get_chat_variable' ? local : global;
                const v = _.get(store, a0);
                return toStr(v);
            }
            case 'format_message_variable': case 'format_chat_variable': case 'format_global_variable': {
                const store = name === 'format_message_variable' ? (ctx.msgVars?.() || {}) : name === 'format_chat_variable' ? local : global;
                const v = _.get(store, a0);
                if (v === undefined) return '';
                return typeof v === 'object' ? YAML.stringify(v).trimEnd() : String(v);
            }
            default: return undefined;
        }
    }

    function sub(str) {
        if (typeof str !== 'string' || str.indexOf('{{') < 0) return str;
        let out = '';
        let i = 0;
        for (;;) {
            const s = str.indexOf('{{', i);
            if (s < 0) { out += str.slice(i); break; }
            out += str.slice(i, s);
            // comments: {{// ... }} — remove without parsing inside
            if (str.startsWith('{{//', s)) {
                const e = str.indexOf('}}', s + 4);
                if (e < 0) { out += str.slice(s); break; }
                i = e + 2;
                continue;
            }
            let depth = 0, j = s, end = -1;
            while (j < str.length) {
                if (str.startsWith('{{', j)) { depth++; j += 2; }
                else if (str.startsWith('}}', j)) { depth--; j += 2; if (depth === 0) { end = j; break; } }
                else j++;
            }
            if (end < 0) { out += str.slice(s); break; }
            const inner = sub(str.slice(s + 2, end - 2));
            const r = evalMacro(inner);
            out += r === undefined ? '{{' + inner + '}}' : r;
            i = end;
        }
        return out;
    }

    return function substitute(str) {
        if (typeof str !== 'string') return str;
        let r = sub(str);
        if (r.includes(TRIM)) r = r.replace(/\s*\u0000TRIM\u0000\s*/g, '');
        return r;
    };
}
