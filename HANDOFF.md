# dsh-custom-tools 交接文档

> 写给下一个 session：把"用户手上的可执行文件/脚本/shell 命令"变成模型能调用的 DSH 工具。
> 本文档记录**当前实现状态、为什么这么做、还剩什么没做、哪些坑已经踩过**。
> 权威设计文档在 [`research/research-design.md`](research/research-design.md)（1215 行，v2 实施规范）；本文档是实现与现场的现状快照，冲突时以代码 + 本文档的"决策日志"为准。

---

## 0. 三十秒版本

| 项 | 值 |
| --- | --- |
| 仓库 | `C:\Users\mark\Desktop\dsh-custom-tools`（Git，`main`） |
| 最新提交 | `456e003 fix(icon): declare the top-level icon field`（tag `v0.1.2`）；工作树干净，与 `origin/main` 同步 |
| 版本 | `package.json` **0.1.3**；tag `v0.1.1` / `v0.1.2` / `v0.1.3`；npm `latest = 0.1.2`（0.1.3 待发；发布由**人**执行，见 §8「发版靠人手」） |
| 规模 | `index.js` 133 行 + `client.js` 3264 行 + `src/**` 3652 行；测试 **116 项全绿**（12 个测试文件） |
| 宿主基线 | DSH `0.2.1-rc.3`、`@deepseek-ai/cordis` `4.0.5`、`@deepseek-ai/dsh-tools` `0.2.1-rc.3`、`@deepseek-ai/schemastery` `3.18.5`、本机 Node `v24.15.0` |
| 安装形态 | `~/.dsh/profiles/desktop` 里是**拷贝**（依赖写 `dsh-custom-tools: 0.1.1`，`pnpm-lock.yaml` 记成 tarball），**不是** `link:`；npm 最新仍是 0.1.2（0.1.3 待发）。改本仓库的模块代码**不会**进入运行中的实例，必须重装后重启 |
| 用户现场 | 5 个可用工具：`python_pretty_json`（script）、`bash_grep`（bash）、`pwsh_recent_files`（powershell）、`rg_search`（executable）、`ciallo_echo`（bash） |
| 设置页验收 | **已通过**（真机截图逐项核对，见 §7.1）：5 张卡片（验收当时是 4 张，后来加了 `ciallo_echo`）、开关、模式切换、下拉浮层、⋯ 菜单、保存/放弃都正常 |
| 给模型的管理面 | `custom_tools_schema`（只读速查）+ `custom_tools_propose`（校验后返回一行 `/custom-tools add <JSON>`，不写配置、不写文件），生效仍靠人执行那行命令（README「Agent-authored definitions」） |

**这个插件的定位**（用户定的）：不是"把 agent 放出去"，而是"把用户的工具**收窄**成一条确定命令行"。模型只能影响声明过的 argv/stdin/env **值**，永远无法影响程序、脚本、命令文本、cwd、env 键名、凭据引用。

---

## 1. 怎么跑、怎么验证

