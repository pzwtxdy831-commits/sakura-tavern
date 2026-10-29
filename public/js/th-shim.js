// TavernHelper (JS-Slash-Runner) compatible API inside message iframes. Same-origin, talks to parent.LT.
(function () {
    'use strict';
    const P = window.parent;
    const LT = P && P.LT;
    if (!LT) return;
    const frame = window.frameElement;
    // surface frontend errors in the main console (iframe consoles are easy to miss)
    window.addEventListener('error', e => P.console.warn('[frontend]', e.message, e.filename || '', e.lineno || ''));
    window.addEventListener('unhandledrejection', e => P.console.warn('[frontend] unhandled', e.reason?.message || e.reason));
    const myId = () => Number(frame?.dataset?.mesid ?? LT.lastMessageId());

    // auto height
    // measure the body, not the document: content using 100vh would otherwise grow the frame forever
    let grows = 0, lastH = 0;
    const fit = () => {
        if (!frame || !document.body) return;
        const cs = getComputedStyle(document.body);
        const h = Math.ceil(document.body.scrollHeight + parseFloat(cs.marginTop || 0) + parseFloat(cs.marginBottom || 0));
        if (!h || Math.abs(frame.offsetHeight - h) <= 1) return;
        if (h > lastH && lastH) { if (++grows > 12) return; } else grows = 0;
        lastH = h;
        frame.style.height = h + 'px';
    };
    const ro = new ResizeObserver(fit);
    const watchBody = () => { if (document.body) ro.observe(document.body); else setTimeout(watchBody, 50); };
    watchBody();
    setInterval(() => { grows = 0; }, 4000);
    window.addEventListener('load', fit);
    setInterval(fit, 1500);

    const resolveId = (id) => {
        if (id === undefined || id === null || id === 'current') return myId();
        if (id === 'latest' || id === -1) return LT.lastMessageId();
        if (typeof id === 'number' && id < 0) return LT.lastMessageId() + 1 + id;
        return Number(id);
    };

    function getVariables(opt = {}) {
        const type = opt.type || 'chat';
        if (type === 'message') return _.cloneDeep(LT.getMsgVars(resolveId(opt.message_id)) || {});
        if (type === 'global') return _.cloneDeep(LT.globalVars());
        if (type === 'script' || type === 'extension') return _.cloneDeep(LT.scriptVars(opt.script_id || scriptId()));
        if (type === 'character') return {};
        return _.cloneDeep(LT.chatVars());
    }
    function replaceVariables(vars, opt = {}) {
        const type = opt.type || 'chat';
        if (type === 'message') return LT.setMsgVars(resolveId(opt.message_id), _.cloneDeep(vars));
        if (type === 'global') return LT.setGlobalVars(_.cloneDeep(vars));
        if (type === 'script' || type === 'extension') return LT.setScriptVars(opt.script_id || scriptId(), vars);
        return LT.setChatVars(_.cloneDeep(vars));
    }
    function updateVariablesWith(fn, opt = {}) {
        const v = getVariables(opt);
        const r = fn(v) || v;
        replaceVariables(r, opt);
        return r;
    }
    const insertOrAssignVariables = (vars, opt) => updateVariablesWith(v => _.merge(v, vars), opt);
    const insertVariables = (vars, opt) => updateVariablesWith(v => _.defaultsDeep(v, vars), opt);
    const deleteVariable = (path, opt) => { let ok = false; updateVariablesWith(v => { ok = _.unset(v, path); return v; }, opt); return { variables: getVariables(opt), delete_occurred: ok }; };

    function parseRange(range) {
        const last = LT.lastMessageId();
        if (range === undefined) return [0, last];
        if (typeof range === 'number') { const i = range < 0 ? last + 1 + range : range; return [i, i]; }
        const s = String(range).replace(/{{lastMessageId}}/g, String(last));
        const m = s.match(/^(-?\d+)(?:-(-?\d+))?$/);
        if (!m) return [last, last];
        let a = Number(m[1]), b = m[2] !== undefined ? Number(m[2]) : a;
        if (a < 0) a = last + 1 + a;
        if (b < 0) b = last + 1 + b;
        return [Math.min(a, b), Math.max(a, b)];
    }
    function getChatMessages(range, opt = {}) {
        const [a, b] = parseRange(range);
        const out = [];
        for (let i = a; i <= b; i++) {
            const m = LT.getMessage(i);
            if (!m) continue;
            const role = m.user ? 'user' : 'assistant';
            if (opt.role && opt.role !== 'all' && opt.role !== role) continue;
            if (opt.hide_state === 'hidden' && !m.hidden) continue;
            if (opt.hide_state === 'unhidden' && m.hidden) continue;
            out.push({
                message_id: i, name: m.name, role, is_hidden: !!m.hidden, message: m.mes,
                data: _.cloneDeep(LT.getMsgVars(i) || {}), extra: {}, swipe_id: m.sid, swipes: opt.include_swipes ? [m.mes] : undefined,
            });
        }
        return out;
    }
    async function setChatMessages(list) { for (const x of list || []) if (x.message !== undefined) await LT.editMessage(resolveId(x.message_id), x.message); if (list?.some(x => x.data)) for (const x of list) if (x.data) LT.setMsgVars(resolveId(x.message_id), x.data); }
    async function setChatMessage(field, id) { if (field.message !== undefined) await LT.editMessage(resolveId(id), field.message); if (field.data) LT.setMsgVars(resolveId(id), field.data); }
    async function createChatMessages(list) { for (const x of list || []) await LT.addMessage(x.role === 'user', x.message || '', x.name); }
    async function deleteChatMessages(ids) { for (const id of [...ids].map(resolveId).sort((a, b) => b - a)) await LT.deleteMessage(id); }

    const triggerSlash = (cmd) => LT.runSlash(cmd);
    const scriptId = () => frame?.dataset?.scriptid || 'frame';
    const buttonEvent = (name) => `lt-button:${scriptId()}:${name}`;

    // ── worldbooks (TavernHelper entry shape <-> SillyTavern world file) ──
    const POS = ['before_character_definition', 'after_character_definition', 'before_author_note', 'after_author_note', 'at_depth', 'before_example_messages', 'after_example_messages', 'outlet'];
    const LOGIC = ['and_any', 'not_all', 'not_any', 'and_all'];
    const ROLES = ['system', 'user', 'assistant'];
    function toTH(e) {
        return {
            uid: e.uid, name: e.comment || '', enabled: !e.disable,
            strategy: {
                type: e.constant ? 'constant' : (e.vectorized ? 'vectorized' : 'selective'),
                keys: e.key || [],
                keys_secondary: { logic: LOGIC[e.selectiveLogic || 0], keys: e.keysecondary || [] },
                scan_depth: e.scanDepth ?? 'same_as_global',
            },
            position: { type: POS[e.position ?? 0] || 'before_character_definition', role: ROLES[e.role || 0], depth: e.depth ?? 4, order: e.order ?? 100 },
            content: e.content || '',
            probability: e.probability ?? 100,
            recursion: { prevent_incoming: !!e.excludeRecursion, prevent_outgoing: !!e.preventRecursion, delay_until: e.delayUntilRecursion ? 1 : null },
            effect: { sticky: e.sticky ?? null, cooldown: e.cooldown ?? null, delay: e.delay ?? null },
            extra: e.extra || {},
        };
    }
    function fromTH(t, orig = {}) {
        const e = { ...orig };
        e.uid = t.uid ?? orig.uid;
        if (t.name !== undefined) e.comment = t.name;
        if (t.enabled !== undefined) e.disable = !t.enabled;
        if (t.content !== undefined) e.content = t.content;
        if (t.probability !== undefined) { e.probability = t.probability; e.useProbability = t.probability < 100; }
        const s = t.strategy;
        if (s) {
            if (s.type) { e.constant = s.type === 'constant'; e.vectorized = s.type === 'vectorized'; }
            if (s.keys) e.key = s.keys;
            if (s.keys_secondary) { e.keysecondary = s.keys_secondary.keys || []; e.selectiveLogic = Math.max(0, LOGIC.indexOf(s.keys_secondary.logic)); e.selective = e.keysecondary.length > 0; }
            if (s.scan_depth !== undefined) e.scanDepth = s.scan_depth === 'same_as_global' ? null : s.scan_depth;
        }
        const p = t.position;
        if (p) {
            if (p.type) e.position = Math.max(0, POS.indexOf(p.type));
            if (p.role) e.role = Math.max(0, ROLES.indexOf(p.role));
            if (p.depth !== undefined) e.depth = p.depth;
            if (p.order !== undefined) e.order = p.order;
        }
        if (t.recursion) { e.excludeRecursion = !!t.recursion.prevent_incoming; e.preventRecursion = !!t.recursion.prevent_outgoing; e.delayUntilRecursion = !!t.recursion.delay_until; }
        if (t.extra) e.extra = t.extra;
        return e;
    }
    async function getWorldbook(name) {
        const w = await LT.getWorld(name);
        return Object.values(w?.entries || {}).sort((a, b) => (a.displayIndex ?? a.uid) - (b.displayIndex ?? b.uid)).map(toTH);
    }
    async function replaceWorldbook(name, list) {
        const w = (await LT.getWorld(name)) || { entries: {} };
        const old = w.entries || {};
        const entries = {};
        let next = Math.max(-1, ...Object.keys(old).map(Number)) + 1;
        for (const t of list) {
            const uid = t.uid ?? next++;
            entries[uid] = fromTH({ ...t, uid }, old[uid] || { uid, key: [], keysecondary: [], displayIndex: uid });
        }
        await LT.saveWorld(name, { ...w, entries });
        return list;
    }
    async function updateWorldbookWith(name, fn) {
        const list = await getWorldbook(name);
        const r = (await fn(list)) || list;
        await replaceWorldbook(name, r);
        return r;
    }
    const charBooks = () => ({ primary: LT.charData()?.world || null, additional: [] });

    const listeners = {};
    function eventOn(name, fn) { (listeners[name] ??= new Set()).add(fn); LT.on(name, fn); return { stop: () => eventRemoveListener(name, fn) }; }
    function eventOnce(name, fn) { const w = (...a) => { eventRemoveListener(name, w); fn(...a); }; return eventOn(name, w); }
    function eventRemoveListener(name, fn) { listeners[name]?.delete(fn); LT.off(name, fn); }
    async function eventEmit(name, ...args) { LT.emit(name, ...args); }
    window.addEventListener('unload', () => { for (const [n, set] of Object.entries(listeners)) for (const fn of set) LT.off(n, fn); });

    const tavern_events = {
        APP_READY: 'app_ready', MESSAGE_SENT: 'message_sent', MESSAGE_RECEIVED: 'message_received', MESSAGE_EDITED: 'message_edited',
        MESSAGE_DELETED: 'message_deleted', MESSAGE_SWIPED: 'message_swiped', MESSAGE_UPDATED: 'message_updated', CHAT_CHANGED: 'chat_id_changed',
        GENERATION_STARTED: 'generation_started', GENERATION_ENDED: 'generation_ended', GENERATION_STOPPED: 'generation_stopped',
        CHARACTER_MESSAGE_RENDERED: 'character_message_rendered', USER_MESSAGE_RENDERED: 'user_message_rendered', STREAM_TOKEN_RECEIVED: 'stream_token_received',
        CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready', GENERATE_AFTER_DATA: 'generate_after_data', SETTINGS_UPDATED: 'settings_updated',
    };
    const iframe_events = { MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started', MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended', GENERATION_STARTED: 'js_generation_started', STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully', STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally', GENERATION_ENDED: 'js_generation_ended' };

    const Mvu = {
        events: { VARIABLE_INITIALIZED: 'mag_variable_initialized', VARIABLE_UPDATE_STARTED: 'mag_variable_update_started', COMMAND_PARSED: 'mag_command_parsed', VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended', BEFORE_MESSAGE_UPDATE: 'mag_before_message_update' },
        getMvuData: (opt = {}) => getVariables({ type: opt.type || 'message', message_id: opt.message_id }),
        replaceMvuData: async (data, opt = {}) => replaceVariables(data, { type: opt.type || 'message', message_id: opt.message_id }),
        parseMessage: async (text, old) => LT.parseMvu(text, old),
        getRecordFromMvuData: (d, p) => _.get(d?.stat_data, p),
        setMvuVariable: async (d, path, value) => { _.set(d.stat_data, path, value); return true; },
        getMvuVariable: (d, path, opt = {}) => { const v = _.get(d?.stat_data, path); return v === undefined ? opt.default_value : v; },
        reloadInitVar: async () => false,
    };

    const api = {
        getVariables, replaceVariables, updateVariablesWith, insertOrAssignVariables, insertVariables, deleteVariable,
        getChatMessages, setChatMessages, setChatMessage, createChatMessages, deleteChatMessages,
        triggerSlash, triggerSlashWithResult: triggerSlash,
        getCurrentMessageId: myId, getLastMessageId: () => LT.lastMessageId(), getMessageId: () => myId(),
        eventOn, eventOnce, eventMakeLast: eventOn, eventMakeFirst: eventOn, eventOnButton: (n, fn) => eventOn(buttonEvent(n), fn), eventRemoveListener, eventClearEvent: () => { }, eventClearListener: () => { }, eventClearAll: () => { }, eventEmit, eventEmitAndWait: eventEmit,
        tavern_events, iframe_events, Mvu,
        waitGlobalInitialized: async () => { },
        errorCatched: (fn) => fn,
        substitudeMacros: (t) => LT.macro(t),
        getCharData: () => LT.charData(), getCharAvatarPath: () => LT.charAvatar(), getUserAvatarPath: () => LT.userAvatar(),
        getChatHistoryBrief: () => [], getChatHistoryDetail: () => [],
        getCurrentCharPrimaryLorebook: () => LT.charData()?.world || null, getCharLorebooks: charBooks,
        getWorldbook, replaceWorldbook, updateWorldbookWith,
        createWorldbookEntries: async (name, list) => updateWorldbookWith(name, l => [...l, ...list]),
        deleteWorldbookEntries: async (name, pred) => updateWorldbookWith(name, l => l.filter(e => !pred(e))),
        getLorebookEntries: async (name) => getWorldbook(name),
        getWorldbookNames: () => LT.worldNames(), getLorebooks: () => LT.worldNames(),
        getGlobalWorldbookNames: () => LT.globalWorlds(), getCharWorldbookNames: charBooks,
        getChatWorldbookName: () => null,
        getTavernHelperVersion: () => '4.9.0', getFrontendVersion: () => '4.9.0', getTavernVersion: () => '1.19.0',
        generate: async (cfg = {}) => { if (cfg.user_input) await LT.addMessage(true, cfg.user_input); return LT.generate('normal'); },
        generateRaw: async () => '',
        stopAllGeneration: () => LT.stop(),
        builtin: {}, reloadIframe: () => location.reload(),
        toastr: { success: (m) => LT.toast(m), info: (m) => LT.toast(m), warning: (m) => LT.toast(m), error: (m) => LT.toast(m, true) },
        SillyTavern: { getContext: () => LT.stContext(), get chat() { return LT.stContext().chat; }, saveChat: async () => { }, reloadCurrentChat: async () => LT.reloadChat() },
        getScriptId: scriptId, getIframeName: () => 'message-iframe-' + myId(),
        formatAsTavernRegexedString: (t) => t,
        getButtonEvent: buttonEvent, replaceScriptButtons: (list) => LT.setScriptButtons(scriptId(), list), getScriptButtons: () => LT.getScriptButtons(scriptId()) || [],
        appendInexistentScriptButtons: (list) => { const cur = LT.getScriptButtons(scriptId()) || []; LT.setScriptButtons(scriptId(), [...cur, ...list.filter(b => !cur.some(c => c.name === b.name))]); },
    };
    for (const [k, v] of Object.entries(api)) if (!(k in window)) window[k] = v;
    window.TavernHelper = api;
    if (P.z && P.z.object) window.z = P.z;
    window.YAML ??= P.YAML;
})();
