// UI helpers: element builder, icons, toast, modal, api.

// Views build child lists with `cond ? el : null`; let replaceChildren/append skip empty slots instead of printing "null".
for (const name of ['replaceChildren', 'append']) {
    const orig = Element.prototype[name];
    Element.prototype[name] = function (...nodes) { return orig.apply(this, nodes.filter(n => n !== null && n !== undefined && n !== false)); };
}

export function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'html') el.innerHTML = v;
        else if (k in el && typeof v !== 'string') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
}

const P = {
    back: 'M15 18l-6-6 6-6',
    home: 'M3 11l9-8 9 8M5 10v10h14V10',
    send: 'M4 12l16-8-6 16-3-7-7-1z',
    stop: 'M7 7h10v10H7z',
    edit: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
    trash: 'M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13',
    branch: 'M6 3v12M18 9a3 3 0 1 0 0-.01M6 21a3 3 0 1 0 0-.01M18 12c0 4-6 3-12 6',
    left: 'M15 6l-6 6 6 6',
    right: 'M9 6l6 6-6 6',
    redo: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
    cont: 'M5 12h11M12 6l6 6-6 6M20 5v14',
    eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
    eyeoff: 'M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3 3.6M6.6 6.6C3.9 8.3 2 12 2 12s4 7 10 7c1.6 0 3-.4 4.3-1',
    copy: 'M8 8h12v12H8zM4 16V4h12',
    wand: 'M4 20L16 8M14 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 11l.7 1.3L21 13l-1.3.7L19 15l-.7-1.3L17 13l1.3-.7z',
    plus: 'M12 5v14M5 12h14',
    gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1A2 2 0 1 1 4.3 17l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1A2 2 0 1 1 7 4.3l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1A2 2 0 1 1 19.7 7l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    book: 'M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
    upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
    download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    x: 'M6 6l12 12M18 6L6 18',
    check: 'M5 12l5 5 9-10',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3',
    star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
    sakura: 'M12 11c-1.5-2.5-1.8-5.2 0-7.5 1.8 2.3 1.5 5 0 7.5zM12.9 11.7c1.3-2.6 3.5-4.2 6.4-3.9-.6 2.9-3 4.2-6.4 3.9zM12.6 12.8c2.8.6 4.8 2.3 5.4 5.1-2.9.1-4.7-2-5.4-5.1zM11.4 12.8c-.7 3.1-2.5 5.2-5.4 5.1.6-2.8 2.6-4.5 5.4-5.1zM11.1 11.7c-3.4.3-5.8-1-6.4-3.9 2.9-.3 5.1 1.3 6.4 3.9z',
    top: 'M6 15l6-6 6 6M5 5h14',
    bottom: 'M6 9l6 6 6-6M5 19h14',
    plug: 'M9 2v6M15 2v6M7 8h10v4a5 5 0 0 1-10 0zM12 17v5',
    layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
};
/** Long press (touch) / right click (mouse) → onLong; a plain tap/click → onClick. */
export function onLongPress(el, onLong, onClick) {
    let t = null, fired = false, sx = 0, sy = 0;
    el.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        fired = false; sx = e.clientX; sy = e.clientY;
        t = setTimeout(() => { fired = true; t = null; onLong(e); }, 520);
    });
    el.addEventListener('pointermove', e => { if (t && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) { clearTimeout(t); t = null; } });
    el.addEventListener('pointerup', e => {
        if (t) { clearTimeout(t); t = null; }
        if (!fired && !e.target.closest('.icon-btn') && Math.hypot(e.clientX - sx, e.clientY - sy) < 10) onClick?.(e);
    });
    el.addEventListener('pointercancel', () => { if (t) { clearTimeout(t); t = null; } });
    el.addEventListener('contextmenu', e => { e.preventDefault(); if (!fired) onLong(e); fired = false; });
}
export function icon(name, cls = '') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    if (cls) svg.setAttribute('class', cls);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', P[name] || P.more);
    svg.append(path);
    return svg;
}
export function iconBtn(name, title, onclick, cls = '') {
    return h('button', { class: 'icon-btn ' + cls, title, 'aria-label': title, onclick }, icon(name));
}

