// node --test test/*.test.mjs
// Loads index.js without SillyTavern: a no-op jQuery keeps init() from running.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.jQuery = () => {};
await import('../index.js');
const { staleCardEntries, cardManifest } = globalThis.CardUpdater;

const bookEntry = (comment, content, extra = {}) => ({ comment, content, keys: [comment], secondary_keys: [], enabled: true, constant: false, ...extra });
const fileEntry = (uid, comment, content, extra = {}) => ({ uid, comment, content, key: [comment], keysecondary: [], disable: false, constant: false, ...extra });
const worldOf = (...entries) => ({ entries: Object.fromEntries(entries.map(e => [e.uid, e])) });
const manifestData = (owned, extra = {}) => ({ extensions: { card_updater: { schema: 1, bot_id: 'bot', lorebook: { owned_entries: owned } } }, ...extra });

test('no manifest → manifest: a renamed entry is listed for removal', () => {
    // The old card had no manifest; an earlier update embedded the card's own lorebook in it.
    const oldData = { character_book: { entries: [bookEntry('Mascot', 'a dog'), bookEntry('Forms of address', 'call him shixiong')] } };
    const newM = cardManifest(manifestData(['Mascot · หมานหมาน', 'Forms of address']));
    const world = worldOf(
        fileEntry(0, 'Mascot', 'a dog', { constant: true }),
        fileEntry(1, 'Forms of address', 'call him shixiong'),
        fileEntry(2, 'My own note', 'player text'), // the player's, not in the old card's book
    );
    const stale = staleCardEntries({ oldData, oldM: null, owned: newM.owned, world });
    assert.deepEqual(stale.map(x => x.name), ['Mascot']);
    assert.equal(stale[0].constant, true);
    // No manifest and no import-time copy: can't tell the card's entries from the player's → not ticked.
    assert.equal(stale[0].preselect, false);
    assert.equal(stale[0].edited, null);
});

test('no manifest: ticked when the import-time copy shows the entry is the card\'s and unchanged', () => {
    const oldData = { character_book: { entries: [bookEntry('Old A', 'x'), bookEntry('Old B', 'y'), bookEntry('Mine', 'z')] } };
    const world = {
        ...worldOf(fileEntry(0, 'Old A', 'x'), fileEntry(1, 'Old B', 'y edited by player'), fileEntry(2, 'Mine', 'z')),
        originalData: { entries: [bookEntry('Old A', 'x'), bookEntry('Old B', 'y')] },
    };
    const stale = staleCardEntries({ oldData, oldM: null, owned: ['New A'], world });
    const by = Object.fromEntries(stale.map(x => [x.name, x]));
    assert.equal(by['Old A'].preselect, true);
    assert.equal(by['Old B'].preselect, false);
    assert.equal(by['Old B'].edited, true);
    assert.equal(by.Mine.preselect, false, 'an entry the import never had is never ticked');
});

test('manifest → manifest: untouched entries are ticked, edited ones are not', () => {
    const oldData = manifestData(['Keep', 'Gone', 'Gone edited'], {
        character_book: { entries: [bookEntry('Keep', 'k'), bookEntry('Gone', 'g'), bookEntry('Gone edited', 'e')] },
    });
    const world = worldOf(fileEntry(0, 'Keep', 'k'), fileEntry(1, 'Gone', 'g'), fileEntry(2, 'Gone edited', 'e!'), fileEntry(3, 'Mine', 'm'));
    const stale = staleCardEntries({ oldData, oldM: cardManifest(oldData), owned: ['Keep'], world });
    assert.deepEqual(stale.map(x => [x.name, x.preselect, x.edited]), [['Gone', true, false], ['Gone edited', false, true]]);
});

test('manifest: an embedded book re-embedded from the lorebook file is not trusted', () => {
    // SillyTavern wrote the whole linked file (the player's entry too) into the card.
    const oldData = manifestData(['Gone'], { character_book: { entries: [bookEntry('Gone', 'g2'), bookEntry('Mine', 'm')] } });
    const world = worldOf(fileEntry(0, 'Gone', 'g2'), fileEntry(1, 'Mine', 'm'));
    const stale = staleCardEntries({ oldData, oldM: cardManifest(oldData), owned: [], world });
    assert.deepEqual(stale.map(x => [x.name, x.preselect, x.edited]), [['Gone', false, null]]);
});

test('entries gone from the lorebook file are not listed', () => {
    const oldData = { character_book: { entries: [bookEntry('Gone', 'g')] } };
    assert.deepEqual(staleCardEntries({ oldData, oldM: null, owned: [], world: worldOf() }), []);
});
