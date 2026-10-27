# Todo app

A single-page todo app. Tasks are stored client-side in the browser's IndexedDB, so there is no server
and no build step.

## Features
- Add a task with an optional **due date**, a **priority** (High, Medium or Low; Medium by default) and optional
  **tags** (comma separated, saved lowercase).
- Mark tasks done, **edit** them, or delete them. Edit opens an inline form for the title, due date, repeat,
  priority and tags: Enter saves, Escape cancels, and problems (empty title, a repeat without a due date, an
  impossible date) are shown inside the form. An edit in progress keeps its text when the list refreshes and stays
  visible even if a filter change would hide it. Saving applies only the fields you changed, so it never
  overwrites changes made elsewhere (for example another tab changing the priority), and it tells you if the task
  was deleted in the meantime.
- **Status filter**: All, Incomplete, Completed.
- **Tag filter** and **priority filter**: dropdowns that combine with each other and with the status filter.
- **Search box** (ticket #18): filters the list by title or tag as you type. It ignores case and spaces around the text,
  treats what you type literally (no patterns), combines with the status, tag and priority filters, and keeps the
  due-date order. Clearing it shows the other filters' results again. It is not saved: a reload starts empty. The task
  being edited stays visible, and the footer still counts every task.
- **Task count footer** below the list: `3 open · 2 done`. It counts every task whatever the filters show (so the
  numbers do not move when you filter, and stay right when a filter shows nothing), counts each completed
  occurrence of a recurring task as done, updates after every change, and is empty when there are no tasks. It is
  a polite live region that stays in the page (so its first text is announced), is only rewritten when the numbers
  change (so filtering does not make a screen reader repeat them), and hides the separator dot from screen readers.
  A stored record whose title cannot be converted to text no longer stops the list from loading.
- Tasks are ordered by due date (earliest first), then priority (High first), then creation order. Undated tasks
  come last, ordered by priority. Incomplete tasks past their due date are highlighted as overdue. Priority shows
  as a labelled badge, never colour alone.
- **Recurring tasks**: choose Daily, Weekly or Monthly (a due date is required). Completing a recurring task
  keeps it as completed history and creates the next occurrence with the same title, tags and repeat. The next
  date counts from the old due date and advances to the first date after today; monthly repeats keep the
  original day and clamp at month end (Jan 31 -> Feb 28/29 -> Mar 31; each occurrence remembers the day the
  series started on); the next occurrence inherits the priority. Un-ticking a completed recurring task undoes it:
  the next occurrence is removed if it is still open and you have not edited it (an edited occurrence is yours and
  is never deleted for you; ticking the original again does not add a third copy). Editing a task's due date or
  repeat starts a new series for monthly dates. A series continues until its open task is deleted, or until the
  last supported date (9999-12-31), where it ends.
- Due dates must be real dates between 1970 and 9999. If a save fails (storage full or blocked) the app says so
  and keeps what you typed.
- Tasks saved by the earlier versions (no date, tags, repeat or priority) still load; a missing priority counts as
  Medium.

## Run
Serve the folder over HTTP and open it, for example `npx serve todo`. Tasks persist per browser and origin.
Browsers restrict IndexedDB on some `file://` and `data:` pages, so serving over `http://localhost` is the
dependable way.

## Eval
`node todo/evals/run.js` runs the behaviour checks in headless Chrome and proves they can fail by injecting
deliberate bugs. Counts and coverage are in `evals/README.md`; recorded, timestamped reports live in `evals/results/`.

## Screenshots
Verification screenshots for each ticket live in `screenshots/ticket-<N>/`. QA review screenshots (phone width,
dark mode, keyboard focus, malformed data) live in `screenshots/qa-review/`.
