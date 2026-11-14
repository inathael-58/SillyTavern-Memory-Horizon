// Memory Horizon — บอกว่า AI ยังจำย้อนได้ถึงข้อความไหน และอะไรกิน context
//
// แนวคิด: ในแชทยาว SillyTavern ใส่ประวัติแชทจนเต็มงบทุกครั้ง "เต็ม 95%" จึงเป็นเรื่องปกติ
// สิ่งที่ควรรู้คือ AI ลืมอะไรไปแล้วบ้าง เราเลยวัดจาก "ขอบความจำ" ที่ ST คำนวณไว้เอง
// และใช้ตัวนับ token ของ Prompt Manager ตรง ๆ (ตัวเดียวกับที่ ST ใช้ตัดประวัติ) ไม่นับใหม่เอง
//
// รับเฉพาะรอบที่ผู้ใช้ส่ง/สุ่มใหม่/ต่อข้อความจริง ไม่รับ quiet prompt หรือ generateRaw
// ของ extension อื่น ส่วนรอบจำลอง (dry run) ใช้เป็นค่าประมาณ ไม่ปลุกการเตือน
//
// สีทุกสีอ้างตัวแปรธีมของ ST (--SmartTheme*) ผ่าน CSS จึงเปลี่ยนตามธีมเอง

const MODULE = 'memory_horizon';
const LOG = '[Memory Horizon]';
const VERSION = '0.3.0'; // ให้ตรงกับ manifest.json เสมอ
const BASE_URL = new URL('.', import.meta.url);
const FILES = ['index.js', 'style.css', 'manifest.json'];

const PLACES = Object.freeze({
    perch: { label: 'เกาะขอบแถบพิมพ์', hint: 'ป้ายเล็กลอยเหนือแถบพิมพ์ ไม่เบียดช่องพิมพ์' },
    strip: { label: 'เส้นบนช่องพิมพ์', hint: 'เส้นไทม์ไลน์บาง ๆ พาดขอบบนแถบพิมพ์' },
    top: { label: 'หัวแชท', hint: 'ป้ายลอยกลางขอบบนของแชท' },
    float: { label: 'ปุ่มลอย', hint: 'ลากวางได้ · เก็บเข้า Quick Dock ได้' },
});
const SIZES = Object.freeze({ mini: 'มินิ', compact: 'ย่อ', full: 'เต็ม' });
const FIELDS = Object.freeze({
    horizon: 'จำย้อนได้กี่ข้อความ',
    room: 'ที่ว่างก่อนเริ่มลืม',
    unsummarized: 'ลืมไปแล้วแต่ยังไม่ได้สรุป (Memory Hub)',
    forgotten: 'ลืมไปแล้วกี่ข้อความ',
    tokens: 'token ที่ส่ง / งบ',
    percent: 'ใช้งบไปกี่ %',
});
const ACCENTS = Object.freeze({
    quote: ['คำพูด', '--SmartThemeQuoteColor'],
    em: ['ตัวเอียง', '--SmartThemeEmColor'],
    underline: ['ขีดเส้นใต้', '--SmartThemeUnderlineColor'],
    body: ['ตัวอักษรหลัก', '--SmartThemeBodyColor'],
});

const DEFAULTS = Object.freeze({
    enabled: true,
    places: {
        perch: { on: true, size: 'compact' },
        strip: { on: false, size: 'mini' },
        top: { on: false, size: 'compact' },
        float: { on: false, size: 'mini' },
    },
    fields: ['horizon', 'room', 'unsummarized'],
    marker: true,       // เส้นขอบความจำในแชท
    hideStLine: true,   // ซ่อนเส้นประเดิมของ ST เมื่อเปิดเส้นของเรา
    dim: false,         // ทำข้อความที่ลืมแล้วให้จาง
    minWindow: 10,      // ระวังเมื่อจำย้อนได้น้อยกว่านี้ (0 = ปิด)
    fixedPct: 60,       // ระวังเมื่อส่วนที่ส่งทุกรอบกินงบเกิน % นี้ (0 = ปิด)
    warnUnsummarized: true,
    toast: true,
    accent: 'quote',
    floatPos: null,     // { x, y } px จากมุมซ้ายบน
    side: 'left',       // ป้ายเกาะขอบ / ป้ายบนเส้น อยู่ฝั่งไหนของแถบพิมพ์
});
const SIDES = Object.freeze({ left: 'ซ้าย', right: 'ขวา' });

// กลุ่มของ identifier ใน Prompt Manager
const GROUPS = [
    { key: 'chat', label: 'ประวัติแชท', ids: ['chatHistory', 'conversation'] },
    { key: 'inject', label: 'แทรกตามความลึก (preset/extension)', ids: ['__injected'] },
    { key: 'card', label: 'การ์ดตัวละคร', ids: ['charDescription', 'charPersonality', 'scenario'] },
    { key: 'lore', label: 'Lorebook', ids: ['worldInfoBefore', 'worldInfoAfter'] },
    { key: 'persona', label: 'เพอร์โซนา', ids: ['personaDescription'] },
    { key: 'examples', label: 'ตัวอย่างบทสนทนา', ids: ['dialogueExamples', 'examples'] },
    { key: 'preset', label: 'Preset', ids: ['main', 'nsfw', 'jailbreak', 'enhanceDefinitions', 'impersonate', 'bias', 'nudge', 'start_chat', 'prompt', 'quietPrompt', 'groupNudge', 'newMainChat', 'continueNudge', 'emptyUserMessageReplacement'] },
    { key: 'ext', label: 'ส่วนเสริม / อื่น ๆ', ids: [] },
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ctx = () => SillyTavern.getContext();
let oai = null; // โมดูล openai.js ของ ST (promptManager, oai_settings, openai_messages_count)

// ───────────────────────── settings ─────────────────────────

function settings() {
    const all = ctx().extensionSettings;
    all[MODULE] ??= {};
    const s = all[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) if (s[k] === undefined) s[k] = structuredClone(v);
    // 0.1.x มีชิปในแถบพิมพ์ (send/left) ซึ่งเบียดช่องพิมพ์ — ย้ายไปเป็นป้ายเกาะขอบแทน
    if (s.places.send || s.places.left) {
        const old = [s.places.send, s.places.left].find(p => p?.on);
        if (old && !s.places.perch) s.places.perch = { on: true, size: old.size };
        delete s.places.send;
        delete s.places.left;
    }
    if (!SIDES[s.side]) s.side = DEFAULTS.side;
    for (const [k, v] of Object.entries(DEFAULTS.places)) {
        s.places[k] ??= structuredClone(v);
        if (!SIZES[s.places[k].size]) s.places[k].size = v.size;
    }
    if (!Array.isArray(s.fields)) s.fields = [...DEFAULTS.fields];
    return s;
}
const save = () => ctx().saveSettingsDebounced();

// ───────────────────────── diagnostics ─────────────────────────

const diagLog = [];
function diag(msg) {
    diagLog.push(`${new Date().toISOString().slice(11, 23)} ${msg}`);
    if (diagLog.length > 40) diagLog.shift();
}
function reportError(where, err) {
    console.error(LOG, where, err);
    diag(`ERROR ${where}: ${err?.stack || err}`);
    try { toastr.error(`${where}: ${err?.message ?? err}`, 'Memory Horizon'); } catch { /* ignore */ }
}
window.addEventListener('error', e => { if (String(e.filename || '').startsWith(BASE_URL.href)) diag(`window error ${e.message} @${String(e.filename).slice(BASE_URL.href.length)}:${e.lineno}`); });
window.addEventListener('unhandledrejection', e => { if (String(e.reason?.stack || '').includes(BASE_URL.href)) diag(`unhandled ${e.reason?.message ?? e.reason}`); });

// ───────────────────────── measurement ─────────────────────────

/** การวัดล่าสุดของแชทนี้ (เก็บใน chat metadata ด้วย ไปกับไฟล์แชท) */
let meas = null;
let pending = null; // { type, dry } จาก GENERATION_STARTED
let lastAlert = { chatId: null, level: 0 };

const nonHidden = chat => {
    const out = [];
    chat.forEach((m, i) => { if (!m?.is_system || Array.isArray(m?.extra?.tool_invocations)) out.push(i); });
    return out;
};

const normText = t => String(t ?? '').replace(/\s+/g, ' ').trim();
const contentText = c => typeof c === 'string' ? c
    : Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : (p?.text ?? ''))).join(' ') : '';
/** ชิ้นข้อความ ต้น/กลาง/ท้าย ไว้หาว่าข้อความแชทอยู่ในพรอมท์ไหม (ทนต่อชื่อที่เติมข้างหน้าและ regex ที่แก้บางส่วน) */
function snippets(mes) {
    const t = normText(mes);
    if (!t) return [];
    if (t.length <= 24) return [t];
    const k = 24, mid = Math.floor((t.length - k) / 2);
    return [t.slice(0, k), t.slice(mid, mid + k), t.slice(-k)];
}
const SYS_IDS = ['newMainChat', 'groupNudge', 'emptyUserMessageReplacement', 'continueNudge'];

