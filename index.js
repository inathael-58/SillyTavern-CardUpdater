/*
 * Card Updater — SillyTavern UI extension
 *
 * One button in the character panel. Pick one or more files — it tells what each one is:
 *   • a character card  → replaces the open character but keeps its file name, so every
 *     chat stays linked; the lorebook embedded in the card overwrites the linked one
 *     (same name, no version bumps); the card's regex is allowed, and the old scripts the new
 *     card doesn't have are kept (unless asked to drop them); a .json keeps the avatar;
 *   • a lorebook (.json) → overwrites the lorebook linked to the character (or any you name);
 *   • regex (.json, one script or a list) → replaces the scripts with the same names and adds
 *     new ones, in the character's regex or the global list.
 * One dialog before, one summary after, with an Undo button.
 *
 * It is a real button (a <label> around a file input), so the file picker also
 * opens on iPhone/iPad, where the built-in "Replace / Update" can't open it.
 */

const MODULE = 'card_updater';
const LOG = '[CardUpdater]';
const VERSION = '1.2.0'; // keep in step with manifest.json
const CARD_EXT = ['png', 'json', 'charx', 'yaml', 'yml', 'byaf'];

const DEFAULTS = Object.freeze({
    updateLore: true,
    allowRegex: true,
    keepAvatar: true,
    regexMode: 'merge',        // regex file: 'merge' | 'replace'
    cardRegexMode: 'merge',    // new card: 'merge' keeps old scripts the card doesn't have | 'replace' uses the card's set
    loreFromFile: Object.freeze({}), // world name -> true when its last update came from a lorebook file
});

// ---------------------------------------------------------------- helpers

const ctx = () => SillyTavern.getContext();

function settings() {
    const ext = ctx().extensionSettings;
    if (!ext[MODULE]) ext[MODULE] = {};
    const s = ext[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (typeof s[k] !== typeof v || (v && typeof v === 'object' && (!s[k] || Array.isArray(s[k])))) s[k] = v && typeof v === 'object' ? { ...v } : v;
    }
    if (!['merge', 'replace'].includes(s.regexMode)) s.regexMode = 'merge';
    if (!['merge', 'replace'].includes(s.cardRegexMode)) s.cardRegexMode = 'merge';
    return s;
}

const save = () => ctx().saveSettingsDebounced();

