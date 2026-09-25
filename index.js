/*
 * Card Updater — SillyTavern UI extension
 *
 * One button in the character panel: pick the edited card file and it
 *   • replaces the open character but keeps its file name, so every chat stays linked;
 *   • overwrites the linked lorebook with the one embedded in the card — same name,
 *     no more version bumps to stop SillyTavern from using the old one;
 *   • allows the card's regex scripts (and can put the old ones back if the new file lost them);
 *   • keeps the avatar when the new card is a .json;
 *   • shows one summary of what changed, with an Undo button.
 *
 * It is a real button (a <label> around a file input), so the file picker also
 * opens on iPhone/iPad, where the built-in "Replace / Update" can't open it.
 */

const MODULE = 'card_updater';
const LOG = '[CardUpdater]';
const CARD_EXT = ['png', 'json', 'charx', 'yaml', 'yml', 'byaf'];

const DEFAULTS = Object.freeze({
    updateLore: true,
    allowRegex: true,
    keepOldRegex: true,
    keepAvatar: true,
});

// ---------------------------------------------------------------- helpers

const ctx = () => SillyTavern.getContext();

function settings() {
    const ext = ctx().extensionSettings;
    if (!ext[MODULE]) ext[MODULE] = {};
    const s = ext[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) if (typeof s[k] !== typeof v) s[k] = v;
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
const extOf = name => (String(name).split('.').pop() || '').toLowerCase();

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

const regexNames = list => list.map(s => String(s?.scriptName ?? '').trim()).filter(Boolean);

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

// ---------------------------------------------------------------- reading the picked file

const PHOTOS_HINT = 'ถ้าเลือกไฟล์จาก <b>คลังรูปภาพ (Photos)</b> ของ iPhone ระบบจะลบข้อมูลการ์ดที่ฝังในรูปทิ้ง ให้เลือกจากแอป <b>Files</b> แทน';

/** @returns {Promise<{card: object|null, error?: string}>} card = parsed card JSON when we can read it ahead of time. */
async function readCardFile(file, ext) {
    try {
        if (ext === 'png') {
            const u8 = new Uint8Array(await file.arrayBuffer());
            if (!isPng(u8)) return { card: null, error: `ไฟล์ <b>${esc(file.name)}</b> ไม่ใช่ PNG จริง (อาจถูกแปลงเป็น JPEG/HEIC)<br>${PHOTOS_HINT}` };
            const json = readPngCard(u8);
            if (json === null) return { card: null, error: `ไม่พบข้อมูลการ์ดในรูป <b>${esc(file.name)}</b><br>${PHOTOS_HINT}` };
            return { card: JSON.parse(json) };
        }
        if (ext === 'json') return { card: JSON.parse(await file.text()) };
    } catch (e) {
        return { card: null, error: `อ่านไฟล์การ์ดไม่ได้: ${esc(e.message)}` };
    }
    return { card: null }; // charx / yaml / byaf: SillyTavern reads them; we check afterwards
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

async function showAgain(chid, chatFile) {
    const c = ctx();
    try {
        await c.selectCharacterById(chid);
        if (chatFile) await ctx().openCharacterChat(chatFile);
    } catch (e) {
        console.warn(LOG, 'could not reopen the chat', e);
    }
}

// ---------------------------------------------------------------- the dialog before updating

function planDialog(file, ext, old, parsed) {
    const s = settings();
    const next = parsed.card ? cardInfo(parsed.card) : null;
    const names = worldNames();
    const target = old.world || next?.bookName || `${old.name}'s Lorebook`;

    const el = document.createElement('div');
    el.className = 'cu_dialog';
    const warnName = next && next.name && !sameName(next.name, old.name)
        ? `<div class="cu_warn"><i class="fa-solid fa-triangle-exclamation"></i> ชื่อในไฟล์คือ “${esc(next.name)}” ไม่ตรงกับ “${esc(old.name)}” — เลือกไฟล์ถูกหรือเปล่า?</div>` : '';

    const loreLine = !next ? 'จะเช็คหลังอัปโหลด (อ่าน .' + esc(ext) + ' ล่วงหน้าไม่ได้)'
        : next.book ? `การ์ดมี lorebook ฝังมา <b>${next.entries}</b> ${plural(next.entries)}${next.bookName ? ` (ชื่อในการ์ด: “${esc(next.bookName)}”)` : ''}`
            : 'การ์ดใหม่<b>ไม่มี</b> lorebook ฝังมา' + (old.world ? ` — จะคงการผูก “${esc(old.world)}” ไว้` : '');

    const regexLine = !next ? `เดิมมี ${old.regex.length} ตัว · ของใหม่จะเช็คหลังอัปโหลด`
        : `ในไฟล์ <b>${next.regex.length}</b> ตัว (เดิม ${old.regex.length} ตัว)`;
    const regexLost = old.regex.length > 0 && (!next || next.regex.length === 0);

    el.innerHTML = `
        <h3>อัปเดตการ์ด: ${esc(old.name)}</h3>
        <div class="cu_row"><i class="fa-solid fa-file-import"></i> <span><b>${esc(file.name)}</b> → เขียนทับ <code>${esc(old.avatar)}</code><br><small>ชื่อไฟล์เดิม · แชททั้งหมดยังเชื่อมอยู่</small></span></div>
        ${warnName}
        <div class="cu_section">
            <div class="cu_head"><i class="fa-solid fa-book-atlas"></i> Lorebook</div>
            <div class="cu_note">${loreLine}</div>
            <label class="checkbox_label cu_lore_opt"><input type="checkbox" class="cu_lore"> อัปเดต lorebook จากการ์ด เขียนทับชื่อ:</label>
            <input type="text" class="text_pole cu_target cu_lore_opt" list="cu_world_list" value="${esc(target)}" enterkeyhint="done">
            <datalist id="cu_world_list">${names.map(n => `<option value="${esc(n)}"></option>`).join('')}</datalist>
            <div class="cu_note cu_target_hint cu_lore_opt"></div>
        </div>
        <div class="cu_section">
            <div class="cu_head"><i class="fa-solid fa-code"></i> Regex ของการ์ด</div>
            <div class="cu_note">${regexLine}</div>
            <label class="checkbox_label"><input type="checkbox" class="cu_allow"> อนุญาตให้ regex ของการ์ดนี้ทำงาน</label>
            ${regexLost ? `<label class="checkbox_label"><input type="checkbox" class="cu_keep_regex"> ถ้าไฟล์ใหม่ไม่มี regex ให้ใส่ของเดิม ${old.regex.length} ตัวกลับเข้าไป</label>` : ''}
        </div>
        ${ext === 'json' ? `<label class="checkbox_label"><input type="checkbox" class="cu_keep_avatar"> ใช้รูปตัวละครเดิม (ไฟล์ .json ไม่มีรูป)</label>` : ''}
        ${['yaml', 'yml'].includes(ext) ? '<div class="cu_warn"><i class="fa-solid fa-triangle-exclamation"></i> ไฟล์ .yaml ไม่มีรูป รูปตัวละครจะกลายเป็นรูปเริ่มต้น</div>' : ''}
        <div class="cu_note">กด “ย้อนกลับ” ในหน้าสรุปได้ ถ้าเลือกผิดไฟล์</div>`;

    const $ = sel => el.querySelector(sel);
    const lore = $('.cu_lore');
    const targetInput = $('.cu_target');
    const hasLore = !next || !!next.book;
    lore.checked = s.updateLore;
    el.querySelectorAll('.cu_lore_opt').forEach(n => { n.hidden = !hasLore; });
    $('.cu_allow').checked = s.allowRegex;
    if ($('.cu_keep_regex')) $('.cu_keep_regex').checked = s.keepOldRegex;
    if ($('.cu_keep_avatar')) $('.cu_keep_avatar').checked = s.keepAvatar;

    const hint = () => {
        const name = targetInput.value.trim();
        const exists = names.includes(name);
        targetInput.disabled = !lore.checked;
        $('.cu_target_hint').innerHTML = !lore.checked ? 'ไม่แตะ lorebook'
            : !name ? '<span class="cu_bad">ใส่ชื่อ lorebook</span>'
                : exists ? `มีอยู่แล้ว → <b>เขียนทับ</b> แล้วผูกกับการ์ด${name === old.world ? ' (ตัวที่ผูกอยู่ตอนนี้)' : ''}`
                    : 'ยังไม่มี → <b>สร้างใหม่</b> แล้วผูกกับการ์ด';
    };
    lore.addEventListener('change', hint);
    targetInput.addEventListener('input', hint);
    targetInput.addEventListener('keydown', e => { if (e.key === 'Enter') targetInput.blur(); });
    hint();

    const read = () => ({
        lore: lore.checked && hasLore,
        target: targetInput.value.trim(),
        allowRegex: $('.cu_allow').checked,
        keepOldRegex: $('.cu_keep_regex')?.checked ?? s.keepOldRegex,
        keepAvatar: $('.cu_keep_avatar')?.checked ?? s.keepAvatar,
    });
    return { el, read };
}

async function askPlan(file, ext, old, parsed) {
    const c = ctx();
    const { el, read } = planDialog(file, ext, old, parsed);
    let plan = null;
    const popup = new c.Popup(el, c.POPUP_TYPE.CONFIRM, '', {
        okButton: 'อัปเดต',
        cancelButton: 'ยกเลิก',
        allowVerticalScrolling: true,
        onClosing: p => {
            if (p.result !== c.POPUP_RESULT.AFFIRMATIVE) return true;
            const r = read();
            if (r.lore && !r.target) {
                toast.warn('ใส่ชื่อ lorebook ก่อน');
                return false;
            }
            plan = r;
            return true;
        },
    });
    await popup.show();
    if (!plan) return null;
    const s = settings();
    if (hasCheckbox(el, '.cu_lore')) s.updateLore = el.querySelector('.cu_lore').checked;
    s.allowRegex = plan.allowRegex;
    if (hasCheckbox(el, '.cu_keep_regex')) s.keepOldRegex = plan.keepOldRegex;
    if (hasCheckbox(el, '.cu_keep_avatar')) s.keepAvatar = plan.keepAvatar;
    save();
    return plan;
}

const hasCheckbox = (el, sel) => { const n = el.querySelector(sel); return !!n && !n.hidden && !n.closest('[hidden]'); };

// ---------------------------------------------------------------- the update itself

const line = (kind, html) => ({ kind, html });
const ICON = { ok: 'fa-circle-check', info: 'fa-circle-info', warn: 'fa-triangle-exclamation' };

function listNames(list, max = 6) {
    const shown = list.slice(0, max).map(n => `“${esc(n)}”`).join(', ');
    return list.length > max ? `${shown} และอีก ${list.length - max}` : shown;
}

async function runUpdate(file, ext, old, parsed, plan) {
    const c = ctx();
    const report = [];
    const undo = { avatar: old.avatar, chat: old.chat, png: null, world: null, allowed: isRegexAllowed(old.avatar) };

    // The PNG on the server holds the whole current card: the undo point, and the image for a .json card.
    undo.png = await fetchAvatarPng(old.avatar);

    let upload = file;
    let format = ext;
    if (ext === 'json' && plan.keepAvatar && parsed.card && (parsed.card.spec || parsed.card.name) && undo.png) {
        upload = new File([writePngCard(undo.png, JSON.stringify(parsed.card))], old.avatar, { type: 'image/png' });
        format = 'png';
    }
    await importCard(upload, format, old.avatar);
    await refreshImages(old.avatar);

    const chid = await reopen(old.avatar);
    if (chid === undefined) throw new Error('อัปโหลดแล้วแต่หาตัวละครไม่เจอ ลองรีเฟรชหน้า');
    const ch = ctx().characters[chid];
    const now = cardInfo({ data: ch.data });

    report.push(line('ok', `การ์ด “${esc(ch.name)}” อัปเดตแล้ว · ไฟล์ <code>${esc(old.avatar)}</code> แชทเดิมเชื่อมอยู่ครบ`));
    if (ext === 'json') {
        report.push(format === 'png'
            ? line('ok', 'ใช้รูปตัวละครเดิม')
            : line(plan.keepAvatar ? 'warn' : 'info', 'รูปตัวละครเป็นรูปเริ่มต้น (ไฟล์ .json ไม่มีรูป)'));
    }

    // --- lorebook
    if (now.book && plan.lore) {
        const target = plan.target;
        const existed = worldNames().includes(target);
        let before = null;
        if (existed) {
            try {
                const data = await c.loadWorldInfo(target);
                before = data ? structuredClone(data) : null;
            } catch (e) { console.warn(LOG, 'could not snapshot lorebook', e); }
        }
        undo.world = { name: target, data: before, existed };
        const converted = c.convertCharacterBook(now.book);
        await c.saveWorldInfo(target, converted, true);
        await c.updateWorldInfoList();
        if (now.world !== target) await c.writeExtensionField(chid, 'world', target);
        c.reloadWorldInfoEditor?.(target);
        const n = Object.keys(converted.entries ?? {}).length;
        const was = before?.entries ? Object.keys(before.entries).length : null;
        report.push(line('ok', `Lorebook “${esc(target)}” ${existed ? 'เขียนทับ' : 'สร้างใหม่'} · ${was !== null && was !== n ? `${was} → ` : ''}<b>${n}</b> ${plural(n)} · ผูกกับการ์ดแล้ว`));
    } else if (now.book) {
        const linked = now.world && worldNames().includes(now.world);
        report.push(line(linked ? 'info' : 'warn', `ข้ามการอัปเดต lorebook ตามที่เลือก${linked ? ` · ยังผูก “${esc(now.world)}” อยู่` : ' · ยังไม่ได้ผูก lorebook'}`));
    } else if (!now.world && old.world) {
        await c.writeExtensionField(chid, 'world', old.world);
        report.push(line('info', `การ์ดใหม่ไม่มี lorebook ฝังมา · ผูก “${esc(old.world)}” ไว้เหมือนเดิม`));
    } else if (now.world) {
        const exists = worldNames().includes(now.world);
        report.push(line(exists ? 'info' : 'warn', `การ์ดไม่มี lorebook ฝังมา · ผูกกับ “${esc(now.world)}”${exists ? '' : ' ซึ่ง<b>ไม่มีอยู่</b>ในเซิร์ฟเวอร์'}`));
    } else {
        report.push(line('info', 'การ์ดนี้ไม่มี lorebook'));
    }

    // --- regex
    let scripts = now.regex;
    if (!scripts.length && old.regex.length) {
        if (plan.keepOldRegex) {
            await c.writeExtensionField(chid, 'regex_scripts', structuredClone(old.regex));
            scripts = old.regex;
            report.push(line('warn', `ไฟล์ใหม่ไม่มี regex · ใส่ของเดิม ${old.regex.length} ตัวกลับเข้าไปแล้ว`));
        } else {
            report.push(line('warn', `ไฟล์ใหม่ไม่มี regex · ของเดิม ${old.regex.length} ตัวหายไป`));
        }
    }
    if (scripts.length) {
        const off = scripts.filter(x => x?.disabled).length;
        let msg = `Regex ในการ์ด <b>${scripts.length}</b> ตัว${off ? ` (ปิดไว้ ${off})` : ''}`;
        let kind = 'ok';
        if (plan.allowRegex) {
            setRegexAllowed(old.avatar, true);
            msg += ' · อนุญาตให้ทำงานแล้ว';
        } else if (isRegexAllowed(old.avatar)) {
            msg += ' · อนุญาตอยู่แล้ว';
        } else {
            msg += ' · <b>ยังไม่ได้อนุญาต</b>';
            kind = 'warn';
        }
        report.push(line(kind, msg));
        if (scripts !== old.regex) {
            const oldN = regexNames(old.regex), newN = regexNames(scripts);
            const added = newN.filter(n => !oldN.includes(n));
            const removed = oldN.filter(n => !newN.includes(n));
            if (added.length) report.push(line('info', `regex ใหม่: ${listNames(added)}`));
            if (removed.length) report.push(line('warn', `regex ที่หายไป: ${listNames(removed)}`));
        }
    } else if (!old.regex.length) {
        report.push(line('info', 'การ์ดนี้ไม่มี regex'));
    }

    await showAgain(chid, old.chat);
    return { report, undo };
}

async function runUndo(undo) {
    const c = ctx();
    if (!undo.png) throw new Error('ไม่มีข้อมูลการ์ดเดิมให้ย้อนกลับ');
    await importCard(new File([undo.png], undo.avatar, { type: 'image/png' }), 'png', undo.avatar);
    await refreshImages(undo.avatar);
    const notes = ['คืนการ์ดเดิมแล้ว'];
    if (undo.world?.data) {
        await c.saveWorldInfo(undo.world.name, undo.world.data, true);
        await c.updateWorldInfoList();
        c.reloadWorldInfoEditor?.(undo.world.name);
        notes.push(`คืน lorebook “${undo.world.name}”`);
    } else if (undo.world && !undo.world.existed) {
        notes.push(`lorebook “${undo.world.name}” ที่สร้างใหม่ยังอยู่ (ลบเองได้ถ้าไม่ใช้)`);
    }
    setRegexAllowed(undo.avatar, undo.allowed);
    const chid = await reopen(undo.avatar);
    if (chid !== undefined) await showAgain(chid, undo.chat);
    toast.ok(notes.join(' · '));
}

async function showReport(result) {
    const c = ctx();
    const el = document.createElement('div');
    el.className = 'cu_dialog cu_report';
    el.innerHTML = `<h3>อัปเดตเสร็จแล้ว</h3>
        <ul>${result.report.map(r => `<li class="cu_${r.kind}"><i class="fa-solid ${ICON[r.kind]}"></i><span>${r.html}</span></li>`).join('')}</ul>`;
    const UNDO = c.POPUP_RESULT.CUSTOM1;
    const answer = await new c.Popup(el, c.POPUP_TYPE.TEXT, '', {
        okButton: 'เรียบร้อย',
        allowVerticalScrolling: true,
        customButtons: result.undo.png ? [{ text: 'ย้อนกลับ', result: UNDO, classes: ['cu_undo_btn'] }] : null,
    }).show();
    if (answer !== UNDO) return;
    const sure = await c.Popup.show.confirm('ย้อนกลับเป็นการ์ดก่อนอัปเดต?', 'การ์ด lorebook และสิทธิ์ regex จะกลับเป็นแบบก่อนกดอัปเดต');
    if (sure !== c.POPUP_RESULT.AFFIRMATIVE) return;
    await withLoader(() => runUndo(result.undo));
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
    const c = ctx();
    if (busy) return 'กำลังอัปเดตอยู่';
    if (c.groupId) return 'ใช้กับแชทกลุ่มไม่ได้ เปิดตัวละครเดี่ยวก่อน';
    if (c.menuType === 'create' || c.characterId === undefined || !c.characters[c.characterId]) return 'เปิดตัวละครที่จะอัปเดตก่อน';
    if (isGenerating()) return 'รอให้บอทตอบเสร็จ (หรือกดหยุด) ก่อน';
    return null;
}

async function onFilePicked(file) {
    const why = blocker();
    if (why) { toast.warn(why); return; }
    const ext = extOf(file.name);
    if (!CARD_EXT.includes(ext)) { toast.warn(`ไฟล์ .${esc(ext)} ไม่ใช่การ์ดตัวละคร (ใช้ได้: ${CARD_EXT.join(', ')})`); return; }

    busy = true;
    try {
        const c = ctx();
        const chid = c.characterId;
        await c.unshallowCharacter?.(chid);
        const char = ctx().characters[chid];
        const old = { avatar: char.avatar, name: char.name, chat: char.chat, ...cardInfo({ data: char.data }) };

        const parsed = await readCardFile(file, ext);
        if (parsed.error) {
            await c.Popup.show.text('อัปเดตการ์ดไม่ได้', parsed.error);
            return;
        }
        const plan = await askPlan(file, ext, old, parsed);
        if (!plan) return;
        if (ctx().characterId !== chid || isGenerating()) { toast.warn('ตัวละครที่เปิดอยู่เปลี่ยนไป หรือบอทกำลังตอบ — ยกเลิกการอัปเดต'); return; }

        const result = await withLoader(() => runUpdate(file, ext, old, parsed, plan));
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
    label.innerHTML = `${html}<input type="file" class="cu_file" hidden>`;
    const input = label.querySelector('input');
    label.addEventListener('click', e => {
        if (e.target === input) return;
        const why = blocker();
        if (why) { e.preventDefault(); toast.warn(why); }
    });
    input.addEventListener('change', () => {
        const file = input.files?.[0];
        input.value = ''; // so the same file can be picked again
        if (file) onFilePicked(file);
    });
    return label;
}

function addPanelButton() {
    if (document.getElementById('cu_button')) return;
    const block = document.querySelector('#avatar_controls .form_create_bottom_buttons_block');
    if (!block) return;
    const btn = makePickButton('cu_button', 'menu_button fa-solid fa-file-arrow-up', '', 'อัปเดตการ์ด (Card Updater)\nเลือกไฟล์การ์ดที่แก้แล้ว — แชท lorebook และ regex ตามมาครบ');
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
                <b>Card Updater</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <small>เปิดตัวละคร แล้วกดปุ่ม <i class="fa-solid fa-file-arrow-up"></i> ในแผงตัวละคร (ข้างปุ่ม Export) หรือปุ่มด้านล่างนี้ · ค่าด้านล่างคือค่าเริ่มต้นของหน้าต่างอัปเดต</small>
                <div class="cu_set_btn"></div>
                <label class="checkbox_label"><input type="checkbox" data-key="updateLore"> อัปเดต lorebook จากการ์ด (เขียนทับชื่อเดิม)</label>
                <label class="checkbox_label"><input type="checkbox" data-key="allowRegex"> อนุญาต regex ของการ์ดอัตโนมัติ</label>
                <label class="checkbox_label"><input type="checkbox" data-key="keepOldRegex"> ถ้าไฟล์ใหม่ไม่มี regex ให้ใส่ของเดิมกลับ</label>
                <label class="checkbox_label"><input type="checkbox" data-key="keepAvatar"> การ์ด .json ใช้รูปตัวละครเดิม</label>
            </div>
        </div>`;
    wrap.querySelector('.cu_set_btn').append(makePickButton('cu_button_settings', 'menu_button', '<i class="fa-solid fa-file-arrow-up"></i> อัปเดตการ์ดที่เปิดอยู่…', 'เลือกไฟล์การ์ดที่แก้แล้ว'));
    wrap.querySelectorAll('input[data-key]').forEach(inp => {
        inp.checked = !!s[inp.dataset.key];
        inp.addEventListener('change', () => { settings()[inp.dataset.key] = inp.checked; save(); });
    });
    host.append(wrap);
}

function init() {
    settings();
    addPanelButton();
    addSettings();
    const { eventSource, event_types: E } = ctx();
    if (E?.APP_READY) eventSource.on(E.APP_READY, () => { addPanelButton(); addSettings(); });
    console.log(LOG, 'loaded');
}

globalThis.CardUpdater = { readPngCard, writePngCard, cardInfo, onFilePicked };

if (typeof jQuery === 'function') jQuery(init); else init();