/**
 * อ่านก้อน chatHistory ที่ ST ประกอบไว้ใน Prompt Manager (ก่อน extension อื่นแก้พรอมท์ใน PROMPT_READY)
 * แล้วจับคู่กับข้อความแชทจริงจากใหม่ไปเก่า — ข้อความที่ไม่ตรงกับแชทคือของที่แทรกตามความลึก
 * (preset ที่ตั้ง @D, Author's Note, extension ต่าง ๆ) ซึ่ง ST ไม่ได้ติดป้ายแยกไว้ให้
 * @returns {{count:number, oldest:number|null, chatTok:number, sysTok:number, injTok:number, orig:number, matched:boolean}|null}
 */
function analyzeChatHistory(type) {
    const hist = oai?.promptManager?.messages?.collection?.find?.(x => x?.identifier === 'chatHistory');
    if (!Array.isArray(hist?.collection)) return null;
    const leaves = [];
    const walk = col => { for (const it of col.collection) { if (!it) continue; if (Array.isArray(it.collection)) walk(it); else leaves.push(it); } };
    walk(hist);
    const chat = ctx().chat ?? [];
    const core = nonHidden(chat);
    if (type === 'swipe') core.pop(); // ข้อความที่กำลังสุ่มใหม่ไม่ได้อยู่ในพรอมท์
    let j = core.length - 1, count = 0, oldest = null, chatTok = 0, sysTok = 0, orig = 0;
    let roleN = 0, roleTok = 0, roleOldest = null;
    for (let i = leaves.length - 1; i >= 0; i--) {
        const it = leaves[i];
        const id = String(it.identifier ?? '');
        const tok = Number(it.tokens) || 0;
        orig += tok;
        if (SYS_IDS.includes(id)) { sysTok += tok; continue; }
        if (/^chatHistory-\d+$/.test(id) && (it.role === 'user' || it.role === 'assistant')) { roleN++; roleTok += tok; }
        if (it.role === 'tool') { chatTok += tok; continue; } // ผลของ tool เป็นส่วนของข้อความที่เรียก tool
        if (id.startsWith('toolCall-')) {
            chatTok += tok;
            if (j >= 0) { count++; oldest = core[j]; j--; }
            continue;
        }
        const text = normText(contentText(it.content));
        if (!text) continue;
        for (let k = j; k >= Math.max(0, j - 2); k--) {
            const sn = snippets(chat[core[k]]?.mes);
            if (sn.length && sn.some(x => text.includes(x))) {
                count++; chatTok += tok; oldest = core[k]; j = k - 1;
                break;
            }
        }
    }
    if (roleN) roleOldest = core[Math.max(0, core.length - roleN)] ?? null;
    // จับคู่ไม่ได้เลย (เช่น regex แปลงข้อความทั้งหมด) — ใช้นับตาม role แบบ ST แทน
    if (!count && roleN) return { count: roleN, oldest: roleOldest, chatTok: roleTok, sysTok, injTok: Math.max(0, orig - roleTok - sysTok), orig, matched: false };
    return { count, oldest, chatTok, sysTok, injTok: Math.max(0, orig - chatTok - sysTok), orig, matched: true };
}

/** text completion: ใช้ขอบที่ ST คำนวณไว้ (lastInContextMessageId) */
function stIncludedCount(dry) {
    if (dry) return null;
    const c = ctx();
    const lic = c.chatMetadata?.lastInContextMessageId;
    return Number.isInteger(lic) ? c.chat.length - lic : null;
}

/** ค่าที่ทำให้ผลวัดเดิมใช้ไม่ได้ถ้าเปลี่ยน: API · แหล่ง · โมเดล · ขนาด context · ที่กันไว้ตอบ · preset */
function settingsSig() {
    const c = ctx();
    const o = oai?.oai_settings;
    if (c.mainApi !== 'openai' || !o) return String(c.mainApi ?? '');
    let model = '';
    try { model = oai.getChatCompletionModel?.() ?? ''; } catch { /* ignore */ }
    return [c.mainApi, o.chat_completion_source, model, o.openai_max_context, o.openai_max_tokens, o.preset_settings_openai].join('|');
}

function readTokens(a) {
    const c = ctx();
    if (c.mainApi !== 'openai' || !oai?.promptManager?.tokenHandler || !oai.oai_settings) return null;
    const counts = { ...(oai.promptManager.tokenHandler.getCounts?.() ?? {}) };
    const max = Number(oai.oai_settings.openai_max_context) || 0;
    const reserve = Number(oai.oai_settings.openai_max_tokens) || 0;
    const total = Object.values(counts).reduce((x, v) => x + (Number(v) || 0), 0);
    if (!max || !total) return null;
    // แยกก้อน chatHistory: แชทจริง / ที่แทรกตามความลึก / [Start a new chat]
    const orig = Number(counts.chatHistory) || 0;
    if (a && orig && a.chatTok + a.sysTok <= orig) {
        counts.chatHistory = a.chatTok;
        if (a.sysTok) counts.newMainChat = (Number(counts.newMainChat) || 0) + a.sysTok;
        if (orig - a.chatTok - a.sysTok > 0) counts.__injected = orig - a.chatTok - a.sysTok;
    }
    return { counts, total, max, reserve, budget: Math.max(1, max - reserve) };
}

let userDryRun = false; // กด "วัดตอนนี้" เอง

function capture(type, dry) {
    const c = ctx();
    if (!c.chatId || !Array.isArray(c.chat)) return;
    // รอบจำลองที่ ST/extension สั่งเอง ไม่ทับค่าจากรอบที่ส่งจริงของแชทเดียวกันที่ยังไม่มีข้อความเพิ่ม
    if (dry && !userDryRun && meas && !meas.est && meas.chatId === c.chatId && meas.len === c.chat.length && meas.sig === settingsSig()) {
        diag(`skip dry run: real measurement still current`);
        return;
    }
    const chat = c.chat;
    const list = nonHidden(chat);
    const a = c.mainApi === 'openai' ? analyzeChatHistory(type) : null;
    const tokens = readTokens(a);
    let idx, all, sent;
    if (a) {
        sent = a.count;
        if (a.oldest === null) { idx = (list.at(-1) ?? 0) + 1; all = !list.length; }
        else { idx = a.oldest; all = idx <= (list[0] ?? 0); }
        if (!a.matched) diag('chat history matched by role only (prompt text differs from chat)');
    } else {
        let n = stIncludedCount(dry);
        if (n === null && !tokens) return;
        idx = meas?.idx ?? 0; all = meas?.all ?? true; sent = n ?? meas?.sent ?? 0;
        if (n !== null) {
            all = n >= list.length;
            idx = all ? (list[0] ?? 0) : list[list.length - n];
            sent = type === 'swipe' || type === 'regenerate' || type === 'continue' ? n - 1 : n;
        }
    }
    meas = { v: 3, chatId: c.chatId, at: Date.now(), type, est: !!dry, idx, all, sent, len: chat.length, tokens, sig: settingsSig() };
    diag(`capture ${type}${dry ? ' (dry)' : ''} sent=${sent} idx=${idx} all=${all} total=${tokens?.total ?? '-'}${a ? ` chat=${a.chatTok} inj=${a.injTok}` : ''}`);
    if (!dry) {
        try { c.chatMetadata[MODULE] = meas; } catch { /* ignore */ }
    }
    refresh({ alert: !dry });
}

function loadForChat() {
    const c = ctx();
    meas = null;
    if (!c.chatId) return;
    const saved = c.chatMetadata?.[MODULE];
    lastAlert = { chatId: c.chatId, level: 0 };
    if (saved?.v === 3 && Number.isInteger(saved.idx)) {
        meas = { ...saved, chatId: c.chatId };
        return;
    }
    // ผลวัดจากเวอร์ชันก่อน (นับเพี้ยนได้) หรือไม่มีเลย: แชท Chat Completion ให้วัดใหม่เอง
    // ไม่ใช้ lastInContextMessageId ของ ST เพราะอาจค้างมาจาก preset/โมเดล/ขนาด context เดิม
    if (c.mainApi === 'openai') {
        scheduleRecalc('chat opened without a current measurement');
    } else if (Number.isInteger(c.chatMetadata?.lastInContextMessageId) && c.chat?.length) {
        const idx = c.chatMetadata.lastInContextMessageId;
        meas = { v: 3, chatId: c.chatId, at: 0, type: 'st', est: true, idx, all: idx <= 0, sent: 0, len: c.chat.length, tokens: null, sig: settingsSig() };
    }
}