const toast = {
    ok: m => globalThis.toastr?.success(m, 'Card Updater'),
    info: m => globalThis.toastr?.info(m, 'Card Updater'),
    warn: m => globalThis.toastr?.warning(m, 'Card Updater'),
    err: m => globalThis.toastr?.error(m, 'Card Updater'),
};

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const plural = n => (n === 1 ? 'entry' : 'entries');
const extOf = name => (String(name).includes('.') ? String(name).split('.').pop() : '').toLowerCase();
const baseName = name => String(name).replace(/\.[^.]+$/, '');
const newId = () => ctx().uuidv4?.() ?? globalThis.crypto?.randomUUID?.() ?? `cu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function isGenerating() {
    const stop = document.getElementById('mes_stop');
    return !!stop && getComputedStyle(stop).display !== 'none';
}

function findChid(avatar) {
    const i = ctx().characters.findIndex(ch => ch?.avatar === avatar);
    return i < 0 ? undefined : i;
}

function worldNames() {
    const c = ctx();
    return typeof c.getWorldInfoNames === 'function' ? c.getWorldInfoNames() : [];
}

async function loadWorld(name) {
    if (!name || !worldNames().includes(name)) return null;
    try {
        const data = await ctx().loadWorldInfo(name);
        return data ? structuredClone(data) : null;
    } catch (e) {
        console.warn(LOG, 'could not load lorebook', name, e);
        return null;
    }
}

/** What a card holds that we care about. Accepts a V2/V3 card, a V1 card, or `{ data: character.data }`. */
function cardInfo(card) {
    const d = card?.data && typeof card.data === 'object' ? card.data : (card ?? {});
    const book = d.character_book && Array.isArray(d.character_book.entries) ? d.character_book : null;
    const regex = Array.isArray(d.extensions?.regex_scripts) ? d.extensions.regex_scripts : [];
    return {
        name: String(d.name ?? card?.name ?? card?.char_name ?? ''),
        book,
        entries: book ? book.entries.length : 0,
        bookName: String(book?.name ?? '').trim(),
        world: String(d.extensions?.world ?? '').trim(),
        regex,
    };
}

const regexName = s => String(s?.scriptName ?? '').trim();
const regexNames = list => list.map(regexName).filter(Boolean);

function isRegexAllowed(avatar) {
    const list = ctx().extensionSettings.character_allowed_regex;
    return Array.isArray(list) && list.includes(avatar);
}

function setRegexAllowed(avatar, allowed) {
    const ext = ctx().extensionSettings;
    if (!Array.isArray(ext.character_allowed_regex)) ext.character_allowed_regex = [];
    const list = ext.character_allowed_regex;
    const i = list.indexOf(avatar);
    if (allowed && i < 0) list.push(avatar);
    if (!allowed && i >= 0) list.splice(i, 1);
    save();
}

const globalRegex = () => (Array.isArray(ctx().extensionSettings.regex) ? ctx().extensionSettings.regex : []);

function listNames(list, max = 6) {
    const shown = list.slice(0, max).map(n => `“${esc(n)}”`).join(', ');
    return list.length > max ? `${shown} และอีก ${list.length - max}` : shown;
}

// ---------------------------------------------------------------- lorebook comparison

/** One string per entry: what the model actually sees (keys, content) plus its label and on/off state. */
function loreSigs(data) {
    return Object.values(data?.entries ?? {}).map(e => JSON.stringify([
        [...(Array.isArray(e?.key) ? e.key : [])].map(String).sort(),
        String(e?.content ?? ''),
        String(e?.comment ?? ''),
        !!e?.disable,
    ]));
}

function loreDiff(before, after) {
    const a = loreSigs(before), b = loreSigs(after);
    const pool = new Map();
    for (const s of a) pool.set(s, (pool.get(s) ?? 0) + 1);
    let same = 0;
    for (const s of b) {
        const n = pool.get(s) ?? 0;
        if (n) { same++; pool.set(s, n - 1); }
    }
    return { before: a.length, after: b.length, same, changed: b.length - same, gone: a.length - same, identical: same === a.length && same === b.length };
}

function diffText(d) {
    if (!d) return '';
    if (d.identical) return 'เหมือนของเดิมทุก entry';
    const parts = [];
    if (d.changed) parts.push(`ใหม่/แก้ <b>${d.changed}</b>`);
    if (d.gone) parts.push(`ของเดิมที่ไม่อยู่ในของใหม่ <b>${d.gone}</b>`);
    parts.push(`เหมือนเดิม ${d.same}`);
    return parts.join(' · ');
}

// ---------------------------------------------------------------- PNG card data

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const isPng = u8 => u8.length > 8 && PNG_SIG.every((b, i) => u8[i] === b);

function* pngChunks(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let p = 8;
    while (p + 12 <= u8.length) {
        const len = dv.getUint32(p);
        const end = p + 12 + len;
        if (end > u8.length) break;
        const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
        yield { type, start: p, end, data: u8.subarray(p + 8, p + 8 + len) };
        if (type === 'IEND') break;
        p = end;
    }
}

function latin1(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return s;
}

function textChunkOf(chunk) {
    if (chunk.type !== 'tEXt') return null;
    const z = chunk.data.indexOf(0);
    if (z < 0) return null;
    return { keyword: latin1(chunk.data.subarray(0, z)).toLowerCase(), text: latin1(chunk.data.subarray(z + 1)) };
}

const b64ToUtf8 = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.trim()), c => c.charCodeAt(0)));
const utf8ToB64 = str => btoa(latin1(new TextEncoder().encode(str)));

/** Card JSON string stored in a PNG (V3 `ccv3` first, like SillyTavern), or null. */
function readPngCard(u8) {
    let v2 = null;
    for (const chunk of pngChunks(u8)) {
        const t = textChunkOf(chunk);
        if (t?.keyword === 'ccv3') return b64ToUtf8(t.text);
        if (t?.keyword === 'chara') v2 = t.text;
    }
    return v2 === null ? null : b64ToUtf8(v2);
}

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function makeTextChunk(keyword, asciiText) {
    const body = keyword.length + 1 + asciiText.length;
    const out = new Uint8Array(12 + body);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, body);
    'tEXt'.split('').forEach((ch, i) => { out[4 + i] = ch.charCodeAt(0); });
    let p = 8;
    for (let i = 0; i < keyword.length; i++) out[p++] = keyword.charCodeAt(i);
    out[p++] = 0;
    for (let i = 0; i < asciiText.length; i++) out[p++] = asciiText.charCodeAt(i);
    dv.setUint32(8 + body, crc32(out.subarray(4, 8 + body)));
    return out;
}

/** A copy of the PNG `u8` carrying `json` as its card data (old card chunks removed). */
function writePngCard(u8, json) {
    const parts = [u8.subarray(0, 8)];
    for (const chunk of pngChunks(u8)) {
        const t = textChunkOf(chunk);
        if (t && (t.keyword === 'chara' || t.keyword === 'ccv3')) continue;
        if (chunk.type === 'IEND') parts.push(makeTextChunk('chara', utf8ToB64(json)));
        parts.push(u8.subarray(chunk.start, chunk.end));
    }
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
}

// ---------------------------------------------------------------- reading the picked files

const PHOTOS_HINT = 'ถ้าเลือกไฟล์จาก <b>คลังรูปภาพ (Photos)</b> ของ iPhone ระบบจะลบข้อมูลการ์ดที่ฝังในรูปทิ้ง ให้เลือกจากแอป <b>Files</b> แทน';

const isRegexScript = x => !!x && typeof x === 'object' && !Array.isArray(x) && typeof x.scriptName === 'string' && 'findRegex' in x;

/** 'card' | 'lore' | 'regex' | null for a parsed .json file. */
function jsonKind(o) {
    if (Array.isArray(o)) return o.length && o.every(isRegexScript) ? 'regex' : null;
    if (!o || typeof o !== 'object') return null;
    if (isRegexScript(o)) return 'regex';
    if (typeof o.spec === 'string' && o.spec.startsWith('chara_card')) return 'card';
    if (o.data && typeof o.data === 'object' && ('first_mes' in o.data || 'description' in o.data)) return 'card';
    if ('first_mes' in o || 'char_name' in o) return 'card';
    if (o.entries && typeof o.entries === 'object') return 'lore';
    return null;
}

/** A lorebook file (SillyTavern's own format, or a V2 character_book) in SillyTavern's format. */
function normalizeLore(o, fileName) {
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : baseName(fileName);
    const foreign = 'ไม่ใช่ lorebook รูปแบบของ SillyTavern (ถ้าเป็นของ NovelAI/Agnai/Risu ให้ Import ผ่านหน้า World Info)';
    if ('lorebookVersion' in o || o.kind === 'memory' || o.type === 'risu') throw new Error(foreign);
    if (Array.isArray(o.entries)) {
        if (!o.entries.length) throw new Error('lorebook ว่าง ไม่มี entry');
        if (!o.entries.every(e => e && typeof e === 'object' && 'content' in e)) throw new Error(foreign);
        return { name, data: ctx().convertCharacterBook(o) };
    }
    const values = Object.values(o.entries);
    if (!values.length) throw new Error('lorebook ว่าง ไม่มี entry');
    if (!values.every(e => e && typeof e === 'object' && ('content' in e || 'key' in e))) {
        throw new Error(foreign);
    }
    const data = structuredClone(o);
    delete data.name;
    return { name, data };
}

/** Sort the picked files into { card, lore, regex }, or return an error message (HTML). */
async function classifyFiles(files) {
    const out = { card: null, lore: null, regex: null };
    const cards = [], lores = [], regexFiles = [], scripts = [];
    for (const file of files) {
        const ext = extOf(file.name);
        try {
            if (ext === 'png') {
                const u8 = new Uint8Array(await file.arrayBuffer());
                if (!isPng(u8)) return `ไฟล์ <b>${esc(file.name)}</b> ไม่ใช่ PNG จริง (อาจถูกแปลงเป็น JPEG/HEIC)<br>${PHOTOS_HINT}`;
                const json = readPngCard(u8);
                if (json === null) return `ไม่พบข้อมูลการ์ดในรูป <b>${esc(file.name)}</b><br>${PHOTOS_HINT}`;
                cards.push({ file, ext, card: JSON.parse(json) });
            } else if (ext === 'json') {
                const o = JSON.parse(await file.text());
                const kind = jsonKind(o);
                if (kind === 'card') cards.push({ file, ext, card: o });
                else if (kind === 'lore') lores.push({ file, ...normalizeLore(o, file.name) });
                else if (kind === 'regex') { regexFiles.push(file.name); scripts.push(...(Array.isArray(o) ? o : [o])); }
                else return `ไม่รู้ว่า <b>${esc(file.name)}</b> เป็นไฟล์อะไร — ใช้ได้กับการ์ดตัวละคร, lorebook และ regex ของ SillyTavern`;
            } else if (CARD_EXT.includes(ext)) {
                cards.push({ file, ext, card: null }); // charx / yaml / byaf: SillyTavern reads them; we check afterwards
            } else {
                return `ไฟล์ .${esc(ext || '?')} (<b>${esc(file.name)}</b>) ใช้ไม่ได้ — ใช้ได้: การ์ด (${CARD_EXT.join(', ')}), lorebook .json, regex .json`;
            }
        } catch (e) {
            return `อ่านไฟล์ <b>${esc(file.name)}</b> ไม่ได้: ${esc(e.message)}`;
        }
    }
    if (cards.length > 1) return 'เลือกการ์ดได้ทีละใบ';
    if (lores.length > 1) return 'เลือก lorebook ได้ทีละเล่ม';
    out.card = cards[0] ?? null;
    out.lore = lores[0] ?? null;
    if (scripts.length) {
        // Same name twice across the files: the later one wins.
        const byName = new Map();
        for (const s of scripts) byName.set(regexName(s), s);
        out.regex = { files: regexFiles, scripts: [...byName.values()].map(s => structuredClone(s)) };
    }
    return out;
}

async function fetchAvatarPng(avatar) {
    try {
        const res = await fetch(`/characters/${encodeURIComponent(avatar)}`, { cache: 'no-store' });
        if (!res.ok) return null;
        const u8 = new Uint8Array(await res.arrayBuffer());
        return isPng(u8) ? u8 : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------- server calls

/** Replace the character stored as `avatar` with `file` (same endpoint as SillyTavern's own Replace / Update). */
async function importCard(file, format, avatar) {
    const c = ctx();
    const form = new FormData();
    form.append('avatar', file);
    form.append('file_type', format);
    form.append('user_name', c.name1 ?? '');
    form.append('preserved_name', avatar);
    const res = await fetch('/api/characters/import', {
        method: 'POST',
        body: form,
        headers: c.getRequestHeaders({ omitContentType: true }),
        cache: 'no-cache',
    });
    if (!res.ok) throw new Error(`เซิร์ฟเวอร์ตอบ ${res.status} ${res.statusText}`);
    const data = await res.json().catch(() => ({}));
    if (data.error || !data.file_name) throw new Error('เซิร์ฟเวอร์อ่านไฟล์การ์ดนี้ไม่ได้ (ไฟล์อาจเสีย)');
    if (`${data.file_name}.png` !== avatar) console.warn(LOG, 'unexpected file name', data.file_name, avatar);
}

async function refreshImages(avatar) {
    const c = ctx();
    await Promise.allSettled([
        fetch(c.getThumbnailUrl('avatar', avatar), { cache: 'reload' }),
        fetch(`/characters/${encodeURIComponent(avatar)}`, { cache: 'reload' }),
    ]);
}

/** Reload the character list and return the character's (possibly new) index. */
async function reopen(avatar) {
    await ctx().getCharacters();
    const chid = findChid(avatar);
    if (chid === undefined) return undefined;
    await ctx().unshallowCharacter?.(chid);
    return chid;
}

/** Show the character again with the chat that was open — also makes the regex extension reload its scripts. */
async function showAgain(chid, chatFile) {
    const c = ctx();
    try {
        await c.selectCharacterById(chid);
        if (chatFile) await ctx().openCharacterChat(chatFile);
    } catch (e) {
        console.warn(LOG, 'could not reopen the chat', e);
    }
}

async function refreshChat() {
    try { await ctx().reloadCurrentChat?.(); } catch (e) { console.warn(LOG, 'could not reload the chat', e); }
}

/** Save the character form the way SillyTavern's autosave does — the server then re-embeds the linked lorebook into the card. */
function resaveCharacterForm(chid) {
    if (String(ctx().characterId) !== String(chid)) return;
    if (document.getElementById('form_create')?.getAttribute('actiontype') !== 'editcharacter') return;
    document.getElementById('create_button')?.click();
}

// ---------------------------------------------------------------- the dialog before updating

function planDialog(items, old) {
    const s = settings();
    const c = ctx();
    const names = worldNames();
    const card = items.card;
    const next = card?.card ? cardInfo(card.card) : null;
    const hasChar = !!old;

    // --- lorebook source
    const loreFromFile = !!items.lore;
    const loreKnown = loreFromFile || !!next; // do we know the new lorebook before uploading?
    const cardHasBook = !!next?.book;
    const loreRelevant = loreFromFile || (card && (!next || cardHasBook));
    const newLoreData = loreFromFile ? items.lore.data : cardHasBook ? c.convertCharacterBook(next.book) : null;
    const defaultTarget = (hasChar && old.world) || (loreFromFile ? items.lore.name : next?.bookName) || (hasChar ? `${old.name}'s Lorebook` : '');

    // --- regex source
    const regexFromFile = !!items.regex;
    const incoming = items.regex?.scripts ?? [];
    const incomingNames = regexNames(incoming);
    const scopedNow = hasChar ? old.regex : [];
    const inGlobal = incomingNames.filter(n => regexNames(globalRegex()).includes(n));
    const inScoped = incomingNames.filter(n => regexNames(scopedNow).includes(n));
    const defaultRegexTarget = !hasChar ? 'global' : (inGlobal.length && !inScoped.length ? 'global' : 'scoped');

    const el = document.createElement('div');
    el.className = 'cu_dialog';

    const title = card ? `อัปเดตการ์ด: ${esc(old.name)}`
        : loreFromFile && regexFromFile ? 'อัปเดต lorebook และ regex'
            : loreFromFile ? 'อัปเดต lorebook' : 'อัปเดต regex';

    const warnName = next && next.name && !sameName(next.name, old.name)
        ? `<div class="cu_warn"><i class="fa-solid fa-triangle-exclamation"></i> ชื่อในไฟล์คือ “${esc(next.name)}” ไม่ตรงกับ “${esc(old.name)}” — เลือกไฟล์ถูกหรือเปล่า?</div>` : '';

    const cardBlock = card ? `
        <div class="cu_row"><i class="fa-solid fa-id-card"></i> <span><b>${esc(card.file.name)}</b> → เขียนทับ <code>${esc(old.avatar)}</code><br><small>ชื่อไฟล์เดิม · แชททั้งหมดยังเชื่อมอยู่</small></span></div>
        ${warnName}
        ${card.ext === 'json' ? '<label class="checkbox_label"><input type="checkbox" class="cu_keep_avatar"> ใช้รูปตัวละครเดิม (ไฟล์ .json ไม่มีรูป)</label>' : ''}
        ${['yaml', 'yml'].includes(card.ext) ? '<div class="cu_warn"><i class="fa-solid fa-triangle-exclamation"></i> ไฟล์ .yaml ไม่มีรูป รูปตัวละครจะกลายเป็นรูปเริ่มต้น</div>' : ''}` : '';

    const loreSource = loreFromFile
        ? `ไฟล์ <b>${esc(items.lore.file.name)}</b> · <b>${Object.keys(items.lore.data.entries).length}</b> ${plural(Object.keys(items.lore.data.entries).length)}${card && cardHasBook ? '<br><small>ใช้ไฟล์นี้แทน lorebook ที่ฝังในการ์ด</small>' : ''}`
        : !card ? ''
            : !next ? `จะเช็คหลังอัปโหลด (อ่าน .${esc(card.ext)} ล่วงหน้าไม่ได้)`
            : cardHasBook ? `การ์ดมี lorebook ฝังมา <b>${next.entries}</b> ${plural(next.entries)}${next.bookName ? ` (ชื่อในการ์ด: “${esc(next.bookName)}”)` : ''}`
                : '';

    const loreBlock = loreRelevant ? `
        <div class="cu_section">
            <div class="cu_head"><i class="fa-solid fa-book-atlas"></i> Lorebook</div>
            <div class="cu_note">${loreSource}</div>
            <label class="checkbox_label"><input type="checkbox" class="cu_lore"> เขียนทับ lorebook ชื่อ:</label>
            <input type="text" class="text_pole cu_target" list="cu_world_list" value="${esc(defaultTarget)}" enterkeyhint="done" placeholder="ชื่อ lorebook">
            <datalist id="cu_world_list">${names.map(n => `<option value="${esc(n)}"></option>`).join('')}</datalist>
            <div class="cu_note cu_target_hint"></div>
            <div class="cu_note cu_diff"></div>
            <div class="cu_warn cu_stale" hidden><i class="fa-solid fa-triangle-exclamation"></i> lorebook นี้อัปเดตจาก<b>ไฟล์ lorebook แยก</b>ครั้งล่าสุด ของที่ฝังในการ์ดอาจเก่ากว่า — เลยไม่ติ๊กไว้ให้</div>
            ${hasChar ? '<label class="checkbox_label cu_link_row"><input type="checkbox" class="cu_link"> ผูกเป็น lorebook หลักของการ์ดนี้</label>' : ''}
        </div>` : card && next && !cardHasBook ? `
        <div class="cu_section">
            <div class="cu_head"><i class="fa-solid fa-book-atlas"></i> Lorebook</div>
            <div class="cu_note">การ์ดใหม่<b>ไม่มี</b> lorebook ฝังมา${old.world ? ` — จะคงการผูก “${esc(old.world)}” ไว้` : ''}</div>
        </div>` : '';

    const regexBlock = regexFromFile ? `
        <div class="cu_section">
            <div class="cu_head"><i class="fa-solid fa-code"></i> Regex</div>
            <div class="cu_note">${items.regex.files.map(f => `<b>${esc(f)}</b>`).join(', ')} · ${incoming.length} ตัว: ${listNames(incomingNames)}</div>
            <label class="cu_field">ใส่ไว้ที่
                <select class="text_pole cu_rx_target">
                    ${hasChar ? `<option value="scoped">Regex ของการ์ด “${esc(old.name)}”</option>` : ''}
                    <option value="global">Global regex (ทุกตัวละคร)</option>
                </select>
            </label>
            <label class="cu_field">วิธีใส่
                <select class="text_pole cu_rx_mode">
                    <option value="merge">แทนตัวชื่อซ้ำ + เพิ่มตัวใหม่</option>
                    <option value="replace">แทนทั้งชุด (ลบตัวที่ไม่อยู่ในไฟล์)</option>
                </select>
            </label>
            <div class="cu_note cu_rx_preview"></div>
            ${hasChar && !card ? '<label class="checkbox_label cu_allow_row"><input type="checkbox" class="cu_allow"> อนุญาตให้ regex ของการ์ดนี้ทำงาน</label>' : ''}
        </div>` : '';

    const cardRegexBlock = card ? `
        <div class="cu_section">
            <div class="cu_head"><i class="fa-solid fa-code"></i> Regex ของการ์ด</div>
            <div class="cu_note">${!next ? `เดิมมี ${old.regex.length} ตัว · ของใหม่จะเช็คหลังอัปโหลด` : `ในการ์ดใหม่ <b>${next.regex.length}</b> ตัว (เดิม ${old.regex.length} ตัว)`}</div>
            ${old.regex.length ? `<label class="cu_field">regex เดิมที่ไม่อยู่ในการ์ดใหม่
                <select class="text_pole cu_card_rx_mode">
                    <option value="merge">คงไว้ (แทนตัวชื่อซ้ำ + เพิ่มตัวใหม่)</option>
                    <option value="replace">ลบทิ้ง (ใช้ตามการ์ดใหม่ทั้งชุด)</option>
                </select>
            </label>
            <div class="cu_note cu_card_rx_preview"></div>` : ''}
            <label class="checkbox_label"><input type="checkbox" class="cu_allow"> อนุญาตให้ regex ของการ์ดนี้ทำงาน</label>
        </div>` : '';

    el.innerHTML = `
        <h3>${title}</h3>
        ${cardBlock}
        ${loreBlock}
        ${cardRegexBlock}
        ${regexBlock}
        <div class="cu_note">กด “ย้อนกลับ” ในหน้าสรุปได้ ถ้าเลือกผิดไฟล์</div>`;

    const $ = sel => el.querySelector(sel);
    const has = sel => !!$(sel);

    // ---- lorebook controls
    let staleDefaultOff = false;
    let linkTouched = false;
    let diffToken = 0;
    const loreHint = async () => {
        if (!has('.cu_lore')) return;
        const lore = $('.cu_lore'), input = $('.cu_target');
        const name = input.value.trim();
        const exists = names.includes(name);
        input.disabled = !lore.checked;
        $('.cu_target_hint').innerHTML = !lore.checked ? 'ไม่แตะ lorebook'
            : !name ? '<span class="cu_bad">ใส่ชื่อ lorebook</span>'
                : exists ? `มีอยู่แล้ว → <b>เขียนทับ</b>${hasChar && name === old.world ? ' (ตัวที่ผูกกับการ์ดอยู่ตอนนี้)' : ''}`
                    : 'ยังไม่มี → <b>สร้างใหม่</b>';
        if (has('.cu_link')) {
            if (!linkTouched) $('.cu_link').checked = !old.world || name === old.world || !exists;
            $('.cu_link_row').hidden = !lore.checked;
        }
        const token = ++diffToken;
        if (!lore.checked || !exists || !newLoreData) { $('.cu_diff').innerHTML = ''; return; }
        const current = await loadWorld(name);
        if (token !== diffToken) return;
        $('.cu_diff').innerHTML = current ? `เทียบกับของเดิม (${loreSigs(current).length}): ${diffText(loreDiff(current, newLoreData))}` : '';
    };
    if (has('.cu_lore')) {
        const lore = $('.cu_lore');
        lore.checked = loreFromFile ? true : s.updateLore;
        // Guard: the card's embedded lorebook would overwrite one that was last updated from its own file.
        if (!loreFromFile && cardHasBook && s.loreFromFile[defaultTarget] && names.includes(defaultTarget)) {
            loadWorld(defaultTarget).then(current => {
                if (current && !loreDiff(current, newLoreData).identical) {
                    staleDefaultOff = true;
                    lore.checked = false;
                    $('.cu_stale').hidden = false;
                    loreHint();
                }
            });
        }
        lore.addEventListener('change', () => { $('.cu_stale').hidden = true; loreHint(); });
        $('.cu_target').addEventListener('input', loreHint);
        $('.cu_target').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
        $('.cu_link')?.addEventListener('change', () => { linkTouched = true; });
        loreHint();
    }

    // ---- regex controls
    const cardMode = () => $('.cu_card_rx_mode')?.value ?? s.cardRegexMode;
    const cardRxPreview = () => {
        if (!has('.cu_card_rx_preview')) return;
        const mode = cardMode();
        if (!next) {
            $('.cu_card_rx_preview').innerHTML = mode === 'merge'
                ? `ตัวที่ชื่อตรงกันจะใช้ของการ์ดใหม่ ตัวเดิมที่การ์ดใหม่ไม่มีจะคงไว้`
                : `<span class="cu_bad">ใช้ regex ตามการ์ดใหม่ ตัวเดิมที่การ์ดใหม่ไม่มีจะถูกลบ</span>`;
            return;
        }
        const oldNames = regexNames(old.regex), newNames = regexNames(next.regex);
        const replaced = newNames.filter(n => oldNames.includes(n));
        const added = newNames.filter(n => !oldNames.includes(n));
        const others = oldNames.filter(n => !newNames.includes(n));
        const parts = [];
        if (replaced.length) parts.push(`แทน ${replaced.length}: ${listNames(replaced, 4)}`);
        if (added.length) parts.push(`เพิ่มใหม่ ${added.length}: ${listNames(added, 4)}`);
        if (others.length) parts.push(mode === 'merge' ? `คงไว้ ${others.length}: ${listNames(others, 4)}` : `<span class="cu_bad">ลบ ${others.length}: ${listNames(others, 4)}</span>`);
        $('.cu_card_rx_preview').innerHTML = parts.join('<br>');
    };
    const rxPreview = () => {
        if (!has('.cu_rx_target')) return;
        const target = $('.cu_rx_target').value, mode = $('.cu_rx_mode').value;
        if (has('.cu_allow_row')) $('.cu_allow_row').hidden = target !== 'scoped';
        // With a new card, the card's own scoped regex is what we merge into.
        if (target === 'scoped' && card && !next) { $('.cu_rx_preview').innerHTML = 'จะรวมกับ regex ของการ์ดใหม่หลังอัปโหลด'; return; }
        const base = target === 'global' ? globalRegex() : (card && next ? cardRegexAfter(old.regex, next.regex, cardMode()).result : scopedNow);
        const baseNames = regexNames(base);
        const replaced = incomingNames.filter(n => baseNames.includes(n));
        const added = incomingNames.filter(n => !baseNames.includes(n));
        const others = baseNames.filter(n => !incomingNames.includes(n));
        const parts = [];
        if (replaced.length) parts.push(`แทน ${replaced.length}: ${listNames(replaced, 4)}`);
        if (added.length) parts.push(`เพิ่มใหม่ ${added.length}: ${listNames(added, 4)}`);
        if (others.length) parts.push(mode === 'merge' ? `คงไว้ ${others.length}` : `<span class="cu_bad">ลบ ${others.length}: ${listNames(others, 4)}</span>`);
        $('.cu_rx_preview').innerHTML = parts.join('<br>');
    };
    if (has('.cu_rx_target')) {
        $('.cu_rx_target').value = defaultRegexTarget;
        $('.cu_rx_mode').value = s.regexMode;
        $('.cu_rx_target').addEventListener('change', rxPreview);
        $('.cu_rx_mode').addEventListener('change', rxPreview);
        rxPreview();
    }
    if (has('.cu_card_rx_mode')) {
        $('.cu_card_rx_mode').value = s.cardRegexMode;
        $('.cu_card_rx_mode').addEventListener('change', () => { cardRxPreview(); rxPreview(); });
        cardRxPreview();
    }
    if (has('.cu_allow')) $('.cu_allow').checked = s.allowRegex;
    if (has('.cu_keep_avatar')) $('.cu_keep_avatar').checked = s.keepAvatar;

    const read = () => ({
        card: !!card,
        keepAvatar: $('.cu_keep_avatar')?.checked ?? s.keepAvatar,
        lore: {
            source: loreFromFile ? 'file' : 'card',
            apply: !!$('.cu_lore')?.checked,
            target: $('.cu_target')?.value.trim() ?? '',
            link: hasChar && ($('.cu_link')?.checked ?? true),
            staleDefaultOff,
        },
        regex: {
            source: regexFromFile ? 'file' : 'card',
            target: $('.cu_rx_target')?.value ?? 'scoped',
            mode: $('.cu_rx_mode')?.value ?? s.regexMode,
            cardMode: cardMode(),
            allow: $('.cu_allow')?.checked ?? false,
        },
    });
    return { el, read };
}

