// SillyTavern-compatible regex scripts. Shared by server (prompt) and client (display).

export const PLACEMENT = { USER: 1, AI: 2, SLASH: 3, WORLD: 5, REASONING: 6 };

const cache = new Map();

export function regexFromString(input) {
    if (cache.has(input)) return cache.get(input);
    let re;
    try {
        const m = String(input).match(/(\/?)(.+)\1([a-z]*)/is);
        if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJdyv]+$/.test(m[3])) re = new RegExp(input);
        else re = new RegExp(m[2], m[3]);
    } catch {
        re = null;
    }
    if (cache.size > 500) cache.clear();
    cache.set(input, re);
    return re;
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {object} script ST regex script
 * @param {string} text
 * @param {(s:string)=>string} macro macro substitution
 */
export function runRegexScript(script, text, macro = s => s) {
    if (!script || script.disabled || !script.findRegex || !text) return text;
    let find = script.findRegex;
    if (script.substituteRegex === 1) find = macro(find);
    else if (script.substituteRegex === 2) find = macro(find).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = regexFromString(find);
    if (!re) return text;
    re.lastIndex = 0;
    const replaceTpl = String(script.replaceString ?? '').replace(/{{match}}/gi, '$0');
    const trims = script.trimStrings || [];
    return text.replace(re, function (...args) {
        const hasGroups = typeof args[args.length - 1] === 'object';
        const groups = hasGroups ? args[args.length - 1] : {};
        const out = replaceTpl.replace(/\$(\d+)|\$<([^>]+)>/g, (_, num, name) => {
            let v = num !== undefined ? args[Number(num)] : groups?.[name];
            if (typeof v !== 'string' || !v) return '';
            for (const t of trims) v = v.split(macro(t)).join('');
            return v;
        });
        return macro(out);
    });
}

/**
 * Apply a list of scripts.
 * @param {object[]} scripts
 * @param {string} text
 * @param {{placement:number, mode:'display'|'prompt'|'store', depth?:number|null, isEdit?:boolean}} opt
 */
export function applyRegex(scripts, text, opt, macro) {
    if (!text || !scripts?.length) return text;
    for (const s of scripts) {
        if (!s || s.disabled) continue;
        if (!Array.isArray(s.placement) || !s.placement.includes(opt.placement)) continue;
        if (opt.mode === 'display' && !s.markdownOnly) continue;
        if (opt.mode === 'prompt' && !s.promptOnly) continue;
        if (opt.mode === 'store' && (s.markdownOnly || s.promptOnly)) continue;
        if (opt.mode === 'store' && opt.isEdit && !s.runOnEdit) continue;
        if (opt.depth !== null && opt.depth !== undefined) {
            if (s.minDepth !== null && s.minDepth !== undefined && s.minDepth !== '' && Number(s.minDepth) >= -1 && opt.depth < Number(s.minDepth)) continue;
            if (s.maxDepth !== null && s.maxDepth !== undefined && s.maxDepth !== '' && Number(s.maxDepth) >= 0 && opt.depth > Number(s.maxDepth)) continue;
        }
        text = runRegexScript(s, text, macro);
    }
    return text;
}

export { escapeRe };
