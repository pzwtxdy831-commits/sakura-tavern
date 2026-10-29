// MVU (MagVarUpdate) compatible variable updates.
// Variables live per message: message.variables[swipe_id] = { stat_data, display_data, delta_data, ... }.
import _ from 'lodash';
import YAML from 'yaml';

export function latestVars(messages, beforeIndex = messages.length) {
    for (let i = Math.min(beforeIndex, messages.length) - 1; i >= 0; i--) {
        const m = messages[i];
        const v = msgVars(m);
        if (v && Object.keys(v).length) return v;
    }
    return null;
}

export function msgVars(m) {
    if (!m || !m.variables) return null;
    if (Array.isArray(m.variables)) return m.variables[m.swipe_id ?? 0] || null;
    return m.variables;
}

export function setMsgVars(m, vars) {
    const sid = m.swipe_id ?? 0;
    if (!Array.isArray(m.variables)) m.variables = [];
    m.variables[sid] = vars;
}

function parseValue(raw) {
    if (raw === undefined) return undefined;
    const s = String(raw).trim();
    if (s === '') return '';
    try { return JSON.parse(s); } catch { /* */ }
    try { return YAML.parse(s); } catch { /* */ }
    // JS-ish single-quoted string
    const q = s.match(/^'([\s\S]*)'$/);
    if (q) return q[1].replace(/\\'/g, "'");
    return s;
}

/** Split a call argument list at top-level commas. */
function splitArgs(s) {
    const out = [];
    let depth = 0, cur = '', str = null;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (str) {
            cur += c;
            if (c === '\\') { cur += s[++i] ?? ''; continue; }
            if (c === str) str = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { str = c; cur += c; continue; }
        if ('[{('.includes(c)) depth++;
        if (']})'.includes(c)) depth--;
        if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
        cur += c;
    }
    if (cur.trim()) out.push(cur);
    return out.map(x => x.trim());
}

/** Find `_.fn(args)` calls, matching parentheses while respecting quoted strings. */
function findCalls(text) {
    const out = [];
    const re = /_\.(set|add|insert|assign|remove|unset|delete)\s*\(/g;
    let m;
    while ((m = re.exec(text))) {
        let i = re.lastIndex, depth = 1, str = null;
        for (; i < text.length; i++) {
            const c = text[i];
            if (str) {
                if (c === '\\') { i++; continue; }
                if (c === str) str = null;
                continue;
            }
            if (c === '"' || c === "'" || c === '`') { str = c; continue; }
            if (c === '(' || c === '[' || c === '{') depth++;
            else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) break; }
        }
        out.push({ fn: m[1], args: text.slice(re.lastIndex, i) });
        re.lastIndex = i + 1;
    }
    return out;
}