/** รวมทุกอย่างเป็นข้อมูลพร้อมแสดง คำนวณสดจากแชทปัจจุบัน */
function model() {
    const c = ctx();
    const s = settings();
    const chat = Array.isArray(c.chat) ? c.chat : [];
    const list = nonHidden(chat);
    const T = list.length;
    const recalcing = !!(recalcTimer || recalcRunning);
    const stale = !!meas && meas.chatId === c.chatId && !!meas.sig && meas.sig !== settingsSig();
    if (recalcing && (!meas || meas.chatId !== c.chatId || stale)) return { ready: false, T, state: 'recalc', reasons: [] };
    if (!c.chatId || !meas || meas.chatId !== c.chatId) {
        return { ready: false, T, state: 'idle', reasons: [] };
    }
    if (stale) return { ready: false, T, state: 'idle', stale: true, reasons: [] };
    const all = meas.all || meas.idx <= (list[0] ?? 0);
    const idx = all ? (list[0] ?? 0) : meas.idx;
    const remembered = all ? T : list.filter(i => i >= idx).length;
    const forgotten = T - remembered;

    // Memory Hub: สรุปไว้ถึงข้อความไหน
    const mh = c.chatMetadata?.memory_hub;
    const mhActive = !!mh && Number.isInteger(mh.lastEnd) && (mh.lastEnd >= 0 || mh.memories?.length);
    const summarizedUpTo = mhActive ? mh.lastEnd : null;
    let unsummarized = null, forgottenSummarized = 0;
    if (mhActive) {
        unsummarized = 0;
        for (const i of list) {
            if (i >= idx || all) break;
            if (i <= summarizedUpTo) forgottenSummarized++; else unsummarized++;
        }
    }

    const tk = meas.tokens;
    let groups = null, fixed = 0, chatTokens = 0;
    if (tk) {
        const sum = Object.fromEntries(GROUPS.map(g => [g.key, 0]));
        for (const [id, v] of Object.entries(tk.counts)) {
            const n = Number(v) || 0;
            if (!n) continue;
            let g = GROUPS.find(g => g.ids.includes(id));
            if (!g && UUID.test(id)) g = GROUPS.find(g => g.key === 'preset');
            sum[(g ?? GROUPS.at(-1)).key] += n;
        }
        groups = GROUPS.map(g => ({ key: g.key, label: g.label, tokens: sum[g.key] })).filter(g => g.tokens > 0);
        chatTokens = sum.chat;
        fixed = tk.total - chatTokens;
    }
    const room = tk && all ? Math.max(0, tk.budget - tk.total) : (tk ? 0 : null);

    // สถานะ
    const reasons = [];
    let level = 0;
    if (tk && T > 0 && meas.sent === 0 && !meas.est) {
        level = 2; reasons.push({ level: 2, text: 'ไม่มีข้อความแชทถูกส่งไปเลย — ส่วนที่ส่งทุกรอบ (การ์ด/lore/preset) กินงบหมดแล้ว', tip: 'ลด Lorebook หรือ preset หรือเพิ่ม Context Size' });
    } else if (tk && tk.total > tk.budget * 1.02) {
        level = 2; reasons.push({ level: 2, text: `พรอมท์เกินงบ ${fmt(tk.total - tk.budget)} token`, tip: 'โมเดลอาจตัดคำตอบหรือปฏิเสธคำขอ' });
    }
    if (s.minWindow > 0 && !all && remembered < s.minWindow) {
        level = Math.max(level, 1);
        reasons.push({ level: 1, text: `AI จำย้อนได้แค่ ${remembered} ข้อความ (ตั้งไว้ขั้นต่ำ ${s.minWindow})`, tip: 'ข้อความยาวมาก หรือส่วนที่ส่งทุกรอบใหญ่เกินไป' });
    }
    if (tk && s.fixedPct > 0 && fixed / tk.budget * 100 >= s.fixedPct) {
        level = Math.max(level, 1);
        const big = groups.filter(g => g.key !== 'chat').sort((a, b) => b.tokens - a.tokens)[0];
        reasons.push({ level: 1, text: `ส่วนที่ส่งทุกรอบกินงบ ${pct(fixed / tk.budget)} เหลือให้ประวัติแชทน้อย`, tip: big ? `ตัวใหญ่สุดคือ ${big.label} (${fmt(big.tokens)} token)` : '' });
    }
    if (s.warnUnsummarized && unsummarized > 0) {
        level = Math.max(level, 1);
        reasons.push({ level: 1, text: `${unsummarized} ข้อความหลุดจากความจำแล้วแต่ Memory Hub ยังไม่ได้สรุป`, tip: 'สั่งสรุปใน Memory Hub เพื่อไม่ให้เนื้อเรื่องส่วนนั้นหายไป' });
    }
    const state = ['ok', 'watch', 'over'][level];

    // ข้อความตัวอย่างของขอบความจำ
    const hm = chat[idx];
    const snippet = hm ? String(hm.mes ?? '').replace(/\s+/g, ' ').trim().slice(0, 90) : '';

    return {
        ready: true, est: meas.est, at: meas.at, T, idx, all, remembered, forgotten,
        lastIdx: list.at(-1) ?? 0, firstIdx: list[0] ?? 0,
        mhActive, summarizedUpTo, unsummarized, forgottenSummarized,
        tk, groups, fixed, chatTokens, room,
        level, state, reasons, snippet, snippetName: hm?.name ?? '',
    };
}

// ───────────────────────── formatting ─────────────────────────

const fmt = n => Math.round(Number(n) || 0).toLocaleString();
const fmtK = n => {
    n = Math.round(Number(n) || 0);
    if (Math.abs(n) < 1000) return String(n);
    if (Math.abs(n) < 100000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return Math.round(n / 1000) + 'k';
};
const pct = f => `${Math.round(f * 100)}%`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const STATE_LABEL = { ok: 'ปกติ', watch: 'ระวัง', over: 'เกินงบ', idle: 'รอวัด', recalc: 'กำลังวัด' };

/** ข้อความของแต่ละช่องข้อมูล: [ย่อ, เต็ม] หรือ null ถ้าไม่มีค่าให้แสดง */
function fieldText(key, m) {
    if (!m.ready) return null;
    switch (key) {
        case 'horizon':
            return m.all ? ['จำครบ', 'AI ยังจำได้ทั้งแชท'] : [`จำ ${m.remembered}`, `AI จำย้อนได้ ${m.remembered} ข้อความ`];
        case 'room':
            if (m.room === null || !m.all) return null;
            return [`ว่าง ${fmtK(m.room)}`, `เหลืออีก ${fmtK(m.room)} token ก่อนเริ่มลืม`];
        case 'unsummarized':
            return m.unsummarized > 0 ? [`ไม่ได้สรุป ${m.unsummarized}`, `${m.unsummarized} ข้อความที่ลืมไปยังไม่ได้สรุป`] : null;
        case 'forgotten':
            return m.forgotten > 0 ? [`ลืม ${m.forgotten}`, `ลืมไปแล้ว ${m.forgotten} ข้อความ`] : null;
        case 'tokens':
            return m.tk ? [`${fmtK(m.tk.total)}/${fmtK(m.tk.budget)}`, `ส่ง ${fmtK(m.tk.total)} จากงบ ${fmtK(m.tk.budget)} token`] : null;
        case 'percent':
            return m.tk ? [pct(m.tk.total / m.tk.budget), `ใช้งบ ${pct(m.tk.total / m.tk.budget)}`] : null;
    }
    return null;
}

/** ส่วนของแถบไทม์ไลน์: [{cls, w}] สัดส่วนรวม ≤ 1 */
function timelineSegs(m) {
    if (!m.ready) return [];
    if (m.all) {
        if (!m.tk) return [{ cls: 'mem', w: 1 }];
        const b = m.tk.budget;
        return [{ cls: 'fixed', w: Math.min(1, m.fixed / b) }, { cls: 'mem', w: Math.min(1, m.chatTokens / b) }];
    }
    const T = Math.max(1, m.T);
    if (m.mhActive) {
        return [
            { cls: 'sum', w: m.forgottenSummarized / T },
            { cls: 'lost', w: m.unsummarized / T },
            { cls: 'mem', w: m.remembered / T },
        ];
    }
    return [{ cls: 'gone', w: m.forgotten / T }, { cls: 'mem', w: m.remembered / T }];
}
const segHTML = m => timelineSegs(m).filter(x => x.w > 0).map(x => `<i class="mh-seg mh-seg-${x.cls}" style="flex-basis:${(x.w * 100).toFixed(2)}%"></i>`).join('');

// ───────────────────────── badges ─────────────────────────

const badges = new Map(); // place -> element
let skipClick = false;

function mountPoint(place) {
    switch (place) {
        case 'perch': return { parent: document.getElementById('send_form'), how: 'append' };
        case 'strip': return { parent: document.getElementById('send_form'), how: 'append' };
        case 'top': return { parent: document.getElementById('sheld'), how: 'append' };
        case 'float': return { parent: document.body, how: 'append' };
    }
    return {};
}

function ensureBadges() {
    const s = settings();
    for (const place of Object.keys(PLACES)) {
        const want = s.enabled && s.places[place]?.on;
        let el = badges.get(place);
        if (!want) {
            if (el) { el.remove(); badges.delete(place); }
            continue;
        }
        // ปุ่มลอยที่ Quick Dock ย้ายไปไว้ในถาดยังนับว่าติดตั้งอยู่
        if (el?.isConnected && (place === 'float' || el.parentElement === mountPoint(place).parent)) continue;
        const { parent, how } = mountPoint(place);
        if (!parent) continue;
        if (!el) el = createBadge(place);
        if ((place === 'strip' || place === 'perch') && getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
        if (how === 'prepend') parent.prepend(el); else parent.append(el);
        badges.set(place, el);
        if (place === 'float') placeFloat();
    }
}

function createBadge(place) {
    const el = document.createElement('div');
    el.className = `mh-badge mh-at-${place}`;
    el.id = place === 'float' ? 'mh_float' : `mh_badge_${place}`;
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.title = 'Memory Horizon — แตะเพื่อดูรายละเอียด';
    el.addEventListener('click', e => {
        if (skipClick) { skipClick = false; e.preventDefault(); e.stopPropagation(); return; }
        e.preventDefault(); e.stopPropagation();
        openSheet();
    });
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSheet(); } });
    if (place === 'float') makeDraggable(el);
    return el;
}

