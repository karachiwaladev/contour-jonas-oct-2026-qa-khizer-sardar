#!/usr/bin/env node
// PreToolUse guard for the factory. Blocks, before they run:
//   1. recursive + forced deletes   (rm -rf and its spellings, git rm -rf, Remove-Item -Recurse -Force, rd /s /q, del /s /q)
//   2. forced pushes                (git push --force / -f / --force-with-lease / --mirror / +refspec)
//   3. downloading and running code (curl|sh, wget|bash, iwr|iex, bash <(curl ...), sh -c "$(curl ...)")
//   4. reading .env files           (Read/Grep on .env, .env.*, *.env; cat/type/Get-Content/grep... on them; < .env; @.env)
// It reads the PreToolUse payload from stdin and answers with a permission decision. Any internal error blocks the
// call (fail closed); the hook entry in settings.json also sets onFailure: "block" in case Node itself is missing.
// Every block is appended to .claude/logs/guard.jsonl (gitignored). Limits are listed in .claude/hooks/README.md:
// this is a seatbelt against mistakes and injected instructions, not a sandbox.
'use strict';
const fs = require('fs');
const path = require('path');

// ---------- small shell-aware tokenizer ----------
// Splits a command line into segments at unquoted ; & && || | newline ( ) { } and backticks, respects quotes, and
// removes heredoc / here-string bodies first so text inside them is never mistaken for a command.
function stripHeredocs(text) {
  return text
    .replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '\n') // bash heredoc
    .replace(/@(['"])[ \t]*\r?\n[\s\S]*?\r?\n\1@/g, '""');                                      // PowerShell here-string
}

function tokenize(input) {
  const text = stripHeredocs(input.replace(/\\\r?\n/g, ' '));
  const segments = []; // { op, tokens }
  let cur = [], tok = '', inTok = false, op = '', q = null, skeleton = '';
  const endTok = () => { if (inTok) { cur.push(tok); tok = ''; inTok = false; } };
  const endSeg = (nextOp) => { endTok(); if (cur.length) segments.push({ op, tokens: cur }); cur = []; op = nextOp; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (q) {
      if (c === q) { q = null; skeleton += c; continue; }
      if (q === '"' && c === '\\' && (n === '"' || n === '\\')) { tok += n; i++; continue; }
      tok += c; continue;
    }
    if (c === '"' || c === "'") { q = c; inTok = true; skeleton += c; continue; }
    if (c === ';' || c === '\n' || c === '\r') { skeleton += ' '; endSeg(';'); continue; }
    if (c === '&' && n === '&') { skeleton += ' && '; endSeg('&&'); i++; continue; }
    if (c === '|' && n === '|') { skeleton += ' || '; endSeg('||'); i++; continue; }
    if (c === '|') { skeleton += ' | '; endSeg('|'); continue; }
    if (c === '&') { skeleton += ' & '; endSeg('&'); continue; }
    if (c === '(' || c === ')' || c === '{' || c === '}' || c === '`') { skeleton += c === '(' ? ' ( ' : c === ')' ? ' ) ' : ' '; endSeg(c); continue; }
    if (/\s/.test(c)) { skeleton += ' '; endTok(); continue; }
    tok += c; inTok = true; skeleton += c;
  }
  endSeg('');
  return { segments, skeleton };
}

const base = (t) => (t || '').replace(/^\\/, '').replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.exe$/, '');
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'exec', 'nohup', 'time', 'nice', 'stdbuf', 'xargs', 'builtin', 'setsid']);
const WRAPPER_OPT_ARG = { sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U']), xargs: new Set(['-I', '-n', '-P', '-d', '-L', '-s', '-E', '-a']), nice: new Set(['-n']) };

// First real command of a segment: skips VAR=value, wrappers (sudo, env, xargs...) and their options.
function commandOf(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z_]\w*=/.test(t)) { i++; continue; }
    const b = base(t);
    if (WRAPPERS.has(b)) {
      i++;
      while (i < tokens.length && tokens[i].startsWith('-')) i += (WRAPPER_OPT_ARG[b] && WRAPPER_OPT_ARG[b].has(tokens[i])) ? 2 : 1;
      continue;
    }
    break;
  }
  return { word: base(tokens[i]), args: tokens.slice(i + 1) };
}