function unq(s) {
    s = String(s ?? '').trim();
    const m = s.match(/^(['"`])([\s\S]*)\1$/);
    return m ? m[2] : s;
}

function normPath(p) {
    p = String(p).trim();
    if (p.startsWith('/')) {
        return p.slice(1).split('/').map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'));
    }
    return _.toPath(p);
}

/** Value with MVU's legacy [value, description] tuple support. */
function setValue(root, pathArr, value) {
    const cur = _.get(root, pathArr);
    if (Array.isArray(cur) && cur.length === 2 && typeof cur[1] === 'string' && !Array.isArray(value)) {
        _.set(root, [...pathArr, 0], value);
    } else {
        _.set(root, pathArr, value);
    }
}
function getNum(root, pathArr) {
    let cur = _.get(root, pathArr);
    if (Array.isArray(cur) && cur.length === 2 && typeof cur[1] === 'string') cur = cur[0];
    return Number(cur) || 0;
}

/** Extract update commands from message text. */
export function extractUpdateBlock(text) {
    const s = String(text || '');
    const re = /<(UpdateVariable|update)>([\s\S]*?)(?:<\/\1>|$)/gi;
    let m, last = null;
    while ((m = re.exec(s))) last = m[2];
    return last;
}

/** Apply MVU commands found in text to stat_data. Returns {vars, changed:[paths]} */
export function applyUpdates(prevVars, text) {
    const vars = prevVars ? _.cloneDeep(prevVars) : {};
    vars.stat_data ??= {};
    const stat = vars.stat_data;
    const block = extractUpdateBlock(text);
    const changed = [];
    if (!block) return { vars, changed, found: false };

    // JSON Patch
    const jp = block.match(/<JSONPatch>([\s\S]*?)(?:<\/JSONPatch>|$)/i);
    const jsonText = jp ? jp[1] : (block.trim().startsWith('[') ? block.trim() : null);
    if (jsonText) {
        let ops = null;
        const cleaned = jsonText.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim();
        try { ops = JSON.parse(cleaned); } catch { try { ops = YAML.parse(cleaned); } catch { /* */ } }
        if (Array.isArray(ops)) {
            for (const op of ops) {
                if (!op || !op.path) continue;
                const p = normPath(op.path);
                try {
                    switch (String(op.op || '').toLowerCase()) {
                        case 'replace': case 'add': case 'assign': case 'insert': {
                            const parent = _.get(stat, p.slice(0, -1));
                            const last = p[p.length - 1];
                            if (Array.isArray(parent) && (last === '-' || op.op === 'insert' || op.op === 'add') && (last === '-' || /^\d+$/.test(last))) {
                                if (last === '-') parent.push(op.value);
                                else parent.splice(Number(last), 0, op.value);
                            } else setValue(stat, p, op.value);
                            break;
                        }
                        case 'remove': case 'delete': {
                            const parent = _.get(stat, p.slice(0, -1));
                            const last = p[p.length - 1];
                            if (Array.isArray(parent) && /^\d+$/.test(last)) parent.splice(Number(last), 1);
                            else _.unset(stat, p);
                            break;
                        }
                        case 'delta': case 'increment': setValue(stat, p, getNum(stat, p) + Number(op.value || 0)); break;
                        case 'move': {
                            const from = normPath(op.from);
                            const v = _.get(stat, from);
                            _.unset(stat, from);
                            setValue(stat, p, v);
                            break;
                        }
                        default: continue;
                    }
                    changed.push(p.join('.'));
                } catch { /* skip bad op */ }
            }
        }
    }

    // _.set / _.add / _.insert / _.remove / _.delete calls
    for (const call of findCalls(block)) {
        const fn = call.fn;
        const args = splitArgs(call.args);
        if (!args.length) continue;
        const p = normPath(unq(args[0]));
        try {
            if (fn === 'set') {
                const v = parseValue(args.length >= 3 ? args[2] : args[1]);
                setValue(stat, p, v);
            } else if (fn === 'add') {
                const cur = _.get(stat, p);
                const v = parseValue(args[1]);
                if (Array.isArray(cur) && !(cur.length === 2 && typeof cur[1] === 'string' && typeof cur[0] === 'number')) cur.push(v);
                else if (typeof v === 'number' || (typeof cur === 'number') || (Array.isArray(cur) && typeof cur[0] === 'number')) setValue(stat, p, getNum(stat, p) + Number(v || 0));
                else if (cur && typeof cur === 'object' && v && typeof v === 'object') Object.assign(cur, v);
                else setValue(stat, p, v);
            } else if (fn === 'insert' || fn === 'assign') {
                const cur = _.get(stat, p);
                if (args.length >= 3) {
                    const k = parseValue(args[1]);
                    const v = parseValue(args[2]);
                    if (Array.isArray(cur) && typeof k === 'number') cur.splice(k, 0, v);
                    else _.set(stat, [...p, String(k)], v);
                } else {
                    const v = parseValue(args[1]);
                    if (Array.isArray(cur)) cur.push(v);
                    else if (cur && typeof cur === 'object' && v && typeof v === 'object') Object.assign(cur, v);
                    else _.set(stat, p, v);
                }
            } else {
                if (args.length >= 2) {
                    const cur = _.get(stat, p);
                    const k = parseValue(args[1]);
                    if (Array.isArray(cur)) {
                        const idx = typeof k === 'number' ? k : cur.findIndex(x => _.isEqual(x, k));
                        if (idx >= 0) cur.splice(idx, 1);
                    } else if (cur && typeof cur === 'object') delete cur[String(k)];
                } else _.unset(stat, p);
            }
            changed.push(p.join('.'));
        } catch { /* skip */ }
    }
    vars.delta_data = {};
    for (const c of changed) _.set(vars.delta_data, c, _.get(stat, c));
    vars.display_data = stat;
    return { vars, changed, found: true };
}

/** Build initial variables from [InitVar] lorebook entries. */
export function initVarsFromWorlds(worlds) {
    const stat = {};
    for (const w of worlds) {
        for (const e of Object.values(w?.data?.entries || {})) {
            if (!/\[initvar\]/i.test(e.comment || '')) continue;
            const c = String(e.content || '').trim();
            let v = null;
            try { v = JSON.parse(c); } catch { try { v = YAML.parse(c); } catch { /* */ } }
            if (v && typeof v === 'object') _.merge(stat, v);
        }
    }
    return Object.keys(stat).length ? { stat_data: stat, display_data: stat, delta_data: {} } : null;
}