function renderBadges(m) {
    const s = settings();
    const fields = Object.keys(FIELDS).filter(k => s.fields.includes(k));
    for (const [place, el] of badges) {
        const size = s.places[place].size;
        el.dataset.size = size;
        el.dataset.state = m.state;
        el.dataset.est = m.est ? '1' : '';
        // Quick Dock อ่าน data-qd… ไม่ได้ แต่อ่าน data-state: ใช้ค่ามาตรฐานที่มันรู้จัก
        if (place === 'float') el.dataset.state = m.state === 'over' ? 'attention' : m.state === 'watch' ? 'warning' : m.state;
        el.classList.toggle('mh-state-ok', m.state === 'ok');
        el.classList.toggle('mh-state-watch', m.state === 'watch');
        el.classList.toggle('mh-state-over', m.state === 'over');
        el.classList.toggle('mh-state-idle', m.state === 'idle');
        el.classList.toggle('mh-state-recalc', m.state === 'recalc');
        el.classList.toggle('mh-side-right', s.side === 'right');

        const texts = fields.map(k => fieldText(k, m)).filter(Boolean);
        const tl = `<span class="mh-tl">${segHTML(m) || '<i class="mh-seg mh-seg-empty" style="flex-basis:100%"></i>'}</span>`;
        const dot = '<i class="mh-dot"></i>';
        let text = '';
        if (!m.ready) text = size === 'mini' ? '' : `<span class="mh-txt mh-muted">${m.state === 'recalc' ? 'กำลังคำนวณ…' : 'รอวัด'}</span>`;
        // แบบย่อแสดงแค่ 2 ช่องแรกที่มีค่า (ตามลำดับในตั้งค่า) ให้ป้ายสั้น
        else if (size === 'compact') text = texts.length ? `<span class="mh-txt">${texts.slice(0, 2).map(t => esc(t[0])).join('<b class="mh-sep">·</b>')}</span>` : '';
        else if (size === 'full') text = texts.length ? `<span class="mh-txt mh-txt-full">${texts.map(t => `<span>${esc(t[1])}</span>`).join('')}</span>` : '';

        if (place === 'strip') {
            // ถ้าเปิดป้ายเกาะขอบด้วย ไม่ต้องมีป้ายตัวเลขบนเส้นซ้ำ
            const label = size !== 'mini' && text && !badges.has('perch');
            el.innerHTML = `<span class="mh-strip-track">${segHTML(m)}</span>${label ? `<span class="mh-strip-label">${dot}${text}</span>` : ''}`;
        } else {
            el.innerHTML = `<span class="mh-glyph">${tl}${dot}</span>${text}`;
        }
        const label = (texts.map(t => t[1]).join(' · ') || (m.ready ? STATE_LABEL[m.state] : m.state === 'recalc' ? 'กำลังคำนวณใหม่' : 'ยังไม่ได้วัด')) + (m.ready && m.est ? ' (ค่าประมาณ)' : '');
        el.setAttribute('aria-label', `Memory Horizon: ${label}`);
        el.title = `Memory Horizon — ${label}`;
    }
}

// ───────────────────────── floating badge ─────────────────────────

function visibleArea() {
    const vv = window.visualViewport;
    return vv ? { w: vv.width, h: vv.height, x: vv.offsetLeft, y: vv.offsetTop } : { w: innerWidth, h: innerHeight, x: 0, y: 0 };
}

function placeFloat() {
    const el = badges.get('float');
    if (!el || !el.isConnected || el.parentElement !== document.body) return; // อยู่ในถาด Quick Dock
    const s = settings();
    const a = visibleArea();
    const r = el.getBoundingClientRect();
    const w = r.width || 40, h = r.height || 28;
    const p = s.floatPos ?? { x: a.w - w - 12, y: a.h * 0.62 };
    const x = Math.min(Math.max(8, p.x), a.w - w - 8);
    const y = Math.min(Math.max(8, p.y), a.h - h - 8);
    el.style.left = `${Math.round(a.x + x)}px`;
    el.style.top = `${Math.round(a.y + y)}px`;
}

function makeDraggable(el) {
    let start = null;
    el.addEventListener('pointerdown', e => {
        skipClick = false;
        if (el.parentElement !== document.body || e.button > 0) return;
        const r = el.getBoundingClientRect();
        start = { x: e.clientX, y: e.clientY, ox: r.left, oy: r.top, moved: false, id: e.pointerId };
    });
    el.addEventListener('pointermove', e => {
        if (!start || e.pointerId !== start.id) return;
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (!start.moved && Math.hypot(dx, dy) < 8) return;
        if (!start.moved) { start.moved = true; el.setPointerCapture?.(e.pointerId); el.classList.add('mh-dragging'); }
        el.style.left = `${start.ox + dx}px`;
        el.style.top = `${start.oy + dy}px`;
        e.preventDefault();
    });
    const end = () => {
        if (!start) return;
        if (start.moved) {
            skipClick = true;
            el.classList.remove('mh-dragging');
            const a = visibleArea();
            const r = el.getBoundingClientRect();
            const snapRight = r.left + r.width / 2 > a.w / 2;
            settings().floatPos = { x: snapRight ? a.w - r.width - 12 : 12, y: r.top - a.y };
            save();
            el.classList.add('mh-snapping');
            placeFloat();
            setTimeout(() => el.classList.remove('mh-snapping'), 260);
        }
        start = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
}

// ───────────────────────── chat marker ─────────────────────────

let markerTimer = null;
function scheduleMarker() {
    clearTimeout(markerTimer);
    markerTimer = setTimeout(applyMarker, 120);
}

function applyMarker() {
    const s = settings();
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;
    document.body.classList.toggle('mh-hide-st-line', s.enabled && s.marker && s.hideStLine);
    const m = model();
    const showMarker = s.enabled && s.marker && m.ready && !m.all;
    const dim = s.enabled && s.dim && m.ready && !m.all;
    for (const mes of chatEl.querySelectorAll('.mes')) {
        const id = Number(mes.getAttribute('mesid'));
        const isH = showMarker && id === m.idx;
        mes.classList.toggle('mh-horizon', isH);
        if (isH) mes.dataset.mhLabel = `AI จำได้ตั้งแต่ตรงนี้ · ลืมไปแล้ว ${m.forgotten} ข้อความ`;
        else delete mes.dataset.mhLabel;
        mes.classList.toggle('mh-forgotten', dim && id < m.idx);
    }
}

// ───────────────────────── detail sheet ─────────────────────────

let sheet = null;
let openedAt = 0;

function buildSheet() {
    const root = document.createElement('div');
    root.id = 'mh_sheet';
    root.className = 'mh-sheet-root';
    root.innerHTML = `
        <div class="mh-backdrop"></div>
        <div class="mh-sheet" role="dialog" aria-modal="true" aria-label="Memory Horizon">
            <div class="mh-grab"><i></i></div>
            <div class="mh-sheet-body"></div>
        </div>`;
    root.querySelector('.mh-backdrop').addEventListener('click', () => { if (Date.now() - openedAt > 450) closeSheet(); });
    root.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
    // ปัดลงเพื่อปิด
    const panel = root.querySelector('.mh-sheet');
    let sy = null, dy = 0;
    panel.addEventListener('pointerdown', e => {
        const body = root.querySelector('.mh-sheet-body');
        if (e.target.closest('button, input, select, a')) return;
        if (body.scrollTop > 0 && !e.target.closest('.mh-grab, .mh-head')) return;
        sy = e.clientY; dy = 0;
    });
    panel.addEventListener('pointermove', e => {
        if (sy === null) return;
        dy = Math.max(0, e.clientY - sy);
        if (dy > 6) { panel.style.transition = 'none'; panel.style.transform = `translateY(${dy}px)`; }
    });
    const up = () => {
        if (sy === null) return;
        panel.style.transition = ''; panel.style.transform = '';
        if (dy > 90) closeSheet();
        sy = null;
    };
    panel.addEventListener('pointerup', up);
    panel.addEventListener('pointercancel', up);
    root.addEventListener('click', e => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!act) return;
        if (act === 'close') closeSheet();
        if (act === 'jump') jumpToHorizon();
        if (act === 'measure') measureNow();
        if (act === 'settings') openSettingsDrawer();
        if (act === 'lorelens') { closeSheet(); try { globalThis.LoreLens.open('tok'); } catch (err) { reportError('เปิด Lore Lens ไม่สำเร็จ', err); } }
    });
    document.body.append(root);
    return root;
}