async function askPlan(items, old) {
    const c = ctx();
    const { el, read } = planDialog(items, old);
    let plan = null;
    const popup = new c.Popup(el, c.POPUP_TYPE.CONFIRM, '', {
        okButton: 'อัปเดต',
        cancelButton: 'ยกเลิก',
        allowVerticalScrolling: true,
        onClosing: p => {
            if (p.result !== c.POPUP_RESULT.AFFIRMATIVE) return true;
            const r = read();
            if (r.lore.apply && !r.lore.target) {
                toast.warn('ใส่ชื่อ lorebook ก่อน');
                return false;
            }
            plan = r;
            return true;
        },
    });
    await popup.show();
    if (!plan) return null;

    // Remember choices as next time's defaults (only the ones the dialog actually offered).
    const s = settings();
    const shown = sel => { const n = el.querySelector(sel); return !!n && !n.closest('[hidden]'); };
    if (shown('.cu_lore') && plan.lore.source === 'card' && !plan.lore.staleDefaultOff) s.updateLore = plan.lore.apply;
    if (shown('.cu_allow')) s.allowRegex = plan.regex.allow;
    if (shown('.cu_card_rx_mode')) s.cardRegexMode = plan.regex.cardMode;
    if (shown('.cu_keep_avatar')) s.keepAvatar = plan.keepAvatar;
    if (shown('.cu_rx_mode')) s.regexMode = plan.regex.mode;
    save();
    return plan;
}

