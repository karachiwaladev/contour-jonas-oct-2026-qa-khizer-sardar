# Factory hooks

Hooks that run around the agent. They are configured in `../settings.json`.

| Hook | When | What it does |
|---|---|---|
| `guard.js` | Before every Bash, PowerShell, Read and Grep call | Blocks dangerous commands and `.env` reads (below) |
| `log-prompts.js` | When the agent stops | Appends new user prompts to `../logs/prompts.jsonl` (gitignored) |
| `auto-commit.js` | When the agent stops | Commits and pushes the current branch, never `main` |

## The guard

Two layers, because neither is enough alone:
1. **`permissions.deny`** in `../settings.json`: static rules that match the start of a command or a file path.
2. **`guard.js`**, a PreToolUse hook that parses the command (quotes, `;`, `&&`, `|`, subshells, `sudo` and `env`
   wrappers, `bash -c "..."`, `find -exec`, heredocs) and decides on the whole thing.

It blocks:

| Rule | Examples |
|---|---|
| Recursive and forced delete | `rm -rf`, `rm -fr`, `rm -r -f`, `rm --recursive --force`, `sudo rm -rf`, `git rm -rf`, `find -exec rm -rf`, PowerShell `Remove-Item -Recurse -Force` (and `rm`/`ri` aliases and parameter prefixes), `rd /s /q`, `del /s /q` |
| Forced push | `git push --force`, `-f`, `-uf`, `--force-with-lease`, `--force-if-includes`, `--mirror`, `origin +main`, `git -C dir push --force` |
| Downloading and running code | `curl … \| sh`, `wget … \| bash`, `… \| python/node/perl`, `iwr … \| iex`, `iex (iwr …)`, `bash <(curl …)`, `sh -c "$(curl …)"`, `eval "$(curl …)"` |
| Reading `.env` files | the Read and Grep tools on `.env`, `.env.*` or `*.env`; `cat`/`type`/`head`/`grep`/`source`/`Get-Content`/`cp`… on them; `< .env`; `curl -d @.env`; `git show HEAD:.env` |

It deliberately **does not** block: `rm` of a file, `rm -f` alone, `rm -r` alone, `git push` and `git push -u`, `curl`
to a file or into `jq`, running a local script, or a commit message or heredoc that merely *mentions* a dangerous
command. `.env.example` is blocked too (the pattern is `.env.*`); to allow it, narrow the Read rules in
`settings.json` and `ENV_NAME` in `guard.js` together.

A blocked call returns a reason to the agent ("ask the user to run it themselves") and is logged to
`../logs/guard.jsonl`. On any internal error the guard blocks (fail closed), and the hook entry sets
`onFailure: "block"` in case Node itself is missing.

### What it cannot stop
This is a seatbelt against mistakes and injected instructions, not a sandbox. Probing it with evasions showed these get
through, so do not rely on the guard against a determined or cleverly prompted agent:
- indirection: a variable as the command (`c=rm; $c -rf x`), `echo <base64> | base64 -d | sh`, a two-step download
  then run (`curl -o x.sh …; bash x.sh`), `python -c "shutil.rmtree(…)"`, `node -e "readFileSync('.env')"`;
- reads that never name the file: `grep -r KEY .`, `cat $f` with `f=.env`, PowerShell `Get-Content (Join-Path . '.env')`;
- destructive commands outside the list: `git reset --hard`, `git clean -fdx`, `git push origin --delete main`.
For real containment, run the agent in a sandbox or container without secrets, and use a read-only token.

### Testing
```bash
node .claude/hooks/guard.selftest.js
```
Feeds the real hook 78 payloads that must be blocked and 50 that must be allowed (including the near misses above),
and checks that unreadable input is refused and every block is logged. CI runs it.

Hooks load when a session starts, so a change here applies to the next session.
