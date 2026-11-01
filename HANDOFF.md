# dsh-custom-tools 交接文档

> 写给下一个 session：把"用户手上的可执行文件/脚本/shell 命令"变成模型能调用的 DSH 工具。
> 本文档记录**当前实现状态、为什么这么做、还剩什么没做、哪些坑已经踩过**。
> 权威设计文档在 [`research/research-design.md`](research/research-design.md)（1215 行，v2 实施规范）；本文档是实现与现场的现状快照，冲突时以代码 + 本文档的"决策日志"为准。

---

## 0. 三十秒版本

| 项 | 值 |
| --- | --- |
| 仓库 | `C:\Users\mark\Desktop\dsh-custom-tools`（Git，`main`，无未提交改动） |
| 最新提交 | `65c5774 fix(client): unwrap describe() and write through the resolved namespace` |
| 规模 | `index.js` 120 行 + `client.js` 2176 行 + `src/**` 约 2900 行；测试 76 项全绿 |
| 宿主基线 | DSH `0.2.1-rc.3`、`@deepseek-ai/cordis` `4.0.5`、`@deepseek-ai/dsh-tools` `0.2.1-rc.3`、`@deepseek-ai/schemastery` `3.18.5`、本机 Node `v24.15.0` |
| 安装形态 | `link:C:/Users/mark/Desktop/dsh-custom-tools`，装在 `~/.dsh/profiles/desktop`（应用 `plugin_manager` 装过，现在靠 link 生效） |
| 用户现场 | 4 个可用工具：`python_pretty_json`（script）、`bash_grep`（bash）、`pwsh_recent_files`（powershell）、`rg_search`（executable） |
| 当前唯一未确认项 | 设置页在真机上是否能正常列出这 4 个工具（client 侧 namespace 解包刚修完，等刷新验收） |

**这个插件的定位**（用户定的）：不是"把 agent 放出去"，而是"把用户的工具**收窄**成一条确定命令行"。模型只能影响声明过的 argv/stdin/env **值**，永远无法影响程序、脚本、命令文本、cwd、env 键名、凭据引用。

---

## 1. 怎么跑、怎么验证

```bash
cd /c/Users/mark/Desktop/dsh-custom-tools

node --check client.js     # client.js 不能有语法错误（它是手写单文件，没有构建）
node --test                # 76 项，全绿；约 0.4s
```

真机验证（在 DSH 应用里）：

```
/custom-tools list                         # 已声明工具 + 注册状态
/custom-tools status                       # 当前代际、诊断、最近提交时间
/custom-tools preview rg_search {"pattern":"inject"}   # 只打印 argv/cwd/env 键，不启动进程
/custom-tools test rg_search {"pattern":"inject"}      # 真跑一次，与模型调用同一条流水线
```

真机往返探针（改 `client.js` 的 pieces 映射后必跑）：

```bash
node research/tools/roundtrip-live.mjs <path-to-js-yaml.mjs>
# 从 ~/.dsh/profiles/desktop/cordis.patch.yml 读真实工具定义，
# 跑 piecesOf → applyPieces 的字节级往返，并打印 previewOf 的形状。
```

### 生效规则（很重要，踩过坑）

| 改了什么 | 怎么生效 |
| --- | --- |
| 用户工具定义（`~/.dsh/profiles/desktop/cordis.patch.yml` 里的 `config.tools`） | **几秒内自动生效**（`dsh-hmr` 监听 patch 文件 → `loader/volatile-update` → `Manager.apply`），不用重启 |
| 本插件**模块代码**（`index.js` / `src/**` / `client.js`） | **必须重启 DSH 应用**。`link:` 包按 realpath 走 Node `ModuleLoader.loadCache`，同一个 URL 不会重新求值；`plugin_manager` 的 disable/enable 也不行 |
| 只是刷新浏览器页面 | 只会重载 Client 半边（`client.js`），Host 不变 |

Agent 自己**不能**刷新 Host（`unlag_refresh` 会返回"在右键菜单里打开 Agent 可以自己刷新"），所以要提醒用户重启或刷新。

---

## 2. 仓库地图

