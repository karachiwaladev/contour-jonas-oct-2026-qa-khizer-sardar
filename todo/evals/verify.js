#!/usr/bin/env node
// Independent verifier for an eval report. It does not trust the report: every claim in it is re-derived.
//
//   node todo/evals/verify.js                       verify the newest report in todo/evals/results/
//   node todo/evals/verify.js <report.json>         verify a specific report
//   node todo/evals/verify.js --against <other.json> also require the same verdicts as another report
//                                                    (used to compare a committed report with a fresh run)
//
// Exit code 0 only if every verification passes. Warnings (for example the commit is not in history because the
// PR was squash-merged) do not fail the run but are printed. Needs only Node and git; it does not run a browser.
'use strict';
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const againstIdx = args.indexOf('--against');
const against = againstIdx >= 0 ? args[againstIdx + 1] : null;
const positional = args.filter((a, i) => !a.startsWith('--') && i !== againstIdx + 1);

const fileHash = (buf) => crypto.createHash('sha256').update(Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'))).digest('hex');
const git = (...a) => execFileSync('git', a, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });

const results = [];
const check = (name, status, detail) => { results.push({ name, status, detail }); console.log(`${status.padEnd(4)} ${name}${detail ? '\n       ' + detail : ''}`); };
const pass = (n, d) => check(n, 'PASS', d); const fail = (n, d) => check(n, 'FAIL', d); const warn = (n, d) => check(n, 'WARN', d);

function newestReport() {
  const dir = path.join(__dirname, 'results');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  if (!files.length) throw new Error('no reports in ' + dir);
  return path.join(dir, files[files.length - 1]);
}

function verdicts(r) {
  return {
    checks: Object.fromEntries(r.checks.map((c) => [c.id, { status: c.status, evidence: c.status === 'pass' ? c.evidence : null }])),
    mutations: Object.fromEntries(r.mutations.map((m) => [m.id, m.status])),
  };
}

function main() {
  const file = positional[0] ? path.resolve(positional[0]) : newestReport();
  console.log(`Verifying ${path.relative(REPO, file)}\n`);
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));

  r.schema === 1 ? pass('report schema is 1') : fail('report schema is 1', 'got ' + r.schema);

  // Recount everything the report claims about itself.
  const passed = r.checks.filter((c) => c.status === 'pass').length;
  const caught = r.mutations.filter((m) => m.status === 'caught').length;
  const consistent = r.summary.checks_total === r.checks.length && r.summary.checks_passed === passed &&
    r.summary.checks_failed === r.checks.length - passed && r.summary.mutations_total === r.mutations.length && r.summary.mutations_caught === caught;
  consistent ? pass('summary counts match the individual results', `${passed}/${r.checks.length} checks, ${caught}/${r.mutations.length} mutations`)
    : fail('summary counts match the individual results', 'the summary disagrees with the per-check data');
  const expectOk = passed === r.checks.length && caught === r.mutations.length && r.checks.length > 0;
  r.ok === expectOk ? pass(`"ok" flag is consistent (${r.ok})`) : fail('"ok" flag is consistent', `report says ${r.ok}, recount says ${expectOk}`);
  r.ok === true ? pass('the report says the eval passed') : fail('the report says the eval passed', 'ok is not true');

  // Nothing was quietly removed: the report must contain every check and mutation that run.js defines today.
  const runSrc = fs.readFileSync(path.join(__dirname, 'run.js'), 'utf8');
  const defChecks = [...runSrc.matchAll(/\{ id: '(c\d+)', name:/g)].map((m) => m[1]);
  const defMuts = [...runSrc.matchAll(/\{ id: '(m\d+-[a-z-]+)', check:/g)].map((m) => m[1]);
  const missingC = defChecks.filter((id) => !r.checks.some((c) => c.id === id));
  const missingM = defMuts.filter((id) => !r.mutations.some((m) => m.id === id));
  !missingC.length && !missingM.length ? pass('every check and mutation defined in run.js is in the report', `${defChecks.length} checks, ${defMuts.length} mutations`)
    : fail('every check and mutation defined in run.js is in the report', `missing: ${[...missingC, ...missingM].join(', ')}`);

  // The code the report is about.
  for (const f of r.files_under_test) {
    const p = path.join(REPO, f.path);
    const now = fs.existsSync(p) ? fileHash(fs.readFileSync(p)) : null;
    now === f.sha256 ? pass(`${f.path} on disk hashes to the recorded value`, f.sha256.slice(0, 16) + '...')
      : fail(`${f.path} on disk hashes to the recorded value`, `recorded ${f.sha256.slice(0, 16)}..., now ${now ? now.slice(0, 16) + '...' : 'file missing'}: the report is stale, re-run the eval`);
    // Prove the recorded code really is what was committed at the recorded commit.
    try {
      const blob = git('show', `${r.git.head}:${f.path}`);
      fileHash(blob) === f.sha256 ? pass(`${f.path} at commit ${r.git.head.slice(0, 10)} hashes to the recorded value`)
        : fail(`${f.path} at commit ${r.git.head.slice(0, 10)} hashes to the recorded value`, 'the recorded commit holds different code than the report claims');
    } catch (e) {
      warn(`${f.path} at the recorded commit could not be read`, 'the commit is not in this clone (squash or rebase merge, or shallow clone); the on-disk hash above still applies');
    }
  }
  r.git.dirty === false ? pass('the run was made from committed code (no uncommitted changes under todo/)') : fail('the run was made from committed code', 'git.dirty was true');

  // Time sanity.
  const s = Date.parse(r.started_at), e = Date.parse(r.finished_at);
  s <= e && e <= Date.now() + 60000 && Math.abs((e - s) - r.duration_ms) < 1000
    ? pass('timestamps are ordered and not in the future', `${r.started_at} to ${r.finished_at}`) : fail('timestamps are ordered and not in the future');

  // Only local traffic.
  const foreign = r.network_requests.filter((u) => !/^http:\/\/127\.0\.0\.1:/.test(u) && !/^(about|data):/.test(u));
  !foreign.length ? pass('no network request left the machine', `${r.network_requests.length} requests, all local`) : fail('no network request left the machine', foreign.slice(0, 3).join(', '));

  // Same verdicts as another run (determinism).
  if (against) {
    const o = JSON.parse(fs.readFileSync(path.resolve(against), 'utf8'));
    const a = JSON.stringify(verdicts(r)), b = JSON.stringify(verdicts(o));
    a === b ? pass('verdicts are identical to the other report', `same status for all ${r.checks.length} checks and ${r.mutations.length} mutations, same evidence on passes`)
      : fail('verdicts are identical to the other report', diff(verdicts(r), verdicts(o)));
  }

  const bad = results.filter((x) => x.status === 'FAIL').length;
  console.log(`\n${bad ? 'VERIFICATION FAILED' : 'VERIFIED'}: ${results.filter((x) => x.status === 'PASS').length} passed, ${results.filter((x) => x.status === 'WARN').length} warnings, ${bad} failed`);
  process.exit(bad ? 1 : 0);
}

function diff(a, b) {
  const out = [];
  for (const k of ['checks', 'mutations']) for (const id of new Set([...Object.keys(a[k]), ...Object.keys(b[k])])) {
    if (JSON.stringify(a[k][id]) !== JSON.stringify(b[k][id])) out.push(`${id}: ${JSON.stringify(a[k][id])} vs ${JSON.stringify(b[k][id])}`);
  }
  return out.slice(0, 5).join('; ');
}

try { main(); } catch (e) { console.error('VERIFY ERROR:', e.message); process.exit(2); }
