#!/usr/bin/env node
// Checks the checker: takes the newest recorded report, doctors copies of it in four ways that verify.js must
// reject (a hidden failure, a deleted check, a wrong code hash, a missed mutation), and confirms the untouched
// report is accepted. Run it with: node todo/evals/verify.selftest.js
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = path.join(__dirname, 'results');
const newest = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().pop();
const base = JSON.parse(fs.readFileSync(path.join(dir, newest), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-selftest-'));
const clone = () => JSON.parse(JSON.stringify(base));

const cases = [
  { name: 'untouched report is accepted', expect: 0, make: () => clone() },
  { name: 'a failing check hidden behind an unchanged summary', expect: 1, make: () => { const r = clone(); r.checks[r.checks.length - 2].status = 'fail'; return r; } },
  { name: 'a check deleted and the summary rewritten to match', expect: 1, make: () => { const r = clone(); r.checks.pop(); r.summary.checks_total--; r.summary.checks_passed--; return r; } },
  { name: 'a wrong hash for the app file', expect: 1, make: () => { const r = clone(); r.files_under_test[0].sha256 = '0'.repeat(64); return r; } },
  { name: 'a mutation marked missed but the summary left as caught', expect: 1, make: () => { const r = clone(); r.mutations[0].status = 'MISSED'; return r; } },
  { name: 'a request to an outside host recorded', expect: 1, make: () => { const r = clone(); r.network_requests.push('https://example.com/x'); return r; } },
];

let bad = 0;
cases.forEach((c, i) => {
  const f = path.join(tmp, `case${i}.json`);
  fs.writeFileSync(f, JSON.stringify(c.make()));
  const code = spawnSync(process.execPath, [path.join(__dirname, 'verify.js'), f], { encoding: 'utf8' }).status;
  const ok = code === c.expect;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name} (verify.js exit ${code}, wanted ${c.expect})`);
});
console.log(bad ? `\nSELF-TEST FAILED: ${bad} case(s)` : `\nSELF-TEST PASSED: verify.js accepts the real report and rejects ${cases.length - 1} kinds of doctoring`);
process.exit(bad ? 1 : 0);
