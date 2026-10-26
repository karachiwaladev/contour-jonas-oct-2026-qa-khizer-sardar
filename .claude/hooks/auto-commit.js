// Stop hook: commit whatever changed during the turn and push it to the current branch.
// Work goes through pull requests, so this hook never pushes to main or master: if the repo is sitting on
// main with changes, it first moves them onto a new auto/<timestamp> branch (nothing is lost or rewritten).
// Non-destructive by design: plain `git add`, `git commit` and a normal (never forced) push.
// Respects .gitignore, so .claude/logs/ and other ignored files are never committed.
// Failures are written to .claude/logs/auto-commit.log and never block the session.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let cwd = process.cwd();
  try { cwd = JSON.parse(raw || '{}').cwd || cwd; } catch (e) {}
  try {
    run(cwd);
  } catch (e) {
    try {
      const dir = path.join(cwd, '.claude', 'logs');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'auto-commit.log'),
        `${new Date().toISOString()} ${String(e.stderr || e.message).trim()}\n`);
    } catch (e2) {}
  }
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function run(cwd) {
  if (!git(cwd, 'status', '--porcelain').trim()) return; // nothing changed this turn
  let branch = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  if (branch === 'HEAD') throw new Error('detached HEAD: not committing'); // no branch to push to

  if (branch === 'main' || branch === 'master') {
    const p = (n) => String(n).padStart(2, '0');
    const d = new Date();
    branch = `auto/${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    git(cwd, 'switch', '-c', branch); // carries the working-tree changes along
  }

  git(cwd, 'add', '-A');
  const files = git(cwd, 'diff', '--cached', '--name-only').trim().split('\n').filter(Boolean);
  if (!files.length) return;
  const shown = files.slice(0, 5).join(', ') + (files.length > 5 ? `, +${files.length - 5} more` : '');
  const message = `Auto-commit: ${shown}\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`;
  git(cwd, 'commit', '-m', message);
  git(cwd, 'push', '-u', 'origin', branch);
}
