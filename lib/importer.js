// One-shot import from an existing SillyTavern user folder (data/default-user) into Sakura's data folder.
import fs from 'node:fs';
import path from 'node:path';
import { ST_USER, CONFIG, dir, ensureDir, readJSON, writeJSONSync } from './util.js';
import { getSettings, saveSettings, getSecrets } from './store.js';


function copyDir(src, dst, filter, overwrite) {
    if (!fs.existsSync(src)) return 0;
    ensureDir(dst);
    let n = 0;
    for (const f of fs.readdirSync(src)) {
        const s = path.join(src, f);
        const d = path.join(dst, f);
        const st = fs.statSync(s);
        if (st.isDirectory()) { n += copyDir(s, d, filter, overwrite); continue; }
        if (filter && !filter(f)) continue;
        if (!overwrite && fs.existsSync(d)) continue;
        fs.copyFileSync(s, d);
        n++;
    }
    return n;
}

const ppMap = v => v || 'none';

function activeSecretId(secrets, key) {
    const list = secrets[key];
    if (!Array.isArray(list)) return '';
    return (list.find(x => x.active) || list[0] || {}).id || '';
}

/**
 * @param {{overwrite?: boolean, settingsToo?: boolean}} opt
 */
export function importFromST(opt = {}) {
    const overwrite = !!opt.overwrite;
    const report = {};
    if (!fs.existsSync(ST_USER)) throw new Error('找不到旧酒馆目录 ' + ST_USER);

    report.characters = copyDir(path.join(ST_USER, 'characters'), dir('characters'), f => /\.png$/i.test(f), overwrite);
    report.thumbs = copyDir(path.join(ST_USER, 'thumbnails', 'avatar'), dir('thumbs'), f => /\.png$/i.test(f), overwrite);
    report.chats = copyDir(path.join(ST_USER, 'chats'), dir('chats'), f => f.endsWith('.jsonl'), overwrite);
    report.worlds = copyDir(path.join(ST_USER, 'worlds'), dir('worlds'), f => f.endsWith('.json'), overwrite);
    report.presets = copyDir(path.join(ST_USER, 'OpenAI Settings'), dir('presets'), f => f.endsWith('.json'), overwrite);
    report.personas = copyDir(path.join(ST_USER, 'User Avatars'), dir('personas'), f => /\.(png|jpe?g|webp|gif)$/i.test(f), overwrite);
    for (const src of CONFIG.novelFiles || []) {
        const dst = dir('novels', path.basename(src));
        if (fs.existsSync(src) && !fs.existsSync(dst)) { fs.copyFileSync(src, dst); report.novels = (report.novels || 0) + 1; }
    }

    // secrets: copy the file, then add any extra Vertex service-account JSON files listed in sakura.config.json
    const stSecretsPath = path.join(ST_USER, 'secrets.json');
    if (fs.existsSync(stSecretsPath) && (overwrite || !fs.existsSync(dir('secrets.json')))) {
        fs.copyFileSync(stSecretsPath, dir('secrets.json'));
    }
    const secrets = getSecrets();
    Object.assign(secrets, readJSON(dir('secrets.json'), {}));
    const extraVertex = [];
    for (const k of CONFIG.extraVertexKeys || []) {
        if (!fs.existsSync(k.file)) continue;
        const raw = fs.readFileSync(k.file, 'utf8');
        secrets.vertexai_service_account_json ??= [];
        let ex = secrets.vertexai_service_account_json.find(x => x.value === raw);
        if (!ex) {
            ex = { id: crypto.randomUUID(), value: raw, label: k.name || path.basename(k.file), active: false };
            secrets.vertexai_service_account_json.push(ex);
        }
        extraVertex.push({ name: k.name || path.basename(k.file, '.json'), id: ex.id });
    }
    writeJSONSync(dir('secrets.json'), secrets);

    if (opt.settingsToo === false) return report;

    const st = readJSON(path.join(ST_USER, 'settings.json'), {});
    const oai = st.oai_settings || {};
    const ext = st.extension_settings || {};
    const pu = st.power_user || {};
    const s = getSettings();

    s.activePreset ||= oai.preset_settings_openai || '';
    s.regex = Array.isArray(ext.regex) ? ext.regex : [];
    s.globalVars = ext.variables?.global || s.globalVars || {};

    // personas
    const personas = {};
    const binding = {};
    for (const [avatar, name] of Object.entries(pu.personas || {})) {
        const d = pu.persona_descriptions?.[avatar] || {};
        personas[avatar] = {
            name, description: d.description || '', avatar,
            position: d.position ?? 0, depth: d.depth ?? 2, role: d.role ?? 0,
        };
        for (const c of d.connections || []) if (c.type === 'character') binding[c.id] = avatar;
    }
    s.personas = personas;
    s.personaBinding = binding;
    s.defaultPersona = pu.default_persona || st.user_avatar || Object.keys(personas)[0] || '';

    // connection profiles — one name = one url/model
    const profiles = [];
    const add = (p) => {
        if (profiles.some(x => x.source === p.source && x.url === p.url && x.model === p.model && x.secretId === p.secretId && x.region === p.region)) return;
        profiles.push({ id: crypto.randomUUID(), postProcessing: 'none', ...p });
    };
    const vSa = activeSecretId(secrets, 'vertexai_service_account_json');
    if (vSa) add({ name: 'Vertex', source: 'vertex', vertexAuth: 'full', region: oai.vertexai_region || 'global', model: oai.vertexai_model || 'gemini-2.5-pro', secretId: vSa, url: '' });
    for (const v of extraVertex) add({ name: v.name, source: 'vertex', vertexAuth: 'full', region: 'global', model: oai.vertexai_model || 'gemini-2.5-pro', secretId: v.id, url: '' });
    add({ name: '8318 反代', source: 'openai', url: oai.custom_url || 'http://127.0.0.1:8318/v1', model: oai.custom_model || '', secretId: activeSecretId(secrets, 'api_key_custom'), postProcessing: ppMap(oai.custom_prompt_post_processing) });
    for (const cp of ext.connectionManager?.profiles || []) {
        if (cp.api === 'custom') add({ name: cp.name, source: 'openai', url: cp['api-url'], model: cp.model, secretId: cp['secret-id'] || '', postProcessing: ppMap(cp['prompt-post-processing']) });
        else if (cp.api === 'vertexai') add({ name: cp.name, source: 'vertex', vertexAuth: 'full', region: cp['api-url'] || 'global', model: cp.model, secretId: cp['secret-id'] || vSa, url: '' });
        else if (cp.api === 'makersuite') add({ name: cp.name, source: 'aistudio', url: '', model: cp.model, secretId: cp['secret-id'] || '' });
    }
    const ms = activeSecretId(secrets, 'api_key_makersuite');
    if (ms) add({ name: 'AI Studio', source: 'aistudio', url: '', model: oai.google_model || 'gemini-2.5-pro', secretId: ms });
    if (!s.profiles.length) s.profiles = profiles;
    else for (const p of profiles) if (!s.profiles.some(x => x.name === p.name)) s.profiles.push(p);
    if (!s.activeProfile) {
        const src = oai.chat_completion_source === 'vertexai' ? 'vertex' : oai.chat_completion_source === 'makersuite' ? 'aistudio' : 'openai';
        s.activeProfile = (s.profiles.find(x => x.source === src) || s.profiles[0])?.id || '';
    }

    // world info settings
    const wis = st.world_info_settings || {};
    s.wi = { depth: wis.world_info_depth ?? 2, recursive: wis.world_info_recursive ?? true, maxRecursion: wis.world_info_max_recursion_steps || 5, caseSensitive: !!wis.world_info_case_sensitive, matchWholeWords: !!wis.world_info_match_whole_words };
    s.globalWorlds = wis.world_info?.globalSelect || [];

    // reasoning
    const rs = pu.reasoning || {};
    s.reasoning = { autoParse: rs.auto_parse ?? true, prefix: rs.prefix || '<think>', suffix: rs.suffix || '</think>' };

    // memory-summary channel: reuse the old summary extension's channel settings if present
    const bb = ext.baibai_book;
    if (bb?.channels?.length) {
        const ch = bb.channels[0];
        let keyId = '';
        if (ch.key) {
            secrets.api_key_custom ??= [];
            let ex = secrets.api_key_custom.find(x => x.value === ch.key && x.label === '记忆总结通道');
            if (!ex) { ex = { id: crypto.randomUUID(), value: ch.key, label: '记忆总结通道', active: false }; secrets.api_key_custom.push(ex); }
            keyId = ex.id;
            writeJSONSync(dir('secrets.json'), secrets);
        }
        Object.assign(s.plugins.summary, {
            enabled: !!bb.enabled, url: ch.url, model: ch.model, secretId: keyId,
            keepRecent: bb.keepRecent ?? 10, batch: bb.batchMaxFloors ?? 10, maxChars: bb.batchMaxChars ?? 40000,
            resummaryThreshold: bb.resummaryThreshold ?? 8,
            stripTags: bb.customStripTags || [],
        });
    }
    const tail = ext['novel-tail-injector'];
    if (tail && CONFIG.novelFiles?.length) s.plugins.tailNovel = { enabled: true, file: path.basename(CONFIG.novelFiles[0]), size: 13000 };

    // keep the old vinyl css for reference
    if (pu.custom_css) fs.writeFileSync(dir('cache', 'st-custom.css'), pu.custom_css, 'utf8');

    saveSettings(true);
    report.profiles = s.profiles.length;
    report.personas = Object.keys(personas).length;
    return report;
}
