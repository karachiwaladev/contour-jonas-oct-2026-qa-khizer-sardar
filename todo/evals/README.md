# Eval for the todo app

A re-runnable check of the app's behaviour. It starts the page on a local web server, drives it in headless
Chrome or Edge over the DevTools protocol (real key events and clicks where it matters) and writes a timestamped
report. It exists so that "the work was verified" is something a reviewer can check, not something to take on
trust.

```bash
node todo/evals/run.js            # run everything; report goes to the OS temp folder
node todo/evals/run.js --record   # also write the report to todo/evals/results/ (commit this one)
node todo/evals/run.js --only c12 # run one check while developing
```

Needs Node 22+ and Chrome or Edge (`CHROME_PATH` overrides detection). The exit code is 0 only if every check
passes and every deliberate bug is caught.

## What it checks
24 checks (`c01` to `c24` in `run.js`) cover adding, filters, tags, due dates, recurring tasks, persistence,
malformed and old-format data, XSS, keyboard use and focus, accessible names, phone width, failed saves,
WCAG AA colour contrast in light and dark, and that the page makes no outside network requests.

## How you know the checks can fail
The eval also runs a **mutation self-check**: it serves copies of the app with a deliberate bug (for example
`textContent` swapped for `innerHTML`) and requires the matching check to fail. A check that cannot detect its own
bug is reported as `MISSED` and fails the eval. If you change the app code that a mutation edits, update the
mutation in `run.js`; the eval says so loudly instead of passing quietly.

## The report (`results/<UTC timestamp>.json` and `.md`)
`schema` 1. Fields: `started_at`/`finished_at` (UTC), `git` (branch, commit, uncommitted changes under `todo/`),
`files_under_test` (SHA-256 of `todo/index.html` and of `run.js`), `environment` (browser, Node, platform),
`summary`, every check with `status`, `duration_ms`, `evidence` and any `console_errors`, every mutation with its
outcome, and every network request made.

To confirm a report applies to the code you are about to merge, hash the file and compare:

```bash
node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('todo/index.html')).digest('hex'))"
```

If the hash differs, the report is stale: re-run the eval.

## What a report cannot prove
It cannot prove who wrote the checks or who ran them; the `launched_from` field is only a hint. Authorship is
shown by the git history (commit trailers) and by the Claude Code session transcript
(`~/.claude/projects/<project>/<session>.jsonl`), which records every tool call and result with timestamps.
The reliable check is to run the eval yourself.
