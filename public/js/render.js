// Message rendering: display regex → code fences/iframes → line breaks → inline markdown + quotes.
import { applyRegex, PLACEMENT } from './regex.js';

const BLOCK = /^(div|p|details|summary|table|thead|tbody|tfoot|tr|td|th|ul|ol|li|h[1-6]|blockquote|pre|hr|section|article|header|footer|center|style|script|br|iframe|figure|figcaption|nav|aside|main|form|fieldset|legend|dl|dt|dd|svg|video|audio|canvas|textarea|select|option|button)$/i;
const RAW = /^(pre|style|script|textarea|code|svg)$/i;

export function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function makeMacro(ctx) {
    return (s) => String(s ?? '').replace(/{{(user|char|random::[^}]*|random:[^}]*|newline|noop|trim)}}/gi, (m, k) => {
        const kl = k.toLowerCase();
        if (kl === 'user') return ctx.user || '';
        if (kl === 'char') return ctx.char || '';
        if (kl === 'newline') return '\n';
        if (kl === 'noop' || kl === 'trim') return '';
        const list = k.includes('::') ? k.split('::').slice(1) : k.slice(7).split(',');
        return list[Math.floor(Math.random() * list.length)] ?? '';
    });
}

export function isHtmlDoc(s) {
    return /<\s*(html|head|body|script|!doctype)\b/i.test(s);
}

/** Convert newlines to <br> outside tags, skipping raw blocks and gaps between block tags. */
function breakLines(html) {
    const parts = html.split(/(<!--[\s\S]*?-->|<[^>]+>)/);
    const out = [];
    let rawDepth = 0, rawTag = '';
    const tagName = t => (t.match(/^<\/?\s*([a-zA-Z0-9-]+)/) || [])[1] || '';
    for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (i % 2 === 1) {
            const name = tagName(p);
            if (!rawDepth && RAW.test(name) && !p.startsWith('</') && !p.endsWith('/>')) { rawDepth = 1; rawTag = name.toLowerCase(); }
            else if (rawDepth && p.startsWith('</') && name.toLowerCase() === rawTag) rawDepth = 0;
            out.push(p);
            continue;
        }
        if (rawDepth || !p) { out.push(p); continue; }
        let t = p;
        const prev = parts[i - 1], next = parts[i + 1];
        if (prev && BLOCK.test(tagName(prev))) t = t.replace(/^[ \t]*\n/, '');
        if (next && BLOCK.test(tagName(next))) t = t.replace(/\n[ \t]*$/, '');
        out.push(t.replace(/\n/g, '<br>'));
    }
    return out.join('');
}

const INLINE = [
    [/\*\*([^*\n][\s\S]*?)\*\*/g, '<strong>$1</strong>'],
    [/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>'],
    [/`([^`\n]+)`/g, '<code>$1</code>'],
    [/(“[^”\n]*”|"[^"\n]*"|「[^」\n]*」|『[^』\n]*』)/g, '<q>$1</q>'],
];

function inlineMarkdown(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
            let p = n.parentElement;
            while (p && p !== root) {
                if (/^(PRE|CODE|STYLE|SCRIPT|TEXTAREA|Q|BUTTON|SELECT)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
                p = p.parentElement;
            }
            return /[*`"“「『]/.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
        let s = escapeHtml(n.data).replace(/&quot;/g, '"');
        for (const [re, rep] of INLINE) s = s.replace(re, rep);
        if (s === escapeHtml(n.data).replace(/&quot;/g, '"')) continue;
        const tpl = document.createElement('template');
        tpl.innerHTML = s;
        n.replaceWith(tpl.content);
    }
}

/**
 * @returns {{el: HTMLElement, frames: string[]}}
 */
export function renderText(text, opt) {
    const macro = makeMacro({ user: opt.userName, char: opt.char });
    let s = String(text ?? '');
    if (opt.scripts?.length) s = applyRegex(opt.scripts, s, { placement: opt.isUser ? PLACEMENT.USER : PLACEMENT.AI, mode: 'display', depth: opt.depth }, macro);
    const frames = [];
    s = s.replace(/```([\w-]*)[^\S\n]*\n?([\s\S]*?)```/g, (m, lang, body) => {
        if (isHtmlDoc(body) && !opt.noFrames) {
            frames.push(body);
            return `<div class="th-slot" data-f="${frames.length - 1}"></div>`;
        }
        if (isHtmlDoc(body)) return '<div class="muted">〔前端界面〕</div>';
        return `<pre><code>${escapeHtml(body)}</code></pre>`;
    });
    s = breakLines(s);
    const el = document.createElement('div');
    el.className = 'mes-text';
    el.innerHTML = s;
    for (const sc of el.querySelectorAll('script')) sc.remove();
    inlineMarkdown(el);
    return { el, frames };
}

/** Wrap an HTML snippet into a document that has the TavernHelper-compatible shim. */
export function frameDoc(html) {
    const head = `<meta charset="utf-8"><base target="_blank">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}:root{--TH-viewport-height:${window.innerHeight}px}</style>
<script src="/vendor/jquery-3.5.1.min.js"><\/script><script src="/vendor/lodash.min.js"><\/script><script src="/vendor/zod.umd.js"><\/script><script src="https://testingcf.jsdelivr.net/npm/vue@3.5.13/dist/vue.global.prod.js"><\/script><script>window.z=(parent.z&&parent.z.object)?parent.z:window.Zod<\/script><script src="/js/th-shim.js"><\/script>`;
    if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, m => m + head);
    if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, m => m + '<head>' + head + '</head>');
    return `<!doctype html><html><head>${head}</head>${/<body/i.test(html) ? html : '<body>' + html + '</body>'}</html>`;
}

export function mountFrames(container, frames, mesId) {
    for (const slot of container.querySelectorAll('.th-slot')) {
        const html = frames[Number(slot.dataset.f)];
        const f = document.createElement('iframe');
        f.className = 'th-frame';
        f.dataset.mesid = mesId;
        f.setAttribute('loading', 'lazy');
        f.srcdoc = frameDoc(html);
        slot.replaceWith(f);
    }
}