```bash
cd /c/Users/mark/Desktop/dsh-custom-tools

node --check client.js     # client.js 不能有语法错误（它是手写单文件，没有构建）
node --test                # 116 项，全绿；约 0.5s
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
| 本插件**模块代码**（`index.js` / `src/**`） | **必须重启 DSH 应用**，而且当前是**拷贝安装**：改仓库里的文件对运行中的实例毫无影响，要先把包装进 profile（`plugin_manager` 重装，或临时把依赖改成 `link:C:/Users/mark/Desktop/dsh-custom-tools`）。`link:` 形态下同样要重启——Node `ModuleLoader.loadCache` 按 realpath 缓存，同一个 URL 不会重新求值；`plugin_manager` 的 disable/enable 也不行 |
| `client.js` | 改**安装目录里那一份**（`~/.dsh/profiles/desktop/node_modules/dsh-custom-tools/client.js`）才**不用重启**：客户端插件带 HMR 接收器，存盘后设置页当场重挂（实测，见 §7.2）。改仓库副本不会触发任何重载。真不生效时再刷新页面 |
| 只是刷新浏览器页面 | 只会重载 Client 半边（`client.js`），Host 不变 |

Agent 自己**不能**刷新 Host（`unlag_refresh` 会返回"在右键菜单里打开 Agent 可以自己刷新"），所以要提醒用户重启或刷新。

---

## 2. 仓库地图

```
index.js                 组合根：读 volatile config → Manager → 注册 /custom-tools
client.js                浏览器半边（单文件，3042 行）：设置页 settings.section
cordis.patch.yml         本插件的 bundle patch：一条 bare row `id: custom-tools`
package.json             peer+dev 依赖、exports、dsh.bundle.patch、dsh.client.inject
icon.png / locale/*.json 图标与 meta 文案（i18n 只有标题/描述）

src/config/schema.js     Schemastery 适配层（唯一的 schema 声明处）
src/config/validate.js   纯跨字段校验（保存期/编译期用，返回带 path 的 issues）
src/config/document.js   工具文档读取：单个对象 / 数组 / {"tools":[...]} 三形状（add 与页面导入共用）

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

src/admin/propose.js     模型侧：custom_tools_propose，校验后返回一行 /custom-tools add <JSON>（不碰配置、不写文件、不申请审批）
src/admin/schema-tool.js 模型侧：custom_tools_schema，字段表 + 每模式一份样例 + 现有工具

src/commands/index.js    /custom-tools 命令族（list/status/show/preview/test/enable/disable/add/export）；add 与 export 走同一份工具文档三形状

test/                    12 个测试文件，116 项
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
- 除工具与命令外，还注册两个**给模型用的管理入口**（`src/admin/`）：`custom_tools_schema`（只读速查：字段表 + 每模式一份样例 + 用户现有工具）与 `custom_tools_propose`（校验后返回一行 `/custom-tools add <整份 JSON>`，缩进版同一条消息里给人核对）。两者都**不写任何东西**：配置只在人执行那行命令时变。propose 曾经带审批门、后来带草稿文件，两样都删了——add 那一步已经是 human gate；草稿则只是把同一份定义存第二遍（§8「别在 human gate 前面再加一道」）。

### 3.2 Client 半边

`client.js` 是一个**手写单文件 bundle**，通过 `window.__ModuleLoader__.load({ id: 'dsh-custom-tools', factory(require) })` 注册；`inject = ['slots', 'remote', 'remote.settings']`；注册三个槽位：

| 槽位 | 声明 | 说明 |
|---|---|---|
| `settings.section` | `{ id: 'custom-tools', order: 60, label: '自定义工具' }` | 设置页那一节 |
| `main` | `{ key: 'custom-tools' }` | 主栏面板，**始终注册**（`kind:"keyed"`，槽位契约见 asar 里的 slots-catalog：registerOptions `key` required） |
| `sidebar.panellist` | `{ id: 'custom-tools', order: 5, label: '自定义工具' }` | 左栏图标，**按偏好动态注册/注销**（`kind:"list"`；id 即 `main` 的 key，点了切面板） |

侧边栏开关是**纯客户端偏好**，存 `localStorage` 的 `dsh-custom-tools:sidebar-entry`（`'1'`/`'0'`），不进插件 config——所以拨开关不会 bump settings revision、不影响任何在用代际。`readSidebarPref`/`writeSidebarPref` 用模块级 `Set` 通知已挂载的页面，注册/注销走 `register` 返回的 disposer。

**主栏面板必须自己当滚动容器**。`main` 槽的宿主是 `centerCol`（`display:flex;flex-direction:column;overflow:hidden`），它把溢出的内容裁掉，且不保证给子元素一个确定高度，所以：

- `height:100%` 不够——实测内容直接被裁在窗口底边、滚轮毫无反应；
- 现在的做法：`S.pageScroll` 里 `overflowY:auto` + `tabIndex:0`（点一下就能用 PageDown 滚），高度由 `useEffect` 量出来写进 `style.height`（`innerHeight - getBoundingClientRect().top`，首帧可能还没布局所以先跳过 `top < 8`，rAF 里再量一次，并监听 `resize` / 父元素 `ResizeObserver`）；
- `S.pageBody` 限宽 `maxWidth:1040` 居中，避免宽窗口下内容全挤在左边。

真机验证方式（重要，见 §8「用 SendInput 才有滚轮」）：`mouse_event(0x0800)` 注入的滚轮在 Electron 里**只对会话列表生效、对普通 `overflow:auto` 元素一律无效**，会让人误判成"页面不能滚"。换 `SendInput` + `MOUSEEVENTF_WHEEL` 后设置页与主栏面板都能滚。

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
| `name` | `^[a-z][a-z0-9_]{0,40}$`，不能撞内置工具名（`RESERVED` 37 个，含 `bash`/`pwsh`/`run_code`/`custom_tools`） |
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

- 预览只画**形状**（一个真实 argv 元素一个框）。框里只有程序真正收到的那段文本：变量是 `<path>`（前后缀一起画进去），flag 是虚线框里的 `--sort` —— 参数名是作者的话，不是程序的话，只出现在左侧片段行。**数组不做特殊呈现**：它就是一种变量、占一格，几个元素变成几个 argv 是调用期的事（曾用"实体格 + 虚线格"表示 repeat，被判定为把"一个参数"读成"两个参数"）。`stdin` 画成"JSON 键"。卡片默认全部折叠（列表先扫后开）。
- 布尔开关统一叫 **flag**（预览图例、片段类型、`＋ flag` 按钮、校验文案都是这个词），"开关"这个词在界面上不再出现——它让人以为是 UI 上的开关，而它其实是"为真时插入这个 argv 元素"。
- powershell 模式自动走 stdin，不再逐变量问"传递方式"（那是模式的属性，不是变量的属性）。
- 选项行的标题本身就是人话（"一个值占一格，有几个值就占几个格"），说明紧跟其后。
- 页面自诊断 `collectIssues` 镜像 `src/config/validate.js`；未编辑的字段（`min`/`max`/`minLength`/`maxLength`）经 `parameterOf` 原样保留；孤儿参数（没有绑定的）以 `orphan` 片段保留，保存时不会静默丢弃。
- 编辑态（页面里的 draft 文档，不是已删除的草稿文件）用稳定 `rowIds` 做 React key（否则改名会重挂卡片、打断输入）；`JsonField` 按**序列化内容**比较，不能按对象身份比较。

### 7.1 控件层用宿主组件库

设置页所有控件（按钮、开关、复选、下拉、分段、标签、折叠箭头、方形工具钮）都换成 DSH 自己的
`@deepseek-ai/dsh-client-ui-primitives`，外观与宿主设置页一致；拿不到时逐个回落到原先手写的实现。

- 接入点：`client.js` 里 `const H = (() => { try { return require('@deepseek-ai/dsh-client-ui-primitives') } catch (error) { ... return null } })()`，再经 `host(name)` 按名取组件。适配层是 `Chip` / `Button` / `TextInput` / `NumberInput` / `Select` / `Switch` / `Checkbox` / `Segmented` / `twistIcon` / `iconButton`。
- **它不是 npm 包**：磁盘上没有这个目录，是 shell 通过 `window.__ModuleLoader__` 预置的静态模块（`dsh-web-frontend/dist/assets/index-*.js` 里 `staticModules` 的 11 个条目之一），所以 `package.json` 只能把它记成 optional peer，装不上也不该装。
- 官方指南（`guide/plugin-dev-guide.md:332`）明文劝插件别 require 它：API 无预警变化，抛错的组件会把整个 `settings.section` 抹白。这里接受这个风险，代价与防线都写进 README 的「Controls」。
- 两处**故意**不换：`<textarea>`（宿主没有多行输入，`InlineEditor` 回车即提交，与"显式保存"打架）；argv 预览的配色图例（宿主没有"这格是字面值/那格是变量"的语义色）。
- 尺寸坑：宿主 `Button` 的 `size:'sm'` 是 28px 高、左右各 10px 内边距的药丸，单独一个图标会被拉成扁矩形，所以方形按钮显式给 `{ width: 28, height: 28, padding: 0 }`；`variant:'ghost'` 无描边，只用于方形图标钮，文字按钮一律 `outline`（否则读起来像标签而不是控件）。
- 宿主没有 danger variant：`kind:'danger'` 用 `outline` + `color: var(--dsw-alias-*state-error-primary*)` 表达。
- 卡片级的「复制 / 导出 JSON / 从 JSON 导入 / 上移 / 下移 / 删除」不在卡片正文里，收进卡片头右侧的 ⋯（`CardMenu` = `iconButton(IconEllipsisOutlineRegular)` + 宿主 `Menu`，`portal` + `align:'end'`）。三个注意点：`Menu` 只负责渲染，**开合状态由 `anchor` 自己的 onClick 管**；`onSelect` 收到的是 `item.id`，选中后要自己 `onClose`；分隔项 `{ id: '', type: 'separator' }` 的 id 会作为该 div 的唯一子节点渲染，给空串才不会画出文字（`.separator` 是 `height:.5px`，文字会溢出来）。

### 7.2 真机自检怎么做的（没有 DevTools 也能看）

DSH 的 Web UI 走 `127.0.0.1:54438` 且要 token（401），但**桌面窗口可以截图和点击**：PowerShell + `Add-Type`
声明 `user32` 的 `GetClientRect` / `ClientToScreen` / `CopyFromScreen` 截客户区，`SetCursorPos` +
`mouse_event` 点击，`SendKeys` 打字，`mouse_event(0x0800)` 滚轮。截图 2560×1392。

- 设置入口：窗口左下角**头像** `(30,1374)` → 菜单「设置」`(48,1239)`；弹窗左侧导航「自定义工具」`(976,730)`。（`Ctrl+,` 用 SendKeys 发不进去，走菜单可以。）
- 关键发现：**只改 `client.js` 不需要重启应用**，客户端插件会自动热重载、设置页当场换新实现（与 §1 表格里"必须重启"的说法不符，那条只对 `index.js`/`src/**` 成立）。注意改的必须是 **profile 安装目录里的那份** `client.js`——当前是拷贝安装，改仓库副本不会触发任何热重载（见 §1 表格）。
- 验收过的状态：5 张卡片（当时 4 张，后加 `ciallo_echo`）+ 标签 + 开关；模式分段控件；工具条 保存/放弃修改/重新读取 + `＋ 新增 ▾`（四模式二级菜单，无宿主 `Menu` 时回落成四个按钮）+ 从 JSON 导入；卡片 ⋯ 里的 导出 JSON / 从 JSON 导入…；覆盖已有工具时的二次确认弹窗；bash/powershell 卡片的 shell 可执行文件框 + 「用默认」；审批/并发/输出解析下拉浮层（portal 到 body、当前项带对勾）；工作目录分段；UTF-8 复选；命令片段的折叠/上移/下移/删除图标钮；`保存` 在**有改动**时是白底深字的 primary、**无改动**时是降透明度的禁用态（宿主约定）。改完用「放弃修改」回滚，`git status` 仍只有 `client.js`。

### 7.3 文案与 Info 的写法（改文案前先读这条）

页面上的解释分两层，别再把它写成一段段灰字：

- **标签 + ⓘ**：凡是"这句话是给谁看的、为什么这么填"的解释，一律走 `Info`（宿主 `Tooltip` +
  `IconQuestionOutlineRegular`，`maxWidth: 320`；宿主缺失时降级成原生 `title`）。`Field` 新增 `info`
  入参，ⓘ 跟在标签后面，不占正文。
- **hint**：只留单位和区间这类一眼要看到的（`1000 – 600000`）。超过一行的说明就不是 hint 了。
- **句式**：陈述事实，不劝、不解释动机、不用"请注意/简单来说/只需要"。例：「模型只能提供参数值；程序、命令文本、工作目录与环境变量名都来自定义」。禁用「一键/轻松/强大/丝滑」这类空词。
- 文案是**给模型看的产品面**：`description`/参数 `description` 会进模型上下文，写清用途与取值边界，不写实现细节。

两条样式坑（改 `S` 前必读）：

- 宿主 `Input` 在 grid 列里**不会自动收缩**：`minWidth: 0` 只解开 grid item 的 `min-width: auto` 下限，`<input>` 仍是 `width: auto`（固有宽度约 20 字符），必须**同时**给 `width: '100%'`，否则输入框会溢出到相邻列、两个字段的框直接压在一起。
- 宿主输入框/按钮是**透明底 + 0.5px 描边**，不是填充块；`<textarea>` 也要设 `background: 'transparent'` + `border: 0.5px solid var(--dsw-alias-border-l3)` 才和它们同一套视觉。JSON 类文本域用 `S.areaMono`（等宽），散文类（描述、何时使用）用 `S.area`（继承正文字体）。

字段行用几列的网格：字段数固定才用 `S.grid2` / `S.grid3`；"有时 2 个、有时 3 个"的行（前缀/后缀/分隔符、数组输出）用 `S.gridFit`（`repeat(auto-fit, minmax(150px, 1fr))`），字段几个就平分几份。

### 7.4 数组参数在页面上的形态

数组只有三种真实用法，页面上就只给三个出口：

| 用法 | 页面控件 | 写出的绑定 |
| --- | --- | --- |
| `rg -g a -g b`、`git add a b c`（重复选项 / 位置参数逐值一格） | 「数组输出：每值一格」（**切到 array 类型时的默认**） | `repeat: true`，每个元素一个 argv，前缀/后缀逐元素加 |
| `--fields a,b,c`（整组进一个 argv） | 「数组输出：合并为一格」+ 可选「分隔符」 | `join: '<分隔符>'`；分隔符留空 = 引擎的默认空格连接 |
| 工具要一段原始 JSON 文本 | 「参数形态 → 按 JSON 输出」 | `json: true` |

引擎默认（`src/compiler/bindings.js:47-70` `emitArray`）是"没设 `repeat` 就整组合并、`join` 未定义时用空格"。所以：**把类型切到 array 时页面会自动写上 `repeat: true`**（用户的一次点击，不是偷偷改存档），已有的定义保持原样不动；分隔符输入框只在「合并为一格」时出现，留空显示占位「空格」，不编造逗号。

---

## 8. 决策日志（踩过的坑，别再踩）

### 用 SendInput 才有滚轮，`mouse_event` 的滚轮是假的

自动化验证界面时先用了 `mouse_event(0x0800, …, d)`，现象极具误导性：**会话列表能滚、设置弹窗与主栏面板完全不动**，于是先怀疑自己写的 `overflow` 没生效。真相是这条老 API 注入的滚轮事件在 Electron 里不可靠（只有自绘滚动区的会话列表响应）。换成 `SendInput` + `MOUSEEVENTF_WHEEL`（每格 `±120`，逐格发送）后，任何原生 `overflow:auto` 元素都能滚。同理：`GetWindowRect` 必须先 `SetProcessDpiAwarenessContext(-4)`（per-monitor v2），否则拿到的是被虚拟化的尺寸（`1296x828` 报成 `2576x1408`），截图坐标全错。

另外 Electron 的 DevTools 是同一个进程的另一个 `Chrome_WidgetWin_1` 窗口（默认 `800x600`），一旦按了 `Ctrl+Shift+I`，`Process.MainWindowHandle` 会指向它，后续点击全落进 DevTools——按窗口面积挑最大的那个可见窗口。

### 插件图标要写在 `package.json` 顶层，不是只写 `exports["./icon"]`

0.1.0/0.1.1 只声明了 `exports["./icon"]: "./icon.png"`，装出来在「插件」页显示的是宿主默认的蓝色字形。宿主 `readPluginMeta(specifier, parentURL)` 里的 `iconOf()` 先看 `manifest.icon`（顶层字段，按 package.json 所在目录解析相对路径，**不经过模块解析器**），只有顶层字段缺失才回落到 `optionalResourcePath(\`${specifier}/icon\`)`。同门三个插件（better-sidebar、archive-manager、dsh-ops）都写了顶层 `icon`——这才是实际生效的那条路。补上 `"icon": "./icon.png"` 后重启应用，图标立刻正确；`exports["./icon"]` 保留作后备。

顺带：图标文件支持 SVG / PNG / JPEG / WebP，上限 256 KiB，必须在包内；宿主按 `<img>` 渲染，所以 SVG 里的 `currentColor` 不生效——原来那份 24×24 线稿因此深色主题下几乎看不见。

### 一份工具文档，三个形状：add、export、页面导入必须共用

0.1.2 的 `export` 输出的是**裸数组**，而 `add` 只收**单个对象**，页面又没有导入入口——导出文件没法原样贴回去，用户得自己手工拆数组。修法是统一到"工具文档"这一层：`src/config/document.js` 的 `readToolDocument` 接受**单个对象 / 对象数组 / `{"tools":[...]}` 包**，`add` 逐项 `validateTool` 后**全部通过才一次 mutate**；`export` 无参写 `{"tools":[...]}`（与设置文档同形），带名字写单个对象（与 `show` 同形）；`client.js` 里 `parseToolDocument` / `planImport` / `applyImport` 走同一套判定，并顺手剥 ` ```json ` 围栏与 BOM——从聊天窗粘过来的围栏是标点，不是内容。

配套的三条产品决定：

- **覆盖必须二次确认**：页面导入与卡片导入只要命中已有工具名，先弹 `ConfirmDialog` 列出将被覆盖的名字。导入本身只改编辑区，**点「保存」才写 profile**——这是"页面不能执行任何东西"的延续，也是回滚成本最低的形态。
- **卡片菜单是分享的入口**：「导出 JSON」给只读框 + 复制按钮（`navigator.clipboard` 失败回落到 `execCommand`），「从 JSON 导入…」要求恰好 1 个工具，没写名字时继承当前卡片名——"导出、改一个字段、贴回来"不用重打名字。
- **bash/powershell 的 shell 路径是 `executable` 字段**：`compile.js` 早就按 `spec.executable ?? 'bash'|'pwsh'` 取 shell，运行期也有 `bashCandidates()` 与 `POWERSHELL_FALLBACK`；缺的只是 UI。字段留空 = 默认，**不能写空串**（`??` 不会把 `''` 当缺失，会去 spawn 空名字），所以「用默认」按钮是 `delete copy.executable`，校验器与页面也各拦一道空串。客户端拿不到通用文件选择器（`pickFiles` 需会话、`directoryPick` 只给桌面主体、`showOpenDialog` 在主进程），所以沿用解释器那种「PATH 名或绝对路径」文本框。

### 面板宽度：`minmax(0, 1fr)` + 就地裁剪

设置页第一次在真机上展开卡片时，整个面板被水平推出去约 150px，右侧的滚动条一拖就把左侧标签（「环境变量」「凭据引用」）裁没了。原因是网格里的 `1fr` 列**至少和它最宽的项一样宽**：一个不换行的 argv chip（`whiteSpace: pre`，内容就是整段 bash 命令）或一条长 mono 路径，会把整条网格线撑开，而外层只负责 `overflow: auto`。

修法固定成两条规则，改布局时别退回：

- 顶层 `S.wrap` 用 `gridTemplateColumns: 'minmax(0, 1fr)'`，`card` / `cardBody` / `panel` / `panelBody` / `grid2` / `grid3` / `gridFit` 一律补 `minWidth: 0`——让子项能收缩到比内容窄。
- 宽内容在**自己身上**裁剪或换行：`S.preview` 加 `minWidth: 0; overflow: hidden`，`S.chipBox` 加 `maxWidth: '100%'; overflow: hidden; textOverflow: ellipsis`，`S.pieceHead` 加 `flexWrap: 'wrap'`。

shell 路径框同理，不能放进 flex 行：kit 的 `Input` 按容器宽度定尺寸，放在 `flex: 1` 的格子里会缩回约 20 字符宽（真机上实测就是这样）。用 `S.shellRow`（`gridTemplateColumns: 'minmax(0, 1fr)'`，有值时为 `minmax(0, 1fr) auto`）把输入框放在一整行的第一列，`用默认` 按钮跟在第二列。

### 发版靠人手，而且产物必须来自干净树

`npm publish` 要认证和 OTP，**agent 只能准备，不能发布**。分工固定：

- agent 做：改代码、升 `version`、`node --check client.js`、`node --test`、`npm pack --dry-run` 看清单、打 tag；
- 人做：`npm publish`，并确认 2FA。

v0.1.1 的教训：registry 上的 `dsh-custom-tools@0.1.1` tarball **没有** `icon` 字段（`npm view dsh-custom-tools@0.1.1 icon` 为空，解包看也是空），而现场 profile 里装的那份 `0.1.1` **有**（`package.json` 第 4 行）。所以那次发出去的产物不是从干净 tag 构建的，现场装的是脏工作树本地 `pack` 的拷贝——`0.1.1` 不可复现。`0.1.2` 已经对齐：tag `v0.1.2`、仓库 `HEAD`、npm tarball 三者 `package.json` 逐字节一致。

发版前的最小核对：

```bash
git status --short && git log --oneline -1     # 干净，且这个 commit 就是要打的 tag
node --test                                    # 116 pass
npm pack --dry-run                             # 清单：index.js client.js src locale icon.png cordis.patch.yml README LICENSE
npm pack && tar -xOzf dsh-custom-tools-<v>.tgz package/package.json | grep -E '"version"|icon'
```

判断标准：**tag 指向的提交必须能重现发出去的 tarball**；做不到就别发，宁可把那个版本号废掉。装完再核一次 `~/.dsh/profiles/desktop/node_modules/dsh-custom-tools/package.json` 的 `version` 与 npm 一致——不一致就说明装的是本地包，0.1.1 那次就是这样。

### 0.1.3 里有什么（给发版的人的现成 changelog）

- **JSON 导入/导出打通**：`/custom-tools export` 无参输出 `{"tools":[...]}`（带名字输出单个对象），`add` 接受「单对象 / 对象数组 / `{"tools":[...]}` 三形状」并先全部校验再一次性写入；设置页新增「从 JSON 导入」「＋ 新增 ▾」菜单、卡片 ⋯ 的「导出 JSON / 从 JSON 导入…」，任何覆盖都先弹二次确认。
- **bash / powershell 可选 shell 路径**：卡片上新增「Bash / PowerShell 可执行文件」整行输入框（留空=默认 `bash`/`pwsh`，Windows 自动找 Git Bash/MSYS2），空串会以 `MODE_FIELD_REQUIRED` 拒绝（`compile` 用 `??`，空串不是"缺失"）。
- **侧边栏入口**：设置页与主栏面板底部有「在侧边栏显示入口」开关（`localStorage` 偏好，不写 profile、不 bump revision），勾上后左栏多出「自定义工具」，点它打开整宽面板（`main` 槽 `key: 'custom-tools'`）。
- **两处页面布局统一**：工具条（保存/放弃修改/重新读取 + ＋新增/从 JSON 导入）→ 两个复选框 → 卡片 → 提示；主栏面板自带滚动容器（高度按视口量，`overflow-y:auto`）。
- 修掉真机上「面板内容偏左 / 滚轮不能滚」两个问题。

### 别在 human gate 前面再加一道门

`custom_tools_propose` 最初在写草稿前调 `ctx.approval.request()`。两个问题：

1. **重复门控**：真正改配置的是人跑 `/custom-tools add`，那一步已经是 human in the loop。
2. **静默拒绝**：`decide()` 在 `effectivePolicy(session) === 'never'` 时**不弹卡片**、直接返回 `rejected`。设置页的「完全权限」档正是 `never`，于是模型得到"用户拒绝了这次提议"，而用户屏幕上什么都没出现——我按 `rejected` 写文案时把人搞懵了（用户原话"我没有看到审批提示"）。权限档与 policy 的映射在 `@deepseek-ai/dsh-permission-presets/lib/index.js:141-155`，`NEVER_SENTENCE` 在 `@deepseek-ai/dsh-user-approval/lib/index.js:39`。

现在的契约：propose **只校验、只返回一行命令**，不写配置、不写文件、不申请审批。中间那一版还写过草稿文件（`~/.dsh/custom-tools/drafts/<name>.json`），用户判定为"鸡肋"并砍掉——理由是：草稿要有人读才有意义，而能读它的只有人；于是同一份定义存在两遍，还得再补一个 `add --draft` 才能串起来。命令本身就是产物：`/custom-tools add <整份 JSON>`，`add` 吃的是整行剩余文本，不需要引号转义，粘贴的字节和校验过的字节一致。判断标准：**能在一步里完成的门控，不要拆成两步再想办法把两步接起来。**

### 给模型的管理面必须自带字段词汇表

实测（盲测，只给 propose 的 description）：模型编出了 `execution: { type:'bash', command:"rg … '{{pattern}}'" }`——**插值**，正是本插件禁止的形态；`parameters` 写成 JSON Schema。而当时的校验器**静默忽略**未知键，模型只看到四条互不相干、都没说清正确写法的报错。

现在三处兜住：`custom_tools_schema` 返回字段表 + 每模式一份**能过校验**的样例（`test/schema-tool.test.js` 用 `validateTool` 跑一遍，样例不许烂）；校验器对未知键报 `UNKNOWN_KEY` 并列出可用字段（带 Levenshtein 猜测）；`parameters` 像 JSON Schema 时只报一条 `PARAMETERS_IS_SCHEMA` 并给出正确形状，不再刷四条噪音。

字段表要覆盖到**第二层**。第二轮盲测里模型已经知道 `parameters` 是映射，却在数组参数上写了 `items: { "type": "string" }`——因为参数规格内部的键名当时没列。所以 `custom_tools_schema` 现在单独有一节「parameters 里每个参数的字段」，并写明 `items` 是裸类型名、`default` 是 JSON 文本。

**报错必须给出可直接抄的写法。** 同一轮盲测还暴露两个"能过校验但运行时才炸/根本不动"的坑：`default: 20`（裸数字）校验通过，调用时才报「参数 count 必须是数字」；`"items": { "type": "string" }` 只说「只能是标量类型」。现在前者报 `PARAMETER_DEFAULT_TEXT` 并打印 `应写成 "20"`，后者打印「写成 `"items": "string"`；不能写成 `{ "type": "string" }`」，`PARAMETER_DEFAULT_JSON` 打印「字符串写成 `"\".\""`」。判断标准：一条报错如果没让模型知道**下一句该写什么**，它就只是噪音。

### 保存时用 pieces 重建 args/parameters，别直接写回文档

`settings.get` 返回的文档是**schema 归一化过的**：用户没写过的可选布尔会以 `repeat: false` / `json: false` / `required: false` 的形态出现。早期 `save` 直接把 `config.tools` 写回去，结果一次保存就把整份 `cordis.patch.yml` 灌满默认值（还顺带把 `script: 'C:\...'` 的单引号和 `default: 'false'` 的引号洗掉）。现在 `save` 先 `config.tools.map((tool) => applyPieces(tool, piecesOf(tool)))`，只写出有意义的键。判断标准很简单：**页面必须能把"用户没碰过的定义"原样存回去**，归一化是宿主的事，不该被 UI 固化进文件。改完用 `node research/tools/roundtrip-live.mjs` 验证五份真实定义仍能字节级往返。

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
- **状态型控件不要拿"当前值"当切换判据**：工作目录的分段控件原来写 `set({ cwd: next === 'session' ? undefined : (asString(tool.cwd) || '/') })`，而工具里存的是 `cwd: '.'`——切到「指定路径」时算出来的还是 `'.'`，`set` 等于空写，卡片不 dirty、分段点不动，看起来就是"按钮点不了"。改法：切到 custom 时如果现值不是"自定义路径"就写一个占位绝对路径（`'/'`，进输入框即选中，直接输就替换）。同理，`customCwd` 这种派生布尔值只用来**显示**，不要用来决定**写入什么**。
- **宿主 `Input` 放进 grid 列必须给 `width: '100%'`**：`minWidth: 0` 只解开 grid item 的 `min-width: auto` 下限，`<input>` 仍是 `width: auto`，会保持约 20 字符的固有宽度、画到相邻列上（症状是两个字段的输入框互相压住）。两个都要加，见 `monoStyle` / `plainInputStyle`。
- **前缀/后缀这种"有时 2 个、有时 3 个"的字段行不要用固定三列网格**：`S.grid3` 把 2 个字段挤进前两个 1fr 窄列，右侧留白又难看。改用 `S.gridFit`（`repeat(auto-fit, minmax(150px, 1fr))`），字段几个就平分几份。

---

## 9. 已知问题与建议下一步

### P0 — 先确认可用

1. ~~**设置页真机验收**~~：**已通过**。`65c5774` 修了 `describe()` 解包后，真机上能看到 `revision N` 与五张卡片，控件层也已换成宿主组件库并通过逐项截图核对（§7.1 / §7.2）。原先"开关白底白钮、保存白底白字"的配色 bug 也随之消失——宿主 `Switch`/`Button` 自带对的配色，`C.brand` 那套自绘 token 只剩少量兜底在用。
2. `rg_search` 无命中时返回 `[PROCESS_EXIT] 退出码 1`（ripgrep 用 1 表示"没找到"）。产品决策未定：
   - 保持现状（语义干净，模型能看出"没匹配"），或
   - 改成 bash 包装（`rg … ; s=$?; [ $s -le 1 ] && exit 0; exit $s`）——没匹配即成功，但工具不再是 executable 模式。

### P1 — 明显缺口

3. ~~**`LICENSE` 文件缺失**~~：已补，`LICENSE`（MIT）在仓库里，也在 `files` 清单中。
4. ~~**未发布到 npm**~~：`0.1.2` 已由人手工发布（流程见 §8）。**仍缺**：现场 profile 装的是本地 pack 的 `0.1.1`，与 registry 的 `0.1.2` 不是同一次构建（功能代码逐字节相同，差的是 `package.json` 元数据与 icon 字段的来历）；重装到 `0.1.2` 收尾，并借这次做一遍浏览器端真实安装验证。
5. **凭据 / 审批 / `deferLoading` / `cwd` 绝对路径** 四条路径没有真机演练过（有单测，但没有真实 credential store 与真实审批回合）。
6. **`research/legacy-node_modules/`** 是历史残留（已 gitignore），可以删。
7. **i18n 不完整**：`locale/*.json` 只有 `meta.title/description`，界面文案硬编码中文。

### P2 — 体验与能力

8. ~~页面缺"导入/导出 JSON"按钮~~：已补——卡片 ⋯ 的「导出 JSON / 从 JSON 导入…」、工具条「＋ 新增 ▾」+「从 JSON 导入」，覆盖一律二次确认；`add`/`export`/页面三者共用同一份工具文档三形状（见 §8「一份工具文档，三个形状」）。仍未做：整份 profile 的导入（只导工具数组，`deferLoading` 不随行）。
9. stdout 上限 1 MB 偏紧：大型构建日志会直接 `OUTPUT_LIMIT` 硬失败。可考虑把上限做成配置项。
10. stdout/stderr 是分开收集的，**交错顺序丢失**（`collected.stdout` / `stderr` 各自读）。
11. 参数类型只有 `string|number|integer|boolean|array`，没有 `object`；`env` 不支持引用其他环境变量或 `DSH_*`。
12. 没有后台/长任务（jobs）能力，长命令会占用一轮对话（v1 有意砍掉）。
13. 无 CI、无 lint、无类型检查（纯 JSDoc）；`test-support/` 的宿主替身是手写复刻，宿主升级时**最容易漂移**的地方。
14. `/custom-tools add <JSON>` 靠人粘一整行 JSON，长定义在输入框里不便核对——`custom_tools_propose` 会把同一份 JSON 缩进打印一遍供人核对，但"人能读懂多长的 JSON"是这套设计的天花板。

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
8. **宿主 UI 组件只能从 `host(name)` 拿**，不许在别处散着 `require('@deepseek-ai/dsh-client-ui-primitives')`；每个控件必须保留非宿主分支，因为那个模块可能不存在、也可能在升级后改签名（§7.1）。

---

## 11. 交接清单（5 分钟）

```bash
cd /c/Users/mark/Desktop/dsh-custom-tools
git status --short          # 应该只剩预期改动
git log --oneline -1        # 456e003（tag v0.1.2）
node --check client.js
node --test                 # 116 pass
```

然后：

1. 请用户**重启 DSH 应用**（若刚改过模块代码，且已重新装包）或刷新窗口（若只改过安装目录里的 `client.js`）。
2. 在会话里跑 `/custom-tools list`，确认五个工具都在、`registered: true`。
3. 打开 设置 → 自定义工具，确认能看到 `revision N` 与五张卡片、能展开编辑、保存后 `/custom-tools list` 立即反映；勾「在侧边栏显示入口」后左栏出现「自定义工具」，点它切到主栏面板。**两处顺序一致**：第一行 `保存 / 放弃修改 / 重新读取` + 右侧 `＋新增 / 从 JSON 导入`，第二行两个复选框（延迟加载 / 侧边栏入口）+ 右侧「共 N 个，启用 N 个」，之后才是卡片和底部提示——设置页曾经把保存条在底部又画一遍，看起来像两套工具条。
4. 跑一条 `/custom-tools test rg_search {"pattern":"export const inject"}` 验证执行链路。
5. 再决定 P0/P1 里哪一条先做。

---

## 12. 用户现场的五个工具（`~/.dsh/profiles/desktop/cordis.patch.yml`，`tools:` 从 `:143` 起，到 `:350`）

| 工具 | mode | 关键点 |
| --- | --- | --- |
| `python_pretty_json` `:145` | script | `interpreter: python`、脚本 `C:\Users\mark\.dsh\custom-tools\scripts\pretty-json.py`；参数 `path`(必填) + flag `sort_keys`→`--sort` |
| `bash_grep` `:180` | bash | `command: 'grep -rnI --color=never -- "$@"…'`（没命中 exit 1 被翻成 0）；`$@` 位置传参 |
| `pwsh_recent_files` `:212` | powershell | 参数只走 `{ stdin: 'json' }`；`Get-ChildItem` + 时间过滤；未写 `executable` → 自动回退 `powershell.exe` |
| `rg_search` `:267` | executable | `C:\Users\mark\.dsh\custom-tools\bin\rg.exe`（从 DSH asar 复制出来的 ripgrep 15.0.0，避免随 app 升级失踪）；`concurrency: parallel` |
| `ciallo_echo` `:323` | bash | 只有一格文本参数的卖萌回显：`command: printf 'Ciallo～(∠・ω< )⌒★ %s\n' "$*"`，`args: [{ arg: text }]` |

辅助资产：`C:\Users\mark\.dsh\custom-tools\scripts\`（python 脚本）、`C:\Users\mark\.dsh\custom-tools\bin\`（rg.exe）。

> 这五份定义**只存在于 profile patch 里**，不在本仓库中。仓库里的 `examples/` 是同类示例，可以 `/custom-tools add` 直接导入。