// ---------------------------------------------------------------- the update itself

const line = (kind, html) => ({ kind, html });
const ICON = { ok: 'fa-circle-check', info: 'fa-circle-info', warn: 'fa-triangle-exclamation' };

/** Put `incoming` scripts into `base`: same name → replaced (keeping its id), new → added; 'replace' drops the rest. */
function mergeRegex(base, incoming, mode) {
    const baseByName = new Map(base.map(s => [regexName(s), s]));
    const incomingNames = new Set(regexNames(incoming));
    const usedIds = new Set();
    const fresh = s => {
        const copy = structuredClone(s);
        const prev = baseByName.get(regexName(s));
        copy.id = prev?.id ?? (copy.id && !base.some(b => b.id === copy.id) ? copy.id : newId());
        if (usedIds.has(copy.id)) copy.id = newId();
        usedIds.add(copy.id);
        return copy;
    };
    const result = [];
    const replaced = [], added = [], removed = [];
    // Keep the existing order: replaced scripts stay where they were.
    for (const s of base) {
        const n = regexName(s);
        if (incomingNames.has(n)) { result.push(fresh(incoming.find(x => regexName(x) === n))); replaced.push(n); }
        else if (mode === 'merge') { usedIds.add(s.id); result.push(s); }
        else removed.push(n);
    }
    for (const s of incoming) {
        if (!baseByName.has(regexName(s))) { result.push(fresh(s)); added.push(regexName(s)); }
    }
    return { result, replaced, added, removed, kept: mode === 'merge' ? base.length - replaced.length : 0 };
}

