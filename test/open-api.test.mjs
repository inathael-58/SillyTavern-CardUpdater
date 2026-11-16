// node --test test/*.test.mjs
// The public API (CardUpdater.open) — what can run without SillyTavern or a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

globalThis.jQuery = () => {};
await import('../index.js');
const { waitForPick, open, version } = globalThis.CardUpdater;

/** A stand-in for <input type=file>: an EventTarget with `files` and a resettable `value`. */
function fakeInput() {
    const input = new EventTarget();
    input.files = [];
    Object.defineProperty(input, 'value', { set(v) { if (v === '') input.files = []; }, get: () => '' });
    input.pick = files => { input.files = files; input.dispatchEvent(new Event('change')); };
    return input;
}
const fakeWin = () => new EventTarget();
const tick = ms => new Promise(r => setTimeout(r, ms));
const file = name => ({ name });

test('version matches manifest.json', async () => {
    const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
    assert.equal(version, manifest.version);
});

test('open() never throws when SillyTavern is not there yet', async () => {
    let p;
    assert.doesNotThrow(() => { p = open({ avatar: 'Alice.png' }); });
    assert.deepEqual(await p, { status: 'failed' });
    assert.deepEqual(await open(), { status: 'failed' });
});

test('change → the picked files; the input is reset so the same file can be picked again', async () => {
    const input = fakeInput();
    const p = waitForPick(input, { win: fakeWin() });
    input.pick([file('a.png'), file('b.json')]);
    assert.deepEqual((await p).map(f => f.name), ['a.png', 'b.json']);
    assert.equal(input.files.length, 0);
});

test('cancel event → []', async () => {
    const input = fakeInput();
    const p = waitForPick(input, { win: fakeWin() });
    input.dispatchEvent(new Event('cancel'));
    assert.deepEqual(await p, []);
});

test('a change with no files counts as cancelled', async () => {
    const input = fakeInput();
    const p = waitForPick(input, { win: fakeWin() });
    input.pick([]);
    assert.deepEqual(await p, []);
});

test('focus back with no files → cancelled after the grace period', async () => {
    const input = fakeInput(), win = fakeWin();
    let done = false;
    const p = waitForPick(input, { win, graceMs: 20 }).then(f => { done = true; return f; });
    win.dispatchEvent(new Event('focus'));
    await tick(5);
    assert.equal(done, false, 'waits a little: change usually comes right after focus');
    assert.deepEqual(await p, []);
});

test('focus then change within the grace period → the files, not cancelled', async () => {
    const input = fakeInput(), win = fakeWin();
    const p = waitForPick(input, { win, graceMs: 30 });
    win.dispatchEvent(new Event('focus'));
    await tick(5);
    input.pick([file('card.png')]);
    assert.deepEqual((await p).map(f => f.name), ['card.png']);
});

test('files that arrive after a guessed cancel go to onLate, once', async () => {
    const input = fakeInput(), win = fakeWin();
    const late = [];
    const p = waitForPick(input, { win, graceMs: 5, onLate: f => late.push(f.map(x => x.name)) });
    win.dispatchEvent(new Event('focus'));
    assert.deepEqual(await p, []);
    input.pick([file('slow-icloud.png')]);
    input.pick([file('again.png')]); // listener is gone after the first change
    assert.deepEqual(late, [['slow-icloud.png']]);
});

test('abort (a newer open()) settles as cancelled and stops listening', async () => {
    const input = fakeInput();
    const ctl = new AbortController();
    const late = [];
    const p = waitForPick(input, { win: fakeWin(), signal: ctl.signal, onLate: f => late.push(f) });
    ctl.abort();
    assert.deepEqual(await p, []);
    input.pick([file('for-the-next-call.png')]);
    assert.equal(late.length, 0, 'the old wait must not run the next pick too');
});

test('abort after a guessed cancel also drops the late-files listener', async () => {
    const input = fakeInput(), win = fakeWin();
    const ctl = new AbortController();
    const late = [];
    const p = waitForPick(input, { win, graceMs: 5, signal: ctl.signal, onLate: f => late.push(f) });
    win.dispatchEvent(new Event('focus'));
    await p;
    ctl.abort();
    input.pick([file('x.png')]);
    assert.equal(late.length, 0);
});

test('an already-aborted signal settles at once', async () => {
    const ctl = new AbortController();
    ctl.abort();
    assert.deepEqual(await waitForPick(fakeInput(), { win: fakeWin(), signal: ctl.signal }), []);
});
