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
- Tasks saved by the earlier version (no date or tags) still load.

## Run
Serve the folder over HTTP and open it, for example `npx serve todo`. Tasks persist per browser and origin.
Browsers restrict IndexedDB on some `file://` and `data:` pages, so serving over `http://localhost` is the
dependable way.

## Screenshots
Verification screenshots for each ticket live in `screenshots/ticket-<N>/`.