function openSheet() {
    try {
        if (!sheet || !sheet.isConnected) sheet = buildSheet();
    } catch (err) {
        sheet?.remove(); sheet = null;
        reportError('สร้างหน้ารายละเอียดไม่สำเร็จ', err);
        return;
    }
    diag('open sheet');
    openedAt = Date.now();
    sheet.classList.add('mh-open');
    document.body.classList.add('mh-sheet-open');
    try { renderSheet(); } catch (err) { reportError('แสดงรายละเอียดไม่สำเร็จ', err); }
    sheet.querySelector('.mh-close')?.focus({ preventScroll: true });
}

function closeSheet() {
    if (!sheet?.classList.contains('mh-open')) return;
    diag(`close sheet ${Date.now() - openedAt}ms after open · ${(new Error().stack || '').split('\n').slice(2, 4).map(x => x.trim()).join(' < ')}`);
    sheet.classList.remove('mh-open');
    document.body.classList.remove('mh-sheet-open');
}

const isSheetOpen = () => !!sheet?.classList.contains('mh-open');

function renderSheet() {
    if (!isSheetOpen()) return;
    const m = model();
    const body = sheet.querySelector('.mh-sheet-body');
    sheet.dataset.state = m.state;

    const head = `
        <div class="mh-head">
            <span class="mh-logo" aria-hidden="true">${LOGO_SVG}</span>
            <div class="mh-title"><b>Memory Horizon <span class="mh-vertag">v${VERSION}</span></b><small>${esc(ctx().name2 || '')}</small></div>
            <span class="mh-pill mh-pill-${m.state}">${STATE_LABEL[m.state]}</span>
            <button class="mh-close" data-act="close" title="ปิด" aria-label="ปิด"><i class="fa-solid fa-xmark"></i></button>
        </div>`;

    if (!m.ready) {
        const msg = m.state === 'recalc'
            ? ['กำลังคำนวณใหม่…', 'จำลองพรอมท์ตามพรีเซต โมเดล และขนาด context ปัจจุบัน ไม่ได้ส่งอะไรให้โมเดล']
            : m.stale
                ? ['การตั้งค่าเปลี่ยนไปแล้ว', 'พรีเซต โมเดล หรือขนาด context ไม่ตรงกับตอนที่วัดไว้ ตัวเลขเดิมใช้ไม่ได้ — กด “วัดตอนนี้” หรือส่งข้อความหนึ่งครั้ง']
                : ['ยังไม่ได้วัดในแชทนี้', 'ส่งข้อความหนึ่งครั้ง หรือกด “วัดตอนนี้” เพื่อจำลองพรอมท์โดยไม่ส่งจริง'];
        body.innerHTML = `${head}
            <div class="mh-empty${m.state === 'recalc' ? ' mh-recalc' : ''}">
                <div class="mh-empty-art">${LOGO_SVG}</div>
                <p><b>${msg[0]}</b></p>
                <p class="mh-muted">${msg[1]}</p>
                ${m.state === 'recalc' ? '' : '<div class="mh-actions"><button class="mh-btn mh-btn-primary" data-act="measure"><i class="fa-solid fa-wand-magic-sparkles"></i> วัดตอนนี้</button></div>'}
            </div>`;
        return;
    }

    const hero = m.all
        ? `<div class="mh-hero">
                <div class="mh-big mh-big-text">ทั้งแชท</div>
                <div class="mh-hero-sub">AI ยังจำได้ครบทั้ง ${fmt(m.T)} ข้อความ${m.room !== null ? ` · เหลืออีก <b>${fmt(m.room)}</b> token ก่อนเริ่มลืม` : ''}</div>
           </div>`
        : `<div class="mh-hero">
                <div class="mh-big">${fmt(m.remembered)}<span>ข้อความ</span></div>
                <div class="mh-hero-sub">ที่ AI ยังจำได้ จากทั้งหมด ${fmt(m.T)} · ลืมไปแล้ว ${fmt(m.forgotten)}</div>
           </div>`;

    // ไทม์ไลน์ใหญ่
    const segs = timelineSegs(m).filter(x => x.w > 0);
    const legendItems = m.all
        ? (m.tk ? [['fixed', 'ส่วนที่ส่งทุกรอบ'], ['mem', 'ประวัติแชท'], ['room', 'ที่ว่าง']] : [['mem', 'จำได้']])
        : m.mhActive ? [['sum', 'ลืมแล้ว · สรุปไว้'], ['lost', 'ลืมแล้ว · ยังไม่สรุป'], ['mem', 'จำได้']] : [['gone', 'ลืมแล้ว'], ['mem', 'จำได้']];
    const marker = !m.all ? `<span class="mh-tl-marker" style="left:${((m.forgotten / Math.max(1, m.T)) * 100).toFixed(2)}%"><em>#${m.idx}</em></span>` : '';
    const timeline = m.all && m.tk ? '' : `
        <div class="mh-card">
            <div class="mh-card-title">${m.all ? 'พื้นที่ความจำ' : 'ไทม์ไลน์ของแชท'}</div>
            <div class="mh-timeline"><div class="mh-tl-big">${segs.map(x => `<i class="mh-seg mh-seg-${x.cls}" style="flex-basis:${(x.w * 100).toFixed(2)}%"></i>`).join('')}</div>${marker}</div>
            ${!m.all ? `<div class="mh-tl-ends"><span>#${m.firstIdx} เริ่มแชท</span><span>ล่าสุด #${m.lastIdx}</span></div>` : ''}
            <div class="mh-legend">${legendItems.map(([k, l]) => `<span><i class="mh-sw mh-seg-${k}"></i>${l}</span>`).join('')}</div>
            ${!m.all && m.snippet ? `<button class="mh-quote" data-act="jump"><span class="mh-quote-k">ขอบความจำ · #${m.idx}${m.snippetName ? ` · ${esc(m.snippetName)}` : ''}</span><span class="mh-quote-t">“${esc(m.snippet)}${m.snippet.length >= 90 ? '…' : ''}”</span><span class="mh-quote-go">ไปที่ข้อความนี้ <i class="fa-solid fa-arrow-right"></i></span></button>` : ''}
        </div>`;

    // งบ context
    let budget = '';
    if (m.tk) {
        const b = m.tk.budget;
        const rows = [...m.groups].sort((a, b) => b.tokens - a.tokens);
        budget = `
        <div class="mh-card">
            <div class="mh-card-title">อะไรกิน context <span class="mh-muted">${fmt(m.tk.total)} / ${fmt(b)}</span></div>
            <div class="mh-stack">${rows.map(g => `<i class="mh-g-${g.key}" style="flex-basis:${Math.min(100, g.tokens / b * 100).toFixed(2)}%" title="${esc(g.label)} ${fmt(g.tokens)}"></i>`).join('')}</div>
            <div class="mh-rows">${rows.map(g => `
                <div class="mh-row"><i class="mh-sw mh-g-${g.key}"></i><span class="mh-row-l">${esc(g.label)}</span><span class="mh-row-v">${fmt(g.tokens)}</span><span class="mh-row-p">${pct(g.tokens / b)}</span></div>`).join('')}
            </div>
            <div class="mh-foot">งบ = Context ${fmt(m.tk.max)} − กันไว้ตอบ ${fmt(m.tk.reserve)} · ST ใส่ประวัติแชทจนเต็มงบเสมอ ตัวเลขใกล้ 100% จึงเป็นเรื่องปกติ</div>
        </div>`;
    } else if (ctx().mainApi !== 'openai') {
        budget = `<div class="mh-card mh-muted mh-note">รายละเอียด token มีเฉพาะโหมด Chat Completion · ขอบความจำยังใช้ได้ตามปกติ</div>`;
    }

    const status = m.reasons.length
        ? `<div class="mh-card mh-status">${m.reasons.map(r => `
            <div class="mh-reason mh-reason-${r.level === 2 ? 'over' : 'watch'}">
                <i class="fa-solid ${r.level === 2 ? 'fa-circle-exclamation' : 'fa-triangle-exclamation'}"></i>
                <div><b>${esc(r.text)}</b>${r.tip ? `<small>${esc(r.tip)}</small>` : ''}</div>
            </div>`).join('')}</div>`
        : `<div class="mh-card mh-status"><div class="mh-reason mh-reason-ok"><i class="fa-solid fa-circle-check"></i><div><b>ไม่มีอะไรต้องห่วง</b><small>${m.all ? 'ทุกข้อความยังอยู่ในความจำของ AI' : 'ข้อความเก่าหลุดตามปกติของแชทยาว'}</small></div></div></div>`;

    const when = m.at ? new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const src = m.est ? (m.at ? 'ประมาณจากการจำลอง' : 'ประมาณจากข้อมูลเดิมของแชท') : 'จากรอบที่ส่งจริง';

    body.innerHTML = `${head}${hero}${timeline}${budget}${status}
        <div class="mh-actions">
            ${!m.all ? '<button class="mh-btn" data-act="jump"><i class="fa-solid fa-location-crosshairs"></i> ไปที่ขอบความจำ</button>' : ''}
            <button class="mh-btn" data-act="measure"><i class="fa-solid fa-rotate"></i> วัดตอนนี้</button>
            ${typeof globalThis.LoreLens?.open === 'function' ? '<button class="mh-btn" data-act="lorelens" title="ดูว่าแต่ละ extension / lorebook entry กินเท่าไหร่ใน Lore Lens"><i class="fa-solid fa-magnifying-glass-chart"></i> ละเอียดใน Lore Lens</button>' : ''}
            <button class="mh-btn mh-btn-icon" data-act="settings" title="ตั้งค่า" aria-label="ตั้งค่า"><i class="fa-solid fa-sliders"></i></button>
        </div>
        <div class="mh-meta">${m.est ? '≈ ' : ''}${src}${when ? ` · ${when}` : ''}</div>`;
}

const LOGO_SVG = `<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
<path class="mh-logo-sun" d="M8 19a8 8 0 0 1 16 0z"/>
<path class="mh-logo-ray" d="M16 6v3M7.5 10.5l2 2M24.5 10.5l-2 2M4 16.5h2.5M25.5 16.5H28" stroke-linecap="round"/>
<path class="mh-logo-line" d="M3 21.5h26" stroke-linecap="round"/>
<path class="mh-logo-fade" d="M7 25.5h18M11 28.5h10" stroke-linecap="round"/>
</svg>`;

// ───────────────────────── actions ─────────────────────────

async function jumpToHorizon() {
    const m = model();
    if (!m.ready || m.all) return;
    closeSheet();
    let el = document.querySelector(`#chat .mes[mesid="${m.idx}"]`);
    if (!el) {
        try {
            const c = ctx();
            const run = c.executeSlashCommandsWithOptions ?? c.executeSlashCommands;
            await run?.(`/chat-jump ${m.idx}`);
        } catch (err) { reportError('ไปที่ข้อความไม่สำเร็จ', err); return; }
        el = document.querySelector(`#chat .mes[mesid="${m.idx}"]`);
    }
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.remove('mh-flash'); void el.offsetWidth; el.classList.add('mh-flash');
    setTimeout(() => el.classList.remove('mh-flash'), 1800);
}