/**
 * The character's regex after a new card is imported: the card's scripts, and in 'merge' also the old
 * scripts the card doesn't have (old order kept, the card's new ones at the end). `kept` names those.
 */
function cardRegexAfter(oldList, cardList, mode) {
    if (mode !== 'merge' || !oldList.length) return { result: cardList, kept: [] };
    const m = mergeRegex(oldList, cardList, 'merge');
    if (!m.kept) return { result: cardList, kept: [] };
    const cardNames = new Set(regexNames(cardList));
    return { result: m.result, kept: regexNames(oldList).filter(n => !cardNames.has(n)), keptCount: m.kept };
}

async function runUpdate(items, old, plan) {
    const c = ctx();
    const s = settings();
    const report = [];
    const undo = {
        avatar: old?.avatar ?? null,
        chat: old?.chat ?? null,
        png: null,
        cardTouched: false,
        world: null,
        loreFlag: null,
        globalRegex: null,
        allowed: old ? isRegexAllowed(old.avatar) : null,
    };

    // The PNG on the server holds the whole current card: the undo point, and the image for a .json card.
    if (old) undo.png = await fetchAvatarPng(old.avatar);

    let chid = old ? findChid(old.avatar) : undefined;
    let now = old ? cardInfo({ data: c.characters[chid]?.data }) : null;

    // --- card
    if (items.card) {
        const { file, ext, card } = items.card;
        let upload = file;
        let format = ext;
        if (ext === 'json' && plan.keepAvatar && card && (card.spec || card.name) && undo.png) {
            upload = new File([writePngCard(undo.png, JSON.stringify(card))], old.avatar, { type: 'image/png' });
            format = 'png';
        }
        await importCard(upload, format, old.avatar);
        undo.cardTouched = true;
        await refreshImages(old.avatar);
        chid = await reopen(old.avatar);
        if (chid === undefined) throw new Error('อัปโหลดแล้วแต่หาตัวละครไม่เจอ ลองรีเฟรชหน้า');
        const ch = ctx().characters[chid];
        now = cardInfo({ data: ch.data });
        report.push(line('ok', `การ์ด “${esc(ch.name)}” อัปเดตแล้ว · ไฟล์ <code>${esc(old.avatar)}</code> แชทเดิมเชื่อมอยู่ครบ`));
        if (ext === 'json') {
            report.push(format === 'png'
                ? line('ok', 'ใช้รูปตัวละครเดิม')
                : line(plan.keepAvatar ? 'warn' : 'info', 'รูปตัวละครเป็นรูปเริ่มต้น (ไฟล์ .json ไม่มีรูป)'));
        }
    }

    // --- lorebook
    let reembed = false;
    const newLore = plan.lore.source === 'file' ? items.lore?.data : (items.card && now?.book ? c.convertCharacterBook(now.book) : null);
    if (newLore && plan.lore.apply) {
        const target = plan.lore.target;
        const existed = worldNames().includes(target);
        const before = existed ? await loadWorld(target) : null;
        undo.world = { name: target, data: before, existed };
        undo.loreFlag = { name: target, value: !!s.loreFromFile[target] };
        await c.saveWorldInfo(target, structuredClone(newLore), true);
        await c.updateWorldInfoList();
        c.reloadWorldInfoEditor?.(target);
        if (plan.lore.source === 'file') s.loreFromFile[target] = true; else delete s.loreFromFile[target];
        save();

        let linkNote = '';
        if (old && plan.lore.link) {
            if (now.world !== target) {
                await c.writeExtensionField(chid, 'world', target);
                undo.cardTouched = true;
                now.world = target;
            }
            linkNote = ' · ผูกกับการ์ดแล้ว';
            if (plan.lore.source === 'file') reembed = true;
        } else if (old && now.world === target) {
            linkNote = ' · ผูกกับการ์ดอยู่แล้ว';
            if (plan.lore.source === 'file') reembed = true;
        }
        const n = Object.keys(newLore.entries ?? {}).length;
        const d = before ? loreDiff(before, newLore) : null;
        const src = plan.lore.source === 'file' ? `จากไฟล์ ${esc(items.lore.file.name)}` : 'จากการ์ด';
        report.push(line('ok', `Lorebook “${esc(target)}” ${existed ? 'เขียนทับ' : 'สร้างใหม่'}${src ? ` ${src}` : ''} · <b>${n}</b> ${plural(n)}${linkNote}${d ? `<br><small>${diffText(d)}</small>` : ''}`));
    } else if (newLore) {
        report.push(line('info', plan.lore.staleDefaultOff && plan.lore.source === 'card'
            ? 'ไม่ได้เขียน lorebook ที่ฝังในการ์ดทับ (lorebook ปัจจุบันมาจากไฟล์แยกที่ใหม่กว่า)'
            : 'ข้ามการอัปเดต lorebook ตามที่เลือก'));
        // The new card may name a lorebook that doesn't exist here — keep the one that was linked.
        if (items.card && old.world && now.world !== old.world && !worldNames().includes(now.world)) {
            await c.writeExtensionField(chid, 'world', old.world);
            now.world = old.world;
            report.push(line('info', `ผูก “${esc(old.world)}” ไว้เหมือนเดิม`));
        }
    } else if (items.card) {
        if (!now.world && old.world) {
            await c.writeExtensionField(chid, 'world', old.world);
            report.push(line('info', `การ์ดใหม่ไม่มี lorebook ฝังมา · ผูก “${esc(old.world)}” ไว้เหมือนเดิม`));
        } else if (now.world) {
            const exists = worldNames().includes(now.world);
            report.push(line(exists ? 'info' : 'warn', `การ์ดไม่มี lorebook ฝังมา · ผูกกับ “${esc(now.world)}”${exists ? '' : ' ซึ่ง<b>ไม่มีอยู่</b>ในเซิร์ฟเวอร์'}`));
        } else {
            report.push(line('info', 'การ์ดนี้ไม่มี lorebook'));
        }
    }

    // --- regex
    // A new card first: its scripts, plus the old ones it doesn't have (unless asked to drop them).
    if (items.card) {
        const fromCard = now.regex;
        const after = cardRegexAfter(old.regex, fromCard, plan.regex.cardMode);
        const scripts = after.result;
        if (after.keptCount) {
            await c.writeExtensionField(chid, 'regex_scripts', structuredClone(scripts));
            now.regex = scripts;
            report.push(line('info', fromCard.length
                ? `คง regex เดิมที่ไม่อยู่ในการ์ดใหม่ไว้ ${after.keptCount} ตัว${after.kept.length ? `: ${listNames(after.kept)}` : ''}`
                : `การ์ดใหม่ไม่มี regex · คงของเดิม ${after.keptCount} ตัวไว้`));
        }
        if (scripts.length) {
            const off = scripts.filter(x => x?.disabled).length;
            let msg = `Regex ของการ์ด <b>${scripts.length}</b> ตัว${off ? ` (ปิดไว้ ${off})` : ''}`;
            let kind = 'ok';
            if (plan.regex.allow) {
                setRegexAllowed(old.avatar, true);
                msg += ' · อนุญาตให้ทำงานแล้ว';
            } else if (isRegexAllowed(old.avatar)) {
                msg += ' · อนุญาตอยู่แล้ว';
            } else {
                msg += ' · <b>ยังไม่ได้อนุญาต</b>';
                kind = 'warn';
            }
            report.push(line(kind, msg));
            const oldN = regexNames(old.regex), newN = regexNames(scripts);
            const added = newN.filter(n => !oldN.includes(n));
            const removed = oldN.filter(n => !newN.includes(n));
            if (added.length) report.push(line('info', `regex ใหม่: ${listNames(added)}`));
            if (removed.length) report.push(line('warn', `regex ที่ลบออก: ${listNames(removed)}`));
        } else if (old.regex.length) {
            report.push(line('warn', `การ์ดใหม่ไม่มี regex · ของเดิม ${old.regex.length} ตัวถูกลบ`));
        } else {
            report.push(line('info', 'การ์ดนี้ไม่มี regex'));
        }
    }

    if (plan.regex.source === 'file' && items.regex) {
        const incoming = items.regex.scripts;
        if (plan.regex.target === 'global') {
            undo.globalRegex = structuredClone(globalRegex());
            const m = mergeRegex(globalRegex(), incoming, plan.regex.mode);
            c.extensionSettings.regex = m.result;
            save();
            report.push(line('ok', `Global regex: ${regexReportText(m)}`));
        } else {
            const base = now.regex;
            const m = mergeRegex(base, incoming, plan.regex.mode);
            await c.writeExtensionField(chid, 'regex_scripts', m.result);
            now.regex = m.result;
            undo.cardTouched = true;
            let msg = `Regex ของการ์ด: ${regexReportText(m)}`;
            let kind = 'ok';
            // With a new card, allowing was already reported above.
            if (!items.card) {
                if (plan.regex.allow) { setRegexAllowed(old.avatar, true); msg += '<br><small>อนุญาตให้ทำงานแล้ว</small>'; }
                else if (!isRegexAllowed(old.avatar)) { msg += '<br><small><b>ยังไม่ได้อนุญาต</b>ให้ทำงาน</small>'; kind = 'warn'; }
            }
            report.push(line(kind, msg));
        }
        const off = incoming.filter(x => x?.disabled).length;
        if (off) report.push(line('info', `ในไฟล์มี regex ที่ปิดไว้ ${off} ตัว`));
    }

    if (old && chid !== undefined) {
        await showAgain(chid, old.chat);
        // A lorebook updated from its own file: let SillyTavern re-embed it in the card too, so exports carry it.
        if (reembed) { resaveCharacterForm(chid); undo.cardTouched = true; }
    } else {
        await refreshChat();
    }
    return { report, undo };
}

