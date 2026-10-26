#!/usr/bin/env node
// Append-only verification log for the todo eval: verification-log.jsonl (the record) and VERIFICATION-LOG.md
// (a generated, human-readable view). run.js --record and verify.js --log append to it, so it updates itself.
//
//   node todo/evals/log.js show                      print the log as markdown
//   node todo/evals/log.js check                     verify the hash chain and that the .md matches the .jsonl
//   node todo/evals/log.js ci [runId]                append the result of a finished GitHub Actions run
//                                                    (default: the latest `eval` run on the current branch)
//   node todo/evals/log.js backfill <report.json> [--note "text"]
//                                                    add an entry for an earlier recorded report, using the
//                                                    report's own timestamps
//
// Every entry has a UTC timestamp `at` and `prev`, the SHA-256 of the previous line. Editing or deleting an
// earlier line breaks the chain, and `check` (also run by verify.js and CI) reports it. The chain cannot stop
// someone rewriting the whole file; git history shows that.
'use strict';
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const FILE = path.join(__dirname, 'verification-log.jsonl');
const MD = path.join(__dirname, 'VERIFICATION-LOG.md');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const git = (...a) => { try { return execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim(); } catch (e) { return ''; } };

function read(file = FILE) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean).map((line) => ({ line, entry: JSON.parse(line) }));
}

function append(entry) {
  const rows = read();
  const prev = rows.length ? sha(rows[rows.length - 1].line) : '';
  const full = { at: new Date().toISOString(), ...entry, prev };
  fs.appendFileSync(FILE, JSON.stringify(full) + '\n');
  fs.writeFileSync(MD, render());
  return full;
}

const short = (s) => (s || '').slice(0, 10);
function describe(e) {
  if (e.event === 'eval_run') return { who: 'eval run', result: e.ok ? 'PASSED' : 'FAILED', detail: `${e.checks} checks, ${e.mutations} deliberate bugs caught; app sha256 \`${short(e.app_sha256)}…\`; [report](${e.report})${e.note ? '; ' + e.note : ''}` };
  if (e.event === 'verify') return { who: 'verify.js', result: e.result, detail: `${e.passed} passed, ${e.warnings} warnings, ${e.failed} failed on [${path.basename(e.report)}](${e.report})${e.note ? '; ' + e.note : ''}` };
  if (e.event === 'ci') return { who: 'CI (GitHub Actions)', result: (e.conclusion || '').toUpperCase(), detail: `${e.workflow} run [${e.run_id}](${e.url}), ${e.trigger}, ${Math.round((Date.parse(e.run_finished_at) - Date.parse(e.run_started_at)) / 1000)} s, for commit \`${short(e.commit)}\`` };
  return { who: e.event, result: '', detail: '' };
}

function render() {
  const rows = read().map((r) => r.entry);
  const last = (ev) => [...rows].reverse().find((e) => e.event === ev);
  const L = [];
  L.push('# Verification log: todo eval', '',
    'Append-only record of every recorded eval run, `verify.js` run and CI result, with UTC timestamps. It is updated by',
    '`run.js --record`, `verify.js --log` and `log.js ci`. This file is generated from `verification-log.jsonl`; do not',
    'edit either by hand. Each entry stores the hash of the previous one, so changing or deleting an earlier entry is',
    'detected by `node todo/evals/log.js check` (also run by `verify.js` and CI).', '');
  L.push('## Current status', '', '| Event | Last at (UTC) | Result | Commit |', '|---|---|---|---|');
  for (const [name, ev] of [['Eval run', 'eval_run'], ['verify.js', 'verify'], ['CI', 'ci']]) {
    const e = last(ev);
    L.push(e ? `| ${name} | ${e.at} | ${describe(e).result} | \`${short(e.commit)}\` |` : `| ${name} | never | | |`);
  }
  L.push('', '## History (oldest first)', '', '| # | Time (UTC) | Event | Result | Branch | Commit | Details |', '|---|---|---|---|---|---|---|');
  rows.forEach((e, i) => { const d = describe(e); L.push(`| ${i + 1} | ${e.at} | ${d.who} | ${d.result} | ${e.branch || ''} | \`${short(e.commit)}\` | ${d.detail.replace(/\|/g, '/')} |`); });
  L.push('', `${rows.length} entries.`, '');
  return L.join('\n');
}

