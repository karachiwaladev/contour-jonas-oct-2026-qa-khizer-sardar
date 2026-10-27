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
// Hash text with line endings normalized to LF, so the hash is the same for the committed blob (LF) and for a
// Windows checkout where git converts files to CRLF. verify.js uses the same rule.
const fileHash = (p) => sha256(Buffer.from(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')));
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
    from: 'if (next) s.delete(stored.nextId);', to: '/* mutation: spawn kept */' },
  { id: 'm3-monthly-drift', check: 'c16', desc: 'monthly repeats forget the starting day of month',
    from: 'Math.min(anchor || d,', to: 'Math.min(d,' },
  { id: 'm4-focus-lost', check: 'c20', desc: 'keyboard focus is not restored after the list re-renders',
    from: 'if (control) control.focus();', to: '/* mutation: focus not restored */' },
  { id: 'm5-repeat-without-date', check: 'c11', desc: 'a repeating task is accepted without a due date',
    from: "if (repeat && !due) return { message: 'Choose a due date for a repeating task.', field: 'due' };", to: '' },
  { id: 'm6-no-persistence', check: 'c09', desc: 'tasks are not saved to IndexedDB',
    from: "const addTask = (task) => tx('readwrite', (s) => s.add(task));", to: "const addTask = (task) => tx('readwrite', (s) => s.clear());" },
  { id: 'm7-spawn-drops-priority', check: 'c29', desc: 'the next occurrence of a recurring task does not inherit its priority',
    from: 'priority: stored.priority, // inherited', to: '' },
  { id: 'm8-filter-ignores-priority', check: 'c28', desc: 'the priority filter does nothing',
    from: 'if (view.priority && task.priority !== view.priority) return false;', to: '' },
  { id: 'm9-escape-saves', check: 'c31', desc: 'pressing Escape in the edit form saves instead of cancelling',
    from: "if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented) { e.preventDefault(); cancelEdit(task); }", to: "if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented) { e.preventDefault(); commitEdit(task); }" },
  { id: 'm10-untick-deletes-edited', check: 'c35', desc: 'un-ticking deletes a next occurrence the user has edited',
    from: '(next.done === true || next.edited === true)', to: '(next.done === true)' },
  { id: 'm11-order-ignores-priority', check: 'c27', desc: 'priority no longer breaks ties in the list order',
    from: 'const rank = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];', to: 'const rank = 0;' },
  { id: 'm12-no-default-medium', check: 'c26', desc: 'tasks without a priority (or with a malformed one) are not defaulted to Medium',
    from: "priority: typeof t.priority === 'string' && Object.hasOwn(PRIORITY_LABELS, t.priority) ? t.priority : 'medium',", to: 'priority: t.priority,' },
  { id: 'm13-edit-keeps-anchor', check: 'c34', desc: 'editing the due date of a monthly task keeps the old starting day',
    from: "if (keys.includes('dueDate') || keys.includes('repeat')) delete next.anchorDay;", to: '' },
  { id: 'm14-edit-overwrites-done', check: 'c36', desc: 'saving an edit overwrites the done state with a stale value',
    from: 'const next = { ...stored, edited: true };', to: 'const next = { ...stored, done: false, edited: true };' },
  { id: 'm15-draft-lost', check: 'c33', desc: 'the unsaved edit text is not kept when the list re-renders',
    from: 'const sync = () => { d[key] = el.value; };', to: 'const sync = () => {};' },
  { id: 'm16-edit-skips-validation', check: 'c32', desc: 'the edit form saves without validating',
    from: 'const problem = validateFields(title, d.due, d.repeat);', to: 'const problem = null;' },
  { id: 'm17-edit-drops-tags', check: 'c30', desc: 'saving an edit loses the tags',
    from: 'priority: d.priority, tags: parseTags(d.tags) };', to: 'priority: d.priority, tags: [] };' },
  { id: 'm18-priority-not-saved-on-add', check: 'c25', desc: 'the priority chosen when adding is ignored',
    from: "priority: Object.hasOwn(PRIORITY_LABELS, chosen) ? chosen : 'medium',", to: "priority: 'medium'," },
  // Found by the independent security review of ticket #12; each fix has a check and a mutation.
  { id: 'm19-last-date-spawns-broken-copy', check: 'c37', desc: 'completing a repeating task on the last supported date adds a next occurrence with no date',
    from: 'if (!nextDate) { s.put({ ...stored, done: true }); return; } // the series ends at the last supported date', to: '' },
  { id: 'm20-edit-sends-all-fields', check: 'c38', desc: 'an edit sends every field, so untouched fields are overwritten with the form\'s stale copy',
    from: 'if (JSON.stringify(values[k]) !== JSON.stringify(editing.orig[k])) patch[k] = values[k];', to: 'patch[k] = values[k];' },
  { id: 'm21-stale-save-runs', check: 'c39', desc: 'Save still acts after the edit has been cancelled',
    from: 'if (!editing || editing.id !== task.id || editing.saving) return;', to: '' },
  { id: 'm22-deleted-task-silent', check: 'c40', desc: 'saving an edit to a task deleted elsewhere says nothing',
    from: "if (outcome === 'gone') showProblem({ message: 'That task no longer exists, so your edit was not saved.' });", to: '' },
  { id: 'm23-editing-task-hidden', check: 'c41', desc: 'a filter change hides the task being edited',
    from: ' || (editing && String(editing.id) === String(t.id))', to: '' },
  { id: 'm24-no-focus-fallback', check: 'c41', desc: 'keyboard focus drops to the page body when the list becomes empty',
    from: "if (!shown.length) { list.append(emptyRow('No matching tasks.')); focusFallback(keep); return; }", to: "if (!shown.length) { list.append(emptyRow('No matching tasks.')); return; }" },
  { id: 'm25-untick-forgets-spawn', check: 'c35', desc: 'after un-ticking beside an edited next occurrence, ticking again adds a third copy',
    from: 's.put({ ...stored, done: false }); // keep spawned and nextId: re-ticking must not add another copy', to: 's.put({ ...stored, done: false, spawned: false, nextId: undefined });' },
  { id: 'm26-nextid-unvalidated', check: 'c42', desc: 'a malformed nextId in a stored record makes the task impossible to un-tick',
    from: 'nextId: Number.isInteger(t.nextId) ? t.nextId : undefined, // a non-key here would make s.get throw and abort the un-tick', to: 'nextId: t.nextId,' },
  { id: 'm27-array-repeat-accepted', check: 'c26', desc: 'a stored repeat of ["monthly"] is accepted as a real repeat',
    from: "repeat: typeof t.repeat === 'string' && Object.hasOwn(REPEAT_LABELS, t.repeat) ? t.repeat : undefined,", to: 'repeat: Object.hasOwn(REPEAT_LABELS, t.repeat) ? t.repeat : undefined,' },
  // Ticket #13: the task count footer.
  { id: 'm28-count-follows-filters', check: 'c44', desc: 'the footer counts only the tasks the filters show',
    from: 'updateCount(tasks);', to: 'updateCount(tasks.filter(matches));' },
  { id: 'm29-open-and-done-swapped', check: 'c43', desc: 'the footer\'s open and done counts are swapped',
    from: 'const done = tasks.filter((t) => t.done).length;', to: 'const done = tasks.filter((t) => !t.done).length;' },
  { id: 'm30-footer-shown-when-empty', check: 'c43', desc: 'the footer says "0 open · 0 done" when there are no tasks',
    from: "const key = tasks.length === 0 ? '' : `${open} open · ${done} done`;", to: 'const key = `${open} open · ${done} done`;' },
  { id: 'm31-footer-stale-when-nothing-shown', check: 'c44', desc: 'the footer is not updated while the filters show no tasks',
    from: 'updateCount(tasks);', to: 'if (tasks.some(matches)) updateCount(tasks);' },
  { id: 'm32-stale-footer-after-failed-read', check: 'c46', desc: 'a failed read leaves the old counts on screen',
    from: "countEl.replaceChildren(); lastCount = ''; // do not leave numbers on screen that may no longer be true", to: '' },
  { id: 'm33-dot-read-aloud', check: 'c47', desc: 'the separator dot is exposed to screen readers',
    from: "dot.setAttribute('aria-hidden', 'true');", to: '' },
  // Found by the independent security review of ticket #13.
  { id: 'm34-footer-reannounced', check: 'c49', desc: 'the footer is rewritten on every render even when the counts did not change',
    from: 'if (key === lastCount) return;', to: '' },
  { id: 'm35-unconvertible-title-blocks-list', check: 'c48', desc: 'a stored title that cannot be converted to text stops the whole list loading',
    from: 'try { return String(v ?? \'\'); } catch (e) { return \'\'; }', to: 'return String(v ?? \'\');' },
  { id: 'm8-search-ignores-tags', check: 'c50', desc: 'the search box looks at the title only, not the tags',
    from: 'if (!hit(task.title) && !(Array.isArray(task.tags) && task.tags.some(hit))) return false;', to: 'if (!hit(task.title)) return false;' },
  { id: 'm9-search-case-sensitive', check: 'c50', desc: 'the search is case-sensitive',
    from: 's.toLowerCase().includes(view.search)', to: 's.includes(view.search)' },
  { id: 'm10-search-not-trimmed', check: 'c50', desc: 'spaces around the search text are not ignored',
    from: 'searchBox.value.trim().toLowerCase()', to: 'searchBox.value.toLowerCase()' },
  { id: 'm11-stale-render-draws', check: 'c55', desc: 'a list read that was overtaken by a newer render still draws and overwrites it',
    from: 'if (mine !== renderSeq) { if (keep && !pendingFocus) pendingFocus = keep; return; }', to: '' },
];