```
index.js                 组合根：读 volatile config → Manager → 注册 /custom-tools
client.js                浏览器半边（单文件，2176 行）：设置页 settings.section
cordis.patch.yml         本插件的 bundle patch：一条 bare row `id: custom-tools`
package.json             peer+dev 依赖、exports、dsh.bundle.patch、dsh.client.inject
icon.svg / locale/*.json 图标与 meta 文案（i18n 只有标题/描述）

src/config/schema.js     Schemastery 适配层（唯一的 schema 声明处）
src/config/validate.js   纯跨字段校验（保存期/编译期用，返回带 path 的 issues）

src/compiler/compile.js  snapshot → 不可变 Generation 候选（纯函数，无 I/O）
src/compiler/parameters.js  参数 → 宿主 author DSL 的 property map
src/compiler/bindings.js    pieces/args → 精确 argv + stdin
src/compiler/hash.js        contractHash / contentHash

src/execution/run.js     唯一执行入口 runCustomTool（preview 与 test 与模型调用共用）
src/execution/classify.js  退出码/信号/超时 → 稳定错误码 + 提示
src/execution/interpreters.js  Windows 上找真正的 bash / 回退 powershell.exe
src/execution/encoding.js  按解释器注入 UTF-8 默认（python/java）
src/execution/jsonschema.js 输出 schema 子集校验

src/result/contract.js   结果信封 + OUTPUT_SCHEMA（宿主 author DSL 形态）
src/result/render.js     结果 → 模型可见文本（唯一投影点）

src/runtime/manager.js   代际管理：编译、提交、注册/注销、quiesce
src/runtime/tool-slot.js 每个工具一个稳定 ToolDefinition + 在途调用集合
src/runtime/generation.js    不可变代际 + refcount

src/commands/index.js    /custom-tools 命令族（list/status/show/preview/test/enable/disable/add/export）

test/                    7 个测试文件，76 项
test-support/            宿主契约的测试替身（dsh-tools / schemastery / loader resolve 钩子）
examples/                5 个可直接 add 的示例定义 + README
research/                研究归档（设计稿、对抗审查、mock、取证脚本、Windows 限制矩阵）
```

---

## 3. 架构

### 3.1 Host 半边

```
ctx (Cordis)  ──inject ['tools']──►  apply(ctx, config)
                                      │
                     loader/volatile-update
                                      │
                                      ▼
                                  Manager.apply(snapshot)
                                      │  compile()（纯函数，逐工具保留 last-good）
                                      ▼
                                  Generation（不可变）
                                      │
                     ┌────────────────┴────────────────┐
                     ▼                                 ▼
             ToolSlot（每工具一个）              /custom-tools 命令族
             ctx.tools.register(defineTool(...))  （preview / test）
                     │
                     ▼
             runCustomTool(services, compiled, args, exec)  ← 二者共用
                     │
                     ▼
             ctx.subprocess.spawn(exact argv)
```

- `export const inject = ['tools']` 是**唯一硬依赖**。`subprocess` / `shellEnv` / `workingDirectory` / `credentials` 全部用 getter 惰性 `ctx.get(...)`，缺了就按次报错（`CUSTOM_TOOL_INTERNAL`），不会让整个插件挂掉。
- **`apply()` 绝对不能返回值**。Cordis 会把返回值当 effect 校验，返回普通对象就 `Invalid effect` → fiber 失败 → 所有 disposer 回滚 → 工具全部消失（这个 bug 让 echo 消失了很久，见 §8）。
- 所有注册/监听都归 `ctx.effect`：`ctx.effect(() => ctx.on('loader/volatile-update', refresh))`、`ctx.effect(() => () => manager.dispose())`。

### 3.2 Client 半边

`client.js` 是一个**手写单文件 bundle**，通过 `window.__ModuleLoader__.load({ id: 'dsh-custom-tools', factory(require) })` 注册；`inject = ['slots', 'remote', 'remote.settings']`；在 `settings.section` 槽位注册 `{ id: 'custom-tools', order: 60, label: '自定义工具' }`。

它**只能读写配置，不能执行任何东西**：自定义 Remote 命名空间必须由 DSH monorepo 的 Typert codegen 生成，out-of-tree 插件做不到。所以"试运行"永远只能走 `/custom-tools test`。页面里的 argv 预览是**本地重算**的（`previewOf`），靠测试与 `bindings.js` 对拍防漂移。

读写链路：