// opts.file checks another file (used by the self-test); opts.skipMd skips the markdown-in-sync test.
function check(opts = {}) {
  const rows = read(opts.file || FILE); const problems = [];
  rows.forEach((r, i) => {
    const want = i === 0 ? '' : sha(rows[i - 1].line);
    if (r.entry.prev !== want) problems.push(`entry ${i + 1} does not chain to entry ${i}: an earlier entry was edited, removed or reordered`);
    if (i > 0 && Date.parse(r.entry.at) < Date.parse(rows[i - 1].entry.at)) problems.push(`entry ${i + 1} is timestamped before entry ${i}`);
    if (!r.entry.at || Number.isNaN(Date.parse(r.entry.at))) problems.push(`entry ${i + 1} has no valid timestamp`);
  });
  const md = fs.existsSync(MD) ? fs.readFileSync(MD, 'utf8').replace(/\r\n/g, '\n') : null;
  if (!opts.skipMd && md !== render()) problems.push('VERIFICATION-LOG.md does not match verification-log.jsonl (regenerate by appending, never edit by hand)');
  return { ok: !problems.length, entries: rows.length, problems };
}

function ghPath() {
  for (const p of ['gh', 'C:/Program Files/GitHub CLI/gh.exe']) { try { execFileSync(p, ['--version'], { stdio: 'ignore' }); return p; } catch (e) {} }
  throw new Error('GitHub CLI (gh) not found');
}

function cli() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'show') { process.stdout.write(render()); return; }
  if (cmd === 'check') {
    const r = check();
    console.log(r.ok ? `LOG OK: ${r.entries} entries, chain intact, markdown in sync` : 'LOG PROBLEMS:\n  ' + r.problems.join('\n  '));
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd === 'backfill') {
    const file = path.resolve(rest[0]); const noteIdx = rest.indexOf('--note');
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    const e = append({
      at: r.finished_at, event: 'eval_run', branch: r.git.branch, commit: r.git.head, dirty: r.git.dirty, ok: r.ok,
      checks: `${r.summary.checks_passed}/${r.summary.checks_total}`, mutations: `${r.summary.mutations_caught}/${r.summary.mutations_total}`,
      started_at: r.started_at, finished_at: r.finished_at,
      app_sha256: r.files_under_test[0].sha256, eval_sha256: r.files_under_test[1].sha256,
      report: path.relative(REPO, file).replace(/\\/g, '/'), launched_from: r.environment.launched_from,
      note: (noteIdx >= 0 ? rest[noteIdx + 1] + '; ' : '') + 'backfilled from the committed report',
    });
    console.log('appended', e.at); return;
  }
  if (cmd === 'ci') {
    const gh = ghPath(); const slug = 'karachiwaladev/contour-jonas-oct-2026-qa-khizer-sardar';
    const fields = 'databaseId,status,conclusion,workflowName,headSha,headBranch,event,createdAt,updatedAt,url';
    const run = rest[0]
      ? JSON.parse(execFileSync(gh, ['run', 'view', rest[0], '--repo', slug, '--json', fields], { encoding: 'utf8' }))
      : JSON.parse(execFileSync(gh, ['run', 'list', '--repo', slug, '--workflow', 'eval', '--branch', git('rev-parse', '--abbrev-ref', 'HEAD'), '--limit', '1', '--json', fields], { encoding: 'utf8' }))[0];
    if (!run) { console.error('no eval run found'); process.exit(2); }
    if (run.status !== 'completed') { console.log(`run ${run.databaseId} is ${run.status}; nothing logged. Try again when it has finished.`); process.exit(3); }
    if (read().some((r) => r.entry.event === 'ci' && r.entry.run_id === run.databaseId)) { console.log(`run ${run.databaseId} is already in the log`); return; }
    const e = append({ event: 'ci', workflow: run.workflowName, run_id: run.databaseId, url: run.url, trigger: run.event, branch: run.headBranch, commit: run.headSha,
      conclusion: run.conclusion, run_started_at: run.createdAt, run_finished_at: run.updatedAt });
    console.log(`appended CI run ${run.databaseId}: ${run.conclusion}`); return;
  }
  console.log('usage: node todo/evals/log.js show | check | ci [runId] | backfill <report.json> [--note "text"]');
  process.exit(2);
}

module.exports = { append, check, render, FILE, MD };
if (require.main === module) cli();
