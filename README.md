# dsh-custom-tools

Declare your own tools for [DeepSeek Harness](https://github.com/deepseek-ai/dsh): point at a
local executable, a script, or a fixed bash/PowerShell snippet, describe the parameters the model
may fill, and it shows up as a normal agent tool — with hot reload, hot enable/disable, and a
settings page.

The point is **narrowing, not widening**. `bash` already lets the agent run anything. A custom tool
turns "anything" into "exactly this program, with exactly these arguments, in exactly this
directory".

Tools run with the privileges of the harness itself. There is no confinement layer in the plugin:
local programs expect to read their own config and write their own caches, and reshaping them to
fit a sandbox is not what this plugin is for. You write the definition, so you own the behaviour.

## What it guarantees

| Concern | Behaviour |
| --- | --- |
| Argument passing | The model's values become **exact argv elements** or **stdin bytes**. They are never interpolated into shell source. |
| Approval | `inherit` (session policy decides) or `always` (every call asks). There is no "always allow". |
| Privileges | Runs as the harness runs. No argument can change which program starts, from which directory, or with which environment keys. |
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

# bash — a fixed script body; parameters arrive as positional "$@" values.
mode: bash
command: 'printf "%s\n" "$@"'
args: [{ arg: 'value' }]

# powershell — a fixed script body; parameters arrive as JSON on stdin.
# -Command does not bind trailing tokens to $args, so argv is not an option.
mode: powershell
command: '$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json; Write-Output $payload.value'
args: [{ stdin: 'json' }]
```

## The settings page

Each tool is one collapsible card. Inside, the form is split by concern: identity, command
(target field depends on the mode), **execution preview**, **argument pieces**, execution, and a
free-form advanced block for `env`/`credentials`/`examples`.

There is one ordered list of *pieces*, not a parameter table plus a binding table:

- **literal** — text that is always there, e.g. `--json`.
- **variable** — one model-filled value, drawn as `<name>`. It declares its own type, required
  flag, default and description, so a variable cannot exist without a parameter and a parameter
  cannot be declared but never used.
- **switch** — a boolean the model may turn on. Drawn with a dashed frame because it may or may
  not be present.
- **stdin** — hand the parameters over as one JSON object instead of argv. PowerShell always does
  this (`-Command` never binds `$args`), so the control only appears where it means something.

Two things are worth knowing:

- The **preview** shows the *shape* of the command — one box per argv element, colored by kind,
  never a value — so it stays honest about what will run without inventing sample data. It is
  computed in the page with the same rules the host uses; tests replay a definition matrix through
  both the page and `buildInvocation` so the drawing cannot drift from what actually spawns.
- The card **diagnoses itself** with the validator's rules as you type. Save is disabled while an
  error stands, and the revision chip tells you whether the document moved underneath you.

Fields the page does not edit (`min`, `max`, `minLength`, `maxLength`) are carried through
untouched: opening a card and saving must never rewrite a definition you did not change.

The page cannot run anything. A browser has no channel to the host process, so `preview` and
`test` stay in the session as `/custom-tools` subcommands.

## Shell binaries on Windows

`mode: bash` and `mode: powershell` start a shell. Both default to the name on
`PATH` (`bash`, `pwsh`), and both accept `executable` to pin an installation:

```yaml
mode: bash
executable: C:/Program Files/Git/bin/bash.exe
command: 'printf "%s\n" "$@"'
```

`bash` on `PATH` is usually `C:\Windows\System32\bash.exe` — the WSL launcher, which is not a Unix
shell. When a `mode: bash` tool leaves `executable` unset and `bash` resolves to that launcher or to
the Microsoft Store alias, the plugin looks for a real bash in this order, derived only from the
deployment environment:

1. `<git>/bin/bash.exe` next to the `git` on `PATH`, then `<git>/usr/bin/bash.exe`
2. `%ProgramFiles%\Git`, `%ProgramW6432%\Git`, `%ProgramFiles(x86)%\Git`
3. `%USERPROFILE%\scoop\apps\git\current`, `%USERPROFILE%\scoop\apps\msys2\current`
4. `%LOCALAPPDATA%\Programs\Git`, `%MSYS2_ROOT%`
5. `C:\msys64\usr\bin\bash.exe`

If none of them exists the call fails with `EXECUTABLE_NOT_FOUND` and says which bash is missing. A
model argument never influences this choice, and an explicit `executable` always wins.

`mode: powershell` defaults to `pwsh` and falls back to `powershell.exe` (Windows PowerShell 5.1)
when PowerShell 7 is not installed. Parameters always travel as one JSON document on stdin
(`{ stdin: 'json' }`), never as trailing argv: `powershell -Command <source> a b` appends `a`/`b`
to the command text instead of binding them to `$args` (measured, and the reason validation rejects
positional bindings in this mode). `/custom-tools preview <name> {"k":"v"}` prints the absolute path
that will actually run.

## Choosing the program

`mode: script` takes the interpreter as written. A bare name (`python`, `node`, `pwsh`) is resolved
on `PATH`; an absolute path pins that exact installation, which is what you want when the machine
has several — a virtualenv, a pyenv shim, a second Python:

```yaml
mode: script
interpreter: C:/Users/me/venvs/report/Scripts/python.exe
script: C:/Users/me/tools/report.py
```

There is no trust level and no script hash: the author of the definition is the author of the tool,
so pointing at a script is all the permission it needs.

`cwd` is either `.` (the session directory — follow the conversation) or one absolute path (pin a
project). Anything else is refused at save time, and no model argument can move it.

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
/custom-tools preview <name> {"query":"dsh"}   # prints argv and cwd — runs nothing
/custom-tools test <name> {"query":"dsh"}      # same pipeline as a model call
/custom-tools enable|disable <name>
/custom-tools add <json>                       # whole definition, validated before it is written
/custom-tools export                           # every definition as JSON, ready to `add` back
```

[folder `examples/`](examples/) ships five definitions you can paste straight into `add`: a fixed
executable, an `rg` search with a parameter, a script with a fixed interpreter, a PowerShell snippet
whose parameters arrive on stdin, and a `parse: "json"` tool with an output schema. The test suite
validates and compiles all of them, so they cannot drift from the real schema.

`preview` is the fastest way to find out why a tool isn't doing what you meant: it shows the exact
argv the model's arguments would produce.

## Failure codes

`INVALID_CONFIG`, `INVALID_ARGUMENT`, `TOOL_RELOADING`, `CREDENTIAL_UNAVAILABLE`,
`APPROVAL_REJECTED`, `APPROVAL_UNAVAILABLE`, `CWD_UNAVAILABLE`, `SCRIPT_UNAVAILABLE`,
`EXECUTABLE_NOT_FOUND`, `SPAWN_FAILED`, `ABORTED`, `TIMED_OUT`, `PROCESS_EXIT`,
`PROCESS_SIGNALED`, `OUTPUT_LIMIT`, `INVALID_JSON_OUTPUT`, `OUTPUT_SCHEMA_MISMATCH`,
`CUSTOM_TOOL_INTERNAL`.

Text is UTF-8 in both directions; Python and Java get their usual encoding defaults injected
(`PYTHONIOENCODING=utf-8`, `-Dfile.encoding=UTF-8`) unless you override them.

## Scope of v1

Not included, on purpose: background jobs, preset-scoped tools, agent-authored drafts, disk-backed
call history, output spill files, and any sandbox of its own. `OUTPUT_LIMIT` fails loudly instead of
handing back a partial result.

## Development

```
node --test        # 70 tests, no profile required
```

The design notes and the runtime evidence behind every contract in this README live in
[`research/`](research/README.md).
