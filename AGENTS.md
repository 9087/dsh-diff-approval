# Working rules for agents in this repo

## Never terminate a `node` process you did not start

This machine runs the DeepSeek Harness host (`dsh web`) as a `node.exe` that owns
`127.0.0.1:3080`, on the same machine and in the same process list as this repo's own
tooling: `pnpm`/`vitest` forks, and the harness's `dsh-subprocess-local` runners that
execute every `pwsh` call.

On 2026-09-25 01:33:14 (local) an agent inside this repo ran

```powershell
Stop-Process -Id 73680 -Force; Stop-Process -Id 89276 -Force; ...
```

to clean up what it believed were leftover vitest workers. It killed the host. The
browser session died, `session.v3.jsonl.zstd` stops two milliseconds after that
`tool/call` with no `tool/result` ever written, and the user had to relaunch
`npx @deepseek-ai/dsh@latest web` by hand. The same session log holds 74 earlier
`Stop-Process`/`taskkill` hits, so this was a pattern, not an accident.

Rules that follow from it:

- Do not run `Stop-Process`, `taskkill`, `kill`, or any equivalent against a process
  you did not start. `Stop-Process -Name node` is forbidden outright.
- Never identify a worker by name, by "looks like the one from before", or by a PID you
  copied from an earlier listing.
- If your own command hangs, cancel *that harness job* with the `job_kill` tool: it
  terminates the process tree the job started, and nothing else.
- If you must reason about the host at all, resolve it deliberately — the owner of
  `127.0.0.1:3080` (`Get-NetTCPConnection -LocalPort 3080 -State Listen`) — and treat
  it and its children as infrastructure, not as clutter.
- A vitest fork that will not finish is a bug to diagnose, not a process to kill. See
  "the suite hangs" below.

## The suite must not be run twice at once

Two overlapping `vitest run`s in this repo produce flakes and, when a fork runs away,
a multi-gigabyte worker that never exits. Run the suite only when nothing else is
building or testing, and treat a hung run as a finding to report.

## A source file is written with the edit tool, never through a shell

`src/client/PendingPanel.tsx` was damaged twice in one day, both times by a write that did
not come from the `edit`/`write` tools:

- At 01:18:52 the file was left **invalid UTF-8**: every three-byte character lost its last
  byte (and the whitespace after it, newlines included) to `?` — 410 sites, `— ` becoming
  `E2 80 3F`. The file then refused to be read by the tools that had to repair it.
- The repair itself broke it a second way: a byte-level script put the em dashes back but
  restored a *space* where the damage had eaten a **newline**, gluing `/**` onto the end of a
  `//` line and leaving a stray `*` line — a parse error that stopped every spec importing the
  panel from even collecting.

Rules that follow from it:

- Change a source file with the `edit`/`write` tools. `Get-Content`/`Set-Content`, `Out-File`,
  `>`, `-replace` and every other round trip through PowerShell is forbidden — that is what
  re-encodes a file.
- A mechanical byte-level script is allowed only when the exact original bytes are known from a
  reference that predates the damage (`lib/client.js` from a build older than it,
  `git show HEAD:<path>`) — and it must be followed by proof that the file still **parses** and
  that nothing else moved. Restoring characters without restoring structure is a second bug.
- When a damaged file is found, stop the agents that write it before repairing it, and keep a
  copy of the damaged bytes so the repair can be audited.