function regexReportText(m) {
    const parts = [];
    if (m.replaced.length) parts.push(`แทน ${m.replaced.length} (${listNames(m.replaced, 4)})`);
    if (m.added.length) parts.push(`เพิ่มใหม่ ${m.added.length} (${listNames(m.added, 4)})`);
    if (m.removed.length) parts.push(`ลบ ${m.removed.length} (${listNames(m.removed, 4)})`);
    if (m.kept) parts.push(`คงไว้ ${m.kept}`);
    return parts.join(' · ') || 'ไม่มีอะไรเปลี่ยน';
}

async function runUndo(undo) {
    const c = ctx();
    const notes = [];
    if (undo.cardTouched && undo.png) {
        await importCard(new File([undo.png], undo.avatar, { type: 'image/png' }), 'png', undo.avatar);
        await refreshImages(undo.avatar);
        notes.push('คืนการ์ดเดิมแล้ว');
    }
    if (undo.world?.data) {
        await c.saveWorldInfo(undo.world.name, undo.world.data, true);
        await c.updateWorldInfoList();
        c.reloadWorldInfoEditor?.(undo.world.name);
        notes.push(`คืน lorebook “${undo.world.name}”`);
    } else if (undo.world && !undo.world.existed) {
        notes.push(`lorebook “${undo.world.name}” ที่สร้างใหม่ยังอยู่ (ลบเองได้ถ้าไม่ใช้)`);
    }
    if (undo.loreFlag) {
        const s = settings();
        if (undo.loreFlag.value) s.loreFromFile[undo.loreFlag.name] = true; else delete s.loreFromFile[undo.loreFlag.name];
        save();
    }
    if (undo.globalRegex) {
        c.extensionSettings.regex = undo.globalRegex;
        save();
        notes.push('คืน global regex');
    }
    if (undo.avatar && undo.allowed !== null) setRegexAllowed(undo.avatar, undo.allowed);
    const chid = undo.avatar ? await reopen(undo.avatar) : undefined;
    if (chid !== undefined) await showAgain(chid, undo.chat); else await refreshChat();
    toast.ok(notes.join(' · ') || 'ย้อนกลับแล้ว');
}