```js
const api = ctx.get('remote.settings') ?? ctx.remote?.settings
const result = await api.describe()             // { ok: true, value: { namespaces: [ { ns, revision, value, schema } ] } }
api.mutate(ns, [{ op: 'set', path: ['tools'], value }, { op: 'set', path: ['deferLoading'], value }], revision)
```

⚠️ `describe()` 的返回**是包着的**（`{ namespaces: [...] }`，旧版叫 `views`）。早期版本解包了，重写时丢掉过一次，表现是页面上红字"设置文档里没有命名空间 custom-tools"。已修 + 有回归测试。

### 3.3 命名空间

profile row id = settings namespace = `custom-tools`。但 Host 报出来的 entry id 可能是 `include:custom-tools`（scoped）。`findNamespace` 先精确匹配 `ns | namespace | id`，再接受 `endsWith(':custom-tools')`；写入时用**解析到的那个 ns**（`namespace.current`），不要写死。

---

## 4. 配置契约（`src/config/schema.js`）

```js
Config = {
  tools: ToolSpec[]          // 整个数组是 volatile
  deferLoading: boolean      // volatile
}
```

⚠️ Schemastery 只在 **volatile 祖先**上标 `.volatile()`；在 volatile 字段下面再标 volatile 会报
`volatile fields require a fixed object path without an enclosing volatile field`。

`ToolSpec`：

| 字段 | 说明 |
| --- | --- |
| `name` | `^[a-z][a-z0-9_]{0,40}$`，不能撞内置工具名（`RESERVED` 约 30 个，含 `bash`/`pwsh`/`run_code`/`custom_tools`） |
| `title` | 只在设置页显示，不进模型上下文 |
| `description` / `whenToUse` | 模型据此决定调不调；`whenToUse` 拼成 `When to use:` 段落 |
| `mode` | `executable` \| `script` \| `bash` \| `powershell` |
| `enabled` | 关掉 = 注销工具但保留定义（仍可 preview/test） |
| `executable` | executable/script/bash/powershell 用；不写则 bash→`bash`、powershell→`pwsh`（带 Windows 回退） |
| `interpreter` | script 模式：PATH 名或**绝对路径**（venv 就写 venv 里的那个） |
| `script` | script 模式：脚本路径（模型不可改） |
| `command` | bash/powershell 模式：**作者固定**的命令文本，模型值永不进入 |
| `args` | `ArgBinding[]`，见下 |
| `cwd` | `.`（会话目录）或绝对路径；模型不可改；相对路径会被 `CWD_NOT_ABSOLUTE` 拒绝 |
| `approval` | `inherit`（交给会话策略）\| `always`（每次 `approval.request`） |
| `concurrency` | `exclusive`（默认，同工具串行）\| `parallel` |
| `timeoutMs` | 1000–600000，默认 120000 |
| `env` | 静态明文 env（键名固定，模型不可改） |
| `encodingDefaults` | 默认 `true`：python 注入 `PYTHONIOENCODING=utf-8`，java 注入 `-Dfile.encoding=UTF-8` |
| `credentials` | `[{ env, ref }]`，每次调用 `credentials.resolve(ref)`，永不缓存、永不落盘 |
| `parameters` | `Record<string, ParameterSpec>` |
| `output` | `{ parse: 'text' | 'json', schema?: string }`（schema 是 JSON **字符串**） |
| `examples` | `[{ name, args }]`，`args` 是 JSON 字符串 |

`ParameterSpec`：`type`（`string|number|integer|boolean|array`）、`items`、`required`、`default`（**JSON 文本**）、`description`、`min`/`max`/`minLength`/`maxLength`。

> 已**移除**：`enum`（设置页把未设置序列化成 `[]`，曾导致整条定义编译失败）、`scriptTrust`、`scriptSha256`（用户："我自己的脚本我自己负责"）、`sandbox`（见 §8）。

### `ArgBinding`（参数怎么变成 argv）

| 形态 | 行为 |
| --- | --- |
| `{ literal: '--color=never' }` | 固定元素 |
| `{ arg: 'path', prefix?: '--glob=', suffix?, join?, repeat?, json?, omitIfEmpty?, allowLeadingDash?, allowResponseFile? }` | 参数值 → 一个 argv 元素（`repeat` 逐项、`join` 合并成一格、`json` 输出紧凑 JSON） |
| `{ arg: 'x', stdin: 'raw' }` | 该值原样写进 stdin |
| `{ flag: 'verbose', as: '--verbose' }` | 布尔为 true 才输出（`as` 可以是数组） |
| `{ stdin: 'json' }` | 全部参数打包成一份 JSON 写进 stdin |

