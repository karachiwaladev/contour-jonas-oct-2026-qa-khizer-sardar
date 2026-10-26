# Todo app

A single-page todo app. Tasks are stored client-side in the browser's IndexedDB, so there is no server
and no build step.

## Features
- Add a task with an optional **due date** and optional **tags** (comma separated, saved lowercase).
- Mark tasks done, or delete them.
- **Status filter**: All, Incomplete, Completed.
- **Tag filter**: a dropdown of every tag in use. It combines with the status filter.
- Tasks are ordered by due date (earliest first, undated last). Incomplete tasks past their due date are
  highlighted as overdue.
- **Recurring tasks**: choose Daily, Weekly or Monthly (a due date is required). Completing a recurring task
  keeps it as completed history and creates the next occurrence with the same title, tags and repeat. The next
  date counts from the old due date and advances to the first date after today; monthly repeats keep the
  original day and clamp at month end (Jan 31 -> Feb 28/29 -> Mar 31; each occurrence remembers the day the
  series started on). Un-ticking a completed recurring task undoes it: the next occurrence is removed if it is
  still open. A series continues until its open task is deleted.
- Due dates must be real dates between 1970 and 9999. If a save fails (storage full or blocked) the app says so
  and keeps what you typed.
- Tasks saved by the earlier versions (no date, tags or repeat) still load.

## Run
Serve the folder over HTTP and open it, for example `npx serve todo`. Tasks persist per browser and origin.
Browsers restrict IndexedDB on some `file://` and `data:` pages, so serving over `http://localhost` is the
dependable way.

## Eval
`node todo/evals/run.js` runs 24 behaviour checks in headless Chrome and proves they can fail by injecting six
deliberate bugs. See `evals/README.md`; recorded, timestamped reports live in `evals/results/`.

## Screenshots
Verification screenshots for each ticket live in `screenshots/ticket-<N>/`. QA review screenshots (phone width,
dark mode, keyboard focus, malformed data) live in `screenshots/qa-review/`.