// ---------- rules ----------
// Recursive AND forced, in any spelling: -rf, -fr, -r -f, --recursive --force, PowerShell -Recurse -Force (and
// their prefixes), cmd /s /q. A force flag alone or a recursive flag alone is allowed.
function recursiveForce(args) {
  let rec = false, force = false;
  for (const a of args) {
    if (a === '--recursive') rec = true;
    else if (a === '--force') force = true;
    else if (/^-(re|rec|recu|recur|recurs|recurse)$/i.test(a)) rec = true;
    else if (/^-(fo|for|forc|force)$/i.test(a)) force = true;
    else if (/^-[A-Za-z]+$/.test(a)) { if (/[rR]/.test(a)) rec = true; if (/f/.test(a)) force = true; }
    else if (/^\/s$/i.test(a)) rec = true;
    else if (/^\/[qf]$/i.test(a)) force = true;
  }
  return rec && force;
}

const RM_WORDS = new Set(['rm', 'remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir']);
function checkRm(word, args) {
  if (RM_WORDS.has(word) && recursiveForce(args)) return 'recursive forced delete (rm -rf and equivalents)';
  if (word === 'find') { // find ... -exec rm -rf {} +
    const i = args.findIndex((a) => ['-exec', '-execdir', '-ok'].includes(a));
    if (i >= 0) { const inner = commandOf(args.slice(i + 1)); if (RM_WORDS.has(inner.word) && recursiveForce(inner.args)) return 'recursive forced delete (find -exec rm -rf)'; }
  }
  return null;
}

function checkGit(word, args) {
  if (word !== 'git') return null;
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(args[i]) ? 2 : 1;
  const sub = args[i], rest = args.slice(i + 1);
  if (sub === 'push') {
    for (const a of rest) {
      if (a === '--force' || a === '-f' || a === '--force-if-includes' || a === '--mirror' || a.startsWith('--force-with-lease')) return 'forced git push (--force, -f, --force-with-lease, --mirror)';
      if (/^-[A-Za-z]+$/.test(a) && a.includes('f')) return 'forced git push (-f in a flag cluster)';
      if (/^\+\S/.test(a)) return 'forced git push (+refspec)';
      if (a === '--delete' || /^-[A-Za-z]*d[A-Za-z]*$/.test(a)) return 'git push --delete (removes a remote branch or tag)';
      if (/^:\S/.test(a)) return 'git push with an empty source (:branch deletes the remote branch)';
    }
  }
  if (sub === 'rm' && recursiveForce(rest)) return 'git rm -rf';
  if (sub === 'reset' && rest.includes('--hard')) return 'git reset --hard (discards uncommitted work)';
  if (sub === 'clean') {
    // -n / --dry-run only previews what would be removed, so it stays allowed even next to -f.
    const dry = rest.some((a) => a === '--dry-run' || (/^-[A-Za-z]+$/.test(a) && a.includes('n')));
    const force = rest.some((a) => a === '--force' || (/^-[A-Za-z]+$/.test(a) && a.includes('f')));
    if (force && !dry) return 'git clean -f (deletes untracked files)';
  }
  return null;
}

const FETCHERS = new Set(['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod', 'aria2c', 'fetch']);
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'python', 'python3', 'node', 'perl', 'ruby', 'php', 'iex', 'invoke-expression', 'pwsh', 'powershell', 'cmd']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd']);

function checkRemoteCode(segments, skeleton) {
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].op !== '|') continue;
    const prev = commandOf(segments[i - 1].tokens), cur = commandOf(segments[i].tokens);
    if (FETCHERS.has(prev.word) && INTERPRETERS.has(cur.word)) return `downloading and running code (${prev.word} | ${cur.word})`;
  }
  if (/\b(iex|invoke-expression)\b[\s\S]{0,200}?\b(iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|curl|wget)\b/i.test(skeleton) ||
      /\b(iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|curl|wget)\b[\s\S]{0,300}?\|\s*(iex|invoke-expression)\b/i.test(skeleton)) return 'downloading and running code (iex with a download)';
  // (the tokenizer pads parentheses with spaces, so "<(curl" appears as "< ( curl" in the skeleton)
  if (/(\b(sh|bash|zsh|dash|ksh|source|eval)\b|(^|\s)\.)\s[^\n;|&]*<\s*\(\s*(curl|wget)/i.test(skeleton)) return 'downloading and running code (process substitution of curl/wget)';
  return null;
}