规则：值以 `-` 开头默认被拒（`allowLeadingDash` 放开）、以 `@` 开头默认被拒（`allowResponseFile` 放开）；含 NUL 一律拒；恰好 0 或 1 个 stdin binding。

argv 形态：

```
executable   [exe, ...]
script       [interpreter, script, ...]
bash         [exe, '-c', command, 'custom-tool', ...positional]      # $0=custom-tool, $@=positional
powershell   [exe, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
```

⚠️ **PowerShell 模式禁止 argv 传参**：实测 `powershell.exe -Command '<script>' one two` 里 `one`/`two` 被拼进命令文本、`$args.Count == 0`。所以参数只能走 `{ stdin: 'json' }`；校验期报 `POWERSHELL_ARGV_UNSUPPORTED` / `POWERSHELL_STDIN_REQUIRED`。

---

## 5. 执行流水线（`src/execution/run.js`，12 步）

1. 校参（未声明键拒绝、填默认、强转、范围校验）
2. **cwd 预检**（`workingDirectory.ensure(agent)` 或部署默认；必须是已存在目录 → `CWD_UNAVAILABLE`）——必须早于 spawn，否则坏 cwd 会被报成 `SPAWN_FAILED`
3. 审批（仅 `approval: 'always'` 调 `approval.request`，非 `allowed-once` 即失败）
4. 凭据（逐个 `credentials.resolve(ref)`，按次解析）
5. 可执行文件（`subprocess.resolveExecutable`）+ 解释器/脚本存在性；Windows 特殊处理见 §8
6. 构造精确 argv
7. env：受信 `DSH_*` facts → 编码默认 → 作者 `env` → 凭据（凭据永远最后，覆盖同名键）
8. spawn（stdout 上限 1 MB、stderr 上限 256 KB、`graceMs: 3000`、自建 `AbortController` 叠加调用方 `exec.signal` + 超时定时器）
9. `await handle.done` + `await handle.waitForExit()`（宁可报"无法确认退出"也不留下孤儿）
10. 读输出 → `classifyExit`（TIMED_OUT → ABORTED → OUTPUT_LIMIT → PROCESS_EXIT → PROCESS_SIGNALED）
11. 仅成功才 `JSON.parse` + 输出 schema 校验（`INVALID_JSON_OUTPUT` / `OUTPUT_SCHEMA_MISMATCH`）
12. 返回结果信封（宿主再按 `OUTPUT_SCHEMA` 校验一次）

**唯一成功码是 0**（Unix 约定，不做可配置白名单）。超时/abort 都先 `terminate()` 再 `waitForExit()`。

### 错误码（模型可见）

`INVALID_CONFIG` `INVALID_ARGUMENT` `TOOL_RELOADING` `CREDENTIAL_UNAVAILABLE` `APPROVAL_REJECTED` `APPROVAL_UNAVAILABLE` `CWD_UNAVAILABLE` `SCRIPT_UNAVAILABLE` `EXECUTABLE_NOT_FOUND` `SPAWN_FAILED` `ABORTED` `TIMED_OUT` `PROCESS_EXIT` `PROCESS_SIGNALED` `OUTPUT_LIMIT` `INVALID_JSON_OUTPUT` `OUTPUT_SCHEMA_MISMATCH` `CUSTOM_TOOL_INTERNAL`

> 沙箱相关三个码（`SANDBOX_DENIED`/`SANDBOX_UNAVAILABLE`/`BASH_SANDBOX_UNSUPPORTED`）已随沙箱一起删除。

### 渲染（`src/result/render.js`）

- 成功 text = stdout 原文；成功 json = 紧凑 JSON；空输出 = `（命令成功，没有输出）`
- 失败 = `[CODE] message` + stderr 尾部（40 行）+ `提示：hint`
- **`argv` / `cwd` / `durationMs` / `exitCode` 永远不进模型正文**（只在 `presentationMeta` 与用户可见诊断里）
- 正文上限 12000 字符，超限保留头 1/4 + 尾 3/4

