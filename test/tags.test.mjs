// node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.jQuery = () => {};
await import('../index.js');
const { cardTagNames, planTagSync } = globalThis.CardUpdater;

const T = (id, name) => ({ id, name });
const allTags = [T('a', 'Fantasy'), T('b', 'Romance'), T('c', 'My favourite'), T('d', 'Café')];

test('card tags are cleaned: trimmed, no duplicates, ROOT/TAVERN skipped, null without a field', () => {
    assert.deepEqual(cardTagNames([' Fantasy ', 'fantasy', '', 'ROOT', 'TAVERN', 'Xianxia']), ['Fantasy', 'Xianxia']);
    assert.deepEqual(cardTagNames('a, b ,a'), ['a', 'b']);
    assert.equal(cardTagNames(undefined), null);
    assert.equal(cardTagNames(Array.from({ length: 80 }, (_, i) => `t${i}`)).length, 50);
});

test('new tags are added, dropped card tags removed, the player\'s own tags kept', () => {
    const tp = planTagSync({
        oldTags: ['Fantasy', 'Romance'],
        newTags: ['Fantasy', 'Xianxia'],
        assigned: ['a', 'b', 'c'], // c = added by the player
        allTags,
    });
    assert.deepEqual(tp.add, ['Xianxia']);
    assert.deepEqual(tp.remove, ['b']);
    assert.deepEqual(tp.removeNames, ['Romance']);
});

test('tags the card had but never reached the tag list are added now', () => {
    const tp = planTagSync({ oldTags: ['Fantasy', 'Romance'], newTags: ['Fantasy', 'Romance'], assigned: [], allTags });
    assert.deepEqual(tp.add, ['Fantasy', 'Romance']);
    assert.deepEqual(tp.remove, []);
});

test('matching ignores case and accents, like SillyTavern', () => {
    const tp = planTagSync({ oldTags: ['cafe'], newTags: ['CAFE', 'fantasy'], assigned: ['a', 'd'], allTags });
    assert.deepEqual(tp.add, []);
    assert.deepEqual(tp.remove, []);
});

test('a new card without a tags field changes nothing', () => {
    assert.equal(planTagSync({ oldTags: ['Fantasy'], newTags: undefined, assigned: ['a'], allTags }), null);
});

test('an empty tags list removes the old card\'s tags only', () => {
    const tp = planTagSync({ oldTags: ['Fantasy'], newTags: [], assigned: ['a', 'c'], allTags });
    assert.deepEqual(tp.add, []);
    assert.deepEqual(tp.remove, ['a']);
});

test('apply writes SillyTavern\'s tag list (creating missing tags) and undo puts it back', () => {
    const st = {
        tags: [T('a', 'Fantasy'), T('b', 'Romance'), T('c', 'Mine')],
        tagMap: { 'kim.png': ['a', 'b', 'c'], 'other.png': ['a'] },
        saves: 0,
    };
    let n = 0;
    globalThis.SillyTavern = { getContext: () => ({ tags: st.tags, tagMap: st.tagMap, saveSettingsDebounced: () => { st.saves++; }, uuidv4: () => `new${++n}`, extensionSettings: {} }) };
    const { applyTagSync, undoTagSync } = globalThis.CardUpdater;
    const tp = planTagSync({ oldTags: ['Fantasy', 'Romance'], newTags: ['Fantasy', 'Xianxia'], assigned: st.tagMap['kim.png'], allTags: st.tags });
    const r = applyTagSync('kim.png', tp);
    assert.deepEqual(r.added, ['Xianxia']);
    assert.deepEqual(r.removed, ['Romance']);
    assert.deepEqual(st.tagMap['kim.png'], ['a', 'c', 'new1']);
    assert.equal(st.tags.find(t => t.id === 'new1').name, 'Xianxia');
    assert.ok(st.saves > 0);
    assert.deepEqual(st.tagMap['other.png'], ['a'], 'other characters untouched');

    undoTagSync(r.undo);
    assert.deepEqual(st.tagMap['kim.png'], ['a', 'b', 'c']);
    assert.equal(st.tags.some(t => t.id === 'new1'), false, 'the tag the update made is gone again');
    assert.equal(applyTagSync('kim.png', planTagSync({ oldTags: ['Fantasy'], newTags: ['Fantasy'], assigned: ['a'], allTags: st.tags })), null);
    delete globalThis.SillyTavern;
});