async function showReport(result) {
    const c = ctx();
    const el = document.createElement('div');
    el.className = 'cu_dialog cu_report';
    el.innerHTML = `<h3>อัปเดตเสร็จแล้ว</h3>
        <ul>${result.report.map(r => `<li class="cu_${r.kind}"><i class="fa-solid ${ICON[r.kind]}"></i><span>${r.html}</span></li>`).join('')}</ul>`;
    const UNDO = c.POPUP_RESULT.CUSTOM1;
    const u = result.undo;
    const canUndo = (u.cardTouched && u.png) || u.world || u.globalRegex;
    const answer = await new c.Popup(el, c.POPUP_TYPE.TEXT, '', {
        okButton: 'เรียบร้อย',
        allowVerticalScrolling: true,
        customButtons: canUndo ? [{ text: 'ย้อนกลับ', result: UNDO, classes: ['cu_undo_btn'] }] : null,
    }).show();
    if (answer !== UNDO) return;
    const sure = await c.Popup.show.confirm('ย้อนกลับเป็นแบบก่อนอัปเดต?', 'การ์ด lorebook และ regex จะกลับเป็นแบบก่อนกดอัปเดต');
    if (sure !== c.POPUP_RESULT.AFFIRMATIVE) return;
    await withLoader(() => runUndo(u));
}

async function withLoader(fn) {
    const c = ctx();
    try { c.showLoader?.(); } catch { /* ignore */ }
    try {
        return await fn();
    } finally {
        try { await c.hideLoader?.(); } catch { /* ignore */ }
    }
}

// ---------------------------------------------------------------- entry point

let busy = false;

/** Why an update can't start right now, or null. Checked on tap, before the file picker opens. */
function blocker() {
    if (busy) return 'กำลังอัปเดตอยู่';
    if (isGenerating()) return 'รอให้บอทตอบเสร็จ (หรือกดหยุด) ก่อน';
    return null;
}

