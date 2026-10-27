#!/usr/bin/env node
// Applies the numbered retro edits from retro/edits.js, and refuses any selection that would make SKILL.md longer
// than it was when the retro was written (BASE in edits.js).
//
//   node retro/apply-edits.js --list        show every edit: files, size change, and whether its text still matches
//   node retro/apply-edits.js 1 4 7         apply edits 1, 4 and 7 (in numeric order); writes nothing if any check fails
//   node retro/apply-edits.js --dry-run 1 4 apply in memory and report the resulting size, without writing
//
// Line endings are preserved (the repo is stored with LF; on Windows with autocrlf the working copy may be CRLF).
'use strict';
const fs = require('fs');
const path = require('path');
const { BASE, S, EDITS } = require('./edits.js');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const LIST = args.includes('--list');
const DRY = args.includes('--dry-run');
const picks = args.filter((a) => /^\d+$/.test(a)).map(Number);

const read = (f) => { const raw = fs.readFileSync(path.join(ROOT, f), 'utf8'); return { crlf: raw.includes('\r\n'), text: raw.replace(/\r\n/g, '\n') }; };
const size = (t) => ({ lines: t.split('\n').length - (t.endsWith('\n') ? 1 : 0), bytes: Buffer.byteLength(t, 'utf8') });
const count = (hay, needle) => (needle === '' ? 0 : hay.split(needle).length - 1);

// Apply a set of edits to in-memory copies of the files. Returns { files, problems }.
function apply(numbers) {
  const files = {}; const problems = [];
  for (const n of numbers) {
    const edit = EDITS.find((e) => e.n === n);
    if (!edit) { problems.push(`edit ${n} does not exist`); continue; }
    for (const h of edit.hunks) {
      files[h.file] = files[h.file] || read(h.file);
      const c = count(files[h.file].text, h.old);
      if (c !== 1) { problems.push(`edit ${n}: the text to replace in ${h.file} matches ${c} times (needs exactly 1): "${h.old.slice(0, 70).replace(/\n/g, '\\n')}..."`); continue; }
      files[h.file].text = files[h.file].text.replace(h.old, () => h.new);
    }
  }
  return { files, problems };
}

function delta(numbers) {
  const before = {}; const { files, problems } = apply(numbers);
  for (const f of Object.keys(files)) before[f] = size(read(f).text);
  const out = {};
  for (const f of Object.keys(files)) { const a = before[f], b = size(files[f].text); out[f] = { lines: b.lines - a.lines, bytes: b.bytes - a.bytes }; }
  return { out, problems, files };
}

if (LIST || !picks.length) {
  const skill = size(read(S).text);
  console.log(`SKILL.md now: ${skill.lines} lines, ${skill.bytes} bytes (retro baseline ${BASE.lines} lines, ${BASE.bytes} bytes)${skill.lines === BASE.lines && skill.bytes === BASE.bytes ? '' : '  <-- differs from the baseline: re-check before applying'}\n`);
  console.log('edit | SKILL.md lines/bytes | CLAUDE.md lines/bytes | matches | cause');
  let allOk = true;
  for (const e of EDITS) {
    const { out, problems } = delta([e.n]);
    const s = out[S] || { lines: 0, bytes: 0 }, c = out['CLAUDE.md'] || { lines: 0, bytes: 0 };
    const ok = !problems.length && s.lines <= 0 && s.bytes <= 0;
    if (!ok) allOk = false;
    console.log(`${String(e.n).padStart(4)} | ${String(s.lines).padStart(3)} / ${String(s.bytes).padStart(5)} | ${String(c.lines).padStart(3)} / ${String(c.bytes).padStart(5)} | ${problems.length ? 'NO MATCH' : 'yes'}${s.lines <= 0 && s.bytes <= 0 ? '' : ' GROWS SKILL.md'} | ${e.cause}`);
    for (const p of problems) console.log('       ' + p);
  }
  const all = delta(EDITS.map((e) => e.n));
  console.log(`\nAll 13 together: SKILL.md ${all.out[S].lines} lines / ${all.out[S].bytes} bytes; CLAUDE.md ${(all.out['CLAUDE.md'] || {}).lines} lines / ${(all.out['CLAUDE.md'] || {}).bytes} bytes${all.problems.length ? ' (PROBLEMS: ' + all.problems.length + ')' : ''}`);
  process.exit(allOk && !all.problems.length ? 0 : 1);
}

const { files, problems } = apply([...new Set(picks)].sort((a, b) => a - b));
const after = size(files[S] ? files[S].text : read(S).text);
if (after.lines > BASE.lines || after.bytes > BASE.bytes) problems.push(`SKILL.md would be ${after.lines} lines / ${after.bytes} bytes, longer than the baseline ${BASE.lines} / ${BASE.bytes}`);
if (problems.length) { console.error('NOT APPLIED:\n  ' + problems.join('\n  ')); process.exit(1); }
for (const [f, v] of Object.entries(files)) {
  console.log(`${DRY ? 'would write' : 'writing'} ${f}`);
  if (!DRY) fs.writeFileSync(path.join(ROOT, f), v.crlf ? v.text.replace(/\n/g, '\r\n') : v.text);
}
console.log(`${DRY ? 'DRY RUN OK' : 'APPLIED'}: edits ${[...new Set(picks)].sort((a, b) => a - b).join(', ')}. SKILL.md is ${after.lines} lines / ${after.bytes} bytes (baseline ${BASE.lines} / ${BASE.bytes}).`);
