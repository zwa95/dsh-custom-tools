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

> Working on the plugin itself? [`HANDOFF.md`](HANDOFF.md) is the current state of the implementation:
> architecture, config contract, the decision log behind the parts that look odd, and what is still open.

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

### Controls

The page draws its controls with the host's own component kit
(`@deepseek-ai/dsh-client-ui-primitives`), so a button, switch, checkbox, dropdown or chip looks
and behaves like the one on DSH's own settings pages instead of being a look-alike. The kit is
reached through one guarded `require` and an adapter layer (`Chip`, `Button`, `TextInput`,
`Select`, `Switch`, `Checkbox`, `Segmented`, `twistIcon`, `iconButton`), and every one of them
falls back to the plain implementation written earlier when the module is missing:

- The kit is **not** a published package. It is a module the shell pre-registers with the client
  `ModuleLoader`, so it resolves at runtime and cannot be installed.
- Its API is explicitly not a contract — the official plugin guide tells plugins not to require
  it, because a change lands without notice and a throwing component blanks the whole
  `settings.section` entry. That risk is accepted here: the require is wrapped in `try`, the
  adapter looks components up by name, and each control keeps a non-kit branch.
- Two things stay hand-drawn on purpose: the `<textarea>` (the kit has no multi-line input; its
  inline editor commits on Enter, which fights an explicit Save button) and the argv preview
  legend colours (the kit has no semantic equivalent for "this box is a literal, that one is a
  variable").

### Field copy

Explanations live behind a ⓘ rather than under every control: `Field` takes an `info` string that
renders a `Tooltip` on a question mark next to the label. A `hint` is kept only for the short
things that must stay visible while typing, such as `1000 – 600000`. The prose states what a field
does and who reads it — `description` and each parameter's `description` are what the model sees —
without hedging, filler or motivational phrasing.

Two layout rules follow from the kit's own styling and are easy to regress:

- A host `Input` inside a grid column keeps its intrinsic width (~20 characters) unless given both
  `minWidth: 0` and `width: 100%`. `minWidth` only lifts the grid item's automatic minimum; without
  the width the field still paints over its neighbour.
- Host inputs are transparent with a hairline border, not filled blocks; textareas match them
  (`background: transparent`, `border: 0.5px solid var(--dsw-alias-border-l3)`), with monospace
  reserved for JSON and shell text.

Rows whose field count varies (prefix/suffix plus an optional separator, the array controls) use
`S.gridFit` — `repeat(auto-fit, minmax(150px, 1fr))` — so two fields split the row in half instead of
being squeezed into a three-column preset.

### Array parameters

Three shapes cover the CLIs this plugin targets, and the page offers exactly those:

| Shape | Control | Binding written |
| --- | --- | --- |
| `rg -g a -g b`, `git add a b c` — one argv per value | **One per value** (default when the type becomes `array`) | `repeat: true`; prefix and suffix apply per element |
| `--fields a,b,c` — the whole list in one argv | **Join into one** plus an optional separator | `join: '<separator>'`; an empty separator keeps the engine's space-joined default |
| A tool that wants raw JSON text | Format → **Emit as JSON** | `json: true` |

The engine's own default is the surprising one: without `repeat` the list is joined into a *single*
argv, with a space when `join` is undefined. Switching a parameter's type to `array` therefore writes
`repeat: true` in the same edit — a user action, never a silent rewrite of an existing definition — and
the separator field appears only for the joined shape.


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