export function toast(msg, err = false, ms = 2600) {
    const box = document.getElementById('toasts');
    const t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
    box.append(t);
    setTimeout(() => t.remove(), err ? Math.max(ms, 6000) : ms);
}

export function modal({ title, body, foot, wide = false, onClose }) {
    const back = h('div', { class: 'modal-back' });
    const close = () => { back.remove(); onClose?.(); document.removeEventListener('keydown', esc); };
    const esc = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', esc);
    const m = h('div', { class: 'modal' + (wide ? ' wide' : '') },
        h('div', { class: 'modal-head' }, h('h3', {}, title), iconBtn('x', '关闭', close)),
        h('div', { class: 'modal-body' }, body),
        foot ? h('div', { class: 'modal-foot' }, foot) : null);
    back.append(m);
    back.addEventListener('mousedown', e => { if (e.target === back) close(); });
    document.body.append(back);
    return { close, el: m, body: m.querySelector('.modal-body') };
}

export function confirmBox(text, okText = '确定', danger = true) {
    return new Promise(res => {
        let done = false;
        const m = modal({
            title: '确认',
            body: h('div', {}, text),
            foot: [
                h('button', { class: 'btn', onclick: () => { done = true; m.close(); res(false); } }, '取消'),
                h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { done = true; m.close(); res(true); } }, okText),
            ],
            onClose: () => { if (!done) res(false); },
        });
    });
}

export function promptBox(title, value = '', multiline = false) {
    return new Promise(res => {
        let done = false;
        const input = multiline ? h('textarea', { rows: 8 }) : h('input', { type: 'text' });
        input.value = value;
        const ok = () => { done = true; m.close(); res(input.value); };
        if (!multiline) input.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
        const m = modal({
            title, body: input,
            foot: [h('button', { class: 'btn', onclick: () => { done = true; m.close(); res(null); } }, '取消'), h('button', { class: 'btn primary', onclick: ok }, '确定')],
            onClose: () => { if (!done) res(null); },
        });
        setTimeout(() => input.focus(), 30);
    });
}

export function pickFile(accept, multiple = false) {
    return new Promise(res => {
        const i = h('input', { type: 'file', accept, multiple });
        i.onchange = () => res([...i.files]);
        i.click();
    });
}

export function switchEl(checked, onchange) {
    const inp = h('input', { type: 'checkbox' });
    inp.checked = !!checked;
    inp.onchange = () => onchange(inp.checked);
    return h('label', { class: 'switch' }, inp, h('i'));
}

// ── api ──
export async function api(path, body, opts = {}) {
    const init = { method: body === undefined ? 'GET' : 'POST', headers: {} };
    if (body !== undefined) {
        if (body instanceof Blob || body instanceof ArrayBuffer) init.body = body;
        else { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    }
    const r = await fetch(path, init);
    const t = await r.text();
    let j;
    try { j = t ? JSON.parse(t) : null; } catch { j = t; }
    if (!r.ok) {
        const msg = j?.error || t || r.statusText;
        if (!opts.silent) toast(msg, true);
        throw new Error(msg);
    }
    return j;
}
export const q = (o) => '?' + new URLSearchParams(o).toString();

export function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function fmtTime(ms) {
    const d = new Date(ms);
    const now = new Date();
    const z = n => String(n).padStart(2, '0');
    if (d.toDateString() === now.toDateString()) return `今天 ${z(d.getHours())}:${z(d.getMinutes())}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${z(d.getHours())}:${z(d.getMinutes())}`;
}
export function fmtSize(b) {
    if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b > 1024) return Math.round(b / 1024) + ' KB';
    return b + ' B';
}
