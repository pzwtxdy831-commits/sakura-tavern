// 记忆总结 (rolling memory summary): old floors get summarized by a cheap model, hidden from the
// main prompt (is_system) and replaced by the summary text as a "previously on" block.
import { getSettings, markDirty, findSecret } from './store.js';
import { complete } from './providers.js';

const running = new Set();

function cleanText(s, tags) {
    let t = String(s || '');
    t = t.replace(/<(think|thinking|thought|sakura_planning~|konatan_planning~|planning|Interleaving|UpdateVariable|update|StatusPlaceHolderImpl)[^>]*>[\s\S]*?<\/\1>/gi, '');
    for (const tag of tags || []) t = t.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), '');
    t = t.replace(/<bbs_(start|end)>[\s\S]*?<\/bbs_\1>/gi, m => m.replace(/<\/?bbs_(start|end)>/g, ''));
    t = t.replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();
    return t;
}

/** Top-level summaries (ours, plus ones an older summary extension left in chat_metadata) — not children of another summary. */
export function summaryRoots(meta) {
    const list = [...(meta.baibai_book?.summaries || []), ...(meta.lt_summary?.items || [])];
    const child = new Set();
    for (const s of list) for (const c of s.childIds || []) child.add(c);
    return list.filter(s => !child.has(s.id)).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export function summaryInjection(meta) {
    const roots = summaryRoots(meta);
    if (!roots.length) return '';
    const lines = roots.map(s => {
        const tr = s.timeStart || s.timeEnd ? `（${[s.timeStart, s.timeEnd].filter(Boolean).join(' – ')}）` : '';
        return `${tr}${s.text}`;
    });
    return `<前情提要>\n以下是更早剧情的摘要，按时间先后排列，作为已发生的事实参考：\n${lines.join('\n')}\n</前情提要>`;
}

const SUMMARY_PROMPT = `你是严谨的剧情记忆整理员。阅读下面的【本轮对话】，写一段信息密集的剧情摘要。

【主角】{{user}}  【角色】{{char}}
【前情提要（只读参考）】
{{history}}

【本轮对话】
{{content}}

要求：
- 只写文本里明确发生的事，不编造。
- 保留时间节点（故事内的日期/时刻）、人名、地名、物品名、承诺/约定/悬念及其结果。
- 动作要具体（"兰用50金币换了艾伦的地图"，不要写"进行了交易"）。
- 一个连贯段落，{{words}}字左右，不要 markdown，不要解释。
- 只输出 JSON：{"summary":"…","timeStart":"本段开始的故事时间","timeEnd":"本段结束的故事时间"}`;

const RESUMMARY_PROMPT = `你是剧情压缩助手。下面是若干段按时间先后排列的剧情摘要，请把它们压缩为一段信息密度极高、连贯的上层摘要（{{words}}字左右）。

【主角】{{user}}  【角色】{{char}}
{{content}}

要求：保留时间节点、人名地名物名、承诺和悬念及其了结；不用相对时间词；一个段落；不要 markdown。
只输出 JSON：{"summary":"…"}`;

function parseJsonLoose(t) {
    const s = String(t || '').replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim();
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* */ } }
    return { summary: s };
}

function channel() {
    const c = getSettings().plugins.summary;
    let url = String(c.url || '').replace(/\/+$/, '');
    if (!/\/v\d[^/]*$|\/chat\/completions$/.test(url)) url += '/v1';
    return { source: 'openai', url, model: c.model, secretId: c.secretId };
}

/**
 * Check whether the chat needs summarizing and do one round.
 * @param chat loaded chat
 * @param names {user, char}
 * @param onUpdate callback after changes
 */
export async function maybeSummarize(chat, names, onUpdate) {
    const cfg = getSettings().plugins.summary;
    if (!cfg.enabled || !cfg.url || !cfg.model) return;
    if (running.has(chat.key)) return;
    running.add(chat.key);
    try {
        const msgs = chat.messages;
        const visible = msgs.map((m, i) => ({ m, i })).filter(x => !x.m.is_system);
        const keep = Number(cfg.keepRecent || 10);
        const batch = Number(cfg.batch || 10);
        if (visible.length < keep + batch) return;
        const take = visible.slice(0, visible.length - keep).slice(0, batch);
        let content = '';
        for (const { m } of take) {
            const t = cleanText(m.mes, cfg.stripTags);
            if (!t) continue;
            content += `【${m.is_user ? names.user : names.char}】${t}\n\n`;
            if (content.length > Number(cfg.maxChars || 40000)) break;
        }
        const meta = chat.header.chat_metadata;
        const history = summaryRoots(meta).slice(-6).map(s => s.text).join('\n') || '（无）';
        const prompt = SUMMARY_PROMPT.replaceAll('{{user}}', names.user).replaceAll('{{char}}', names.char)
            .replace('{{history}}', history).replace('{{content}}', content).replace('{{words}}', '300');
        const out = parseJsonLoose(await complete(channel(), [{ role: 'user', content: prompt }], { temperature: 0.7, top_p: 1, max_tokens: 8192, stream: false, seed: -1 }));
        if (!out.summary) return;
        meta.lt_summary ??= { items: [] };
        meta.lt_summary.items.push({
            id: 'lt_' + Date.now().toString(36), level: 1, text: out.summary, timeStart: out.timeStart || '', timeEnd: out.timeEnd || '',
            createdAt: Date.now(), from: take[0].i, to: take[take.length - 1].i, childIds: [],
        });
        for (const { m } of take) { m.is_system = true; (m.extra ??= {}).lt_summarized = true; }
        markDirty(chat);
        onUpdate?.();

        // compress when too many top-level summaries
        const roots = summaryRoots(meta);
        const th = Number(cfg.resummaryThreshold || 8);
        if (roots.length > th + 2) {
            const group = roots.slice(0, th);
            const c2 = group.map(s => `(${s.timeStart || ''} – ${s.timeEnd || ''}) ${s.text}`).join('\n');
            const p2 = RESUMMARY_PROMPT.replaceAll('{{user}}', names.user).replaceAll('{{char}}', names.char).replace('{{content}}', c2).replace('{{words}}', '600');
            const r2 = parseJsonLoose(await complete(channel(), [{ role: 'user', content: p2 }], { temperature: 0.7, top_p: 1, max_tokens: 8192, stream: false, seed: -1 }));
            if (r2.summary) {
                meta.lt_summary.items.push({
                    id: 'lt_' + Date.now().toString(36) + 'c', level: Math.max(...group.map(s => s.level || 1)) + 1, text: r2.summary,
                    timeStart: group[0].timeStart || '', timeEnd: group[group.length - 1].timeEnd || '', createdAt: group[0].createdAt,
                    childIds: group.map(s => s.id),
                });
                markDirty(chat);
                onUpdate?.();
            }
        }
    } catch (e) {
        console.warn('[summary]', e.message);
    } finally {
        running.delete(chat.key);
    }
}

export function summaryChannelOk() {
    const c = getSettings().plugins.summary;
    return !!(c.url && c.model && (c.secretId ? findSecret(c.secretId) !== undefined : true));
}
