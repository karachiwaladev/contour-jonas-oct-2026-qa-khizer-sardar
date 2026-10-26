#!/usr/bin/env node
// Eval for the todo app: drives the real page in headless Chrome over the DevTools protocol and checks behaviour.
//
//   node todo/evals/run.js             run the checks and the mutation self-check; report goes to the OS temp dir
//   node todo/evals/run.js --record    same, and write the report into todo/evals/results/ (commit this one)
//   node todo/evals/run.js --only c12  run a single check (no recording)
//
// Needs Node 22+ (global WebSocket and fetch) and Chrome or Edge (set CHROME_PATH to override). Exit code is 0
// only if every check passes AND every deliberate bug (mutation) is caught, so the checks are shown to have teeth.
// The report records the UTC time, git branch/commit/dirty state, SHA-256 of the app and of this file, Chrome and
// Node versions, every check with its timing and evidence, console errors and every network request.
'use strict';
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..');
const APP = path.join(ROOT, 'index.html');
const args = process.argv.slice(2);
const RECORD = args.includes('--record');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...a) => { try { return execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim(); } catch (e) { return ''; } };

function findChrome() {
  return [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find((p) => fs.existsSync(p));
}
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// ---- Mutations: deliberate bugs. Each must make its named check FAIL, or the eval itself is not trustworthy. ----
const MUTATIONS = [
  { id: 'm1-html-injection', check: 'c08', desc: 'render the task title with innerHTML instead of textContent',
    from: 'title.textContent = task.title;', to: 'title.innerHTML = task.title;' },
  { id: 'm2-untick-keeps-spawn', check: 'c13', desc: 'un-ticking no longer removes the spawned next occurrence',
    from: 'if (next && next.done !== true) s.delete(stored.nextId);', to: '/* mutation: spawn kept */' },
  { id: 'm3-monthly-drift', check: 'c16', desc: 'monthly repeats forget the starting day of month',
    from: 'Math.min(anchor || d,', to: 'Math.min(d,' },
  { id: 'm4-focus-lost', check: 'c20', desc: 'keyboard focus is not restored after the list re-renders',
    from: 'if (control) control.focus();', to: '/* mutation: focus not restored */' },
  { id: 'm5-repeat-without-date', check: 'c11', desc: 'a repeating task is accepted without a due date',
    from: "if ((repeat && !due) || (due && !validDue(due))) {", to: 'if ((due && !validDue(due))) {' },
  { id: 'm6-no-persistence', check: 'c09', desc: 'tasks are not saved to IndexedDB',
    from: "const addTask = (task) => tx('readwrite', (s) => s.add(task));", to: "const addTask = (task) => tx('readwrite', (s) => s.clear());" },
];

// ---- Page-side helpers, injected after every navigation ----
const HELPERS = `window.T = (() => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const rows = () => [...document.querySelectorAll('#list li:not(.empty)')];
  const titleOf = (r) => r.querySelector('.title').textContent;
  const byTitle = (n) => rows().filter((r) => titleOf(r) === n);
  const stat = (r) => (r.classList.contains('done') ? 'done' : 'open') + ' ' + (r.querySelector('.meta') ? r.querySelector('.meta').textContent : '');
  const pad = (n) => String(n).padStart(2, '0');
  const ds = (off) => { const d = new Date(); d.setDate(d.getDate() + off); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const add = async (title, due, repeat, tags) => { $('title').value = title; $('due').value = due || ''; $('repeat').value = repeat || ''; $('tags').value = tags || ''; $('add').requestSubmit(); await wait(250); };
  const raw = (fn) => new Promise((res, rej) => { const t = db.transaction('tasks', 'readwrite'); const s = t.objectStore('tasks'); const r = fn(s); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); });
  const click = async (el) => { el.click(); await wait(350); };
  const lum = (c) => { const [r, g, b] = c.match(/[\\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const bgOf = (el) => { while (el) { const c = getComputedStyle(el).backgroundColor; if (!/, 0\\)$|transparent/.test(c)) return c; el = el.parentElement; } return 'rgb(255, 255, 255)'; };
  return { wait, $, rows, titleOf, byTitle, stat, ds, add, raw, click, ratio, bgOf };
})(); true`;

async function main() {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('No Chrome/Edge found. Set CHROME_PATH.');
  if (typeof WebSocket === 'undefined') throw new Error('Node 22 or newer is required (global WebSocket).');
  const startedAt = new Date();
  const appBuf = fs.readFileSync(APP);
  const baseHtml = appBuf.toString('utf8');

  // App server (the page under test is served from http://127.0.0.1 so IndexedDB works).
  let servedHtml = baseHtml;
  const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(servedHtml); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  // Browser
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-eval-'));
  const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 60; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json(); if (targets.length) break; } catch (e) {}
    await sleep(200);
  }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map(); const listeners = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else if (d.method) listeners.forEach((f) => f(d));
  };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });

  // Evidence collectors
  let current = { consoleErrors: [] };
  const network = [];
  listeners.push((d) => {
    if (d.method === 'Runtime.exceptionThrown') current.consoleErrors.push('exception: ' + ((d.params.exceptionDetails.exception || {}).description || d.params.exceptionDetails.text));
    if (d.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(d.params.type)) current.consoleErrors.push(d.params.type + ': ' + d.params.args.map((a) => a.value || a.description).join(' '));
    if (d.method === 'Log.entryAdded' && ['error', 'warning'].includes(d.params.entry.level)) current.consoleErrors.push('log ' + d.params.entry.level + ': ' + d.params.entry.text);
    if (d.method === 'Network.requestWillBeSent') network.push(d.params.request.url);
  });
  for (const m of ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable']) await send(m);
  const version = (await send('Browser.getVersion')).result.product;
  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 800, deviceScaleFactor: 1, mobile: false });

  // Page/driver primitives
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error('page error: ' + ((r.result.exceptionDetails.exception || {}).description || r.result.exceptionDetails.text));
    return r.result.result.value;
  };
  const waitFor = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return; await sleep(80); } throw new Error('timed out waiting for: ' + expr); };
  const ready = `typeof db !== 'undefined' && !!db && document.getElementById('list').children.length > 0`;
  const fresh = async () => {
    await send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    await send('Page.navigate', { url: origin + '/' });
    await waitFor(ready); await ev(HELPERS);
  };
  const reload = async () => { await send('Page.reload'); await waitFor(ready); await ev(HELPERS); };
  const KEYS = { Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' }, Space: { key: ' ', code: 'Space', vk: 32, text: ' ' }, Tab: { key: 'Tab', code: 'Tab', vk: 9 } };
  const press = async (name) => {
    const k = KEYS[name];
    await send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, text: k.text });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk });
    await sleep(350);
  };
  const typeText = async (text) => { await send('Input.insertText', { text }); await sleep(60); };
  const tabTo = async (selector, max = 40) => {
    for (let i = 0; i < max; i++) { if (await ev(`document.activeElement && document.activeElement.matches(${JSON.stringify(selector)})`)) return; await press('Tab'); }
    throw new Error('could not Tab to ' + selector);
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  const eq = (actual, expected, what) => assert(JSON.stringify(actual) === JSON.stringify(expected), `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  const scheme = (v) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: v }] });
  const ctx = { ev, fresh, reload, press, typeText, tabTo, assert, eq, scheme, send, origin, waitFor, sleep };

  // ---- The checks ----
  const T = (s) => `(async () => { const T = window.T; ${s} })()`;
  const CHECKS = [
    { id: 'c01', name: 'Loads with the CSP, an empty-state message and no console errors', run: async () => {
      await fresh();
      eq(await ev(`document.querySelector('#list li.empty').textContent`), 'No tasks yet.', 'empty state');
      assert(await ev(`/default-src 'none'/.test(document.querySelector('meta[http-equiv=Content-Security-Policy]').content)`), 'CSP meta tag missing');
    } },
    { id: 'c02', name: 'Typing a title and pressing Enter (real key events) adds a task and keeps focus in the field', run: async () => {
      await fresh(); await ev(`document.getElementById('title').focus()`);
      await typeText('Keyboard task'); await press('Enter');
      eq(await ev(T(`return [T.rows().map(T.titleOf), T.$('title').value, document.activeElement.id]`)), [['Keyboard task'], '', 'title'], 'after Enter');
    } },
    { id: 'c03', name: 'Empty and whitespace-only titles are not added', run: async () => {
      await fresh();
      eq(await ev(T(`T.$('title').value = '   '; T.$('add').requestSubmit(); await T.wait(300); return T.rows().length`)), 0, 'rows after whitespace');
    } },
    { id: 'c04', name: 'Tags are lower-cased and de-duplicated; tasks sort by due date with undated last', run: async () => {
      await fresh();
      const r = await ev(T(`await T.add('B task', T.ds(5), '', 'Work, home, work'); await T.add('A task', T.ds(1)); await T.add('No date');
        return { order: T.rows().map(T.titleOf), chips: [...T.byTitle('B task')[0].querySelectorAll('.chip')].map((c) => c.textContent) }`));
      eq(r, { order: ['A task', 'B task', 'No date'], chips: ['work', 'home'] }, 'order and chips');
    } },
    { id: 'c05', name: 'Overdue incomplete tasks are highlighted; completed or future ones are not', run: async () => {
      await fresh();
      const r = await ev(T(`await T.add('Late', T.ds(-5)); await T.add('Soon', T.ds(3));
        const late = T.byTitle('Late')[0]; const before = late.classList.contains('overdue') && late.querySelector('.due').textContent.startsWith('Overdue');
        await T.click(late.querySelector('input'));
        return { before, soon: T.byTitle('Soon')[0].classList.contains('overdue'), lateDone: T.byTitle('Late')[0].classList.contains('overdue') }`));
      eq(r, { before: true, soon: false, lateDone: false }, 'overdue states');
    } },
    { id: 'c06', name: 'Status filters (All / Incomplete / Completed) show the right tasks', run: async () => {
      await fresh();
      const r = await ev(T(`await T.add('One'); await T.add('Two'); await T.click(T.byTitle('One')[0].querySelector('input'));
        const pick = async (s) => { await T.click(document.querySelector('[data-status=' + s + ']')); return T.rows().map(T.titleOf).sort(); };
        return { completed: await pick('completed'), incomplete: await pick('incomplete'), all: await pick('all') }`));
      eq(r, { completed: ['One'], incomplete: ['Two'], all: ['One', 'Two'] }, 'filters');
    } },
    { id: 'c07', name: 'Tag filter works, combines with the status filter, and shows "No matching tasks."', run: async () => {
      await fresh();
      const r = await ev(T(`await T.add('W1', '', '', 'work'); await T.add('H1', '', '', 'home'); await T.click(T.byTitle('H1')[0].querySelector('input'));
        const setTag = async (v) => { T.$('tagFilter').value = v; T.$('tagFilter').dispatchEvent(new Event('change')); await T.wait(300); };
        await setTag('work'); const work = T.rows().map(T.titleOf);
        await T.click(document.querySelector('[data-status=completed]')); const none = document.querySelector('#list li.empty') && document.querySelector('#list li.empty').textContent;
        return { options: [...T.$('tagFilter').options].map((o) => o.value), work, none }`));
      eq(r, { options: ['', 'home', 'work'], work: ['W1'], none: 'No matching tasks.' }, 'tag filter');
    } },
    { id: 'c08', name: 'Task text and tags containing HTML are shown as text and never executed', run: async () => {
      await fresh();
      const r = await ev(T(`await T.add('<b>bold</b><img src=x onerror="window.__pwned=1">', '', '', '<i>t</i>'); await T.wait(300);
        return { pwned: window.__pwned === 1, injected: document.querySelectorAll('#list b, #list img, #list i').length, shown: T.titleOf(T.rows()[0]) }`));
      eq(r, { pwned: false, injected: 0, shown: '<b>bold</b><img src=x onerror="window.__pwned=1">' }, 'html handling');
    } },
    { id: 'c09', name: 'Tasks and their done state survive a real page reload', run: async () => {
      await fresh();
      await ev(T(`await T.add('Keep me', T.ds(2), '', 'x'); await T.click(T.rows()[0].querySelector('input'))`));
      await reload();
      eq(await ev(T(`return T.rows().map(T.stat)`)), ['done Due ' + await ev(`T.ds(2)`) + 'x'], 'after reload');
    } },
    { id: 'c10', name: 'Records saved by older versions and malformed records still render and can be deleted', run: async () => {
      await fresh();
      const r = await ev(T(`await T.raw((s) => s.add({ title: 'Legacy', done: false, created: 1 }));
        await T.raw((s) => s.add({ title: { x: 1 }, done: 'yes', tags: 5, dueDate: 5, repeat: '__proto__', created: 'x' }));
        await T.raw((s) => s.add({ title: 'Odd tags', done: false, tags: ['a', 7, null], created: 2 }));
        await window.render(); const n = T.rows().length;
        for (let i = 0; i < 3 && T.rows().length; i++) await T.click(T.rows()[0].querySelector('button.del'));
        return { n, left: T.rows().length, err: T.$('status').textContent }`));
      eq(r, { n: 3, left: 0, err: '' }, 'legacy and malformed');
    } },
    { id: 'c11', name: 'A repeating task without a due date is rejected with a message and not saved', run: async () => {
      await fresh();
      const r = await ev(T(`T.$('title').value = 'No date'; T.$('repeat').value = 'daily'; T.$('add').requestSubmit(); await T.wait(300);
        return { saved: T.rows().length, msg: T.$('status').textContent, cls: T.$('status').className, focus: document.activeElement.id }`));
      eq(r, { saved: 0, msg: 'Choose a due date for a repeating task.', cls: 'error', focus: 'due' }, 'validation');
    } },
    { id: 'c12', name: 'Completing a daily task 3 days overdue keeps it as history and adds tomorrow', run: async () => {
      await fresh();
      const r = await ev(T(`await T.add('Daily', T.ds(-3), 'daily', 'home'); await T.click(T.byTitle('Daily')[0].querySelector('input'));
        return { rows: T.byTitle('Daily').map(T.stat), tomorrow: T.ds(1) }`));
      eq(r.rows, ['done Due ' + await ev(`T.ds(-3)`) + '↻ Dailyhome', 'open Due ' + r.tomorrow + '↻ Dailyhome'], 'daily completion');
    } },
    { id: 'c13', name: 'Un-ticking a completed recurring task undoes it (no second open copy); re-ticking spawns again', run: async () => {
      await fresh();
      const r = await ev(T(`await T.add('Rec', T.ds(-3), 'daily');
        const open = () => T.byTitle('Rec').filter((x) => !x.classList.contains('done')).length;
        await T.click(T.byTitle('Rec')[0].querySelector('input')); const afterTick = T.byTitle('Rec').length;
        await T.click(T.byTitle('Rec').find((x) => x.classList.contains('done')).querySelector('input')); const afterUntick = { total: T.byTitle('Rec').length, open: open() };
        await T.click(T.byTitle('Rec')[0].querySelector('input')); const afterRetick = { total: T.byTitle('Rec').length, open: open() };
        return { afterTick, afterUntick, afterRetick }`));
      eq(r, { afterTick: 2, afterUntick: { total: 1, open: 1 }, afterRetick: { total: 2, open: 1 } }, 'undo semantics');
    } },
    { id: 'c14', name: 'A fast double click (tick then un-tick) leaves exactly one open copy', run: async () => {
      await fresh();
      const r = await ev(T(`await T.add('Dbl', T.ds(-3), 'weekly'); const cb = T.byTitle('Dbl')[0].querySelector('input'); cb.click(); cb.click(); await T.wait(900);
        return T.byTitle('Dbl').map(T.stat)`));
      eq(r, ['open Overdue · ' + await ev(`T.ds(-3)`) + '↻ Weekly'], 'double click');
    } },
    { id: 'c15', name: 'Weekly next date counts from the old due date, not from the day it was completed', run: async () => {
      await fresh();
      const r = await ev(T(`await T.add('Weekly', T.ds(-9), 'weekly'); await T.click(T.byTitle('Weekly')[0].querySelector('input'));
        return { dues: T.byTitle('Weekly').map((x) => x.querySelector('.due').textContent.replace(/^(Overdue · |Due )/, '')), expectNext: T.ds(5) }`));
      eq(r.dues, [await ev(`T.ds(-9)`), r.expectNext], 'weekly dates (-9 +7 = -2 is past, so +14 = +5)');
    } },
    { id: 'c16', name: 'Monthly repeats keep the 31st: Jan 31, then end of Feb, then Mar 31', run: async () => {
      await fresh();
      const Y = new Date().getFullYear() + 1; const febLast = new Date(Y, 2, 0).getDate();
      const r = await ev(T(`await T.add('Rent', '${Y}-01-31', 'monthly');
        await T.click(T.byTitle('Rent')[0].querySelector('input'));
        await T.click(T.byTitle('Rent').find((x) => !x.classList.contains('done')).querySelector('input'));
        return T.byTitle('Rent').map((x) => x.querySelector('.due').textContent)`));
      eq(r, [`Due ${Y}-01-31`, `Due ${Y}-02-${febLast}`, `Due ${Y}-03-31`], 'monthly chain');
    } },
    { id: 'c17', name: 'A due year with five or six digits cannot freeze the page', run: async () => {
      await fresh();
      const r = await ev(T(`await T.raw((s) => s.add({ title: 'Far', done: false, created: 1, dueDate: '100000-01-01', repeat: 'daily' })); await window.render();
        const t0 = performance.now(); await T.click(T.rows()[0].querySelector('input')); return { ms: Math.round(performance.now() - t0), rows: T.rows().length }`));
      assert(r.ms < 1500 && r.rows === 1, 'tick took ' + r.ms + ' ms with ' + r.rows + ' rows');
    } },
    { id: 'c18', name: 'Date logic: validDue, nextDue and stepDue return the hand-computed values', run: async () => {
      await fresh();
      const r = await ev(`({
        valid: [validDue('2028-02-29'), validDue('1970-01-01'), validDue('9999-12-31')],
        invalid: [validDue('100000-01-01'), validDue('1969-12-31'), validDue('2026-02-30'), validDue('26-1-1'), validDue(5), validDue(null)],
        steps: [nextDue('2026-10-20', 'daily', '2026-10-20'), nextDue('2026-10-20', 'daily', '2026-10-26'), nextDue('2026-10-19', 'weekly', '2026-10-26'),
                stepDue('2027-01-31', 'monthly', 1, 31), stepDue('2027-01-31', 'monthly', 2, 31), stepDue('2028-01-31', 'monthly', 1, 31),
                stepDue('2026-12-15', 'monthly', 1), nextDue('2026-12-31', 'daily', '2026-12-31')] })`);
      eq(r, { valid: [true, true, true], invalid: [false, false, false, false, false, false],
        steps: ['2026-10-21', '2026-10-27', '2026-11-02', '2027-02-28', '2027-03-31', '2028-02-29', '2027-01-15', '2027-01-01'] }, 'date logic');
    } },
    { id: 'c19', name: 'Every control has an accessible name and each task control names its task', run: async () => {
      await fresh();
      const r = await ev(T(`await T.add('Alpha', T.ds(1), '', 'a'); await T.add('Beta');
        const unnamed = [...document.querySelectorAll('input, select, button')].filter((e) => !(e.getAttribute('aria-label') || e.textContent.trim() || (e.labels && e.labels.length))).map((e) => e.id || e.outerHTML.slice(0, 40));
        return { unnamed, boxes: T.rows().map((x) => x.querySelector('input').getAttribute('aria-label')), dels: T.rows().map((x) => x.querySelector('button.del').getAttribute('aria-label')) }`));
      eq(r, { unnamed: [], boxes: ['Alpha', 'Beta'], dels: ['Delete Alpha', 'Delete Beta'] }, 'accessible names');
    } },
    { id: 'c20', name: 'Keyboard focus stays on the same row after Space toggles a task, and moves to a neighbour after Delete', run: async () => {
      await fresh();
      await ev(T(`await T.add('First'); await T.add('Second'); await T.add('Third'); document.getElementById('title').focus()`));
      await tabTo('#list li input'); await press('Space');
      const afterSpace = await ev(`({ label: document.activeElement.getAttribute('aria-label'), done: window.T.byTitle('First')[0].classList.contains('done') })`);
      eq(afterSpace, { label: 'First', done: true }, 'after Space');
      await press('Tab'); await press('Enter'); // Tab to this row's Delete button, activate it
      const afterDelete = await ev(`({ inList: document.getElementById('list').contains(document.activeElement), rows: window.T.rows().length })`);
      eq(afterDelete, { inList: true, rows: 2 }, 'after Delete');
    } },
    { id: 'c21', name: 'At 375px wide (phone) nothing scrolls sideways or is clipped, even with very long text', run: async () => {
      await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
      try {
        await fresh();
        const r = await ev(T(`await T.add('x'.repeat(190) + ' ' + 'y'.repeat(9), T.ds(2), 'weekly', 'one, two, three'); await T.add('Short');
          const de = document.documentElement; const clipped = [...document.querySelectorAll('input, select, button')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).map((e) => e.id || e.textContent);
          return { sideways: de.scrollWidth > de.clientWidth, clipped, vw: innerWidth }`));
        eq(r, { sideways: false, clipped: [], vw: 375 }, 'phone layout');
      } finally { await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 800, deviceScaleFactor: 1, mobile: false }); }
    } },
    { id: 'c22', name: 'A failed save shows a message, keeps what was typed, and the message clears after the next success', run: async () => {
      await fresh();
      const r = await ev(T(`const real = db.transaction.bind(db);
        db.transaction = (store, mode) => { if (mode === 'readwrite') throw new DOMException('quota', 'QuotaExceededError'); return real(store, mode); };
        T.$('title').value = 'Will fail'; T.$('add').requestSubmit(); await T.wait(300);
        const failed = { msg: T.$('status').textContent, cls: T.$('status').className, kept: T.$('title').value, rows: T.rows().length };
        db.transaction = real; await window.render();
        T.$('title').value = 'Recovered'; T.$('add').requestSubmit(); await T.wait(400);
        return { failed, afterMsg: T.$('status').textContent, rows: T.rows().map(T.titleOf) }`));
      eq(r, { failed: { msg: 'Could not save that change. Browser storage may be full or blocked.', cls: 'error', kept: 'Will fail', rows: 0 }, afterMsg: '', rows: ['Recovered'] }, 'failed save');
    } },
    { id: 'c23', name: 'Text and controls meet WCAG AA contrast (4.5:1) in both light and dark colour schemes', run: async () => {
      const probe = T(`await T.add('Overdue recurring', T.ds(-2), 'daily', 'work'); await T.add('Future', T.ds(5)); await T.add('Plain task'); await T.click(T.byTitle('Plain task')[0].querySelector('input'));
        T.$('title').value = 'x'; T.$('repeat').value = 'daily'; T.$('add').requestSubmit(); await T.wait(200);
        const probes = { 'task title': 'li:not(.done) .title', 'completed task title': 'li.done .title', 'due date': 'li:not(.overdue) .meta .due', 'overdue date': '.overdue .due', 'repeat badge': '.repeat', 'tag chip': '.chip',
          'delete button': 'li button.del', 'Add button': '#add button', 'selected filter': '.segmented [aria-pressed=true]', 'other filter': '.segmented [aria-pressed=false]', 'error message': '#status.error' };
        const bad = []; const seen = {};
        for (const [name, sel] of Object.entries(probes)) {
          const el = document.querySelector(sel); if (!el) { bad.push(name + ': element not found'); continue; }
          const cs = getComputedStyle(el); const r = T.ratio(cs.color, T.bgOf(el)); seen[name] = Math.round(r * 100) / 100;
          if (r < 4.5) bad.push(name + ' ' + seen[name]);
        }
        return { bad, seen }`);
      const out = {};
      for (const s of ['light', 'dark']) { await scheme(s); try { await fresh(); out[s] = await ev(probe); } finally { await scheme('light'); } }
      eq({ light: out.light.bad, dark: out.dark.bad }, { light: [], dark: [] }, 'contrast failures (ratio shown)');
      return out;
    } },
    { id: 'c24', name: 'The only network requests are for the local page itself', run: async () => {
      const foreign = network.filter((u) => !u.startsWith(origin + '/') && !u.startsWith('about:') && !u.startsWith('data:'));
      eq(foreign, [], 'requests to other hosts');
    } },
  ];

  async function runCheck(check) {
    current = { consoleErrors: [] };
    const t0 = Date.now(); let status = 'pass', detail = null;
    try { detail = (await Promise.race([check.run(), sleep(25000).then(() => { throw new Error('check timed out after 25 s'); })])) || null; }
    catch (e) { status = 'fail'; detail = e.message; }
    if (status === 'pass' && current.consoleErrors.length && !check.allowConsoleErrors) { status = 'fail'; detail = 'console errors: ' + current.consoleErrors.join(' | '); }
    return { id: check.id, name: check.name, status, duration_ms: Date.now() - t0, evidence: detail, console_errors: current.consoleErrors };
  }

  // 1. Real app, all checks
  const checks = [];
  for (const c of CHECKS.filter((c) => !ONLY || c.id === ONLY)) {
    const r = await runCheck(c); checks.push(r);
    console.log(`${r.status === 'pass' ? 'PASS' : 'FAIL'} ${r.id} ${r.name}${r.status === 'fail' ? '\n     ' + String(r.evidence).slice(0, 400) : ''}`);
  }

  // 2. Mutation self-check: each deliberate bug must be caught by its check
  const mutations = [];
  if (!ONLY) {
    for (const m of MUTATIONS) {
      const count = baseHtml.split(m.from).length - 1;
      if (count !== 1) { mutations.push({ id: m.id, description: m.desc, status: 'error', detail: `expected 1 match for the code to mutate, found ${count}; update the mutation in run.js` }); console.log(`ERR  ${m.id}: ${count} matches`); continue; }
      servedHtml = baseHtml.replace(m.from, m.to);
      const r = await runCheck(CHECKS.find((c) => c.id === m.check));
      servedHtml = baseHtml;
      const caught = r.status === 'fail';
      mutations.push({ id: m.id, description: m.desc, expected_failing_check: m.check, status: caught ? 'caught' : 'MISSED', check_evidence: r.evidence });
      console.log(`${caught ? 'PASS' : 'FAIL'} mutation ${m.id}: ${m.desc} -> ${m.check} ${caught ? 'failed as it should' : 'STILL PASSED (the check cannot detect this bug)'}`);
    }
  }

  ws.close(); chrome.kill(); server.close();
  const finishedAt = new Date();
  const passed = checks.filter((c) => c.status === 'pass').length;
  const mutBad = mutations.filter((m) => m.status !== 'caught').length;
  const report = {
    schema: 1, project: 'todo',
    started_at: startedAt.toISOString(), finished_at: finishedAt.toISOString(), duration_ms: finishedAt - startedAt,
    git: { branch: git('rev-parse', '--abbrev-ref', 'HEAD'), head: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--', 'todo').length > 0 },
    files_under_test: [{ path: 'todo/index.html', sha256: sha256(appBuf) }, { path: 'todo/evals/run.js', sha256: sha256(fs.readFileSync(__filename)) }],
    // launched_from is only a hint (Claude Code sets CLAUDECODE in its shells); it is not proof of who ran this.
    environment: { browser: version, node: process.version, platform: `${os.platform()} ${os.release()}`, launched_from: process.env.CLAUDECODE ? 'a Claude Code shell' : 'a plain shell' },
    summary: { checks_total: checks.length, checks_passed: passed, checks_failed: checks.length - passed, mutations_total: mutations.length, mutations_caught: mutations.length - mutBad },
    ok: !ONLY && passed === checks.length && mutBad === 0,
    checks, mutations, network_requests: network,
  };
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const dir = RECORD ? path.join(__dirname, 'results') : path.join(os.tmpdir(), 'todo-eval-results');
  if (!ONLY) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(dir, `${stamp}.md`), markdown(report));
    console.log(`\nReport: ${path.join(dir, stamp + '.json')}`);
  }
  console.log(`${report.ok ? 'EVAL PASSED' : 'EVAL FAILED'}: ${passed}/${checks.length} checks, ${mutations.length - mutBad}/${mutations.length} deliberate bugs caught`);
  process.exit(report.ok ? 0 : 1);
}

function markdown(r) {
  const L = [];
  L.push(`# Eval report: ${r.project}`, '', `**${r.ok ? 'PASSED' : 'FAILED'}** at ${r.finished_at} (started ${r.started_at}, ${(r.duration_ms / 1000).toFixed(1)} s)`, '');
  L.push(`- Git: branch \`${r.git.branch}\`, commit \`${r.git.head.slice(0, 10)}\`, uncommitted changes under todo/: ${r.git.dirty ? 'yes' : 'no'}`);
  for (const f of r.files_under_test) L.push(`- \`${f.path}\` sha256 \`${f.sha256}\``);
  L.push(`- ${r.environment.browser}, Node ${r.environment.node}, ${r.environment.platform}, launched from ${r.environment.launched_from} (a hint, not proof of who ran it)`, '');
  L.push(`Re-run it yourself: \`node todo/evals/run.js\`. If \`todo/index.html\` hashes to the value above, the result applies to that exact file.`, '');
  L.push('## Checks', '', '| | Check | ms |', '|---|---|---|');
  for (const c of r.checks) L.push(`| ${c.status === 'pass' ? 'pass' : '**FAIL**'} | ${c.id} ${c.name}${c.status === 'fail' ? '<br>' + String(c.evidence).replace(/\|/g, '/').slice(0, 300) : ''} | ${c.duration_ms} |`);
  L.push('', '## Deliberate bugs (the checks must catch them)', '', '| | Bug | Caught by |', '|---|---|---|');
  for (const m of r.mutations) L.push(`| ${m.status === 'caught' ? 'caught' : '**' + m.status + '**'} | ${m.description} | ${m.expected_failing_check || ''} |`);
  L.push('', `Network requests during the run: ${r.network_requests.length}, all to the local page: ${r.network_requests.every((u) => /^http:\/\/127\.0\.0\.1:/.test(u) || /^(about|data):/.test(u)) ? 'yes' : 'NO'}`, '');
  return L.join('\n');
}

main().catch((e) => { console.error('EVAL ERROR:', e.message); process.exit(2); });
