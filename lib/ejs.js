// Small EJS engine compatible with what ST-Prompt-Template cards use
// (<% %>, <%= %>, <%- %>, <%_ _%>, -%>, <%# %>), async, sloppy `with` scope.
import _ from 'lodash';
import YAML from 'yaml';

const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
const cache = new Map();

export function hasEjs(s) {
    return typeof s === 'string' && s.includes('<%');
}

function compile(tpl) {
    if (cache.has(tpl)) return cache.get(tpl);
    let src = tpl.replace(/[ \t]*<%_/g, '<%_').replace(/_%>[ \t]*/g, '_%>');
    const re = /<%([_\-=#]?)([\s\S]*?)([_-]?)%>/g;
    let code = '';
    let last = 0;
    let truncate = false;
    let m;
    while ((m = re.exec(src))) {
        let text = src.slice(last, m.index);
        if (truncate) { text = text.replace(/^(?:\r\n|\r|\n)/, ''); truncate = false; }
        if (text) code += `__o.push(${JSON.stringify(text)});\n`;
        const [, open, body, close] = m;
        if (open === '=' || open === '-') code += `__o.push(__s(${body}));\n`;
        else if (open !== '#') code += body + '\n';
        if (close === '_' || close === '-') truncate = true;
        last = re.lastIndex;
    }
    let tail = src.slice(last);
    if (truncate) tail = tail.replace(/^(?:\r\n|\r|\n)/, '');
    if (tail) code += `__o.push(${JSON.stringify(tail)});\n`;
    let fn;
    try {
        fn = new AsyncFunction('__ctx', '__o', '__s', `with (__ctx) {\n${code}\n}`);
    } catch (e) {
        fn = e;
    }
    if (cache.size > 2000) cache.clear();
    cache.set(tpl, fn);
    return fn;
}

const toS = v => (v === undefined || v === null) ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * Render an EJS template.
 * @param {string} tpl
 * @param {object} env  { vars: {global, local, message()}, chat, worldLookup(world, name), user, char, onError }
 */
export async function renderEjs(tpl, env) {
    if (!hasEjs(tpl)) return tpl;
    const fn = compile(tpl);
    if (fn instanceof Error) {
        env.onError?.(fn, tpl);
        return stripEjs(tpl);
    }
    const out = [];
    const ctx = buildContext(env, out);
    try {
        await fn(ctx, out, toS);
        return out.join('');
    } catch (e) {
        env.onError?.(e, tpl);
        return stripEjs(tpl);
    }
}

export function stripEjs(tpl) {
    return String(tpl).replace(/<%[\s\S]*?%>/g, '');
}

function msgText(m) { return m ? String(m.mes ?? '') : ''; }

function buildContext(env, out) {
    const v = env.vars;
    const msgVars = () => v.message?.() || {};
    const merged = () => _.merge({}, v.global, v.local, msgVars());
    const pick = (store, path, opts) => {
        const r = path === undefined || path === null || path === '' ? store : _.get(store, path);
        return r === undefined ? opts?.defaults : r;
    };
    const scopeStore = (scope) => scope === 'global' ? v.global : (scope === 'message' ? msgVars() : v.local);
    const chat = env.chat || [];
    const visible = () => chat.filter(m => !m.is_system);
    const ctx = {
        _,
        YAML,
        JSON,
        console: { log() { }, warn() { }, error() { }, info() { } },
        print: (...a) => { out.push(a.map(toS).join('')); },
        getvar: (path, opts = {}) => opts.scope ? pick(scopeStore(opts.scope), path, opts) : pick(merged(), path, opts),
        setvar: (path, value, opts = {}) => { _.set(scopeStore(opts.scope || 'local'), path, value); return value; },
        incvar: (path, n = 1, opts = {}) => { const s = scopeStore(opts.scope || 'local'); const r = (Number(_.get(s, path)) || 0) + n; _.set(s, path, r); return r; },
        decvar: (path, n = 1, opts = {}) => { const s = scopeStore(opts.scope || 'local'); const r = (Number(_.get(s, path)) || 0) - n; _.set(s, path, r); return r; },
        delvar: (path, opts = {}) => { _.unset(scopeStore(opts.scope || 'local'), path); },
        getLocalVar: (path, opts) => pick(v.local, path, opts),
        setLocalVar: (path, value) => { _.set(v.local, path, value); return value; },
        getGlobalVar: (path, opts) => pick(v.global, path, opts),
        setGlobalVar: (path, value) => { _.set(v.global, path, value); return value; },
        getMessageVar: (path, opts) => pick(msgVars(), path, opts),
        setMessageVar: (path, value) => { _.set(msgVars(), path, value); return value; },
        getChatVar: (path, opts) => pick(v.local, path, opts),
        setChatVar: (path, value) => { _.set(v.local, path, value); return value; },
        getwi: async (a, b) => {
            const [world, name] = b === undefined ? [null, a] : [a, b];
            const r = await env.worldLookup?.(world, name);
            return r ?? '';
        },
        getWorldInfo: async (a, b) => ctx.getwi(a, b),
        getchar: () => env.char,
        getChatMessage: (idx, role) => {
            let list = visible();
            if (role) list = list.filter(m => (role === 'user') === !!m.is_user);
            const i = idx < 0 ? list.length + idx : idx;
            return msgText(list[i]);
        },
        getChatMessages: (start, end, role) => {
            let list = visible();
            if (role) list = list.filter(m => (role === 'user') === !!m.is_user);
            return list.slice(start ?? 0, end === undefined ? undefined : end).map(msgText);
        },
        matchChatMessages: (pattern, opts = {}) => {
            const list = visible();
            const start = opts.start ?? Math.max(0, list.length - 2);
            const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            return list.slice(start, opts.end).some(m => re.test(msgText(m)));
        },
        activateWorldInfo: async () => null,
        activewi: async () => null,
        define: (name, value) => { ctx[name] = value; },
        execute: async () => '',
        evalTemplate: async (t) => renderEjs(t, env),
        user: env.user, char: env.char, userName: env.user, charName: env.char,
        assistantName: env.char,
        lastUserMessage: msgText([...visible()].reverse().find(m => m.is_user)),
        lastCharMessage: msgText([...visible()].reverse().find(m => !m.is_user)),
        lastMessageId: Math.max(0, chat.length - 1),
        chatId: env.chatId || '',
        characterId: env.char,
        runType: env.genType || 'generate',
        get variables() { return merged(); },
        SillyTavern: { chat },
        faker: undefined,
    };
    return ctx;
}
