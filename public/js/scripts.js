// Imported TavernHelper-style scripts (run in hidden iframes with the shim) and slash-command quick replies.
import { state, generate, stopGen, saveSettings } from './app.js';
import { toast } from './ui.js';

const frames = new Map(); // script id -> iframe

/** (Re)start every enabled script; scripts that were turned off are torn down. */
export function startScripts() {
    const list = state.settings?.scripts || [];
    const want = new Set(list.filter(s => s.enabled).map(s => s.id));
    for (const [id, f] of frames) if (!want.has(id)) { f.remove(); frames.delete(id); }
    for (const s of list) {
        if (!s.enabled || frames.has(s.id)) continue;
        const f = document.createElement('iframe');
        f.className = 'script-frame';
        f.dataset.scriptid = s.id;
        f.dataset.mesid = '-1';
        f.style.display = 'none';
        f.srcdoc = `<!doctype html><html><head><meta charset="utf-8">
<script src="/vendor/jquery-3.5.1.min.js"><\/script><script src="/vendor/lodash.min.js"><\/script><script src="/vendor/zod.umd.js"><\/script>
<script>window.z=(parent.z&&parent.z.object)?parent.z:window.Zod<\/script><script src="/js/th-shim.js"><\/script></head><body>
<script type="module">${String(s.content || '').replace(/<\/script/gi, '<\\/script')}<\/script></body></html>`;
        document.body.append(f);
        frames.set(s.id, f);
    }
}

export function restartScript(id) {
    frames.get(id)?.remove();
    frames.delete(id);
    startScripts();
}

/** Buttons that enabled scripts registered (static list from import, or replaced at runtime). */
export function scriptButtons() {
    const out = [];
    for (const s of state.settings?.scripts || []) {
        if (!s.enabled) continue;
        const list = window.LT.getScriptButtons(s.id) || s.buttons || [];
        for (const b of list) if (b.visible !== false && b.name) out.push({ id: s.id, name: b.name, script: s.name });
    }
    return out;
}

export function pressButton(id, name) {
    window.LT.emit(`lt-button:${id}:${name}`);
}

/**
 * Minimal STscript: /send /sendas /sys /trigger /gen /continue /regenerate /stop /setinput /echo /setvar /getvar.
 * Text without a leading slash is sent as a user message.
 */
export async function runSlash(cmd) {
    const text = String(cmd ?? '').trim();
    if (!text) return '';
    if (!text.startsWith('/')) { await generate('normal', text); return ''; }
    const parts = text.split(/\|(?=\s*\/)/).map(s => s.trim());
    let result = '';
    let pendingSend = null;
    for (const p of parts) {
        const m = p.match(/^\/(\w+)\s*([\s\S]*)$/);
        if (!m) continue;
        const name = m[1].toLowerCase();
        const arg = m[2].replace(/{{pipe}}/gi, result);
        const clean = arg.replace(/^(?:\w+=(?:"[^"]*"|\S+)\s+)*/, '');
        switch (name) {
            case 'send': pendingSend = clean; break;
            case 'sendas': case 'sendai': case 'sys': case 'comment': await window.LT.addMessage(false, clean); break;
            case 'trigger': case 'gen': case 'generate':
                if (pendingSend !== null) { await generate('normal', pendingSend); pendingSend = null; } else await generate('normal');
                break;
            case 'continue': await generate('continue'); break;
            case 'swipe': case 'regenerate': case 'reroll': await generate('regenerate'); break;
            case 'stop': stopGen(); break;
            case 'setinput': window.LT.setInput(clean); break;
            case 'echo': toast(clean); break;
            case 'setvar': {
                const k = (arg.match(/key=(\S+)/) || [])[1];
                if (k) { const cv = window.LT.chatVars(); cv[k] = arg.replace(/key=\S+\s*/, ''); window.LT.setChatVars(cv); }
                break;
            }
            case 'getvar': result = String(window.LT.chatVars()[clean] ?? ''); break;
            default: console.debug('[Sakura] unsupported slash command', name);
        }
    }
    if (pendingSend !== null) await window.LT.addMessage(true, pendingSend);
    return result;
}

export function setScriptEnabled(id, on) {
    const list = state.settings.scripts.map(s => s.id === id ? { ...s, enabled: on } : s);
    saveSettings({ scripts: list });
    startScripts();
}
