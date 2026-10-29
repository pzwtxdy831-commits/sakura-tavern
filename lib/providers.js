// Upstream providers: OpenAI-compatible, Vertex AI, Google AI Studio. All yield {type, text} events.
import crypto from 'node:crypto';
import YAML from 'yaml';
import { findSecret } from './store.js';

export const SOURCES = {
    openai: 'OpenAI 兼容',
    vertex: 'Vertex AI',
    aistudio: 'AI Studio',
};

const GEMINI_SAFETY = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT', 'HARM_CATEGORY_CIVIC_INTEGRITY']
    .map(category => ({ category, threshold: 'OFF' }));

// ── SSE parsing ──
async function* sseLines(body, signal) {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of body) {
        if (signal?.aborted) return;
        buf += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, '');
            buf = buf.slice(idx + 1);
            if (line.startsWith('data:')) yield line.slice(5).trimStart();
        }
    }
    if (buf.startsWith('data:')) yield buf.slice(5).trimStart();
}

async function errorText(res) {
    let t = '';
    try { t = await res.text(); } catch { /* */ }
    try {
        const j = JSON.parse(t);
        t = j.error?.message || j.message || j.error || t;
        if (typeof t !== 'string') t = JSON.stringify(t);
    } catch { /* */ }
    return `HTTP ${res.status}: ${String(t).slice(0, 800)}`;
}

// ── OpenAI compatible ──
async function* openaiStream(profile, messages, params, signal) {
    const key = profile.secretId ? findSecret(profile.secretId) : (profile.key || '');
    let url = String(profile.url || '').replace(/\/+$/, '');
    if (!/\/chat\/completions$/.test(url)) url += '/chat/completions';
    const body = {
        model: profile.model,
        messages,
        temperature: params.temperature,
        top_p: params.top_p,
        max_tokens: params.max_tokens,
        frequency_penalty: params.frequency_penalty,
        presence_penalty: params.presence_penalty,
        stream: params.stream,
    };
    if (params.stream) body.stream_options = { include_usage: true };
    if (params.seed >= 0) body.seed = params.seed;
    if (profile.includeBody) {
        try { Object.assign(body, YAML.parse(profile.includeBody) || {}); } catch { /* */ }
    }
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(await errorText(res));
    if (!params.stream) {
        const j = await res.json();
        if (j.usage) yield { type: 'usage', usage: j.usage };
        const msg = j.choices?.[0]?.message || {};
        const r = msg.reasoning_content || msg.reasoning;
        if (r) yield { type: 'reasoning', text: r };
        if (msg.content) yield { type: 'text', text: msg.content };
        return;
    }
    for await (const data of sseLines(res.body, signal)) {
        if (data === '[DONE]') break;
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
        if (j.usage) yield { type: 'usage', usage: j.usage };
        const d = j.choices?.[0]?.delta || j.choices?.[0]?.message || {};
        const r = d.reasoning_content ?? d.reasoning;
        if (r) yield { type: 'reasoning', text: r };
        if (d.content) yield { type: 'text', text: d.content };
        const fr = j.choices?.[0]?.finish_reason;
        if (fr && fr !== 'stop' && fr !== 'length') yield { type: 'finish', text: fr };
    }
}

// ── Gemini (Vertex / AI Studio) ──
export function toGemini(messages, useSys) {
    const msgs = messages.map(m => ({ ...m }));
    const sys = [];
    if (useSys) while (msgs.length > 1 && msgs[0].role === 'system') sys.push(msgs.shift().content);
    const contents = [];
    for (const m of msgs) {
        const role = m.role === 'assistant' ? 'model' : 'user';
        const last = contents[contents.length - 1];
        if (last && last.role === role) last.parts[0].text += '\n\n' + m.content;
        else contents.push({ role, parts: [{ text: m.content }] });
    }
    return { contents, systemInstruction: sys.length ? { parts: sys.map(text => ({ text })) } : null };
}

function thinkingFor(model, effort, maxTokens, includeThoughts) {
    if (!/^gemini-(2\.5|3|4)/.test(model) || /image/.test(model)) return null;
    const cfg = { includeThoughts: !!includeThoughts };
    if (/^gemini-4/.test(model)) {
        cfg.thinkingLevel = ['medium', 'high'].includes(effort) ? effort : (effort === 'max' ? 'high' : 'low');
        return cfg;
    }
    if (/^gemini-3/.test(model)) {
        if (effort === 'auto') return cfg;
        cfg.thinkingLevel = /pro/.test(model)
            ? (['high', 'max'].includes(effort) ? 'high' : 'low')
            : ({ min: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'high' }[effort] || 'low');
        return cfg;
    }
    const budget = { auto: -1, min: /pro/.test(model) ? 128 : 0, low: 0.1, medium: 0.25, high: 0.5, max: 1 }[effort];
    if (budget === undefined) return cfg;
    cfg.thinkingBudget = budget < 1 && budget > 0 ? Math.min(24576, Math.floor(maxTokens * budget)) : (budget === 1 ? Math.min(24576, maxTokens) : budget);
    if (cfg.thinkingBudget === 0) cfg.includeThoughts = false;
    return cfg;
}