---

## 6. 热更新与代际

- 每次 volatile 变化 → `Manager.apply(snapshot)` → `compile()`。
- 编译失败：**逐工具**保留 last-good，坏掉的工具不进新代际；整份非法（`tools` 不是数组）才整份失败并保留上一代。
- `contentHash` 覆盖**整个 plan**（不只是 `contractHash`），否则"只改 argv 的实现级编辑"会被误判为无变化而静默沿用旧代际。
- 兼容变更（`contractHash` 相同）→ 只换内部 generation 指针，**不重新注册**；破坏性变更 / 禁用 → `quiesce()`（abort 在途）→ 注销/重注册。
- 在途调用 pin 住启动时的代际：旧调用跑完旧定义，新调用用新定义。
- `TOOL_RELOADING`：slot 注销期间被调用时的结果（不会未定义行为）。

---

## 7. 设置页（`client.js`）

核心模型：**一张有序的「命令片段」表**，取代"参数表 + 绑定表"两张表。

| 片段 | 语义 | 落到 spec |
| --- | --- | --- |
| 字面值 | 固定 argv 元素 | `{ literal }` |
| 变量 | 参数值占一格，同时**就地声明**参数 | `{ arg, prefix/suffix/join/repeat/json/omitIfEmpty/allowLeadingDash/allowResponseFile }` + `parameters[name]` |
| 开关 | 布尔为 true 才出现的元素 | `{ flag, as }` + `parameters[name].type='boolean'` |
| stdin | 全部参数打包 JSON | `{ stdin: 'json' }` |

要点：

- 预览只画**形状**（一个真实 argv 元素一个框，变量画成 `<path>` 而不是值）；`repeat` 多画一个虚线虚位框；`stdin` 画成"JSON 键"。
- powershell 模式自动走 stdin，不再逐变量问"传递方式"（那是模式的属性，不是变量的属性）。
- 选项行的标题本身就是人话（"一个值占一格，有几个值就占几个格"），说明紧跟其后。
- 页面自诊断 `collectIssues` 镜像 `src/config/validate.js`；未编辑的字段（`min`/`max`/`minLength`/`maxLength`）经 `parameterOf` 原样保留；孤儿参数（没有绑定的）以 `orphan` 片段保留，保存时不会静默丢弃。
- 改草稿用稳定 `rowIds` 做 React key（否则改名会重挂卡片、打断输入）；`JsonField` 按**序列化内容**比较，不能按对象身份比较。

---

## 8. 决策日志（踩过的坑，别再踩）

### 为什么执行沙箱被整个移除

用户决定（原话）："化繁为简去掉执行沙箱限制, 因为用户应该要对自己的工具行为负责, 且很多自制小脚本或者工具执行中会产生读写这个是没办法的, 不能要求用户去改自己的小工具来适配DSH的沙箱执行限制, 这个插件的最大目的是为了让用户把手上的工具方便接入agent,而不是倒腾沙箱配置"。

所以：**不调 `ctx.sandbox.confine()`，工具与宿主同权限**。删掉了 `sandbox` 字段、三个 sandbox 错误码、`src/execution/sandbox.js`、`src/execution/dshbash.js`（staged bash 桥接）与相关测试。README 里写清"写定义的人负责行为"，不假装有隔离。

### Windows 上的 bash：PATH 里的 `bash.exe` 不是 bash

`C:\Windows\System32\bash.exe` 是 **WSL 启动器**，返回 UTF-16LE 的 `错误代码: Bash/E_ACCESSDENIED`；`%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe` 是商店 stub。`src/execution/interpreters.js` 的 `isStubBash()` 识别这两类，然后按固定顺序找真实 bash：

1. `<git 安装根>/bin/bash.exe`（由 `resolveExecutable('git')` 反推）
2. `%ProgramFiles%` / `%ProgramW6432%` / `%ProgramFiles(x86)%` 下的 `Git/...`
3. scoop 的 `git` / `msys2`
4. `%LOCALAPPDATA%\Programs\Git`、`%MSYS2_ROOT%`
5. 兜底 `C:\msys64\usr\bin\bash.exe`

另加 `decodeWideText()`：NUL 占比 ≥ 15% 时按 UTF-16LE 重解（救得回 ASCII，救不回已被替换的 CJK）。

