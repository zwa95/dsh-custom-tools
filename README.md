# dsh-custom-tools

Declare your own tools for [DeepSeek Harness](https://github.com/deepseek-ai/dsh): point at a
local executable, a script, or a fixed bash/PowerShell snippet, describe the parameters the model
may fill, and it shows up as a normal agent tool — with hot reload, hot enable/disable, and a
settings page.

The point is **narrowing, not widening**. `bash` already lets the agent run anything. A custom tool
turns "anything" into "exactly this program, with exactly these arguments, in exactly this sandbox".

## What it guarantees

| Concern | Behaviour |
| --- | --- |
| Argument passing | The model's values become **exact argv elements** or **stdin bytes**. They are never interpolated into shell source. |
| Sandbox | The declared level can only *tighten* the session's level. A confined session never runs your tool unconfined; a missing sandbox is a failure, not a fallback. |
| Approval | `inherit` (session policy decides) or `always` (every call asks). There is no "always allow". |
| Output | Exit code `0` is the only success. stdout is the result; a failure carries a stable code, a message and a hint. |
| Reload | Editing the config recompiles in place. Compatible edits swap definitions without touching the registry; breaking edits cancel in-flight calls, drain, then re-register. A definition that fails validation keeps its previous version serving. |

## Install

```
dsh plugin --profile <profile> add dsh-custom-tools
```

Then open **Settings → 自定义工具** (Custom Tools) and press one of the `＋ mode` buttons to add a
template.

## The four modes

```yaml
# executable — the default. Runs the program with your argv.
mode: executable
executable: git
args: [{ literal: status }, { literal: --short }]

# script — an interpreter plus a script file.
mode: script
interpreter: python
script: C:/Users/me/tools/report.py

# bash — a fixed script body; parameters arrive as positional $1, $2 …
mode: bash
command: 'printf "%s\n" "$@"'
args: [{ arg: 'value' }]

# powershell — a fixed script body; parameters arrive as positional $args,
# or as JSON on stdin with { stdin: 'json' }.
mode: powershell
command: 'Write-Output $args[0]'
args: [{ arg: 'value' }]
```

## Shell binaries on Windows

`mode: bash` and `mode: powershell` start a shell. Both default to the name on
`PATH` (`bash`, `pwsh`), and both accept `executable` to pin an installation:

```yaml
mode: bash
executable: C:/Program Files/Git/bin/bash.exe
command: 'printf "%s\n" "$@"'
```

That matters on Windows, where `bash` on `PATH` is usually
`C:\Windows\System32\bash.exe` — the WSL launcher. It resolves, then cannot start
inside a confined run and dies with an opaque `E_ACCESSDENIED`. So when a
`mode: bash` tool leaves `executable` unset and `bash` resolves to that launcher
or to the Microsoft Store alias, the plugin looks for a real bash in this order,
derived only from the deployment environment:

1. `<git>/bin/bash.exe` next to the `git` on `PATH`, then `<git>/usr/bin/bash.exe`
2. `%ProgramFiles%\Git`, `%ProgramW6432%\Git`, `%ProgramFiles(x86)%\Git`
3. `%USERPROFILE%\scoop\apps\git\current`, `%USERPROFILE%\scoop\apps\msys2\current`
4. `%LOCALAPPDATA%\Programs\Git`, `%MSYS2_ROOT%`
5. `C:\msys64\usr\bin\bash.exe`

If none of them exists the call fails with `EXECUTABLE_NOT_FOUND` and says which
bash is missing. A model argument never influences this choice, and an explicit
`executable` always wins.

`mode: powershell` defaults to `pwsh` and falls back to `powershell.exe`
(Windows PowerShell 5.1) when PowerShell 7 is not installed. `/custom-tools
preview <name> --param k=v` prints the absolute path that will actually run.

## Parameters and argv

Parameters are described with a JSON-Schema subset (`string`, `number`, `integer`, `boolean`,
`array`), and `args[]` says where each one goes:

```yaml
parameters:
  query: { type: string, required: true }
  limit: { type: integer, default: 10 }
args:
  - arg: query          # -> the value itself
  - literal: --limit
  - arg: limit
  - flag: verbose       # boolean param 'verbose' -> '--verbose' when true
    as: --verbose
```

`arg` entries also accept `prefix` / `suffix` / `join` / `repeat` / `json` / `omitIfEmpty`. Values
starting with `-` or `@` are rejected unless the entry sets `allowLeadingDash` or
`allowResponseFile` — that stops a parameter from silently becoming an option or a response file.

## Commands

```
/custom-tools list
/custom-tools status
/custom-tools show <name>
/custom-tools preview <name> {"query":"dsh"}   # prints argv, cwd, sandbox — runs nothing
/custom-tools test <name> {"query":"dsh"}      # same pipeline as a model call
/custom-tools enable|disable <name>
/custom-tools add <json>                       # whole definition, validated before it is written
/custom-tools export                           # every definition as JSON, ready to `add` back
```

[folder `examples/`](examples/) ships five definitions you can paste straight into `add`: a fixed
executable, an `rg` search with a parameter, a script with a fixed interpreter, a PowerShell snippet
whose parameters land in `$args`, and a `parse: "json"` tool with an output schema. The test suite
validates and compiles all of them, so they cannot drift from the real schema.

`preview` is the fastest way to find out why a tool isn't doing what you meant: it shows the exact
argv the model's arguments would produce.

## Failure codes

`INVALID_CONFIG`, `INVALID_ARGUMENT`, `TOOL_RELOADING`, `CREDENTIAL_UNAVAILABLE`,
`APPROVAL_REJECTED`, `APPROVAL_UNAVAILABLE`, `CWD_UNAVAILABLE`, `SCRIPT_UNAVAILABLE`,
`EXECUTABLE_NOT_FOUND`, `SPAWN_FAILED`, `SANDBOX_UNAVAILABLE`, `ABORTED`, `TIMED_OUT`,
`SANDBOX_DENIED`, `PROCESS_EXIT`, `PROCESS_SIGNALED`, `OUTPUT_LIMIT`, `INVALID_JSON_OUTPUT`,
`OUTPUT_SCHEMA_MISMATCH`, `CUSTOM_TOOL_INTERNAL`.

Text is UTF-8 in both directions; Python and Java get their usual encoding defaults injected
(`PYTHONIOENCODING=utf-8`, `-Dfile.encoding=UTF-8`) unless you override them.

## Scope of v1

Not included, on purpose: background jobs, preset-scoped tools, agent-authored drafts, disk-backed
call history, output spill files. `OUTPUT_LIMIT` fails loudly instead of handing back a partial
result.

## Development

```
node --test        # 44 tests, no profile required
```

The design notes and the runtime evidence behind every contract in this README live in
[`research/`](research/README.md).
