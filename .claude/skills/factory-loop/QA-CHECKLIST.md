# QA checklist (factory-loop review gate)

Run this on the ticket's branch after the build is verified and before opening the PR. Record every item as
pass, fail or not applicable (with the reason) and keep the evidence: a screenshot, a console capture, or the
exact check you ran. A failed item is fixed and re-run, not noted and skipped.

For tickets that only answer a question or add documentation, do items 1, 7 and 8 and mark the rest not applicable.

## 1. Acceptance
Turn the ticket text into a numbered list of expected behaviours. Verify each one in the running app. A ticket
line with no matching check means the ticket is not done.

## 2. Regression
Re-run what the project did before this ticket, using the feature list in the project's `README.md`: create,
complete and delete a task, the filters, persistence across a reload. Load data saved in the previous shape
(seed an old-format record) and confirm it still renders and works.

## 3. Edge cases
Empty and whitespace-only input, very long text, characters like `<b>` and quotes (shown as text, never parsed
as HTML), duplicates, boundary dates (month end, leap day, year rollover, today versus tomorrow), and a rapid
double click on every button.

## 4. Console and network
Zero console errors or warnings and no unhandled promise rejections. No requests to any host other than the
local one, since the apps are client side only.

## 5. Responsive and input
Check at 375px wide and 760px wide: no horizontal scroll, nothing clipped. Operate the main flow by keyboard
alone (Tab, Enter, Space). Every control has a visible label or `aria-label`. Check light and dark colour
schemes. Save screenshots as `qa-*.png` in `screenshots/ticket-<N>/`.

## 6. State and persistence
Reload after each state change and confirm it stuck. Confirm a clear message appears when the browser database
cannot open.

## 7. Code hygiene
No leftover debug output, TODOs or commented-out code. No secrets or real credentials. Files are in the right
project folder. The project `README.md` lists the new behaviour and how to run it. The `CLAUDE.md` index is
updated and the file is still under 100 lines.

## Evidence comes from the eval
Items 1 to 6 are answered by checks in `<project>/evals/run.js`, not by looking at the page and saying so. Add a
check for anything on this list the eval does not yet cover, run it, and cite the check id and the committed
report in the table below. Anything you can only judge by eye (visual polish, wording) is marked as a manual
check and not counted as automated evidence.

## 8. Report
Put a table in the PR body and in the ticket comment:

| Check | Result | Evidence |
|-------|--------|----------|
| 1 Acceptance | pass | screenshots 02-05 |

State what was not covered (other browsers, other time zones, devices) instead of leaving it implied.