function geminiBody(profile, messages, params) {
    const { contents, systemInstruction } = toGemini(messages, params.use_sysprompt);
    const generationConfig = {
        candidateCount: 1,
        maxOutputTokens: params.max_tokens,
        temperature: params.temperature,
        topP: params.top_p,
        topK: params.top_k || undefined,
    };
    if (params.seed >= 0) generationConfig.seed = params.seed;
    const th = thinkingFor(profile.model, params.reasoning_effort, params.max_tokens, params.show_thoughts);
    if (th) generationConfig.thinkingConfig = th;
    const body = { contents, safetySettings: GEMINI_SAFETY, generationConfig };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    return body;
}

const tokenCache = new Map();
async function vertexToken(sa) {
    const c = tokenCache.get(sa.client_email);
    if (c && c.exp > Date.now() + 60000) return c.token;
    const now = Math.floor(Date.now() / 1000);
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
        iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key).toString('base64url');
    const res = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig }),
    });
    if (!res.ok) throw new Error('Vertex 授权失败 ' + await errorText(res));
    const j = await res.json();
    tokenCache.set(sa.client_email, { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
    return j.access_token;
}

async function* geminiStream(profile, messages, params, signal) {
    const body = geminiBody(profile, messages, params);
    const method = params.stream ? 'streamGenerateContent' : 'generateContent';
    const headers = { 'Content-Type': 'application/json' };
    let url;
    if (profile.source === 'vertex') {
        const region = profile.region || 'global';
        const host = region === 'global' ? 'https://aiplatform.googleapis.com' : `https://${region}-aiplatform.googleapis.com`;
        const secret = findSecret(profile.secretId);
        if (profile.vertexAuth === 'express' || !String(secret).trim().startsWith('{')) {
            const pid = profile.projectId;
            url = pid
                ? `${host}/v1/projects/${pid}/locations/${region}/publishers/google/models/${profile.model}:${method}`
                : `${host}/v1/publishers/google/models/${profile.model}:${method}`;
            headers['x-goog-api-key'] = secret;
        } else {
            const sa = JSON.parse(secret);
            url = `${host}/v1/projects/${profile.projectId || sa.project_id}/locations/${region}/publishers/google/models/${profile.model}:${method}`;
            headers.Authorization = `Bearer ${await vertexToken(sa)}`;
        }
    } else {
        const base = String(profile.url || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
        url = `${base}/v1beta/models/${profile.model}:${method}`;
        headers['x-goog-api-key'] = profile.secretId ? findSecret(profile.secretId) : '';
    }
    if (params.stream) url += '?alt=sse';
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(await errorText(res));
    const handle = function* (j) {
        if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
        if (j.promptFeedback?.blockReason) throw new Error('被拦截: ' + j.promptFeedback.blockReason);
        const cand = j.candidates?.[0];
        for (const part of cand?.content?.parts || []) {
            if (typeof part.text !== 'string') continue;
            yield { type: part.thought ? 'reasoning' : 'text', text: part.text };
        }
        if (cand?.finishReason && !['STOP', 'MAX_TOKENS', 'FINISH_REASON_UNSPECIFIED'].includes(cand.finishReason)) {
            yield { type: 'finish', text: cand.finishReason };
        }
        if (j.usageMetadata) yield { type: 'usage', usage: j.usageMetadata };
    };
    if (!params.stream) {
        yield* handle(await res.json());
        return;
    }
    for await (const data of sseLines(res.body, signal)) {
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        yield* handle(j);
    }
}

export function streamFrom(profile, messages, params, signal) {
    if (profile.source === 'vertex' || profile.source === 'aistudio') return geminiStream(profile, messages, params, signal);
    return openaiStream(profile, messages, params, signal);
}

/** One-shot completion (used by summary plugin). */
export async function complete(profile, messages, params, signal) {
    let text = '';
    for await (const ev of streamFrom(profile, messages, { ...params, stream: false }, signal)) {
        if (ev.type === 'text') text += ev.text;
    }
    return text;
}

export async function listModels(profile) {
    if (profile.source === 'openai') {
        const key = profile.secretId ? findSecret(profile.secretId) : '';
        const url = String(profile.url || '').replace(/\/+$/, '').replace(/\/chat\/completions$/, '') + '/models';
        const res = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
        if (!res.ok) throw new Error(await errorText(res));
        const j = await res.json();
        return (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean).sort();
    }
    if (profile.source === 'aistudio') {
        const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': findSecret(profile.secretId) } });
        if (!res.ok) throw new Error(await errorText(res));
        const j = await res.json();
        return (j.models || []).map(m => m.name.replace(/^models\//, '')).filter(n => /gemini|gemma/.test(n)).sort();
    }
    return ['gemini-4-argon', 'gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-3.8-flash', 'gemini-2.5-pro', 'gemini-2.5-flash'];
}