// ---- Page-side helpers, injected after every navigation ----
const HELPERS = `window.T = (() => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const rows = () => [...document.querySelectorAll('#list li:not(.empty):not(.editing)')]; // task rows; the open edit form is editRow()
  const titleOf = (r) => r.querySelector('.title').textContent;
  const byTitle = (n) => rows().filter((r) => titleOf(r) === n);
  // The state plus the due date, repeat and tag text in the order shown. The priority badge is read separately
  // (prio), so the checks written before priority existed keep asserting exactly what they asserted.
  const stat = (r) => (r.classList.contains('done') ? 'done' : 'open') + ' ' + [...r.querySelectorAll('.meta .due, .meta .repeat, .meta .chip')].map((e) => e.textContent).join('');
  const prio = (r) => r.querySelector('.prio').textContent;
  const editRow = () => document.querySelector('#list li.editing');
  const ctl = (name) => document.querySelector('#list li.editing [data-ctl="' + name + '"]');
  const setField = (name, v) => { const el = ctl(name); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  const rowFor = (title) => byTitle(title)[0];
  const idOf = (title) => Number(rowFor(title).dataset.id);
  const get = (id) => raw((s) => s.get(id));
  const pad = (n) => String(n).padStart(2, '0');
  const ds = (off) => { const d = new Date(); d.setDate(d.getDate() + off); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const add = async (title, due, repeat, tags) => { $('title').value = title; $('due').value = due || ''; $('repeat').value = repeat || ''; $('tags').value = tags || ''; $('add').requestSubmit(); await wait(250); };
  const raw = (fn) => new Promise((res, rej) => { const t = db.transaction('tasks', 'readwrite'); const s = t.objectStore('tasks'); const r = fn(s); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); });
  const click = async (el) => { el.click(); await wait(350); };
  const lum = (c) => { const [r, g, b] = c.match(/[\\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const bgOf = (el) => { while (el) { const c = getComputedStyle(el).backgroundColor; if (!/, 0\\)$|transparent/.test(c)) return c; el = el.parentElement; } return 'rgb(255, 255, 255)'; };
  return { wait, $, rows, titleOf, byTitle, stat, prio, editRow, ctl, setField, rowFor, idOf, get, ds, add, raw, click, ratio, bgOf };
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
  const KEYS = { Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' }, Space: { key: ' ', code: 'Space', vk: 32, text: ' ' }, Tab: { key: 'Tab', code: 'Tab', vk: 9 }, Escape: { key: 'Escape', code: 'Escape', vk: 27 } };
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
        const named = (e) => !(e.getAttribute('aria-label') || e.textContent.trim() || (e.labels && e.labels.length));
        const out = { unnamed, boxes: T.rows().map((x) => x.querySelector('input').getAttribute('aria-label')), dels: T.rows().map((x) => x.querySelector('button.del').getAttribute('aria-label')),
          edits: T.rows().map((x) => x.querySelector('button.edit').getAttribute('aria-label')) };
        await T.click(T.rowFor('Alpha').querySelector('button.edit'));   // the edit form's controls need names too
        out.editUnnamed = [...document.querySelectorAll('#list li.editing input, #list li.editing select, #list li.editing button')].filter(named).map((e) => e.dataset.ctl);
        out.editFormName = T.editRow().querySelector('form').getAttribute('aria-label');
        return out`));
      eq(r, { unnamed: [], boxes: ['Alpha', 'Beta'], dels: ['Delete Alpha', 'Delete Beta'], edits: ['Edit Alpha', 'Edit Beta'], editUnnamed: [], editFormName: 'Edit Alpha' }, 'accessible names');
    } },
    { id: 'c20', name: 'Keyboard focus stays on the same row after Space toggles a task, and moves to a neighbour after Delete', run: async () => {
      await fresh();
      await ev(T(`await T.add('First'); await T.add('Second'); await T.add('Third'); document.getElementById('title').focus()`));
      await tabTo('#list li input'); await press('Space');
      const afterSpace = await ev(`({ label: document.activeElement.getAttribute('aria-label'), done: window.T.byTitle('First')[0].classList.contains('done') })`);
      eq(afterSpace, { label: 'First', done: true }, 'after Space');
      // Each row now has an Edit button before Delete (updated for the new control, not weakened): the first Tab
      // must land on this row's Edit button, the second on its Delete button, and Enter activates Delete.
      await press('Tab');
      eq(await ev(`document.activeElement.getAttribute('aria-label')`), 'Edit First', 'first Tab after the checkbox');
      await press('Tab'); await press('Enter');
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
        // And with the edit form open (the widest row the app can show).
        const edit = await ev(T(`await T.click(T.rows()[0].querySelector('button.edit'));
          const de = document.documentElement; const clipped = [...document.querySelectorAll('#list input, #list select, #list button')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).map((e) => e.dataset.ctl);
          return { sideways: de.scrollWidth > de.clientWidth, clipped, editing: !!T.editRow() }`));
        eq(edit, { sideways: false, clipped: [], editing: true }, 'phone layout while editing');
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
        T.$('priority').value = 'high'; await T.add('High one'); T.$('priority').value = 'low'; await T.add('Low one');
        T.$('title').value = 'x'; T.$('repeat').value = 'daily'; T.$('add').requestSubmit(); await T.wait(200);
        const probes = { 'task title': 'li:not(.done) .title', 'completed task title': 'li.done .title', 'due date': 'li:not(.overdue) .meta .due', 'overdue date': '.overdue .due', 'repeat badge': '.repeat', 'tag chip': '.chip',
          'High badge': '.prio-high', 'Medium badge': '.prio-medium', 'Low badge': '.prio-low', 'Edit button': 'li button.edit', 'task count footer': '#count',
          'delete button': 'li button.del', 'Add button': '#add button', 'selected filter': '.segmented [aria-pressed=true]', 'other filter': '.segmented [aria-pressed=false]', 'error message': '#status.error' };
        const bad = []; const seen = {};
        const measure = (probes) => { for (const [name, sel] of Object.entries(probes)) {
          const el = document.querySelector(sel); if (!el) { bad.push(name + ': element not found'); continue; }
          const cs = getComputedStyle(el); const r = T.ratio(cs.color, T.bgOf(el)); seen[name] = Math.round(r * 100) / 100;
          if (r < 4.5) bad.push(name + ' ' + seen[name]);
        } };
        measure(probes);
        await T.click(T.rowFor('Future').querySelector('button.edit'));   // and the edit form's own controls
        T.setField('f-title', ''); T.ctl('save').click(); await T.wait(300);   // shows the edit form's error line
        measure({ 'edit field text': '#list li.editing [data-ctl=f-title]', 'Save button': '#list li.editing button.save', 'Cancel button': '#list li.editing button.cancel', 'edit form error': '#list li.editing .formerror' });
        return { bad, seen }`);
      const out = {};
      for (const s of ['light', 'dark']) { await scheme(s); try { await fresh(); out[s] = await ev(probe); } finally { await scheme('light'); } }
      eq({ light: out.light.bad, dark: out.dark.bad }, { light: [], dark: [] }, 'contrast failures (ratio shown)');
      return out;
    } },
    // ---- Ticket #12: priority, priority filter, edit. (c24, the network check, stays last so it sees every request.) ----
    { id: 'c25', name: 'New tasks default to Medium, the Priority dropdown returns to Medium after adding, and each task shows its priority', run: async () => {
      await fresh();
      const r = await ev(T(`const sel = T.$('priority'); const before = sel.value;
        sel.value = 'high'; await T.add('Hi'); const afterAdd = sel.value; await T.add('Def');
        return { before, afterAdd, options: [...sel.options].map((o) => o.value), badges: T.rows().map((x) => [T.titleOf(x), T.prio(x)]).sort() }`));
      eq(r, { before: 'medium', afterAdd: 'medium', options: ['high', 'medium', 'low'], badges: [['Def', 'Medium'], ['Hi', 'High']] }, 'priority on add');
    } },
    { id: 'c26', name: 'Tasks saved without a priority, and malformed priorities or repeats (including arrays), count as Medium and as not repeating', run: async () => {
      await fresh();
      const r = await ev(T(`for (const [i, p] of [[1, undefined], [2, '__proto__'], [3, 5], [4, 'HIGH'], [5, ['high']]]) await T.raw((s) => s.add({ title: 'T' + i, done: false, created: i, priority: p }));
        await T.raw((s) => s.add({ title: 'RA', done: false, created: 9, dueDate: T.ds(1), repeat: ['monthly'] }));
        await window.render();
        return { prios: T.rows().filter((x) => T.titleOf(x) !== 'RA').map((x) => T.titleOf(x) + ':' + T.prio(x)), raRepeatBadges: T.rowFor('RA').querySelectorAll('.repeat').length }`));
      eq(r, { prios: ['T1:Medium', 'T2:Medium', 'T3:Medium', 'T4:Medium', 'T5:Medium'], raRepeatBadges: 0 }, 'default priority and repeat');
    } },
    { id: 'c27', name: 'The list is ordered by due date, then priority (High first), with undated tasks last ordered by priority', run: async () => {
      await fresh();
      const r = await ev(T(`const mk = (title, due, priority, created) => ({ title, done: false, created, priority, ...(due ? { dueDate: T.ds(due) } : {}) });
        for (const t of [mk('A', 1, 'low', 1), mk('B', 1, 'high', 2), mk('C', 1, 'medium', 3), mk('D', 2, 'high', 4), mk('U1', 0, 'low', 5), mk('U2', 0, 'high', 6), mk('U3', 0, 'medium', 7)]) await T.raw((s) => s.add(t));
        await window.render(); return T.rows().map(T.titleOf)`));
      eq(r, ['B', 'C', 'A', 'D', 'U2', 'U3', 'U1'], 'order');
    } },
    { id: 'c28', name: 'The priority filter works alone and together with the status and tag filters, with the empty state', run: async () => {
      await fresh();
      const r = await ev(T(`const addP = async (title, p, tags) => { T.$('priority').value = p; await T.add(title, '', '', tags); };
        await addP('H1', 'high', 'work'); await addP('H2', 'high', 'home'); await addP('M1', 'medium', 'work'); await addP('L1', 'low', 'home');
        await T.click(T.rowFor('H2').querySelector('input'));
        const names = () => T.rows().map(T.titleOf).sort();
        const setSel = async (id, v) => { T.$(id).value = v; T.$(id).dispatchEvent(new Event('change')); await T.wait(300); };
        const status = async (s) => { await T.click(document.querySelector('[data-status=' + s + ']')); };
        const out = { options: [...T.$('priorityFilter').options].map((o) => o.value), all: names() };
        await setSel('priorityFilter', 'high'); out.high = names();
        await setSel('priorityFilter', 'medium'); out.medium = names();
        await setSel('priorityFilter', 'low'); out.low = names();
        await setSel('priorityFilter', 'high'); await status('completed'); out.highDone = names();
        await status('all'); await setSel('tagFilter', 'home'); out.highHome = names();
        await setSel('priorityFilter', 'low'); await status('completed'); out.lowDone = document.querySelector('#list li.empty') && document.querySelector('#list li.empty').textContent;
        return out`));
      eq(r, { options: ['', 'high', 'medium', 'low'], all: ['H1', 'H2', 'L1', 'M1'], high: ['H1', 'H2'], medium: ['M1'], low: ['L1'], highDone: ['H2'], highHome: ['H2'], lowDone: 'No matching tasks.' }, 'priority filter');
    } },
    { id: 'c29', name: 'The next occurrence of a recurring task inherits its priority', run: async () => {
      await fresh();
      const r = await ev(T(`T.$('priority').value = 'high'; await T.add('Rec', T.ds(-3), 'daily'); await T.click(T.rowFor('Rec').querySelector('input'));
        return T.byTitle('Rec').map(T.prio)`));
      eq(r, ['High', 'High'], 'priority on the completed task and its next occurrence');
    } },
    { id: 'c30', name: 'Editing every field (title, due date, repeat, priority, tags) saves, closes the form, restores focus, and persists across a reload', run: async () => {
      await fresh();
      const ds3 = await ev(`T.ds(3)`), ds10 = await ev(`T.ds(10)`);
      await ev(T(`T.$('priority').value = 'low'; await T.add('Orig', T.ds(3), 'weekly', 'a'); await T.click(T.rowFor('Orig').querySelector('button.edit'));`));
      const opened = await ev(T(`return { form: !!T.editRow(), focus: document.activeElement.dataset.ctl, values: ['f-title', 'f-due', 'f-repeat', 'f-priority', 'f-tags'].map((c) => T.ctl(c).value) }`));
      eq(opened, { form: true, focus: 'f-title', values: ['Orig', ds3, 'weekly', 'low', 'a'] }, 'edit form opens filled in');
      const saved = await ev(T(`T.setField('f-title', 'Changed'); T.setField('f-due', T.ds(10)); T.setField('f-repeat', 'daily'); T.setField('f-priority', 'high'); T.setField('f-tags', 'X, y, x');
        T.ctl('save').click(); await T.wait(500);
        const r = T.rowFor('Changed');
        return { editing: !!T.editRow(), old: T.byTitle('Orig').length, stat: T.stat(r), prio: T.prio(r), focus: document.activeElement.dataset.ctl + ':' + document.activeElement.getAttribute('aria-label') }`));
      const want = { editing: false, old: 0, stat: 'open Due ' + ds10 + '↻ Dailyxy', prio: 'High', focus: 'edit:Edit Changed' };
      eq(saved, want, 'after Save');
      await reload();
      eq(await ev(T(`const r = T.rowFor('Changed'); return { stat: T.stat(r), prio: T.prio(r), rows: T.rows().length }`)), { stat: want.stat, prio: 'High', rows: 1 }, 'after reload');
    } },
    { id: 'c31', name: 'Keyboard editing: Enter saves, Escape cancels, and focus returns to the Edit button (real key events)', run: async () => {
      await fresh(); await ev(T(`await T.add('Key'); document.getElementById('title').focus()`));
      await tabTo('#list li button.edit'); await press('Enter');
      eq(await ev(`document.activeElement.dataset.ctl`), 'f-title', 'focus on the title field after Enter on Edit');
      await typeText(' more'); await press('Enter');
      const afterSave = await ev(T(`return { rows: T.rows().map(T.titleOf), editing: !!T.editRow(), focus: document.activeElement.dataset.ctl }`));
      assert(afterSave.rows.length === 1 && afterSave.rows[0].includes('more') && afterSave.rows[0].includes('Key') && !afterSave.editing && afterSave.focus === 'edit', 'Enter did not save the edit and restore focus: ' + JSON.stringify(afterSave));
      const title1 = afterSave.rows[0];
      await press('Enter'); await typeText('ZZZ'); await press('Escape');
      eq(await ev(T(`return { rows: T.rows().map(T.titleOf), editing: !!T.editRow(), focus: document.activeElement.dataset.ctl }`)), { rows: [title1], editing: false, focus: 'edit' }, 'after Escape');
    } },
    { id: 'c32', name: 'Edit validation: an empty title, a repeat without a due date and an impossible date are rejected, nothing is saved and the draft stays', run: async () => {
      await fresh();
      const r = await ev(T(`await T.add('V'); const id = T.idOf('V'); await T.click(T.rowFor('V').querySelector('button.edit'));
        // Problems are shown inside the edit form (next to Save), where the user is looking, not in the page-level status line.
        const msg = () => T.editRow().querySelector('.formerror').textContent;
        const out = {}; const save = async () => { T.ctl('save').click(); await T.wait(300); };
        T.setField('f-title', '   '); await save(); out.empty = [msg(), document.activeElement.dataset.ctl];
        out.visible = T.editRow().querySelector('.formerror').offsetHeight > 0;
        T.setField('f-title', 'V2'); T.setField('f-repeat', 'daily'); await save(); out.noDue = [msg(), document.activeElement.dataset.ctl];
        editing.draft.due = '2026-02-30'; await save(); out.badDue = msg();
        out.statusLine = T.$('status').textContent;
        const stored = await T.get(id); out.stored = stored.title + '|' + (stored.repeat || 'none') + '|' + (stored.edited === true);
        out.draftKept = T.ctl('f-title').value; out.stillEditing = !!T.editRow();
        T.ctl('cancel').click(); await T.wait(300); out.afterCancel = T.rows().map(T.titleOf);
        return out`));
      eq(r, { empty: ['Enter a title.', 'f-title'], visible: true, noDue: ['Choose a due date for a repeating task.', 'f-due'], badDue: 'Enter a due date between 1970 and 9999.', statusLine: '',
        stored: 'V|none|false', draftKept: 'V2', stillEditing: true, afterCancel: ['V'] }, 'edit validation');
    } },
    { id: 'c33', name: 'An edit in progress keeps its unsaved text when the list re-renders, and other Edit buttons are disabled meanwhile', run: async () => {
      await fresh();
      const r = await ev(T(`await T.add('A'); await T.add('B'); await T.click(T.rowFor('A').querySelector('button.edit')); T.setField('f-title', 'Draft text');
        await T.click(T.rowFor('B').querySelector('input'));
        return { draft: T.ctl('f-title').value, bDone: T.rowFor('B').classList.contains('done'), otherEditDisabled: T.rowFor('B').querySelector('button.edit').disabled }`));
      eq(r, { draft: 'Draft text', bDone: true, otherEditDisabled: true }, 'draft after a re-render');
    } },
    { id: 'c34', name: 'Changing the due date of a monthly task starts a new series: the next occurrence uses the new day of month', run: async () => {
      await fresh();
      const Y = new Date().getFullYear() + 1;
      const r = await ev(T(`await T.add('M', '${Y}-01-31', 'monthly'); await T.click(T.rowFor('M').querySelector('input'));
        const open = T.byTitle('M').find((x) => !x.classList.contains('done')); await T.click(open.querySelector('button.edit'));
        T.setField('f-due', '${Y}-03-10'); T.ctl('save').click(); await T.wait(500);
        await T.click(T.byTitle('M').find((x) => !x.classList.contains('done')).querySelector('input'));
        return T.byTitle('M').map((x) => x.querySelector('.due').textContent)`));
      eq(r, [`Due ${Y}-01-31`, `Due ${Y}-03-10`, `Due ${Y}-04-10`], 'monthly dates after re-anchoring');
    } },
    { id: 'c35', name: 'Un-ticking never deletes a next occurrence the user has edited', run: async () => {
      await fresh();
      const r = await ev(T(`await T.add('R', T.ds(-3), 'daily'); await T.click(T.rowFor('R').querySelector('input'));
        const next = T.byTitle('R').find((x) => !x.classList.contains('done')); await T.click(next.querySelector('button.edit'));
        T.setField('f-priority', 'high'); T.ctl('save').click(); await T.wait(500);
        const state = () => T.byTitle('R').map((x) => (x.classList.contains('done') ? 'done ' : 'open ') + T.prio(x)).sort();
        await T.click(T.byTitle('R').find((x) => x.classList.contains('done')).querySelector('input'));
        const afterUntick = state();
        await T.click(T.byTitle('R').find((x) => T.prio(x) === 'Medium').querySelector('input'));   // tick the original again
        return { afterUntick, afterRetick: state() }`));
      // The edited next occurrence is kept, and re-ticking the original must not add a third copy of the series.
      eq(r, { afterUntick: ['open High', 'open Medium'], afterRetick: ['done Medium', 'open High'] }, 'rows after un-tick and re-tick with an edited next occurrence');
    } },
    { id: 'c36', name: 'Saving an edit does not overwrite a change made elsewhere meanwhile (no stale save)', run: async () => {
      await fresh();
      const r = await ev(T(`await T.add('S'); const id = T.idOf('S'); await T.click(T.rowFor('S').querySelector('button.edit')); T.setField('f-title', 'S edited');
        const rec = await T.get(id); rec.done = true; await T.raw((s) => s.put(rec));   // another tab ticks it meanwhile
        T.ctl('save').click(); await T.wait(500);
        const stored = await T.get(id); return { title: stored.title, done: stored.done, edited: stored.edited }`));
      eq(r, { title: 'S edited', done: true, edited: true }, 'stored record after a stale save');
    } },
    // ---- Found by the independent security review of ticket #12 ----
    { id: 'c37', name: 'Completing a repeating task on the last supported date (9999-12-31) ends the series without freezing the page', run: async () => {
      await fresh();
      const r = await ev(T(`const out = { rows: {} }; const t0 = performance.now();
        for (const [title, due, rep] of [['Dd', '9999-12-31', 'daily'], ['Ww', '9999-12-28', 'weekly'], ['Mm', '9999-12-15', 'monthly']]) {
          await T.add(title, due, rep); await T.click(T.rowFor(title).querySelector('input'));
          out.rows[title] = T.byTitle(title).map((x) => (x.classList.contains('done') ? 'done' : 'open')); }
        out.ms = Math.round(performance.now() - t0); out.status = T.$('status').textContent; return out`));
      assert(r.ms < 4000, 'took ' + r.ms + ' ms');
      eq({ rows: r.rows, status: r.status }, { rows: { Dd: ['done'], Ww: ['done'], Mm: ['done'] }, status: '' }, 'series at the last date');
    } },
    { id: 'c38', name: 'Saving an edit changes only the fields the user changed: another tab\'s change to a different field survives', run: async () => {
      await fresh();
      const r = await ev(T(`await T.add('P', '', '', 'a'); const id = T.idOf('P'); await T.click(T.rowFor('P').querySelector('button.edit'));
        T.setField('f-title', 'P2');                                       // the user changes only the title
        const rec = await T.get(id); rec.priority = 'high'; rec.tags = ['x']; await T.raw((s) => s.put(rec));   // another tab changes priority and tags
        T.ctl('save').click(); await T.wait(500);
        const s = await T.get(id); return { title: s.title, priority: s.priority, tags: s.tags, edited: s.edited }`));
      eq(r, { title: 'P2', priority: 'high', tags: ['x'], edited: true }, 'stored record');
    } },
    { id: 'c39', name: 'Save and Cancel do nothing once the edit they belong to is closed: no error, nothing saved', run: async () => {
      await fresh();
      const r = await ev(T(`await T.add('G'); const id = T.idOf('G'); const task = (await allTasks())[0];
        await T.click(T.rowFor('G').querySelector('button.edit')); T.setField('f-title', 'G2');
        cancelEdit(task);                                                    // Escape
        let threw = false; try { await commitEdit(task); } catch (e) { threw = true; }   // Enter arriving before the form was replaced
        await T.wait(400);
        return { threw, closed: editing === null, rows: T.rows().map(T.titleOf), stored: (await T.get(id)).title }`));
      eq(r, { threw: false, closed: true, rows: ['G'], stored: 'G' }, 'late Save after Cancel');
    } },
    { id: 'c40', name: 'Saving an edit to a task that was deleted elsewhere says so instead of looking successful', run: async () => {
      await fresh();
      const r = await ev(T(`await T.add('D'); const id = T.idOf('D'); await T.click(T.rowFor('D').querySelector('button.edit')); T.setField('f-title', 'D2');
        await T.raw((s) => s.delete(id)); T.ctl('save').click(); await T.wait(500);
        return { msg: T.$('status').textContent, closed: editing === null, rows: T.rows().length }`));
      eq(r, { msg: 'That task no longer exists, so your edit was not saved.', closed: true, rows: 0 }, 'save after the task was deleted');
    } },
    { id: 'c41', name: 'The task being edited stays visible when a filter would hide it, and keyboard focus never falls to the page body when the list empties', run: async () => {
      await fresh();
      const r = await ev(T(`T.$('priority').value = 'high'; await T.add('H'); T.$('priority').value = 'low'; await T.add('L');
        const setSel = async (id, v) => { T.$(id).value = v; T.$(id).dispatchEvent(new Event('change')); await T.wait(300); };
        await T.click(T.rowFor('H').querySelector('button.edit'));
        await setSel('priorityFilter', 'low');                               // H (high) no longer matches the filter
        const out = { formStill: !!T.editRow(), rows: T.rows().map(T.titleOf) };
        T.ctl('cancel').click(); await T.wait(300); out.afterCancel = T.rows().map(T.titleOf);   // now only L matches
        await T.click(T.rowFor('L').querySelector('button.edit')); T.setField('f-priority', 'high'); T.ctl('save').click(); await T.wait(500);
        out.empty = document.querySelector('#list li.empty') && document.querySelector('#list li.empty').textContent;   // nothing matches any more
        out.focusOnFilter = document.activeElement.tagName === 'BUTTON' && document.activeElement.hasAttribute('data-status');
        return out`));
      eq(r, { formStill: true, rows: ['L'], afterCancel: ['L'], empty: 'No matching tasks.', focusOnFilter: true }, 'edit under a filter');
    } },
    { id: 'c42', name: 'Records with a malformed nextId or anchorDay can still be ticked and un-ticked without errors', run: async () => {
      await fresh();
      const Y = new Date().getFullYear() + 1; const febLast = new Date(Y, 2, 0).getDate();
      const r = await ev(T(`await T.raw((s) => s.add({ title: 'N1', done: true, created: 1, repeat: 'daily', dueDate: T.ds(-1), spawned: true, nextId: {} }));
        await T.raw((s) => s.add({ title: 'N2', done: false, created: 2, repeat: 'monthly', dueDate: '${Y}-01-31', anchorDay: 'x' }));
        await window.render();
        await T.click(T.rowFor('N1').querySelector('input'));              // un-tick: must not abort
        await T.click(T.byTitle('N2')[0].querySelector('input'));          // tick: must spawn a valid date
        return { n1: T.byTitle('N1').map((x) => (x.classList.contains('done') ? 'done' : 'open')), n2: T.byTitle('N2').map((x) => x.querySelector('.due').textContent), status: T.$('status').textContent }`));
      eq(r, { n1: ['open'], n2: [`Due ${Y}-01-31`, `Due ${Y}-02-${febLast}`], status: '' }, 'malformed nextId and anchorDay');
    } },
    // ---- Ticket #13: the task count footer ----
    { id: 'c43', name: 'The footer is empty with no tasks (a "0 open · 0 done" would be wrong), then shows open and done counts that follow adding, ticking, un-ticking and deleting', run: async () => {
      await fresh();
      const r = await ev(T(`const foot = () => (T.$('count').textContent === '' ? '(empty)' : T.$('count').textContent);
        const out = { empty: foot() };
        await T.add('A'); out.one = foot(); await T.add('B'); await T.add('C'); out.three = foot();
        await T.click(T.rowFor('A').querySelector('input')); out.tickA = foot();
        await T.click(T.rowFor('B').querySelector('input')); out.tickB = foot();
        await T.click(T.rowFor('A').querySelector('input')); out.untickA = foot();
        await T.click(T.rowFor('B').querySelector('button.del')); out.deleteDoneB = foot();
        await T.click(T.rowFor('C').querySelector('button.del')); out.deleteOpenC = foot();
        await T.click(T.rowFor('A').querySelector('button.del')); out.allGone = foot();
        return out`));
      eq(r, { empty: '(empty)', one: '1 open · 0 done', three: '3 open · 0 done', tickA: '2 open · 1 done', tickB: '1 open · 2 done', untickA: '2 open · 1 done',
        deleteDoneB: '2 open · 0 done', deleteOpenC: '1 open · 0 done', allGone: '(empty)' }, 'footer counts');
    } },
    { id: 'c44', name: 'The footer counts every task whatever the status, tag and priority filters show, and stays right when a filter shows nothing', run: async () => {
      await fresh();
      const r = await ev(T(`const foot = () => (T.$('count').textContent === '' ? '(empty)' : T.$('count').textContent);
        const addP = async (title, p, tags) => { T.$('priority').value = p; await T.add(title, '', '', tags); };
        await addP('H1', 'high', 'work'); await addP('H2', 'high', 'home'); await addP('L1', 'low', 'work'); await T.click(T.rowFor('H2').querySelector('input'));
        const setSel = async (id, v) => { T.$(id).value = v; T.$(id).dispatchEvent(new Event('change')); await T.wait(300); };
        const out = { all: foot() };
        await setSel('priorityFilter', 'low'); out.lowFilter = foot(); out.shownLow = T.rows().length;
        await T.click(document.querySelector('[data-status=completed]')); out.lowDone = foot(); out.nothingShown = !!document.querySelector('#list li.empty');
        T.$('priority').value = 'medium'; await T.add('X'); out.addWhileNothingShown = foot();   // X is hidden by the filters, the footer must still move
        await setSel('tagFilter', 'work'); out.tagFilter = foot();
        return out`));
      eq(r, { all: '2 open · 1 done', lowFilter: '2 open · 1 done', shownLow: 1, lowDone: '2 open · 1 done', nothingShown: true, addWhileNothingShown: '3 open · 1 done', tagFilter: '3 open · 1 done' }, 'footer under filters');
    } },
    { id: 'c45', name: 'Recurring tasks: ticking keeps open the same and adds a done, un-ticking undoes it, and editing changes nothing', run: async () => {
      await fresh();
      const r = await ev(T(`const foot = () => T.$('count').textContent;
        await T.add('Rec', T.ds(-3), 'daily'); await T.add('Other'); const out = { start: foot() };
        await T.click(T.rowFor('Rec').querySelector('input')); out.ticked = foot();
        await T.click(T.byTitle('Rec').find((x) => x.classList.contains('done')).querySelector('input')); out.unticked = foot();
        await T.click(T.rowFor('Rec').querySelector('input')); out.reticked = foot();
        await T.click(T.byTitle('Rec').find((x) => !x.classList.contains('done')).querySelector('button.edit')); out.whileEditing = foot();
        T.setField('f-title', 'Rec renamed'); T.ctl('save').click(); await T.wait(500); out.afterSave = foot();
        return out`));
      eq(r, { start: '2 open · 0 done', ticked: '2 open · 1 done', unticked: '2 open · 0 done', reticked: '2 open · 1 done', whileEditing: '2 open · 1 done', afterSave: '2 open · 1 done' }, 'recurring counts');
    } },
    { id: 'c46', name: 'Malformed records count as open, and a failed read clears the footer instead of leaving stale numbers', run: async () => {
      await fresh();
      const r = await ev(T(`const foot = () => (T.$('count').textContent === '' ? '(empty)' : T.$('count').textContent);
        await T.raw((s) => s.add({ title: 'Old', created: 1 })); await T.raw((s) => s.add({ title: 'Bad', done: 'yes', created: 2 }));
        await T.raw((s) => s.add({ title: 'Done', done: true, created: 3 })); await T.raw((s) => s.add({ title: { x: 1 }, done: 5, created: 4 }));
        await window.render(); const out = { malformed: foot() };
        const real = db.transaction.bind(db);
        db.transaction = (store, mode) => { if (mode === 'readonly') throw new DOMException('blocked', 'InvalidStateError'); return real(store, mode); };
        await window.render(); out.failedRead = { footer: foot(), status: T.$('status').textContent };
        db.transaction = real; await window.render(); out.recovered = foot();
        return out`));
      eq(r, { malformed: '3 open · 1 done', failedRead: { footer: '(empty)', status: 'Could not read your tasks from browser storage.' }, recovered: '3 open · 1 done' }, 'malformed records and a failed read');
    } },
    { id: 'c47', name: 'The footer sits below the list, is a polite live region that is never hidden (even when empty), and hides its separator dot from screen readers', run: async () => {
      await fresh();
      const r = await ev(T(`const c = T.$('count'); const out = { beforeAnyTask: { hiddenAttr: c.hasAttribute('hidden'), display: getComputedStyle(c).display, text: c.textContent } };
        await T.add('A');
        Object.assign(out, { tag: c.tagName, live: c.getAttribute('aria-live'), text: c.textContent, dotHidden: (c.querySelector('[aria-hidden=true]') || {}).textContent,
          spoken: [...c.childNodes].filter((n) => !(n.nodeType === 1 && n.getAttribute('aria-hidden') === 'true')).map((n) => n.textContent).join(''),
          belowList: !!(T.$('list').compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING), insideMain: !!c.closest('main'), focusable: c.tabIndex >= 0, hiddenAttr: c.hasAttribute('hidden') });
        await T.click(T.rowFor('A').querySelector('button.del')); out.afterLastDelete = { hiddenAttr: c.hasAttribute('hidden'), display: getComputedStyle(c).display, text: c.textContent };
        return out`));
      eq(r, { beforeAnyTask: { hiddenAttr: false, display: 'block', text: '' }, tag: 'FOOTER', live: 'polite', text: '1 open · 0 done', dotHidden: '·', spoken: '1 open  0 done', belowList: true, insideMain: true,
        focusable: false, hiddenAttr: false, afterLastDelete: { hiddenAttr: false, display: 'block', text: '' } }, 'footer structure');
    } },
    { id: 'c48', name: 'A stored record whose title cannot be converted to text (such as {toString: 5}) no longer stops the list from loading', run: async () => {
      await fresh();
      const r = await ev(T(`await T.raw((s) => s.add({ title: { toString: 5, valueOf: 5 }, done: false, created: 1 })); await T.raw((s) => s.add({ title: 'Fine', done: false, created: 2 }));
        await window.render();
        return { rows: T.rows().map(T.titleOf), footer: T.$('count').textContent, status: T.$('status').textContent }`));
      eq(r, { rows: ['', 'Fine'], footer: '2 open · 0 done', status: '' }, 'list with an unconvertible title');
    } },
    { id: 'c49', name: 'An unchanged count is not rewritten, so filtering or opening an edit does not make a screen reader announce the same numbers again', run: async () => {
      await fresh();
      const r = await ev(T(`await T.add('A'); await T.add('B', '', '', 'x'); const c = T.$('count'); const first = c.firstChild; const same = () => c.firstChild === first;
        const out = {};
        await T.click(document.querySelector('[data-status=incomplete]')); out.afterStatusFilter = same();
        T.$('tagFilter').value = 'x'; T.$('tagFilter').dispatchEvent(new Event('change')); await T.wait(300); out.afterTagFilter = same();
        T.$('priorityFilter').value = 'high'; T.$('priorityFilter').dispatchEvent(new Event('change')); await T.wait(300); out.afterPriorityFilter = same();
        T.$('priorityFilter').value = ''; T.$('priorityFilter').dispatchEvent(new Event('change')); T.$('tagFilter').value = ''; T.$('tagFilter').dispatchEvent(new Event('change')); await T.wait(300);
        await T.click(T.rowFor('A').querySelector('button.edit')); out.afterOpeningEdit = same();
        T.ctl('cancel').click(); await T.wait(300); out.afterCancelling = same();
        await T.click(T.rowFor('A').querySelector('input')); out.afterTicking = !same();   // a real change does rewrite it
        out.text = c.textContent; return out`));
      eq(r, { afterStatusFilter: true, afterTagFilter: true, afterPriorityFilter: true, afterOpeningEdit: true, afterCancelling: true, afterTicking: true, text: '1 open · 1 done' }, 'footer rewrites');
    } },
    { id: 'c24', name: 'The only network requests are for the local page itself', run: async () => {
      const foreign = network.filter((u) => !u.startsWith(origin + '/') && !u.startsWith('about:') && !u.startsWith('data:'));
      eq(foreign, [], 'requests to other hosts');
    } },
    { id: 'c50', name: 'Search filters by title and tag as you type: case-insensitive, trimmed, literal (no regex), empty search shows everything, no match shows the empty state', run: async () => {
      await fresh();
      const r = await ev(T(`await T.add('Buy Milk', '', '', 'shop'); await T.add('Call Bob', '', '', 'milk-run, work'); await T.add('Read (book)'); await T.add('Plan');
        const names = () => T.rows().map(T.titleOf).sort();
        const setSearch = async (v) => { T.$('search').value = v; T.$('search').dispatchEvent(new Event('input', { bubbles: true })); await T.wait(300); };
        const out = { all: names() };
        await setSearch('milk'); out.milk = names();
        await setSearch('MILK'); out.upper = names();
        await setSearch('  milk  '); out.padded = names();
        await setSearch('shop'); out.tag = names();
        await setSearch('work'); out.tag2 = names();
        await setSearch('(book'); out.literal = names();
        await setSearch('.*'); out.regex = names();
        await setSearch('zzz'); out.none = [names(), document.querySelector('#list li.empty') && document.querySelector('#list li.empty').textContent];
        await setSearch(''); out.cleared = names();
        return out`));
      eq(r, { all: ['Buy Milk', 'Call Bob', 'Plan', 'Read (book)'], milk: ['Buy Milk', 'Call Bob'], upper: ['Buy Milk', 'Call Bob'], padded: ['Buy Milk', 'Call Bob'], tag: ['Buy Milk'], tag2: ['Call Bob'],
        literal: ['Read (book)'], regex: [], none: [[], 'No matching tasks.'], cleared: ['Buy Milk', 'Call Bob', 'Plan', 'Read (book)'] }, 'search results');
      // Real key events: typing updates the list as you go, and focus stays in the box.
      await ev(`document.getElementById('search').focus()`);
      await typeText('plan'); await sleep(300);
      eq(await ev(T(`return [T.rows().map(T.titleOf), document.activeElement.id]`)), [['Plan'], 'search'], 'typed search');
    } },
    { id: 'c51', name: 'Search combines with the status, tag and priority filters, keeps the due-date order, and clearing it leaves the other filters in place', run: async () => {
      await fresh();
      const r = await ev(T(`const addP = async (title, p, due, tags) => { T.$('priority').value = p; await T.add(title, due, '', tags); };
        await addP('Alpha milk', 'high', T.ds(3), 'work'); await addP('Beta milk', 'low', T.ds(1), 'home'); await addP('Gamma milk', 'high', '', 'home'); await addP('Delta', 'high', '', 'work');
        await T.click(T.rowFor('Gamma milk').querySelector('input'));
        const names = () => T.rows().map(T.titleOf);
        const setSearch = async (v) => { T.$('search').value = v; T.$('search').dispatchEvent(new Event('input', { bubbles: true })); await T.wait(300); };
        const setSel = async (id, v) => { T.$(id).value = v; T.$(id).dispatchEvent(new Event('change')); await T.wait(300); };
        const status = async (s) => { await T.click(document.querySelector('[data-status=' + s + ']')); };
        const out = {};
        await setSearch('milk'); out.milk = names();
        await status('incomplete'); out.incomplete = names();
        await setSel('priorityFilter', 'high'); out.incompleteHigh = names();
        await setSel('priorityFilter', ''); await status('all'); await setSel('tagFilter', 'home'); out.home = names();
        await status('completed'); out.homeDone = names();
        await status('all'); await setSel('priorityFilter', 'high'); out.homeHigh = names();
        await setSearch(''); out.clearedKeepsFilters = names();
        return out`));
      eq(r, { milk: ['Beta milk', 'Alpha milk', 'Gamma milk'], incomplete: ['Beta milk', 'Alpha milk'], incompleteHigh: ['Alpha milk'], home: ['Beta milk', 'Gamma milk'], homeDone: ['Gamma milk'],
        homeHigh: ['Gamma milk'], clearedKeepsFilters: ['Gamma milk'] }, 'combined filters');
    } },
    { id: 'c52', name: 'The search text is not saved: after a reload the box is empty and every task shows', run: async () => {
      await fresh();
      await ev(T(`await T.add('Keep'); await T.add('Other'); T.$('search').value = 'keep'; T.$('search').dispatchEvent(new Event('input', { bubbles: true })); await T.wait(300);`));
      eq(await ev(T(`return T.rows().length`)), 1, 'filtered before reload');
      await reload();
      eq(await ev(T(`return [T.$('search').value, T.rows().map(T.titleOf).sort()]`)), ['', ['Keep', 'Other']], 'after reload');
    } },
    { id: 'c53', name: 'The task being edited stays visible when the search would hide it, and the footer counts every task whatever is searched', run: async () => {
      await fresh();
      const r = await ev(T(`await T.add('One'); await T.add('Two');
        const setSearch = async (v) => { T.$('search').value = v; T.$('search').dispatchEvent(new Event('input', { bubbles: true })); await T.wait(300); };
        const out = {};
        await T.click(document.querySelector('button[aria-label="Edit One"]'));
        await setSearch('two'); out.rows = T.rows().map(T.titleOf); out.editOpen = !!T.editRow(); out.footer = T.$('count').textContent;
        return out`));
      eq(r, { rows: ['Two'], editOpen: true, footer: '2 open · 0 done' }, 'edit and footer under search');
    } },
    { id: 'c54', name: 'Stored records with missing or odd titles and tags do not break the search', run: async () => {
      await fresh();
      const r = await ev(T(`await T.raw((s) => s.add({ title: 'Odd', done: false, created: 1, tags: 'work' })); await T.raw((s) => s.add({ title: 'Tagged', done: false, created: 2, tags: [5, null, 'Milk'] }));
        await T.raw((s) => s.add({ done: false, created: 3 })); await window.render();
        const setSearch = async (v) => { T.$('search').value = v; T.$('search').dispatchEvent(new Event('input', { bubbles: true })); await T.wait(300); };
        const out = {};
        await setSearch('milk'); out.milk = T.rows().map(T.titleOf);
        await setSearch('work'); out.work = T.rows().map(T.titleOf);
        out.status = T.$('status').textContent; return out`));
      eq(r, { milk: ['Tagged'], work: [], status: '' }, 'search over odd records');
    } },
    { id: 'c55', name: 'A list read that is overtaken by a newer render never overwrites it (typing while a task is added)', run: async () => {
      await fresh();
      const r = await ev(T(`await T.add('Base a');
        const orig = IDBDatabase.prototype.transaction; let slow = 1;
        IDBDatabase.prototype.transaction = function (store, mode) {
          const t = orig.call(this, store, mode);
          if (slow && mode === 'readonly') { slow--; return new Proxy(t, { set(o, k, v) { o[k] = k === 'oncomplete' ? (e) => setTimeout(() => v(e), 500) : v; return true; }, get(o, k) { const x = o[k]; return typeof x === 'function' ? x.bind(o) : x; } }); }
          return t;
        };
        try {
          T.$('search').value = 'a'; T.$('search').dispatchEvent(new Event('input', { bubbles: true })); // render 1: reads the old list, finishes late
          await T.raw((s) => s.add({ title: 'Zed a', done: false, created: 2 })); await window.render(); // render 2: reads the new list
          await T.wait(900);
        } finally { IDBDatabase.prototype.transaction = orig; }
        return T.rows().map(T.titleOf).sort()`));
      eq(r, ['Base a', 'Zed a'], 'list after a slow, overtaken read');
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
    files_under_test: [{ path: 'todo/index.html', sha256: fileHash(APP) }, { path: 'todo/evals/run.js', sha256: fileHash(__filename) }],
    hash_rule: 'sha256 of the file text with CRLF normalized to LF',
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
    if (RECORD) {
      // Recorded runs are added to the append-only verification log (todo/evals/VERIFICATION-LOG.md).
      require('./log.js').append({
        event: 'eval_run', branch: report.git.branch, commit: report.git.head, dirty: report.git.dirty, ok: report.ok,
        checks: `${passed}/${checks.length}`, mutations: `${mutations.length - mutBad}/${mutations.length}`,
        started_at: report.started_at, finished_at: report.finished_at,
        app_sha256: report.files_under_test[0].sha256, eval_sha256: report.files_under_test[1].sha256,
        report: path.relative(REPO, path.join(dir, `${stamp}.json`)).replace(/\\/g, '/'), launched_from: report.environment.launched_from,
      });
      console.log('Logged to todo/evals/VERIFICATION-LOG.md');
    }
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
