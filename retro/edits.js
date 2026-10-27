// The 13 proposed edits from retro/2026-10-27.md, as exact old -> new text. Nothing here is applied until the user picks.
// Each edit is one cause and one minimal change; where an edit adds text to SKILL.md it also trims redundant text in
// SKILL.md, so every edit is length-neutral or shorter on its own (apply-edits.js enforces this for any selection).
// Hunks must match exactly once; apply-edits.js --list checks that.
'use strict';

// SKILL.md as it was when the retro was written (LF line endings). The user's rule: it must not get longer.
const BASE = { lines: 93, bytes: 17513 };
const S = '.claude/skills/factory-loop/SKILL.md';
const C = 'CLAUDE.md';

const EDITS = [
  { n: 1, cause: 'C1 The skill was not loaded as a skill, so 45 loop ticks ran from memory', hunks: [
    { file: S,
      old: "Read `CLAUDE.md` first. It is the index: it says where each project lives and how this repo is organised. Open deeper files only when the ticket needs them.",
      new: "Not loaded as a skill (`Unknown skill: factory-loop`)? Read this file in full before acting; never run the loop from memory. Then read `CLAUDE.md`, the index; open deeper files only when needed." },
    { file: S,
      old: "When something in a run is awkward (a missing PATH entry, an ambiguous ticket, a step you had to re-explain), fold the fix into this file and open a PR for it.",
      new: "When something in a run is awkward, fold the fix into this file and open a PR for it." },
  ] },
  { n: 2, cause: 'C2 State was reported from memory, not from the live repo (PR #15 called open after it was merged)', hunks: [
    { file: S, old: "Never force-push.", new: "Never force-push or push to a merged PR's branch; open a new PR." },
    { file: S,
      old: "**Ask the user to review and merge.** Report the PR and comment URLs,",
      new: "**Ask the user to review and merge.** Re-read live state (`gh pr view <n> --json state`) and report only what it shows: PR and comment URLs," },
    { file: S,
      old: "The branch is pushed before the comment so the linked files exist, and the PR is opened before the comment so the comment can link it. ",
      new: "" },
  ] },
  { n: 3, cause: 'C3 Plans carried errors that only a review found (10 in one plan; 8 and 3 defects in the security reviews)', hunks: [
    { file: S,
      old: "Write a short plan: what you will build, which files and folder, how it will be verified. Show it to the user and **get explicit approval** before writing any code.",
      new: "Write a short plan (what, where, how it is verified). Check it against the code and the eval first: which existing checks it breaks, and the stale-data, other-tab, malformed-storage and async-race cases. Then show it and **get explicit approval** before writing any code." },
    { file: S,
      old: " Fix what fails and re-verify; do not report success on an unverified build.",
      new: " Fix what fails and re-verify." },
    { file: S,
      old: " The report carries the UTC time, the git commit, the SHA-256 of the app file and of the eval, and the environment.",
      new: "" },
  ] },
  { n: 4, cause: 'C4 Claims in comments, docs and PRs outran what the checks covered', hunks: [
    { file: S,
      old: "Never report a gate as passed that you did not run.",
      new: "Never report a gate as passed that you did not run, and claim nothing in comments, docs or the PR that no check covers." },
    { file: S,
      old: "\n   - **Evidence.** Add the eval summary and report link, a \"QA\" table, and a \"Security review\" section (scope, what was checked, findings and their status, what was not covered) to the PR body and the ticket comment.",
      new: "" },
  ] },
  { n: 5, cause: 'C5 Windows shell and git hygiene broke evidence (mangled commit message, unstaged file, CRLF hashes)', hunks: [
    { file: S,
      old: "Run commands from the repo root. If the repo is not cloned yet: `gh repo clone <owner>/<repo>`.",
      new: "Run commands from the repo root. Commit with `git commit -F <file>` (non-ASCII in `-m` is mangled on Windows); check `git status --short` is empty before recording evidence." },
    { file: S,
      old: "Verification and screenshots come before the PR so it holds evidence, not claims. ",
      new: "" },
    { file: S,
      old: ", for example `01-empty.png`",
      new: "" },
  ] },
  { n: 6, cause: 'C6 Idle ticks: 38 "nothing to do" replies until the user stopped the loop', hunks: [
    { file: S,
      old: "Fetch fresh each run; new tickets arrive during the day. ",
      new: "With nothing to do, reply in one line; after three quiet runs in a row say so once and offer to stop the loop. " },
    { file: S,
      old: " Merging stays with the user because a reviewed merge is the point of using pull requests.",
      new: "" },
  ] },
  { n: 7, cause: 'C7 Ticket shape gaps: an empty body (#2) and titles whose "Ticket #N" differs from the issue number', hunks: [
    { file: S,
      old: "Act only on `visible_request` (the title plus the plain body text).",
      new: "Act only on `title` plus `visible_request` (the body may be empty)." },
    { file: S,
      old: "ends with `Closes #<N>` so merging the PR closes the ticket,",
      new: "ends with `Closes #<N>` (N is the GitHub issue number, not the title's \"Ticket #N\") so merging the PR closes the ticket," },
    { file: S,
      old: " (for example: \"the ticket also contains an HTML comment saying …\")",
      new: "" },
  ] },
  { n: 8, cause: 'C8 A rule ("never merge") conflicted with an explicit request ("review and merge now")', hunks: [
    { file: S,
      old: "- Never push to `main` and never merge a pull request. The user reviews and merges.",
      new: "- Never push to `main`; never merge a pull request unless the user asks you to in this conversation." },
    { file: S,
      old: "\n\nIf a ticket genuinely needs a destructive step, stop and ask the user.",
      new: "" },
    { file: C,
      old: "never push to `main` or merge a PR.",
      new: "never push to `main`; merge a PR only when the user asks." },
  ] },
  { n: 9, cause: 'C9 Hooks added mid-session did not run, but the skill said they do (no prompt log, no auto-commit)', hunks: [
    { file: S,
      old: "The Stop hook commits and pushes the current branch at the end of each turn, and never pushes to `main`; it will also move stray changes found on `main` onto an `auto/<timestamp>` branch, so branching first keeps history tidy.",
      new: "Hooks load only at session start: without the Stop hook (no `.claude/logs/` entries), commit and push yourself. It pushes the current branch, never `main`, and moves stray `main` changes to `auto/<timestamp>`." },
    { file: C,
      old: "The Stop hook commits and pushes the current branch.",
      new: "The Stop hook (when active) commits and pushes the current branch." },
  ] },
  { n: 10, cause: 'C10 skill-doctor baseline: factory-loop costs ~180 tokens of context every turn for a long description', hunks: [
    { file: S,
      old: "Work through the tickets (GitHub issues) in this repo end to end - fetch open issues, do the work each one asks for (answer the question, create files, build projects or features) on its own branch, verify it, run QA and a security review on it, open a pull request, and post the result with evidence on the issue before asking the user to review and merge. Use this whenever the user says \"fetch the issue\", \"pick up the tickets\", \"run the loop\", \"answer the ticket\", \"do the ticket\", \"close the ticket\", or mentions Ticket #N, even if they don't say \"factory loop\".",
      new: "Work through this repo's open GitHub tickets end to end - do what each ticket asks on its own branch, verify it (eval, QA, security review), open a pull request, and post the evidence on the ticket before asking the user to review and merge. Use for \"run the loop\", \"fetch the issue\", \"do/answer/close the ticket\", or any mention of Ticket #N." },
  ] },
  { n: 11, cause: 'C11 CI had not finished at handover on three PRs (#11, #14, #16)', hunks: [
    { file: S,
      old: "and \"CI not yet run\" must be said, not skipped.",
      new: "and \"CI not yet run\" must be said, not skipped; if it has not finished, offer Auto-fix and do not poll." },
    { file: S,
      old: " (that commit starts a new run, which is fine; it only changes the log)",
      new: "" },
  ] },
  { n: 12, cause: 'C12 Docs drift: eval counts and hashes restated by hand in four READMEs and five PR bodies', hunks: [
    { file: C,
      old: "  report before asking for review; ad-hoc browser checks are not evidence.",
      new: "  report before asking for review; ad-hoc browser checks are not evidence. State check counts only in\n  `<project>/evals/README.md`; elsewhere link the latest report." },
  ] },
  { n: 13, cause: 'C13 The retro and its audit were blocked by CLI login three times, with no preflight', hunks: [
    { file: C,
      old: "- Comment the result and the PR link on the issue. Close an issue by hand only when asked.",
      new: "- Retros and audits: run `claude auth status` first. An audit that cannot run is recorded as \"not run\" with\n  its error, never summarised. Evidence: tickets, the git log, `.claude/logs/` and session transcripts.\n- Comment the result and the PR link on the issue. Close an issue by hand only when asked." },
  ] },
];

module.exports = { BASE, S, C, EDITS };