const ENV_NAME = (b) => /^\.env($|\.|[*?\[])/i.test(b) || /\.env$/i.test(b) || /^\*+\.env/i.test(b);
const envToken = (t) => ENV_NAME(base(t.replace(/^[<@:]+/, '').replace(/^.*?:(?=\.env)/, '')));
const READERS = new Set(['cat', 'type', 'more', 'less', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'gawk', 'cut', 'sort', 'uniq', 'tee', 'xxd', 'od', 'hexdump', 'strings', 'base64', 'nl', 'bat',
  'source', '.', 'cp', 'copy', 'xcopy', 'scp', 'rsync', 'get-content', 'gc', 'select-string', 'sls', 'findstr', 'python', 'python3', 'node', 'curl', 'wget']);
const GIT_READ_SUBS = new Set(['show', 'diff', 'log', 'blame', 'cat-file', 'grep']);

function checkEnvRead(word, args, tokens) {
  const hit = args.some(envToken);
  if (!hit) return null;
  if (READERS.has(word)) return 'reading a .env file';
  if (word === 'git' && args.some((a) => GIT_READ_SUBS.has(a))) return 'reading a .env file through git';
  if (tokens.some((t, i) => /^(\d?<|<<<)$/.test(t) && tokens[i + 1] && envToken(tokens[i + 1]))) return 'reading a .env file (< redirect)';
  if (tokens.some((t) => /^(\d?<|<<<)/.test(t) && envToken(t))) return 'reading a .env file (< redirect)';
  if (args.some((a) => a.startsWith('@') && envToken(a))) return 'sending a .env file (@file)';
  return null;
}

// ---------- analysis ----------
function analyze(command, depth = 0) {
  if (depth > 3) return null;
  const { segments, skeleton } = tokenize(command);
  const remote = checkRemoteCode(segments, skeleton);
  if (remote) return remote;
  for (const seg of segments) {
    const { word, args } = commandOf(seg.tokens);
    const hit = checkRm(word, args) || checkGit(word, args) || checkEnvRead(word, args, seg.tokens);
    if (hit) return hit;
    // bash -c "...", pwsh -Command "...", cmd /c "...", eval "...": look inside the script string.
    const flag = SHELLS.has(word) ? args.findIndex((a) => /^(-c|-command|\/c)$/i.test(a)) : -1;
    if (flag >= 0 && args[flag + 1] !== undefined) {
      const script = args.slice(flag + 1).join(' ');
      if (/^\s*(\$\(|`)\s*(curl|wget|iwr|irm)\b/i.test(script)) return 'downloading and running code (sh -c "$(curl ...)")';
      const inner = analyze(script, depth + 1);
      if (inner) return inner;
    }
    if (word === 'eval' && args.length) {
      const script = args.join(' ');
      if (/^\s*(\$\(|`)\s*(curl|wget|iwr|irm)\b/i.test(script)) return 'downloading and running code (eval "$(curl ...)")';
      const inner = analyze(script, depth + 1);
      if (inner) return inner;
    }
  }
  return null;
}

function decide(payload) {
  const tool = payload.tool_name, input = payload.tool_input || {};
  if (tool === 'Bash' || tool === 'PowerShell') return analyze(String(input.command || ''));
  if (tool === 'Read') return ENV_NAME(base(String(input.file_path || ''))) ? 'reading a .env file' : null;
  if (tool === 'Grep') {
    if (ENV_NAME(base(String(input.path || ''))) || ENV_NAME(base(String(input.glob || '')))) return 'searching a .env file';
  }
  return null;
}

function log(entry) {
  try {
    const dir = path.join(process.cwd(), '.claude', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'guard.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) { /* logging must never change the decision */ }
}

function deny(reason, payload) {
  const input = (payload && payload.tool_input) || {};
  log({ tool: payload && payload.tool_name, reason, input: String(input.command || input.file_path || input.path || input.glob || '').slice(0, 200) });
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: `Blocked by the factory guard: ${reason}. If this is really needed, ask the user to run it themselves.` } }));
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(raw);
    const reason = decide(payload);
    if (reason) deny(reason, payload);
  } catch (e) {
    deny('the guard could not read this call (' + String(e.message).slice(0, 80) + '), so it was refused to be safe', payload);
  }
});