> 历史：曾实现过"用 dsh-ops staged MSYS 运行时在受限令牌里跑 bash"（提交 `b8e9ae1`），那条路在受限沙箱下真的可行，但随沙箱一起被移除了；如果将来要恢复沙箱，`research/research-design.md` 与 `research/windows-confinement.md` 里有完整的实测矩阵。

### `apply()` 不能有返回值

Cordis 把 `apply` 的返回值当 effect 校验；返回 `{...}` 直接 `Invalid effect` → fiber 失败 → 全部 disposer 回滚 → 工具消失、只剩 Client 半边还在渲染。这个 bug 的表现是"设置页正常、工具一个都没有"。

### `link:` 包的裸 import 按 realpath 解析

装了 `link:` 之后，Node 从 `C:\Users\mark\Desktop\dsh-custom-tools` 往上找 `node_modules`，**走不到 profile 也走不到 asar**。所以 `package.json` 必须有 `devDependencies` 的精确版本（`4.0.5` / `0.2.1-rc.3` / `3.18.5`），并且项目里要 `pnpm install` 过。缺了它，Host 半边整体 `ERR_MODULE_NOT_FOUND`，而 Client 半边只 `require('react')` 照样能渲染 —— 又是一个"只有设置页活着"的症状。

### 其他小坑