async function measureNow() {
    const c = ctx();
    if (!c.chatId) { toastr.info('เปิดแชทก่อนนะ'); return; }
    if (typeof c.generate !== 'function') { toastr.warning('ST รุ่นนี้ยังจำลองพรอมท์จาก extension ไม่ได้ — ส่งข้อความหนึ่งครั้งแทน'); return; }
    if (busy) { toastr.info('รอให้ตอบเสร็จก่อน แล้วจะวัดให้เอง'); }
    scheduleRecalc('measure now', 0);
}

// ───────────────────────── recalculation ─────────────────────────
// เปลี่ยนพรีเซต/โมเดล/ขนาด context หรือเปิดแชทที่ยังไม่มีผลวัด: จำลองพรอมท์ใหม่เอง (dry run ไม่ส่งอะไรให้โมเดล)

let recalcTimer = null;
let recalcRunning = false;
let busy = false;        // กำลังสร้างคำตอบจริงอยู่
let busyAt = 0;
let lastRecalcSig = '';

function scheduleRecalc(why, delay = 900) {
    const c = ctx();
    if (!settings().enabled || !c.chatId || c.mainApi !== 'openai' || typeof c.generate !== 'function') return;
    clearTimeout(recalcTimer);
    recalcTimer = setTimeout(() => runRecalc(why), delay);
    refresh();
}

async function runRecalc(why) {
    recalcTimer = null;
    if (busy && Date.now() - busyAt < 60_000) { recalcTimer = setTimeout(() => runRecalc(why), 1500); return; }
    busy = false;
    const c = ctx();
    if (!c.chatId) { refresh(); return; }
    recalcRunning = true;
    lastRecalcSig = settingsSig();
    diag(`recalc: ${why}`);
    refresh();
    try {
        userDryRun = true;
        await c.generate('normal', {}, true);
    } catch (err) {
        diag(`recalc failed: ${err?.message ?? err}`);
    } finally {
        userDryRun = false;
        recalcRunning = false;
        refresh();
    }
}

