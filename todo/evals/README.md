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

## Three ways to check it without trusting the author
1. **Re-run it.** `node todo/evals/run.js` on your own machine.
2. **Verify a recorded report.** `node todo/evals/verify.js` re-derives every claim in the newest report in
   `results/` and prints one line per verification: the summary counts and `ok` flag match the per-check data,
   every check and mutation that `run.js` defines is in the report (so nothing was quietly removed), the app
   and `run.js` on disk hash to the recorded values, those same hashes are what is stored in git at the
   recorded commit, the run was made from committed code, timestamps make sense, and no request left the
   machine. It exits 0 only if all pass, and tells you when a report is stale.
   `node todo/evals/verify.selftest.js` checks the checker: it doctors copies of the report five ways (a hidden
   failure, a deleted check, a wrong hash, a missed mutation, an outside request) and requires `verify.js` to
   reject each one and accept the real report.
3. **CI.** `.github/workflows/eval.yml` runs the eval on a clean GitHub runner for every pull request and on
   `main`, then runs `verify.js` on the committed report and on `verify.js --against <fresh report>`, which
   requires the fresh run to reach the same verdicts. The green check on the PR comes from GitHub, not from the
   machine that wrote the code. The workflow's actions are pinned to commit SHAs.

## The verification log
`VERIFICATION-LOG.md` is a running record, with UTC timestamps, of every recorded eval run, every `verify.js`
run and every CI result, plus a "current status" table at the top. It is generated from
`verification-log.jsonl`, and it updates itself:

| Command | Adds an entry for |
|---|---|
| `node todo/evals/run.js --record` | the recorded eval run (counts, commit, hashes, report path) |
| `node todo/evals/verify.js --log` | the verification of that report (passed, warnings, failed) |
| `node todo/evals/log.js ci [runId]` | a finished GitHub Actions run (conclusion, link, duration, commit) |

Each entry stores the SHA-256 of the previous one, so editing, deleting or reordering an earlier entry is
detected by `node todo/evals/log.js check` (also run by `verify.js` and CI, and covered by the self-test). Do
not edit the files by hand. The chain cannot stop someone rewriting the whole file; git history shows that. The
first three entries were backfilled from reports and a CI run that existed before the log, and say so. Runs that
were not recorded (plain `run.js` runs, which write to the temp folder) are not logged.

## What is deterministic
The verdicts: which checks pass or fail and which mutations are caught. Dates in the checks are relative to
today (or fixed), and waits are generous, so the same code gives the same verdicts on any day, on Windows and on
Linux. These fields differ on every run and are not compared: timestamps, durations, ports, the Chrome and Node
versions, and the commit. `verify.js --against` compares only the verdicts (each check's status, the evidence
returned by passing checks such as the contrast ratios, and each mutation's outcome).

## Line endings
Hashes are taken over the file text with CRLF normalized to LF, because git on Windows may check files out with
CRLF while the repository stores LF.

## What it checks
55 checks (`c01` to `c55` in `run.js`) cover adding, filters, search (title and tag, case, literal text, combined filters, not saved, overtaken reads), tags, due dates, priority (default, ordering, the
priority filter and combinations), editing (every field, keyboard Enter and Escape, validation, a kept draft, no
stale overwrite, a task deleted elsewhere, a filter hiding the edited task), recurring tasks (including the last
supported date and an edited next occurrence), the task count footer (counts under filters and recurring ticks,
empty when there are no tasks, malformed records, a failed read, screen-reader structure, no repeated
announcements), persistence, malformed and old-format data (including a title that cannot be converted to text),
XSS, keyboard use and focus, accessible names, phone width (including with the edit form open), failed saves, WCAG
AA colour contrast in light and dark, and that the page makes no outside network requests. The 39 deliberate bugs
cover each area, including each defect that an independent security review has found.

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