- `logger` 也是受守卫的服务：`ctx.logger` 未声明 inject 直接读会抛错，把"配置有问题"升级成"插件挂掉"。`index.js` 的 `warn()` 用 `try/catch` + `console.warn` 兜底。
- Schemastery 把未设置的 `enum` 序列化成 `[]`；校验器必须把空数组当"无约束"。
- 宿主 author DSL 的 scalar 节点**不支持 `min/max/minLength/maxLength`**（只允许 `type/enum/const`），范围校验只能在 `normalizeArguments` 里做。
- 数组参数必须带 `items`；`oneOf` 不能与 `type` 同层；object 必须显式 `additionalProperties`。
- 跨 VM realm 用 `assert.deepEqual` 比较数组会失败（同结构不同原型），改 `Array.from(...)` 或字符串比较。
- ops_bash 的 command 走 JSON 解码，`\\` 会被压成 `\`；写脚本/路径时优先用正斜杠或用 python 脚本传 `sys.argv`。

---

## 9. 已知问题与建议下一步

### P0 — 先确认可用

1. **设置页真机验收**：`65c5774` 修了 `describe()` 解包，但用户还没在新版本上点开过。刷新应用窗口 → 设置 → 自定义工具，应看到 `revision N` 与四张卡片；若仍是红字，把新的报错文案发回来。
2. `rg_search` 无命中时返回 `[PROCESS_EXIT] 退出码 1`（ripgrep 用 1 表示"没找到"）。产品决策未定：
   - 保持现状（语义干净，模型能看出"没匹配"），或
   - 改成 bash 包装（`rg … ; s=$?; [ $s -le 1 ] && exit 0; exit $s`）——没匹配即成功，但工具不再是 executable 模式。

### P1 — 明显缺口

3. **`LICENSE` 文件缺失**，但 `package.json` 声明 `"license": "MIT"`。发布前补上。
4. **未发布到 npm**：`files`/`exports`/`dsh.bundle.patch`/`dsh.client.inject` 都已就绪，缺 LICENSE 与一次 `npm pack` 验证 + 浏览器端真实安装验证。
5. **凭据 / 审批 / `deferLoading` / `cwd` 绝对路径** 四条路径没有真机演练过（有单测，但没有真实 credential store 与真实审批回合）。
6. **`research/legacy-node_modules/`** 是历史残留（已 gitignore），可以删。
7. **i18n 不完整**：`locale/*.json` 只有 `meta.title/description`，界面文案硬编码中文。

### P2 — 体验与能力

8. 页面缺"导入/导出 JSON"按钮（命令族有 `add` / `export`，页面上没有对应入口）。
9. stdout 上限 1 MB 偏紧：大型构建日志会直接 `OUTPUT_LIMIT` 硬失败。可考虑把上限做成配置项。
10. stdout/stderr 是分开收集的，**交错顺序丢失**（`collected.stdout` / `stderr` 各自读）。
11. 参数类型只有 `string|number|integer|boolean|array`，没有 `object`；`env` 不支持引用其他环境变量或 `DSH_*`。
12. 没有后台/长任务（jobs）能力，长命令会占用一轮对话（v1 有意砍掉）。
13. 无 CI、无 lint、无类型检查（纯 JSDoc）；`test-support/` 的宿主替身是手写复刻，宿主升级时**最容易漂移**的地方。

### 升级 DSH 时要重点复验的契约

- `defineTool` 的 options 形状与 author DSL 允许键（`dsh-tools/lib/types/schema.js`）
- `ctx.tools.register()` 的校验项（`output.render` 必填、`timeoutMs` 正有限数）
- `ctx.subprocess.spawn` 的 `stdio` 形态（`{ data }` 写 stdin、collect 对象读输出、`waitForExit` 语义）
- `remote.settings.describe()` 的载荷形状（`{ namespaces: [...] }`）与 `mutate(ns, ops, revision)` 的路径必须是 volatile
- `loader/volatile-update` 的派发方式（按 fiber 过滤）与 Schemastery 的 volatile 嵌套限制

---

## 10. 硬约束（下个 session 不要破坏）

1. **零插值**：模型的值永远只能作为 argv 元素 / stdin 字节 / env 值进入；绝不能拼进 shell 源码、绝不能改程序、脚本、cwd、env 键名、凭据引用。
2. **共享包必须是 peer + dev**：`@deepseek-ai/cordis`、`dsh-tools`、`schemastery` 不能进 `dependencies`。
3. **`apply()` 不能返回值**；所有注册/监听归 `ctx.effect`。
4. **不要手动往 profile 里 `pnpm install` 插件**；安装走 `plugin_manager`。但**改用户工具定义**可以直接改 `~/.dsh/profiles/desktop/cordis.patch.yml`（`dsh-hmr` 会热加载）。
5. **不要用 `ctx.shell`**：它只收 `command: string`，用它就意味着插值。
6. **唯一成功码是 0**，不做可配置白名单。
7. 结果正文里不出现 argv / cwd / duration / sandbox 细节。

---

## 11. 交接清单（5 分钟）

```bash
cd /c/Users/mark/Desktop/dsh-custom-tools
git status --short          # 应该是干净
git log --oneline -1        # 65c5774
node --check client.js
node --test                 # 76 pass
```

然后：

1. 请用户**重启 DSH 应用**（若刚改过模块代码）或刷新窗口（若只改过 `client.js`）。
2. 在会话里跑 `/custom-tools list`，确认四个工具都在、`registered: true`。
3. 打开 设置 → 自定义工具，确认能看到 `revision N` 与四张卡片、能展开编辑、保存后 `/custom-tools list` 立即反映。
4. 跑一条 `/custom-tools test rg_search {"pattern":"export const inject"}` 验证执行链路。
5. 再决定 P0/P1 里哪一条先做。

---

## 12. 用户现场的四个工具（`~/.dsh/profiles/desktop/cordis.patch.yml`，`:142-314`）

| 工具 | mode | 关键点 |
| --- | --- | --- |
| `python_pretty_json` `:146` | script | `interpreter: python`、脚本 `C:\Users\mark\.dsh\custom-tools\scripts\pretty-json.py`；参数 `path`(必填) + 开关 `sort_keys`→`--sort` |
| `bash_grep` `:181` | bash | `command: 'grep -rnI --color=never -- "$@"…'`（没命中 exit 1 被翻成 0）；`$@` 位置传参 |
| `pwsh_recent_files` `:212` | powershell | 参数只走 `{ stdin: 'json' }`；`Get-ChildItem` + 时间过滤；未写 `executable` → 自动回退 `powershell.exe` |
| `rg_search` `:259` | executable | `C:\Users\mark\.dsh\custom-tools\bin\rg.exe`（从 DSH asar 复制出来的 ripgrep 15.0.0，避免随 app 升级失踪）；`concurrency: parallel` |

辅助资产：`C:\Users\mark\.dsh\custom-tools\scripts\`（python 脚本）、`C:\Users\mark\.dsh\custom-tools\bin\`（rg.exe）。

> 这四份定义**只存在于 profile patch 里**，不在本仓库中。仓库里的 `examples/` 是同类示例，可以 `/custom-tools add` 直接导入。
