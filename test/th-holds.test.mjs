// node --test test/*.test.mjs
// When an update of a Tavern Helper card has to go through Tavern Helper's own copy of the scripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.jQuery = () => {};
await import('../index.js');
const { thHoldsCharacter } = globalThis.CardUpdater;

const s = (id, extra = {}) => ({ type: 'script', id, name: id, content: `// ${id}`, enabled: true, ...extra });
const folder = (id, scripts) => ({ type: 'folder', id, name: id, enabled: true, scripts });
const card = [s('engine'), folder('f', [s('panel')])];

test('open character: through Tavern Helper even when script ids differ (earlier update, new script)', () => {
    assert.equal(thHoldsCharacter({ isCurrent: true, thTrees: card, cardTrees: card }), true);
    assert.equal(thHoldsCharacter({ isCurrent: true, thTrees: [s('engine')], cardTrees: card }), true);
    assert.equal(thHoldsCharacter({ isCurrent: true, thTrees: [...card, s('mine')], cardTrees: card }), true);
});

test('open character: empty on either side still goes through Tavern Helper', () => {
    assert.equal(thHoldsCharacter({ isCurrent: true, thTrees: [], cardTrees: card }), true);
    assert.equal(thHoldsCharacter({ isCurrent: true, thTrees: card, cardTrees: [] }), true);
});

test("open character: not when Tavern Helper clearly holds another character's scripts", () => {
    assert.equal(thHoldsCharacter({ isCurrent: true, thTrees: [s('other')], cardTrees: card }), false);
});

test('another character: a copy left over from when it was open is updated through Tavern Helper', () => {
    assert.equal(thHoldsCharacter({ isCurrent: false, thTrees: structuredClone(card), cardTrees: card }), true);
    assert.equal(thHoldsCharacter({ isCurrent: false, thTrees: card, cardTrees: card, openTrees: [s('x')] }), true);
});

test("another character: not when Tavern Helper holds someone else's or nothing", () => {
    assert.equal(thHoldsCharacter({ isCurrent: false, thTrees: [], cardTrees: card }), false);
    assert.equal(thHoldsCharacter({ isCurrent: false, thTrees: [s('other')], cardTrees: card }), false);
    // same bot, but the player's state differs: not this character's copy
    assert.equal(thHoldsCharacter({ isCurrent: false, thTrees: [s('engine', { enabled: false }), folder('f', [s('panel')])], cardTrees: card }), false);
    // the open character has the very same scripts: the copy is the open one's
    assert.equal(thHoldsCharacter({ isCurrent: false, thTrees: card, cardTrees: card, openTrees: structuredClone(card) }), false);
});
