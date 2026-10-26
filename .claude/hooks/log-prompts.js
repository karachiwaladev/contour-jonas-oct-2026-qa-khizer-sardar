// Stop hook: append user prompts not yet logged for this session to .claude/logs/prompts.jsonl.
// Reads the hook payload (session_id, transcript_path, cwd) from stdin, then walks the transcript
// from where the previous run stopped, so each prompt is written exactly once.
const fs = require('fs');
const path = require('path');

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    run(JSON.parse(raw || '{}'));
  } catch (e) {
    // Never block the session over logging.
  }
});

function promptText(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) return null;
  const content = entry.message && entry.message.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    // Tool results arrive as user entries too; only keep real text the user typed.
    text = content.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n');
  }
  text = text.trim();
  return text || null;
}

function run(input) {
  const { session_id: sessionId, transcript_path: transcript } = input;
  if (!sessionId || !transcript || !fs.existsSync(transcript)) return;

  const root = input.cwd || process.cwd();
  const logDir = path.join(root, '.claude', 'logs');
  const logFile = path.join(logDir, 'prompts.jsonl');
  const stateFile = path.join(logDir, '.prompts-state.json');
  fs.mkdirSync(logDir, { recursive: true });

  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) {}

  const lines = fs.readFileSync(transcript, 'utf8').split('\n').filter(Boolean);
  const start = Math.min(state[sessionId] || 0, lines.length);
  const out = [];
  for (const line of lines.slice(start)) {
    let entry;
    try { entry = JSON.parse(line); } catch (e) { continue; }
    const text = promptText(entry);
    if (text) {
      out.push(JSON.stringify({
        timestamp: entry.timestamp || new Date().toISOString(),
        session_id: sessionId,
        prompt: text,
      }));
    }
  }
  if (out.length) fs.appendFileSync(logFile, out.join('\n') + '\n');
  state[sessionId] = lines.length;
  fs.writeFileSync(stateFile, JSON.stringify(state));
}