/** The open (single) character, or null. */
async function currentCharacter() {
    const c = ctx();
    const chid = c.characterId;
    if (c.groupId || c.menuType === 'create' || chid === undefined || !c.characters[chid]) return null;
    await c.unshallowCharacter?.(chid);
    const char = ctx().characters[chid];
    return { chid, avatar: char.avatar, name: char.name, chat: char.chat, ...cardInfo({ data: char.data }) };
}

async function onFilesPicked(files) {
    const why = blocker();
    if (why) { toast.warn(why); return; }
    busy = true;
    try {
        const c = ctx();
        const items = await classifyFiles(files);
        if (typeof items === 'string') {
            await c.Popup.show.text('อัปเดตไม่ได้', items);
            return;
        }
        const old = await currentCharacter();
        if (items.card && !old) { toast.warn('เปิดตัวละครที่จะอัปเดตการ์ดก่อน (ใช้กับแชทกลุ่มไม่ได้)'); return; }

        const plan = await askPlan(items, old);
        if (!plan) return;
        if (String(ctx().characterId ?? '') !== String(old?.chid ?? '') || isGenerating()) {
            toast.warn('ตัวละครที่เปิดอยู่เปลี่ยนไป หรือบอทกำลังตอบ — ยกเลิกการอัปเดต');
            return;
        }
        const result = await withLoader(() => runUpdate(items, old, plan));
        busy = false;
        await showReport(result);
    } catch (e) {
        console.error(LOG, e);
        toast.err(`อัปเดตไม่สำเร็จ: ${esc(e.message)}`);
    } finally {
        busy = false;
    }
}

/** A tappable label wrapping a file input — opens the picker natively on iOS. */
function makePickButton(id, className, html, title) {
    const label = document.createElement('label');
    label.id = id;
    label.className = className;
    label.title = title;
    label.innerHTML = `${html}<input type="file" class="cu_file" multiple hidden>`;
    const input = label.querySelector('input');
    label.addEventListener('click', e => {
        if (e.target === input) return;
        const why = blocker();
        if (why) { e.preventDefault(); toast.warn(why); }
    });
    input.addEventListener('change', () => {
        const files = [...(input.files ?? [])];
        input.value = ''; // so the same file can be picked again
        if (files.length) onFilesPicked(files);
    });
    return label;
}

function addPanelButton() {
    if (document.getElementById('cu_button')) return;
    const block = document.querySelector('#avatar_controls .form_create_bottom_buttons_block');
    if (!block) return;
    const btn = makePickButton('cu_button', 'menu_button fa-solid fa-file-arrow-up', '',
        'อัปเดตการ์ด / lorebook / regex (Card Updater)\nเลือกไฟล์ได้หลายไฟล์พร้อมกัน — จะดูให้เองว่าไฟล์ไหนเป็นอะไร');
    block.insertBefore(btn, document.getElementById('export_button'));
}

function addSettings() {
    if (document.getElementById('cu_settings')) return;
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host) return;
    const s = settings();
    const wrap = document.createElement('div');
    wrap.id = 'cu_settings';
    wrap.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Card Updater <small class="cu_version">v${VERSION}</small></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <small>กดปุ่ม <i class="fa-solid fa-file-arrow-up"></i> ในแผงตัวละคร (ข้างปุ่ม Export) หรือปุ่มด้านล่าง แล้วเลือกการ์ด, lorebook .json หรือ regex .json — เลือกหลายไฟล์พร้อมกันได้ · ไม่ได้เปิดตัวละครไว้ก็อัปเดต lorebook และ global regex ได้</small>
                <div class="cu_set_btn"></div>
                <div class="cu_set_title">ค่าเริ่มต้นของหน้าต่างอัปเดต</div>
                <label class="checkbox_label"><input type="checkbox" data-key="updateLore"> การ์ด: เขียน lorebook ที่ฝังมาทับของเดิม</label>
                <label class="checkbox_label"><input type="checkbox" data-key="allowRegex"> อนุญาต regex ของการ์ดอัตโนมัติ</label>
                <label class="checkbox_label"><input type="checkbox" data-key="keepAvatar"> การ์ด .json ใช้รูปตัวละครเดิม</label>
                <label class="cu_field">การ์ดใหม่: regex เดิมที่ไม่อยู่ในการ์ด
                    <select class="text_pole" data-key="cardRegexMode">
                        <option value="merge">คงไว้</option>
                        <option value="replace">ลบทิ้ง (ใช้ตามการ์ดใหม่ทั้งชุด)</option>
                    </select>
                </label>
                <label class="cu_field">ไฟล์ regex
                    <select class="text_pole" data-key="regexMode">
                        <option value="merge">แทนตัวที่ชื่อซ้ำ + เพิ่มตัวใหม่</option>
                        <option value="replace">แทนทั้งชุด</option>
                    </select>
                </label>
            </div>
        </div>`;
    wrap.querySelector('.cu_set_btn').append(makePickButton('cu_button_settings', 'menu_button', '<i class="fa-solid fa-file-arrow-up"></i> เลือกไฟล์อัปเดต…', 'การ์ด, lorebook หรือ regex'));
    wrap.querySelectorAll('input[data-key]').forEach(inp => {
        inp.checked = !!s[inp.dataset.key];
        inp.addEventListener('change', () => { settings()[inp.dataset.key] = inp.checked; save(); });
    });
    wrap.querySelectorAll('select[data-key]').forEach(sel => {
        sel.value = s[sel.dataset.key];
        sel.addEventListener('change', () => { settings()[sel.dataset.key] = sel.value; save(); });
    });
    host.append(wrap);
}

function init() {
    settings();
    addPanelButton();
    addSettings();
    const { eventSource, event_types: E } = ctx();
    if (E?.APP_READY) eventSource.on(E.APP_READY, () => { addPanelButton(); addSettings(); });
    console.log(LOG, `v${VERSION} loaded`);
    checkStale();
}

/**
 * The browser can keep running an old index.js after the extension was updated on the server.
 * Compare with the manifest on the server (bypassing the cache) and say so if they differ.
 */
async function checkStale() {
    try {
        const url = new URL('manifest.json', import.meta.url);
        url.searchParams.set('t', Date.now());
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return;
        const latest = String((await res.json())?.version ?? '');
        if (!latest || latest === VERSION) return;
        console.warn(LOG, `running v${VERSION}, server has v${latest}`);
        globalThis.toastr?.warning(
            `เซิร์ฟเวอร์มี v${esc(latest)} แล้ว แต่หน้าเว็บยังใช้ v${esc(VERSION)} อยู่ — รีเฟรชหน้า (ถ้ายังไม่เปลี่ยน ให้ล้างแคชของเบราว์เซอร์)`,
            'Card Updater', { timeOut: 0, extendedTimeOut: 0, closeButton: true });
    } catch (e) {
        console.debug(LOG, 'version check skipped', e);
    }
}

globalThis.CardUpdater = { readPngCard, writePngCard, cardInfo, jsonKind, loreDiff, mergeRegex, cardRegexAfter, onFilesPicked };

if (typeof jQuery === 'function') jQuery(init); else init();