function openSettingsDrawer() {
    closeSheet();
    const drawer = document.getElementById('mh_settings');
    const extBtn = document.querySelector('#extensions-settings-button .drawer-toggle');
    const panelOpen = document.getElementById('rm_extensions_block')?.classList.contains('openDrawer');
    if (!panelOpen) extBtn?.click();
    setTimeout(() => {
        const content = drawer?.querySelector('.inline-drawer-content');
        if (content && getComputedStyle(content).display === 'none') drawer.querySelector('.inline-drawer-toggle')?.click();
        drawer?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 250);
}

// ───────────────────────── refresh / alerts ─────────────────────────

function refresh({ alert = false } = {}) {
    try {
        ensureBadges();
        const m = model();
        renderBadges(m);
        scheduleMarker();
        renderSheet();
        if (alert) maybeAlert(m);
    } catch (err) {
        reportError('อัปเดตไม่สำเร็จ', err);
    }
}

function maybeAlert(m) {
    const c = ctx();
    if (lastAlert.chatId !== c.chatId) lastAlert = { chatId: c.chatId, level: 0 };
    if (!m.ready || m.est) return;
    if (m.level > lastAlert.level && settings().toast && settings().enabled) {
        const r = m.reasons.find(x => x.level === m.level) ?? m.reasons[0];
        if (r) {
            const fn = m.level === 2 ? toastr.error : toastr.warning;
            fn(`${r.text}${r.tip ? `<br><small>${esc(r.tip)}</small>` : ''}`, 'Memory Horizon', {
                escapeHtml: false, timeOut: 9000, extendedTimeOut: 4000, closeButton: true,
                onclick: () => openSheet(),
            });
        }
    }
    lastAlert.level = m.level;
}

function applyAccent() {
    const s = settings();
    const v = ACCENTS[s.accent]?.[1] ?? ACCENTS.quote[1];
    document.documentElement.style.setProperty('--mh-accent', `var(${v})`);
}

// ───────────────────────── settings drawer ─────────────────────────

function drawerHTML() {
    const s = settings();
    const placeRows = Object.entries(PLACES).map(([k, p]) => `
        <div class="mh-set-place">
            <label class="checkbox_label"><input type="checkbox" data-place-on="${k}" ${s.places[k].on ? 'checked' : ''}><span><b>${p.label}</b><small>${p.hint}</small></span></label>
            <select class="text_pole" data-place-size="${k}">${Object.entries(SIZES).map(([v, l]) => `<option value="${v}" ${s.places[k].size === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </div>`).join('');
    const fieldRows = Object.entries(FIELDS).map(([k, l]) => `
        <label class="checkbox_label"><input type="checkbox" data-field="${k}" ${s.fields.includes(k) ? 'checked' : ''}><span>${l}</span></label>`).join('');
    return `
    <div id="mh_settings" class="mh-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>Memory Horizon <small class="mh-vertag">v${VERSION}</small></b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <div class="flex-container mh-top-btns">
            <div class="menu_button menu_button_icon" id="mh_open"><i class="fa-solid fa-mountain-sun"></i><span>เปิดรายละเอียด</span></div>
            <div class="menu_button menu_button_icon" id="mh_vcheck"><i class="fa-solid fa-magnifying-glass"></i><span>เช็คเวอร์ชัน</span></div>
            <div class="menu_button menu_button_icon" id="mh_reload" title="ดึงไฟล์ของ Memory Horizon จากเซิร์ฟเวอร์ใหม่ทั้งหมดแล้วโหลดหน้าใหม่"><i class="fa-solid fa-rotate"></i><span>โหลดเวอร์ชันล่าสุด</span></div>
          </div>
          <div class="mh-verline">ที่รันอยู่: <b>v${VERSION}</b> <span data-mh-remote></span></div>
          <label class="checkbox_label"><input type="checkbox" id="mh_enabled" ${s.enabled ? 'checked' : ''}><span>เปิดใช้งาน</span></label>

          <h4>ป้ายแสดงผล <small class="mh-muted">เลือกได้หลายจุด แต่ละจุดเลือกขนาดเองได้ · มินิ = ภาพอย่างเดียว</small></h4>
          <div class="mh-set-places">${placeRows}</div>
          <div class="mh-set-row"><span>ป้ายเกาะขอบ / ป้ายบนเส้น อยู่ฝั่ง</span><select class="text_pole" id="mh_side">${Object.entries(SIDES).map(([k, l]) => `<option value="${k}" ${s.side === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="flex-container"><div class="menu_button menu_button_icon" id="mh_float_reset"><i class="fa-solid fa-arrows-to-dot"></i><span>คืนตำแหน่งปุ่มลอย</span></div></div>

          <h4>ข้อมูลบนป้าย <small class="mh-muted">แบบย่อแสดงสั้น ๆ แบบเต็มแสดงเป็นประโยค · ช่องที่ไม่มีค่าจะซ่อนเอง</small></h4>
          <div class="mh-set-fields">${fieldRows}</div>

          <h4>ในแชท</h4>
          <label class="checkbox_label"><input type="checkbox" id="mh_marker" ${s.marker ? 'checked' : ''}><span>เส้นขอบความจำ “AI จำได้ตั้งแต่ตรงนี้”</span></label>
          <label class="checkbox_label"><input type="checkbox" id="mh_hide_st" ${s.hideStLine ? 'checked' : ''}><span>ซ่อนเส้นประเดิมของ SillyTavern เมื่อใช้เส้นนี้</span></label>
          <label class="checkbox_label"><input type="checkbox" id="mh_dim" ${s.dim ? 'checked' : ''}><span>ทำข้อความที่ AI ลืมแล้วให้จางลง</span></label>

          <h4>การเตือน <small class="mh-muted">เตือนครั้งเดียวต่อการแย่ลง เฉพาะรอบที่ส่งจริง</small></h4>
          <div class="mh-set-num"><span>ระวังเมื่อจำย้อนได้น้อยกว่า</span><input type="number" class="text_pole" id="mh_min" min="0" max="500" value="${s.minWindow}"><span>ข้อความ (0 = ปิด)</span></div>
          <div class="mh-set-num"><span>ระวังเมื่อส่วนที่ส่งทุกรอบกินงบเกิน</span><input type="number" class="text_pole" id="mh_fixed" min="0" max="100" value="${s.fixedPct}"><span>% (0 = ปิด)</span></div>
          <label class="checkbox_label"><input type="checkbox" id="mh_warn_mh" ${s.warnUnsummarized ? 'checked' : ''}><span>ระวังเมื่อมีข้อความหลุดไปโดยที่ Memory Hub ยังไม่ได้สรุป</span></label>
          <label class="checkbox_label"><input type="checkbox" id="mh_toast" ${s.toast ? 'checked' : ''}><span>แจ้งเตือนแบบป๊อปอัป</span></label>

          <h4>สี</h4>
          <div class="mh-set-row"><span>สีเน้นดึงจากธีม</span><select class="text_pole" id="mh_accent">${Object.entries(ACCENTS).map(([k, [l]]) => `<option value="${k}" ${s.accent === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <small class="mh-muted">สีอื่นทั้งหมดผสมจากสีธีมปัจจุบัน เปลี่ยนธีมแล้วเปลี่ยนตามเอง ไม่ต้องเขียน CSS</small>

          <hr>
          <div class="flex-container">
            <div class="menu_button menu_button_icon" id="mh_diag"><i class="fa-solid fa-stethoscope"></i><span>ตรวจปัญหา</span></div>
          </div>
          <div id="mh_diag_box" class="mh-diag" hidden>
            <textarea class="text_pole" rows="10" readonly></textarea>
            <div class="menu_button" id="mh_diag_copy">คัดลอกรายงาน</div>
          </div>
        </div>
      </div>
    </div>`;
}

function mountDrawer() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host || document.getElementById('mh_settings')) return;
    host.insertAdjacentHTML('beforeend', drawerHTML());
    const root = document.getElementById('mh_settings');
    const s = settings();
    const changed = () => { save(); refresh(); };

    root.querySelector('#mh_enabled').addEventListener('change', e => { s.enabled = e.target.checked; changed(); });
    root.querySelectorAll('[data-place-on]').forEach(cb => cb.addEventListener('change', () => { s.places[cb.dataset.placeOn].on = cb.checked; changed(); }));
    root.querySelectorAll('[data-place-size]').forEach(sel => sel.addEventListener('change', () => { s.places[sel.dataset.placeSize].size = sel.value; changed(); }));
    root.querySelectorAll('[data-field]').forEach(cb => cb.addEventListener('change', () => {
        s.fields = Object.keys(FIELDS).filter(k => root.querySelector(`[data-field="${k}"]`).checked);
        changed();
    }));
    const bindBool = (id, key) => root.querySelector(id).addEventListener('change', e => { s[key] = e.target.checked; changed(); });
    bindBool('#mh_marker', 'marker');
    bindBool('#mh_hide_st', 'hideStLine');
    bindBool('#mh_dim', 'dim');
    bindBool('#mh_warn_mh', 'warnUnsummarized');
    bindBool('#mh_toast', 'toast');
    const bindNum = (id, key, max) => root.querySelector(id).addEventListener('change', e => {
        s[key] = Math.max(0, Math.min(max, Math.round(Number(e.target.value) || 0)));
        e.target.value = s[key];
        changed();
    });
    bindNum('#mh_min', 'minWindow', 500);
    bindNum('#mh_fixed', 'fixedPct', 100);
    root.querySelector('#mh_accent').addEventListener('change', e => { s.accent = e.target.value; applyAccent(); save(); });
    root.querySelector('#mh_float_reset').addEventListener('click', () => { s.floatPos = null; save(); placeFloat(); });
    root.querySelector('#mh_open').addEventListener('click', () => openSheet());
    root.querySelector('#mh_diag').addEventListener('click', async () => {
        const box = root.querySelector('#mh_diag_box');
        box.hidden = false;
        box.querySelector('textarea').value = 'กำลังตรวจ…';
        box.querySelector('textarea').value = await runDiagnostics();
    });
    root.querySelector('#mh_diag_copy').addEventListener('click', async () => {
        const ta = root.querySelector('#mh_diag_box textarea');
        try { await navigator.clipboard.writeText(ta.value); toastr.success('คัดลอกแล้ว'); }
        catch { ta.select(); toastr.info('เลือกข้อความไว้แล้ว กดคัดลอกเองได้เลย'); }
    });
    root.querySelector('#mh_side').addEventListener('change', e => { s.side = e.target.value; changed(); });
    root.querySelector('#mh_reload').addEventListener('click', reloadLatest);
    root.querySelector('#mh_vcheck').addEventListener('click', async () => {
        const v = await checkRemoteVersion(true);
        if (!v) toastr.warning('อ่านเวอร์ชันบนเซิร์ฟเวอร์ไม่ได้', 'Memory Horizon');
        else if (!newer(v, VERSION)) toastr.success(`v${VERSION} เป็นเวอร์ชันล่าสุดที่ติดตั้งไว้แล้ว`, 'Memory Horizon');
    });
    checkRemoteVersion(true);
}

// ST โหลดไฟล์ extension ด้วย URL เดิมเสมอ เบราว์เซอร์ (และแอปบนหน้าจอโฮมของ iOS) จึงมักใช้ไฟล์เก่า
// จาก cache ต่อหลังกด Update — เทียบกับ manifest บนเซิร์ฟเวอร์ ถ้าใหม่กว่าให้บอก และดึงไฟล์ใหม่ให้
let remoteVersion = '';
let versionCheckedAt = 0;
let versionToastShown = false;
const newer = (a, b) => {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    return false;
};
async function checkRemoteVersion(force = false) {
    if (!force && Date.now() - versionCheckedAt < 10 * 60_000) return remoteVersion;
    versionCheckedAt = Date.now();
    try {
        const r = await fetch(new URL('manifest.json', BASE_URL), { cache: 'no-store' });
        remoteVersion = r.ok ? String((await r.json())?.version ?? '') : '';
    } catch { remoteVersion = ''; }
    const stale = remoteVersion && newer(remoteVersion, VERSION);
    document.querySelectorAll('[data-mh-remote]').forEach(el => {
        el.innerHTML = !remoteVersion ? '' : stale
            ? `· ติดตั้งไว้ <b>v${esc(remoteVersion)}</b> <span class="mh-stale">ยังไม่ได้โหลด กด “โหลดเวอร์ชันล่าสุด”</span>`
            : '· เป็นเวอร์ชันล่าสุดที่ติดตั้งไว้แล้ว';
    });
    if (stale && !versionToastShown) {
        versionToastShown = true;
        toastr.info(`ติดตั้ง v${esc(remoteVersion)} ไว้แล้ว แต่หน้านี้ยังรัน v${VERSION} อยู่<br>แตะที่นี่เพื่อโหลดเวอร์ชันใหม่`, 'Memory Horizon', {
            timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false, onclick: () => reloadLatest(),
        });
    }
    return remoteVersion;
}

async function reloadLatest() {
    try {
        toastr.info('กำลังดึงไฟล์ใหม่…', 'Memory Horizon', { timeOut: 2000 });
        // cache: 'reload' ดึงจากเซิร์ฟเวอร์แล้วเขียนทับ cache ของเบราว์เซอร์ หน้าที่โหลดใหม่จึงได้ไฟล์ใหม่
        await Promise.all(FILES.map(f => fetch(new URL(f, BASE_URL), { cache: 'reload' }).catch(() => null)));
    } finally {
        location.reload();
    }
}

function fixedBreakers(el) {
    const out = [];
    for (let n = el?.parentElement; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        const bad = ['transform', 'perspective', 'filter', 'backdropFilter', 'contain', 'willChange']
            .filter(k => cs[k] && !['none', 'normal', 'auto', ''].includes(cs[k])).map(k => `${k}:${cs[k]}`);
        if (bad.length) out.push(`${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''} {${bad.join('; ')}}`);
    }
    return out;
}

async function runDiagnostics() {
    const lines = [];
    const add = (k, v) => lines.push(`${k}: ${v}`);
    const c = ctx();
    add('version', `v${VERSION} (server ${remoteVersion ?? '?'})`);
    add('ua', navigator.userAgent);
    const vv = window.visualViewport;
    add('viewport', `${innerWidth}x${innerHeight} · vv ${vv ? `${Math.round(vv.width)}x${Math.round(vv.height)} scale ${vv.scale}` : '-'} · dpr ${devicePixelRatio}`);
    add('api', `${c.mainApi} · openai.js ${oai ? 'linked' : 'missing'} · promptManager ${oai?.promptManager ? 'yes' : 'no'}`);
    add('chat', `${c.chatId ?? '-'} · len ${c.chat?.length ?? 0} · lastInContext ${c.chatMetadata?.lastInContextMessageId ?? '-'}`);
    add('meas', JSON.stringify({ ...(meas ?? {}), tokens: meas?.tokens ? { total: meas.tokens.total, budget: meas.tokens.budget } : null }));
    const m = model();
    add('model', JSON.stringify({ ready: m.ready, state: m.state, T: m.T, idx: m.idx, all: m.all, remembered: m.remembered, unsummarized: m.unsummarized }));
    add('badges', [...badges].map(([p, el]) => {
        const r = el.getBoundingClientRect();
        return `${p}@${el.parentElement?.id || el.parentElement?.className || '?'} ${Math.round(r.width)}x${Math.round(r.height)}`;
    }).join(' · ') || 'none');
    openSheet();
    await new Promise(r => setTimeout(r, 700));
    const o = document.getElementById('mh_sheet');
    if (o) {
        const cs = getComputedStyle(o), r = o.getBoundingClientRect();
        const f = o.querySelector('.mh-sheet')?.getBoundingClientRect();
        add('sheet', `display:${cs.display} vis:${cs.visibility} z:${cs.zIndex} rect ${Math.round(r.width)}x${Math.round(r.height)} · panel ${f ? `${Math.round(f.width)}x${Math.round(f.height)} @${Math.round(f.top)}` : '-'}`);
        add('at screen', [0.15, 0.5, 0.85].map(fy => {
            const el = document.elementFromPoint(innerWidth / 2, innerHeight * fy);
            return `${Math.round(fy * 100)}%=${o.contains(el) ? 'sheet' : (el?.id || el?.className || el?.tagName)}`;
        }).join(' · '));
        add('fixed breakers', fixedBreakers(o).join(' | ') || 'none');
    }
    closeSheet();
    add('log', '');
    lines.push(...diagLog.slice(-16).map(x => '  ' + x));
    return lines.join('\n');
}

// ───────────────────────── wiring ─────────────────────────

function addWandItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('mh_wand')) return;
    const item = document.createElement('div');
    item.id = 'mh_wand';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-solid fa-mountain-sun extensionsMenuExtensionButton"></div><span>Memory Horizon</span>';
    item.addEventListener('click', () => openSheet());
    menu.append(item);
}

function registerCommands() {
    const { SlashCommandParser, SlashCommand } = ctx();
    if (!SlashCommandParser || !SlashCommand) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'horizon',
        helpString: 'เปิดหน้ารายละเอียด Memory Horizon',
        callback: () => { openSheet(); return ''; },
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'horizon-debug',
        helpString: 'ตรวจปัญหา Memory Horizon แล้วคืนรายงาน',
        callback: async () => runDiagnostics(),
    }));
}

function wireEvents() {
    const { eventSource, eventTypes } = ctx();
    const ET = eventTypes ?? ctx().event_types;
    const on = (name, fn) => { if (ET?.[name]) eventSource.on(ET[name], (...a) => { try { return fn(...a); } catch (err) { reportError(name, err); } }); };

    on('GENERATION_STARTED', (type, _opts, dryRun) => {
        pending = { type: type || 'normal', dry: !!dryRun };
        if (!dryRun) { busy = true; busyAt = Date.now(); }
    });
    for (const ev of ['GENERATION_ENDED', 'GENERATION_STOPPED', 'MESSAGE_RECEIVED']) on(ev, () => { busy = false; });
    for (const ev of ['OAI_PRESET_CHANGED_AFTER', 'CHATCOMPLETION_MODEL_CHANGED', 'CHATCOMPLETION_SOURCE_CHANGED', 'MAIN_API_CHANGED', 'CONNECTION_PROFILE_LOADED']) {
        on(ev, () => { if (meas && meas.sig !== settingsSig()) scheduleRecalc(ev.toLowerCase(), 1200); });
    }
    on('GENERATE_AFTER_DATA', (_data, dryRun) => {
        const p = pending; pending = null;
        if (!p || p.type === 'quiet') return; // งานเบื้องหลังของ extension อื่น — ไม่นับ
        if (!settings().enabled) return;
        capture(p.type, p.dry || !!dryRun);
    });
    on('CHAT_CHANGED', () => { pending = null; clearTimeout(recalcTimer); recalcTimer = null; loadForChat(); refresh(); });
    for (const ev of ['MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_DELETED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MORE_MESSAGES_LOADED']) {
        on(ev, () => refresh());
    }
    on('SETTINGS_UPDATED', () => refresh());

    const chatEl = document.getElementById('chat');
    if (chatEl) new MutationObserver(scheduleMarker).observe(chatEl, { childList: true });
    window.addEventListener('resize', placeFloat);
    window.visualViewport?.addEventListener('resize', placeFloat);
    // ST หรือ extension อื่นสร้างแถบพิมพ์ใหม่ / Quick Dock คืนปุ่ม — เช็กทุก 3 วิ
    setInterval(() => { if (settings().enabled && [...badges.values()].some(b => !b.isConnected)) refresh(); }, 3000);
    // ขนาด context / ที่กันไว้ตอบ เปลี่ยนจากแถบเลื่อนโดยไม่มี event — เช็กทุก 2 วิ แล้ววัดใหม่ครั้งเดียวต่อค่าใหม่
    let shownStale = false;
    setInterval(() => {
        if (!settings().enabled || !meas || meas.chatId !== ctx().chatId) return;
        const sig = settingsSig();
        const stale = !!meas.sig && meas.sig !== sig;
        if (stale !== shownStale) { shownStale = stale; refresh(); } // ป้ายเปลี่ยนเป็น "กำลังคำนวณ/รอวัด" ทันที
        if (stale && !recalcTimer && !recalcRunning && sig !== lastRecalcSig) scheduleRecalc('settings changed', 1500);
    }, 2000);
}

jQuery(async () => {
    try {
        try {
            oai = await import('../../../openai.js');
        } catch (err) {
            console.warn(LOG, 'link openai.js failed — token breakdown disabled', err);
        }
        settings();
        applyAccent();
        mountDrawer();
        addWandItem();
        registerCommands();
        wireEvents();
        loadForChat();
        refresh();
        console.log(LOG, `v${VERSION} loaded`);
    } catch (err) {
        reportError('เริ่มทำงานไม่สำเร็จ', err);
    }
});
