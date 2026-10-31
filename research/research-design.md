# dsh-custom-tools 设计稿 v2

> 状态：**v2 实施规范**。目标宿主：DSH `0.2.1-rc.3` / `@deepseek-ai/cordis` `4.0.5`。本文已按实测 API 消除 P0 冲突，是生产实现的规范来源；`adversarial-review.md` 与 `sample/` 仅为历史审查和验证 spike。
> 所有运行时结论来自当前安装包源码 + live Cordis inspection，路径与行号可复核；`✅` = 我亲自读过源码，`🔍` = 独立审查员验证，`💡` = 判断/取舍。

**v2 修订记录（相对 v1）**

| 变更 | 依据 |
|---|---|
| **Jobs 整体移出 v1** | 用户决定：优先实现简单；且 `jobs.start` 同步调 `run()` 与沙箱异步前置冲突（BLOCKER B1） |
| **preset 作用域移出 v1** | `composedPreset` 无 preset 时返回 `undefined` → 工具静默消失（M8）；也避免让用户面对 preset 概念 |
| **GUI 设置页纳入 v1**，执行能力仍留在 `/custom-tools` 命令族 | `settings.section` 通过 `remote.settings.describe()/mutate()` 编辑并持久化 volatile Config；浏览器无 Host 执行通道，因此 preview/test/status/list 仍由命令族承担 |
| **「测试 / 试运行」升为一等公民** | 用户要求：配置完必须能立刻测，不能等运行时才发现错 |
| **执行沙箱整体移除**：工具与宿主同权限运行 | 用户决定（v1 收尾）：自制小工具运行时会读写 `temp`/缓存，不能要求作者为适配 DSH 沙箱改自己的工具；插件的目的是接入已有工具，不是倒腾沙箱配置 |
| 提交协议改为「同步单点换指针 + 每步 try/catch + 复核」 | H1 / X2 |
| 代际 pin 只保留方案 B（closure 快照），release 幂等不抛 | H2 |
| 取消机制改为 ToolSlot 自建 `AbortController` | B2 |
| 输出契约按 DSL 可表达子集重写 | M4 |
| 参数映射 grammar 补 4 个缺口 | F3 |
| 禁用/破坏性更新加在途调用预警 | F12 |
| agent 起草草稿闸门 → v1.1 | 用户决定 |

---

## 0. 结论摘要（TL;DR）

1. **产品定位**：把你每天敲的那几条命令，固化成 **agent 只能按你定的参数调用** 的工具——它不能改命令、不能加参数、不能换执行方式。价值是**收窄**，不是扩展；"安全"是副产品，"agent 不能自作主张"才是护城河。
2. **插件形态**：**单 bundle**（Host 半侧 + 一个 Client 半侧），无 Jobs、无 preset 作用域。交付面 = 设置里的一个分页面 + 一组 `/custom-tools` 用户命令。
3. **工具注册**：每个工具 = `defineTool()` 定义 + 稳定 ToolSlot；热更新靠**不可变 Generation + 单点换指针**，不重注册。
4. **执行引擎**：统一 `ctx.subprocess`（exact argv），**不调用 `ctx.sandbox.confine()`**，与宿主同权限运行。**不用 `ctx.shell`**——它是 composition 选择的单方言 seam，同 context 只能挂一个实现，无法同时承载 Bash 与 PowerShell。
5. **参数绑定**：模型值**永不进入命令文本**，只经 argv / stdin / env。不做模板、不做转义 helper（见 §5）。
6. **热更新**：定义存插件 volatile Config（方案 A）→ 保存后 `loader/volatile-update` → 全量校验编译 → **同步提交**；失败保留 last-good。commit 内**禁止 `await`**，drain/retire 推到下一 microtask。
7. **热启停**：单工具启停是插件内部 `active → quiescing → hidden` 状态机 + 自建 `AbortController`，不碰 Plugin Manager。
8. **必须能测**：`/custom-tools test` 走**与真实调用完全相同的执行流水线**（只是绕过模型），输出逐元素 argv + 完整执行事实；`/custom-tools preview` 只预览不执行。

---

## 1. 已确认的运行时契约（带证据）

### 1.1 Tools registry

| 事实 | 证据 |
|---|---|
| `register(definition): () => void` 返回精确 unregister disposer；**无 update/batch API** | `...\@deepseek-ai\dsh-tools\lib\index.js:2968-2983` ✅ |
| 注册期**不查重名**（只校验 render/schema/timeout/run_code），重名在 `insert` 时才抛 | `...\dsh-tools\lib\types\index.js:468-489`、`:167-181` 🔍 |
| **先 insert 后 `onChange`**，但 undo 在 `onChange` 之前已 yield → Cordis 在 setup 失败时执行 undo，不会留下半注册 | `...\dsh-tools\lib\index.js:2982`；`...\dsh-scope\lib\index.js:189-218`；`...\cordis\lib\index.js:1146-1153,1249-1263` ✅ |
| `ctx.emit` **冒泡无 try/catch**，一个 listener 抛错会中断后续 | `...\@deepseek-ai\cordis\lib\index.js:280-282` 🔍 |
| `createExecution()` 只捕获 `projectContent`/`finalizeContent`，**不捕获** execute body | `...\dsh-tools\lib\index.js:3227-3299` ✅ |
| body 执行前**再次**按 name/scope `resolveExecution()` | `...\dsh-tools\lib\index.js:3390-3414` ✅ |
| 结论：执行中直接 dispose/register 会「旧 projector + 新 body」或 `UNKNOWN_TOOL` | 上两条推得 |
| 回调顺序 = `projectContent` → `postExecute` → `finalizeContent` | `...\dsh-tools\lib\index.js:3459 → :3464 → :3487` 🔍 |
| `schemas(scope)` 每次投影当前定义并深拷贝参数 | `...\dsh-tools\lib\index.js:3113-3144` ✅ |
| 每次 `assemble()` 重新求值 tool providers → 变更在**下一个 model step** 生效 | `...\dsh-system-prompt\lib\index.js:348-399` ✅ |
| 即「提交中间态污染 system prompt」**不成立**（拉取式，非推送式） | `...\dsh-system-prompt\lib\index.js:356-406` 🔍 |
| 参数 DSL 是严格子集：无 `pattern`/`minimum`/`minLength`/`format`/`maxItems` | `...\dsh-tools\lib\index.js:8-49, 142-313` ✅ |
| `parameters` 隐式根对象**不会**自动 `additionalProperties:false` | `...\dsh-tools\lib\index.js:797-810` ✅ |
| 运行期对输出值做**强校验** `validateJsonSchemaValue` | `...\dsh-tools\lib\index.js:3637-3667` 🔍 |
| 输出 schema 可表达子集：`type` 与 `oneOf` 互斥；`number\|null` 必须子级 `oneOf`；annotations 仅 `description/title/default/examples` | `...\dsh-tools\lib\types\json-schema.js:196-258` 🔍 |
| `ToolErrorInfo.reason` = "raw user-facing detail; durable projections preserve it but model-facing content does not include it" | `...\docs\subsystems\tools.md:387` ✅ |
| `'tools/change'` 是注册/注销/限制变化的同步通知；**v1 唯一 listener 是幂等的** | live Event catalog；`...\dsh-tool-subagent\lib\index.js:570-591,601-604` 🔍 |

### 1.2 进程与宿主契约（历史：沙箱条目已不再使用）

> **v1 已移除执行沙箱**。下表保留为运行时取证记录（说明我们为什么不再依赖 `confine()`），不再是实现约束。

| 事实 | 证据 |
|---|---|
| `subprocess.spawn` 无默认值，必须显式 argv/cwd/stdio/graceMs/signal/env | live Service contract ✅ |
| `resolveExecutable(command, env?, signal?)` 只接受绝对路径或裸 PATH 名，拒绝含分隔符的相对路径 | `...\dsh-subprocess-local\lib\index.js:1523-1545` ✅ |
| 父环境被清洗：`/KEY\|PASSWORD\|SECRET\|TOKEN/i` **子串**匹配 + 所有 `DSH_*` 被移除；显式 entries 随后 overlay | `...\dsh-subprocess\lib\index.js:26-55`、`...\runner-launch-B2zsQ1Dz.js:690-707` ✅ |
| ⚠️ 副作用：`MONKEY_PATH`/`KEYBOARD_LAYOUT`/`GIT_ASKPASS` 也会被静默删除 | `...\dsh-subprocess\lib\index.js:32,50-56` 🔍 |
| 即 `SubprocessSpawnSpec.env` 是 **overlay**，不是完整环境 | 同上 ✅ |
| `sandbox.confine(argv, policy, signal)` 返回 `ConfinedArgv{argv,enforcement,denialSignatures,runnerFailureRules}` | live Service contract ✅ |
| **`confine` 没有 mode 短路**——`danger-full-access` 也必须自己跳过 | `...\dsh-sandbox-local\lib\index.js:305-334` 🔍 |
| runner 探测**永久缓存** `this.selectedRunner ??=`，一次失败本进程全废 | `...\dsh-sandbox-local\lib\index.js:490-494,514-520` 🔍 |
| Windows 上 ACL 探测不过 → `enforcement: "partial"`，**不是**读保密边界 | 同上 🔍 |
| 拒绝标记：`[sandbox: file access denied under ${mode} mode]`；升级提示文案**固定且会撒谎** | `...\dsh-sandbox\lib\index.js:64-77` ✅ |
| runner failure / denial 判定依赖 stderr **子串/行前缀**匹配（`"bwrap: "`、`"windows-acl-run: "`）→ 目标程序自己打印会被误判 | `...\dsh-sandbox\lib\index.js:224-237,245`、`...\dsh-sandbox-local:232-241` 🔍 |
| `isRunnerSpawnFailure` 首关 `isUsableWorkdir` → cwd 不存在时退化 | `...\dsh-sandbox\lib\index.js:203-213` 🔍 |
| `sandboxPolicy.resolve()` = `request.mode ?? overrideOf(session) ?? defaultMode`，**deployment 默认 `read-only`** | `...\dsh-sandbox-policy\lib\index.js:97-104,141` ✅ |
| 参考实现（Bash）的 full-access 短路写法 | `...\dsh-bash-sandbox\lib\index.js:65-118` ✅ |
| bash 实际 argv = `["bash","-c",command]` | `...\dsh-bash-local\lib\index.js:140-145` ✅ |
| pwsh 实际 argv = `[pwsh,"-NoLogo","-NoProfile","-NonInteractive","-Command",PREAMBLE+cmd]` | `...\dsh-pwsh-local\lib\index.js:197-205`；PREAMBLE `87-104` ✅ |
| shell 执行器默认值：timeout 120s / max 600s / output 64KB / spill 64MiB / grace 3s | `...\dsh-bash-local\lib\index.js:66-80` ✅ |

### 1.3 超时、凭据、环境

| 事实 | 证据 |
|---|---|
| `clampTimeout` 拒绝非正/非有限值，返回 `min(requested ?? def, max)`——**无下限** | `...\dsh-timeout\lib\index.js:27-46,43-45` ✅ |
| `deadline(upstream, ms, code)` 融合调用方 abort 与可识别超时；`timeoutOf` 区分来源 | `...\dsh-timeout\lib\index.js:48-72,134-146` ✅ |
| `credentialRef` 只接受 `/^[A-Za-z_][A-Za-z0-9_]*$/`（即环境变量名） | `...\dsh-credentials\lib\index.js:13-35` ✅ |
| ⚠️ 凭据 provider 持有**整表内存快照**，"不缓存"不成立；轮换生效 ≈ watcher debounce | `...\dsh-credentials-local\lib\index.js:404-412,418,451` 🔍 |
| `shellEnv.collect(execution)` 重建受信 `DSH_*`；ambient `DSH_*` 被丢弃 | `...\dsh-shell-env\lib\index.js:30-38,84-105` ✅ |
| `workingDirectory.ensure(agent, signal)` 校验/恢复 Session cwd | live Service contract ✅ |

### 1.4 HMR

| 事实 | 证据 |
|---|---|
| `watchConfig(absPath, refresh)`：绝对路径可暂不存在；`awaitWriteFinish`；只处理 add/change/unlink；`ignoreInitial:false`（注册即 refresh 一次）；disposer 等 pending refresh | `...\dsh-hmr\lib\index.js:16-121,767-780` ✅ |
| `runExclusive` 串行化所有 mutation；嵌套报 `HMR transactions cannot be nested` | `...\dsh-hmr\lib\index.js:748-760` ✅ |
| ⚠️ `runReload = runExclusive(async () => { if (await applicationReady) await op() })` → **callback 里 await 会占住整条链**，模块 reload 一起饿死 | `...\dsh-hmr\lib\index.js:757-761` 🔍 |
| profile 自身只 watch manifest/patch 并调 `reconcileProfile` | `...\dsh-hmr\lib\index.js:849-874` ✅ |
| module HMR 先 import 再撤旧，失败可回滚 cache/plugin | `...\dsh-hmr\lib\index.js:1073-1147` ✅ |
| **profile reconcile 回滚弱**：新 import 失败后旧代码不会继续跑 | `...\dsh-hmr\lib\index.js:1308-1385` ✅ |
| `watchConfig` 不是目录发现 API（无 `addDir`） | 由上推得 💡 |

### 1.5 生命周期与配置

- `ctx.effect()` 立即执行，disposer 由 fiber 拥有、逆序单次执行（`...\@deepseek-ai\cordis\src\fiber.ts:402-418` ✅）。
- `ctx.on()` 返回 disposer 且由当前 fiber effect 托管；`emit` **同步且不 await**（`...\cordis\src\events.ts:24-32, 90-106` ✅）。
- `settings.mutate(ns, ops, expectedRevision)`，冲突码 `SETTINGS_CONFLICT`；Live 表单只允许改 volatile 字段。
- `configEditor.edit(entry, change)` 持有 profile 文件锁 + 原子改 patch + 失败回滚。**绝不手改 `cordis.patch.yml`**。
- `pluginManager.setPluginEnabled/setBundleEnabled` → `ChangeResult.application ∈ {applied, restart-required, overridden, failed, cancelled}`。
- 原子写别手写：`@deepseek-ai/dsh-atomic-write` 导出 `writeFileAtomic` / `withFileLock` / `isTransientWindowsRenameError` 🔍。

### 1.6 Approval / Commands / webServer

- `ctx.approval.request(req)` **要求所在会话处于一个未结束的 turn**（`...\docs\subsystems\approval.md:86` ✅）；只返回 `allowed-once|rejected|cancelled|unavailable`，只有 `allowed-once` 放行；无 answerer → fail closed 成 `unavailable`。
- Session 策略词汇是 `ask|never`；`never` 在 dispatch 前直接拒。
- `commands.register(def)` + `@Remote execute(agent, line, attachments, signal)`：Client 可调，**但参数是 `agent`**，且每次解析成功都写 `command/run` + `command/done`（log-only，无 turn）；`recordInput` 是**定义级**字段，只能隐藏输入原文，隐藏不了生命周期 🔍。
- `webServer.register({kind:'exact'|'prefix', path, handler})` + `registerUpgrade`；`registerFallback` 已被 SPA 独占；重复 `(kind,path)` 抛错。**无内置鉴权**。

---

## 2. 四种「热」必须分开

| 场景 | 机制 | 禁止 |
|---|---|---|
| 插件 JS/TS 代码变更 | `@deepseek-ai/dsh-hmr` 模块图替换 | 把 YAML 定义当模块 import |
| 工具定义热更新 | volatile Config + `loader/volatile-update` + 全量校验 + 同步提交 | 自建文件 watcher；在 commit 里 `await` |
| 单个工具启停 | 内部 ToolSlot 状态机 + **自建 AbortController** | Plugin Manager（粒度错，会卸整个 fiber） |
| 插件行/bundle 启停 | `pluginManager.setPluginEnabled / setBundleEnabled` | 手改 profile patch |

---

## 3. 数据模型：插件 Config 的 `tools[]`（方案 A，已拍板）

用户已拍板（「选项A」）：**工具定义住在插件 Config 里**，由 DSH 的 ConfigEditor 落到 `<profile>/cordis.patch.yml`。没有独立 `tools.yaml`、没有文件 watcher、没有自建 HTTP 路由。

### 3.1 为什么是 Config

一件事换来四件事免费：

| 免费得到 | 靠什么 |
|---|---|
| 设置 UI 的读写通道 | `ctx.remote.settings.describe()/mutate()`（§11，已实证） |
| 持久化 + 文件锁 + 并发 | ConfigEditor 的 patch edit + `revision` 乐观并发 |
| Host 侧整份 Config 校验 | Schemastery `.check()` 在持久化前跑，失败 `settings/rejected` |
| 热更新不 remount | 所有字段 `.volatile()` → 只发 `loader/volatile-update`，插件实例身份不变 |

第 4 条是关键：**volatile 变更不重建 fiber**，所以 ToolSlot 存活、只需换 Generation 指针，§7 的 watcher / 原子写 / HMR 事务 / 磁盘 last-good 整条子结构消失。

### 3.2 Schema 形状：扁平 + `.check()`，不用判别联合

Schemastery 没有可用的 discriminated-union 表单渲染，而我们的页面是手写渲染（§11），所以 schema 只负责**形状、类型、枚举、数值范围**，语义校验全放 `.check()` 与编译期（§3.4）。

```ts
export interface Config {
  tools: Volatile<readonly ToolSpec[]>
  deferLoading: Volatile<boolean>
}

const ArgBinding = Schema.object({
  literal: Schema.string(),
  arg: Schema.string(),
  flag: Schema.string().description('布尔参数名；true 时产出 as'),
  as: Schema.union([Schema.string(), Schema.array(Schema.string())]),
  prefix: Schema.string(),
  suffix: Schema.string(),
  join: Schema.string().description('数组参数的连接分隔符'),
  repeat: Schema.boolean().description('数组参数逐项重复输出'),
  json: Schema.boolean().description('把参数序列化成紧凑 JSON 后输出到 argv'),
  stdin: Schema.union(['raw', 'json']).description('本条映射写入 stdin，不输出 argv'),
  omitIfEmpty: Schema.boolean(),
})

const ParameterSpec = Schema.object({
  type: Schema.union(['string', 'number', 'integer', 'boolean', 'array']).required(),
  items: Schema.union(['string', 'number', 'integer', 'boolean']),
  required: Schema.boolean().default(false),
  default: Schema.string().description('任意 JSON 默认值；以 JSON 字符串保存'),
  description: Schema.string(),
  enum: Schema.array(Schema.string())
    .description('v1 仅允许 string 参数使用非空字符串枚举'),
  min: Schema.number(),
  max: Schema.number(),
  minLength: Schema.number(),
  maxLength: Schema.number(),
})

export const Config = Schema.object({
  tools: Schema.array(Schema.object({
    name: Schema.string().required()
      .description('工具名 ^[a-z][a-z0-9_]{0,40}$，全局唯一，禁保留名'),
    description: Schema.string().required()
      .description('模型看到的说明：做什么、什么时候用'),
    whenToUse: Schema.string().description('额外使用场景，拼进 description'),
    title: Schema.string().description('设置页显示名，不影响模型'),
    mode: Schema.union(['executable', 'script', 'bash', 'powershell']).default('executable'),
    enabled: Schema.boolean().default(true),
    executable: Schema.string().description('executable 模式的 PATH 名或绝对路径'),
    interpreter: Schema.string().description('script 模式的解释器 PATH 名或绝对路径'),
    script: Schema.string().description('script 模式的脚本绝对路径'),
    scriptTrust: Schema.union(['trusted-path', 'user-managed']).default('trusted-path'),
    scriptSha256: Schema.string().description('可选的小写 64 位 SHA-256'),
    command: Schema.string()
      .description('bash/powershell 模式的固定源码；模型值只能经 argv/env/stdin 进入'),
    args: Schema.array(ArgBinding).default([]).description('声明式 argv/stdin 映射，见 §5.3'),
    cwd: Schema.string().default('.'),
      .default('workspace-write'),
    approval: Schema.union(['inherit', 'always']).default('inherit'),
    concurrency: Schema.union(['exclusive', 'parallel']).default('exclusive'),
    timeoutMs: Schema.number().step(1000).min(1000).max(600000).default(120000),
    env: Schema.dict(Schema.string()),
    encodingDefaults: Schema.boolean().default(true)
      .description('按执行器注入可删除的 UTF-8 默认设置；false 关闭'),
    credentials: Schema.array(Schema.object({
      env: Schema.string().required(),
      ref: Schema.string().required(),
    })).default([]),
    parameters: Schema.dict(ParameterSpec).default({}),
    output: Schema.object({
      parse: Schema.union(['text', 'json']).default('text'),
      schema: Schema.string().description('可选 JSON Schema；以 JSON 字符串保存'),
    }),
    examples: Schema.array(Schema.object({
      name: Schema.string(),
      args: Schema.string().description('示例参数对象；以 JSON 字符串保存'),
    })).default([]),
  })).default([]).volatile(),
  deferLoading: Schema.boolean().default(false).volatile(),
})
```

`ArgBinding` 在 Schemastery 中刻意保持扁平；`.check()` / 编译器必须保证每项恰好选择 `literal`、`arg`、`flag` 三种源之一，并且 `join`、`repeat`、`json`、`stdin` 互斥或符合 §5.3 的组合规则。`stdin` 只允许由一条映射产生。`scriptTrust:'trusted-path'` 要求绝对路径；`user-managed` 允许用户自行管理脚本位置，但仍受 cwd 与可选哈希校验约束。

两处有意的持久化妥协：

- `parameters.*.default`、`examples[].args`、`output.schema` 这类**任意 JSON** 使用 **JSON 字符串**字段承载，由 GUI 编辑器解析、规范化，`.check()` / 编译器再次验证；编译后的领域对象始终是结构化 JSON，不把字符串泄漏到执行层。
- `tools`、`args`、`credentials`、`examples` 的默认值只给空容器。**空工具数组不是错误状态**，页面显示引导卡（§11.5），不自动生成或写入示例工具。

**固定选项（`enum`）的首版约束**：只允许在 `type: string` 下出现；值必须是非空字符串数组、去重、非空串；编译成 DSH DSL 的 `{type:'string', enum:[...]}`。这样模型侧拿到的是一个封闭集合，几乎不可能填出拼错的选项（`--env prodution`）。数值枚举与"多选"留到 v1.1。

### 3.3 单个工具的字段语义

下面这份 YAML **只用于说清字段语义**（真实存储是上面 `tools[]` 的数组元素，字段名一一对应）：

```yaml
# 每个工具就是 Config 里 tools[] 的一个元素；没有文件级的 version/defaults
# 默认值全部由 Schemastery 的 .default() 承载（见 §3.2）
tools:
  - name: git_status            # ^[a-z][a-z0-9_]{0,40}$，全局唯一，禁保留名
    title: Git status
    description: 读取当前工作区 git 状态摘要。
    whenToUse: 用户询问改动/未提交内容时使用。
    mode: executable            # executable | script | bash | powershell
    enabled: true
    executable: git             # ✅ PATH 名或绝对路径；YAML 里避免裸反斜杠
    # script 模式另用 interpreter + script + scriptTrust + 可选 scriptSha256
    approval: inherit           # inherit | always
    concurrency: exclusive      # exclusive | parallel；默认保守串行
    args:                       # 声明式映射，见 §5.3
      - literal: status
      - literal: --porcelain=v1
    cwd: .                      # 相对 Session cwd；模型不可改
    timeoutMs: 15000
    parameters:                 # 转 DSH 参数 DSL
      path:
        type: string
        required: false
        default: '"."'        # 持久化字段是 JSON 字符串；编译后是结构化值
        description: 限定子目录
    output:
      parse: text               # text | json
    examples:                   # 「测试」按钮/命令的预设入参
      - name: 工作区根
        args: '{"path":"."}' # 持久化字段是 JSON 字符串
    env:
      GIT_TERMINAL_PROMPT: "0"
    credentials:                # 只写引用，永不明文
      - env: GH_TOKEN
        ref: GH_TOKEN
```

### 3.4 两级校验，两种可见性

| 校验 | 在哪 | 失败表现 |
|---|---|---|
| 形状 / 类型 / 枚举 / 数值范围 / 跨字段一致性 | Schemastery + `.check()`（Host 持久化前） | `mutate` 返回 `settings/rejected` + 消息，**GUI 当场显示，文件不变** |
| 纯语义 / 编译：重名、保留字、参数 DSL 合法性、`args[].arg` 引用未声明参数、模式缺必填项、JSON 字段、信任/哈希格式 | Manager 纯编译期（§7.3，不做 I/O） | **保留 last-good**；诊断进内存；`/custom-tools status` 显示 |
| 运行时前置：cwd、解释器/可执行文件、脚本文件与 SHA-256、Credential、审批 | 每次调用的 preflight | 返回稳定错误码；不破坏当前 Generation，不缓存 Credential |

第二级**进不了 GUI**——浏览器侧没有读取 Host 内存的通道（§11.4），这是方案 A 唯一真实的代价，用一条命令补（§11.5）。

### 3.5 历史

Config 住在 patch 里，用户可以「打开配置文件」并自行用版本控制追溯。**v1 不额外写 history 文件**，避免未验证的 profile 路径与清理策略扩大实现面；若后续加入，只能作为显式 opt-in 的 v1.1 功能。

---

## 4. 参数 DSL 与输出契约

### 4.1 参数

- v1 的 `parameters` 只允许 `type: string|number|integer|boolean|array`；数组必须声明标量 `items`。可选字段为 `required`、`default`、`description`、`enum`、`min/max`、`minLength/maxLength`。不支持嵌套 object/json 参数，复杂值可用 `string` 或标量数组并在被调程序内解释。
- **固定选项**（`--env staging|prod`）用 `type: string` + `enum: [...]`，编译成 `{type:'string', enum:[...]}`：模型侧是封闭集合，页面渲染成下拉，拼错选项这条路直接消失。v1 只支持字符串枚举。
- 类型决定"错得多早被发现"：argv 里最终都是 UTF-8 字符串，但插件在 spawn 前按声明验证。数字语义且装得进 `2^53` → `number`/`integer`；ID、版本号、可能超 `2^53` 或带前导零 → `string`。`min/max/minLength/maxLength` 由插件本地验证；DSH 模型参数 DSL 不支持的约束不伪装成模型侧约束。
- `default` **由插件自己填**（DSH DSL 的 default 仅是 annotation）。JSON 字符串解析后必须再次走同一套类型、枚举与范围校验，再进入 argv mapper。
- schema 未声明字段、类型数组、`pattern`、`format`、对象属性、嵌套数组等 → **加载期直接报错**，不假装支持。
- 由于 `parameters` 隐式根对象是**开放**的，插件另加一层「未声明参数 = `INVALID_ARGUMENT`」校验。
- **无值开关**用 `type: boolean` + args 里的 `{flag: name, as: '--verbose'}` 表达（§5.3）；**二选一开关**（`--enable-x` / `--disable-x`）用 `enum` + `{arg: mode}` 表达，把 flag 文本本身当枚举值。

### 4.2 输出契约（按可表达子集重写）

```ts
// 实际 schema（示意，全部为 DSH 子集可表达）
{
  type: 'object',
  additionalProperties: false,
  properties: {
    ok:        { type: 'boolean' },
    code:      { type: 'string' },       // 仅失败时出现，由 body 断言保证
    message:   { type: 'string' },       // 仅失败时出现，稳定、可读
    hint:      { type: 'string' },       // 可选修复建议，不含秘密
    exitCode:  { oneOf: [{ type: 'number' }, { type: 'null' }] },
    signal:    { oneOf: [{ type: 'string' }, { type: 'null' }] },
    timedOut:  { type: 'boolean' },
    aborted:   { type: 'boolean' },
    durationMs:{ type: 'number' },
    stdout:    { type: 'string' },
    stderr:    { type: 'string' },
    truncated: { type: 'boolean' },
    argv:      { type: 'array', items: { type: 'string' } },
    cwd:       { type: 'string' },
                 properties: {
                   declared:    { type: 'string' },
                   session:     { type: 'string' },
                   effective:   { type: 'string' },
                   enforcement: { type: 'string' }, // full-access 时缺省
                   denied:      { type: 'boolean' }
                 } },
    value:     { description: 'parse:json 成功时的 JSON 值' },
  },
  required: ['ok','timedOut','aborted','durationMs','stdout','stderr','truncated','argv','cwd','autoEnvKeys'],
}
```

**三处必须靠断言、不能只靠 schema**：
1. `ok:false` ⟺ `code` 与 `message` 必存在；`ok:true` 时三者都不得出现。body 内断言，并有单元测试覆盖。
2. 每个 result 都带 `autoEnvKeys`（按解释器自动注入的编码环境变量名），成功与失败形状一致。
3. `value` 只能 annotation-only；插件先断言它是 `JsonValue`，再按可选 `output.schema` 做第二层自校验。

**统一一个 output schema 是硬约束**：所有模式、所有代际共用同一 schema。这样 `createExecution` 捕获的旧 `render`/`projectContent` 作用在新代际的结果上仍然正确（§7.2）。

**错误面的两条通道**：
- 模型侧：`ok:false` + `code` + 截断后的 stdout/stderr（`render` 决定形态，保持有界）。
- 用户侧：`ToolErrorInfo.reason` 放**完整可读原因 + 修复建议**（durable 可见、model-facing 不可见）✅。

### 4.2.1 成功路径必须瘦身（schema 统一 ≠ 内容冗余）

**schema 恒定是为了机器正确，不是为了塞满模型上下文。** JSON value 保持全字段（durable、可回溯、代际固定需要它），但**模型看到的内容由 `render` 决定**，成功时就只给数据。

| 情形 | 模型看到的内容 |
|---|---|
| `parse: text` 成功 | **stdout 原文**；stdout 为空则返回 `（命令成功，没有输出）`。stderr 非空时追加一段 `[stderr]`。|
| `parse: json` 成功 | **紧凑序列化的 `value`**（不缩进，避免浪费 token）；stderr 处理同上。|
| 任何失败（`ok:false`） | `code` + 一句话 `message` + stderr 尾部 + `hint`（stderr 为空才退回 stdout 尾部）；**不打印 argv**，需要时用 `/custom-tools test`。|

v1 的 collected output 不启用 spill。任一 reader 报 `lossy:true` 就返回 `OUTPUT_LIMIT`，不得把部分输出伪装成成功结果，更不得用截断 JSON 继续解析。

**成功时永远不出现在模型上下文里的字段**：`argv`（可能很长）、`cwd`、`durationMs`、`exitCode:0`、`autoEnvKeys`、`truncated:false`、`stdout/stderr` 的重复包装。

理由：这个插件的立项动机就是"skill 方式 token 太贵"。如果每次 `echo.py` 都回一段带 argv、cwd、耗时的信封，本来 5 个 token 的结果变成 150 个——那还不如继续用 skill。

**人类仍然看得到全部**：Work log 的 `presentResult` 展示逐元素 argv、耗时、截断位置；`/custom-tools test` 打印全量诊断。**UI 层不占模型 token，模型层不为 UI 让路。**

**措辞与有界输出的细则不在这里展开**，见 §4.2.4：三段式骨架、空成功不给空串、超限明确报 `OUTPUT_LIMIT`、错误靠稳定 code；v1 不暴露 spill 路径。

### 4.2.2 验收样例：模型实际看到的正文

下面每个块就是 tool result 的内容（`▸` 只是工具名行，不属于内容）。实现时逐条对齐，作为 M2 的验收基准。

**S1 · text 成功，干净** —— 只出数据，一个字节不多

```
hello world
```

**S2 · text 成功，但程序往 stderr 写了 warning**

```
hello world

[stderr]
warning: config not found, using defaults
```

**S3 · json 成功** —— 程序打印 `{"rows":2,"ms":13}`

```
{"rows":2,"ms":13}
```

**S4 · 成功但一个字都没输出**（很多写操作就是这样）

```
（命令成功，没有输出）
```

**S5 · 输出超限（v1 不落盘，直接硬失败）**

```
[OUTPUT_LIMIT] stdout 超过 1048576 字节上限，已终止并丢弃输出

hint: 让工具只输出需要的部分（分页、加过滤参数、把日志写 stderr）
```

**F1 · 进程失败（最常见的失败）**

```
[PROCESS_EXIT] 进程以退出码 2 结束

[stderr]
usage: cli.py [-h] sql
cli.py: error: the following arguments are required: sql

hint: 退出码非 0 就按失败报（Unix 约定）；看 stderr 定位原因
```

**F2 · 程序根本不存在**

```
[EXECUTABLE_NOT_FOUND] 找不到可执行文件 "C:\tools\cli.py"

hint: 检查 executable 是否为绝对路径；PATH 里的程序在宿主进程环境下未必可见
```

**F3 · 超时**

```
[TIMED_OUT] 超过 120000ms 未结束，进程已被终止

[stdout 尾部]
正在导出 3/1000 条……
……

hint: 缩小输入或调大 timeoutMs；不要靠重试
```

**F4 · 该是 JSON 却混进了日志**

```
[INVALID_JSON_OUTPUT] stdout 不是合法 JSON（偏移 42 处失败）

[stdout 头部]
INFO 2026-10-31 01:20:11 starting
{"rows": 2, "ms": 13}

hint: 程序把日志混进了 stdout；让它把日志写 stderr，或改 parse: text
```

**F5 · 程序自己失败**

```
[PROCESS_EXIT] 命令以退出码 2 结束

[stderr 尾部]
error: unknown revision 'mian'
  did you mean 'main'?

hint: 程序已经说明了原因；改参数或改命令，不要重试同一条
```

**F6 · 参数错（根本没 spawn）**

```
[INVALID_ARGUMENT] 未声明的参数：patttern

hint: 可用参数：pattern, path
```

### 4.2.3 兜底的承诺边界

**保证（每条都要有测试）**：

1. 任何失败都有稳定 `code`，绝不出现"未知错误"。
2. 进程失败一定带退出码 + **stderr 尾部**；stderr 为空才退回 stdout 尾部。
3. 兜底不改变语义——不换命令、不重试、不换个参数再跑一次。
4. 插件自身异常转成 `CUSTOM_TOOL_INTERNAL`，不穿透 tool body。

**不保证（也不猜）**：

1. 不解释业务语义（"记录不存在"还是"参数错了"，只有作者知道）。
2. 不自动修参数后重试。
3. 不为第三方程序的历史包袱做兼容（编码、输出格式、交互式提示）。
4. 不替用户判断"这个非零退出码算不算正常"——**0 成功、非 0 失败，只有这一条规则**。像 `grep` 那样用非零表示正常结果的程序，请包一层 wrapper 或让它 `exit 0` 并改用 `parse: json` 承载状态。

一句话：**插件负责把失败讲清楚，不负责把失败变成功。**

### 4.2.4 照抄原生工具：模型侧措辞与截断的四条硬规矩

证据：`@deepseek-ai/dsh-tool-fs-search/lib/index.js:1031-1041`（`formatGrepOutput` / `formatRetainedGrep`）、`:1159-1178`（`tools/post-execute` 截断拦截器）、`:1089-1107`（description 与 parameters 的真实写法）、`:86-106`（错误分类）。原生 `grep` 是这个仓库里模型侧体验的范本，四条直接搬。

**规矩 1 · 三段式骨架：头行给事实，正文给数据，页脚给出路**

原生 `grep` 的模型正文（3 文件 5 命中）：

```
Found 5 matches

src/a.ts
Line 12: export function foo() {
Line 40: import { foo } from './a'

src/b.ts
Line 7: foo()
```

我们的对应：`ok:true` 时**不戴帽子**（S1 那样只出数据）；stderr 非空才追加 `[stderr]` 段。v1 没有"截断后仍成功"的中间态，超限一律 `OUTPUT_LIMIT` 硬失败。

**规矩 2 · 空成功绝不给空串**

原生给 `No matches found`（`:1039`），我们给 `（命令成功，没有输出）`（S4）。空串在模型眼里等同于"工具没返回"，会诱发重试或换工具。

**规矩 3 · 超限必须硬失败，绝不产生"半截像成功"的结果**

原生被截时头行 `Found 250 of 3100 matches` + 页脚定位符（`:1032`），存不下来则明说没存（`:1035`）。我们 v1 更保守：**没有 spill，也没有"截断但成功"**。

- **原始通道超预算直接失败，不解析半截**：原生抛 `SEARCH_RAW_OUTPUT_OVERFLOW`（`:102`）。我们对应 `OUTPUT_LIMIT`，并且**禁止**把截断过的 stdout 当完整结果去 `JSON.parse`——宁可报"输出超限"，也不能给模型一个"看起来解析成功"的部分值。
- `lossy:true` 一律归类 `OUTPUT_LIMIT`，不提供部分结果；v1.1 若引入 spill，才谈 `X of Y` 与定位符。

**规矩 4 · 错误靠 code，不靠文案**

原生抛 `class SearchError extends HarnessError`，携带 `SEARCH_INVALID_PATTERN` / `SEARCH_FAILED` / `SEARCH_RAW_OUTPUT_OVERFLOW`（`:65-106`），error result 上暴露 `{name, code}`，上层按 code 分支而不是正则匹配文案。落地要求：

- 所有失败走**同一个** `toErrorResult(code, message, hint)`，禁止裸 `throw new Error(文案)`；
- `hint` 按 code 从固定表取（§4.4 第 2 条），不自由发挥；
- 码表就是 §4.3，不新增散文式错误。

**明确不抄的一条**：原生还注册了 `systemPrompt.section('tool:grep')`（`:1084-1088`）抢一行全局提示。**我们不抢**——用户可能有几十个自定义工具，每个占一行系统提示会把 context 吃光；"什么时候该用我"写进各自的 `description` 就够了。

| 维度 | 原生 grep 的做法 | 我们的规矩 |
|---|---|---|
| 正文排版 | 头行计数 + 按文件分组 + `Line N:` 前缀 | 成功短正文不戴帽；结构化结果（`parse:json` 的数组）才分组 |
| 零结果 | `No matches found` | `（命令成功，没有输出）` |
| 截断 | `X of Y` + spill 定位符 | v1 不截断保留：超限即 `OUTPUT_LIMIT` 硬失败 |
| 单条超长 | `grepMaxLineBytes` 按字节截 | 不做单行截断，整体计入字节上限 |
| 原始超限 | `SEARCH_RAW_OUTPUT_OVERFLOW` 硬失败 | `OUTPUT_LIMIT` 硬失败，不解析半截 |
| 错误形态 | `HarnessError` + 稳定 code | `toErrorResult(code, message, hint)` |
| UI 卡片 | `presentationMeta` 搜索卡片 | 暂不做卡片，`presentResult` 文本足够（§4.2.1） |
| 系统提示 | 抢 `tool:grep` 一行 | **不抢**，写进 description |

### 4.3 错误码与优先级（first cause）

`preflight/approval → spawn failure → abort/timeout → 非零 exit → output parse/schema`

`INVALID_CONFIG` `INVALID_ARGUMENT` `TOOL_RELOADING` `CREDENTIAL_UNAVAILABLE` `APPROVAL_REJECTED` `APPROVAL_UNAVAILABLE` `CWD_UNAVAILABLE` `SCRIPT_UNAVAILABLE` `EXECUTABLE_NOT_FOUND` `SPAWN_FAILED` `ABORTED` `TIMED_OUT` `PROCESS_EXIT` `PROCESS_SIGNALED` `OUTPUT_LIMIT` `INVALID_JSON_OUTPUT` `OUTPUT_SCHEMA_MISMATCH` `CUSTOM_TOOL_INTERNAL`

优先级（first cause，一个失败只报最靠前的一条）：`INVALID_ARGUMENT`（spawn 前）→ `CREDENTIAL_UNAVAILABLE` / `CWD_UNAVAILABLE` → `APPROVAL_REJECTED` / `APPROVAL_UNAVAILABLE` → `EXECUTABLE_NOT_FOUND` / `SCRIPT_UNAVAILABLE` / `SPAWN_FAILED` → `ABORTED` / `TIMED_OUT` → `PROCESS_EXIT` / `PROCESS_SIGNALED` → `OUTPUT_LIMIT` / `INVALID_JSON_OUTPUT` / `OUTPUT_SCHEMA_MISMATCH`。

### 4.4 失败兜底：三层挡住，零静默降级

**一句话原则**：可以失败，但不能**莫名其妙**地失败，更不能**悄悄换个方式**成功。

#### 1) 三层拦截，越早越好

| 层 | 拦什么 | 用户何时知道 |
|---|---|---|
| **保存时**（Schemastery + `.check()`） | 必填缺失、名字格式/重复/保留字、mode 与字段不匹配（如 `mode: executable` 却没 `executable`）、`{flag}` 引用非 `boolean`、JSON 字段不可解析、`output.parse` 非法、`timeoutMs` 越界、恰好一条 stdin 映射 | 设置页立即红字（`settings/rejected`），**根本存不进去** |
| **编译期**（纯函数 `compile()`，无 I/O） | 映射引用未声明参数、参数类型不合法、信任/哈希字段格式、枚举与类型冲突、`repeat`/`join`/`json`/`stdin` 组合非法、保留字 | 保存成功但该工具不进入代际；**旧代际继续服务**（last-good），诊断进 Manager 内存，由 `/custom-tools status` 读出 |
| **调用期 preflight**（§6 流水线） | cwd 不可用、可执行器/解释器解析失败、脚本文件缺失或哈希不符、Credential 取不到、审批被拒 | 结果里的 `code`；**不改变当前代际**，Credential 与 executor 每次重新解析 |
| **调用期运行** | 超时、abort、退出码、信号、输出超限/解析/校验 | 结果里的 `code` + 有界 stderr 尾部 |

#### 2) 模型看到什么（有界、可诊断、不撒谎）

`ok:false` 时 **JSON value** 固定带：`code` / 一句话 `message` / `hint` / `exitCode` / `stdout` / `stderr` / `argv`（逐元素，凭据位脱敏）/ `cwd` / `durationMs` / `autoEnvKeys`。

但**模型正文只看到** `code` + `message` + stderr 尾部（stderr 为空才退回 stdout 尾部）+ `hint`；`argv`/`cwd`/`durationMs` 只进 durable value 与用户侧诊断（§4.2.1）。

v1 不启用 spill，所以“头部/尾部各留多少”只是有界缓冲内的自然形态；一旦 reader 报 `lossy:true` 就整体转 `OUTPUT_LIMIT`，不做部分呈现。

`hint` 是按 `code` 的**固定建议表**，不是自由发挥：

| code | hint |
|---|---|
| `INVALID_ARGUMENT` | 列出未声明的键名（隐式根对象是开放的，必须自己挡） |
| `CREDENTIAL_UNAVAILABLE` | 凭据 provider 没取到值；让用户检查凭据域，不要让模型猜 |
| `EXECUTABLE_NOT_FOUND` | 检查 `executable` 写成绝对路径；PATH 里的程序在宿主进程环境下未必可见 |
| `SPAWN_FAILED` | 检查 `cwd` 是否存在、文件是否有执行权限 |
| `PROCESS_EXIT` | 退出码非 0 一律按失败报（Unix 约定）；看 stderr 定位原因 |
| `PROCESS_SIGNALED` | 进程被外部杀掉（任务管理器/父进程/系统）；不是命令写错了 |
| `TIMED_OUT` | 缩小输入或调大 `timeoutMs`；**不要靠重试** |
| `OUTPUT_LIMIT` | 让程序少打印或加 `tail`/`head` 类参数 |
| `INVALID_JSON_OUTPUT` | 程序把日志混进了 stdout；让它把日志写 stderr，或改 `parse: text` |
| `OUTPUT_SCHEMA_MISMATCH` | 键名/类型不符；对照工具 description 里的输出约定 |

#### 3) 用户看到什么

- `ToolErrorInfo.reason`：完整可读原因 + JSON 形式的 `code/message/hint/exitCode/argv/cwd/autoEnvKeys`，**durable 可见、model-facing 不可见**。
- `/custom-tools test` 是复现入口（与模型调用**同一条代码路径**，§6.6）。
- `/custom-tools status` 在 last-good 生效时必须明说「当前仍在使用上一版定义」，并列出被拒工具的诊断。
- v1 不写 `state.json`、不做跨会话 `lastError` 持久化；设置页也**不显示**错误徽标（浏览器读不到 Host 内存，见 §11.4）。内存计数器可作为 v1.1 候选。

#### 4) 绝不做的四件事（这就是"兜底"的边界）

1. **不换命令**：CLI 失败不自动降级成另一种执行方式（比如 exe 失败退回 bash）。
2. **不自动重试**：写操作重试会重复副作用，读操作重试会掩盖真故障。重试交给模型或用户显式决定。
3. **不重跑**：失败之后绝不"顺手"换个参数再跑一次；失败就是失败，交给人判断。
4. **不吞 stderr**：即使成功也保留 stderr（很多 CLI 用 stderr 报 warning），只是不因为非空就判失败。

#### 5) 插件自己崩了怎么办

`execute` 里任何未预期异常必须在最外层 catch 成 `ok:false, code:'CUSTOM_TOOL_INTERNAL'`，`message` 给一行摘要、完整堆栈进 `reason`（durable 可见、model-facing 不可见）。绝不让异常穿出 tool body——穿出去虽然会被宿主兜成 error result，但会丢掉我们所有结构化诊断字段（`argv`/`exitCode`/`autoEnvKeys` 全没了），等于把可诊断的失败降级成"未知错误"。

---

## 5. 参数绑定：安全 vs 危险（产品核心卖点）

> **已定（方案 A）：零插值。** 模型值只能是**独立 argv 元素 / stdin / env 值**，永不进入任何 shell 源码；**不实现**受控模板语法糖（`{{arg}}`），也**不提供**任何"自动转义"helper——转义正确性依赖 bash / pwsh / cmd 三套语法，无法被结构性证明。安全性由 `execve` 的 argv 边界保证，不由插件代码保证。

### 5.1 绝对禁止

```yaml
# ❌ 任何形如以下的写法都不实现
command: "git log --author=${author}"     # 字符串插值
command: "... {{ args.path }}"            # 模板
command: "cmd " + escape(arg)             # 转义 helper
```

理由：bash/PowerShell/cmd 方言不同，目标程序还可能有二次解析（`--pretty=format:`、response file `@file`），NUL/编码/空串/数组边界无法统一。

### 5.2 四种模式的正确构造

**A. executable**
```
[resolvedExe, ...mappedArgs]
```
`resolvedExe` 只能是绝对路径或由插件 `resolveExecutable` 解析并**当次**固定；模型不可提供路径。

**B. script**（显式解释器，不依赖 shebang / 文件关联）
```
Bash:  [bash,  --noprofile, --norc, --, scriptPath, ...mappedArgs]
Pwsh:  [pwsh,  -NoLogo, -NoProfile, -NonInteractive, -File, scriptPath, ...mappedArgs]
Node:  [node,  scriptPath, ...mappedArgs]
```
`scriptPath` 必须 absolute + canonical。**双轨信任标记（已定）**：默认要求脚本位于不可写目录；若不在，必须显式声明 `scriptTrust: user-managed` 并**强制 hash pin**，未标记则拒绝加载。

**C. bash inline**（命令文本是管理员代码）
```
[bash, --noprofile, --norc, -c, fixedCommand, dsh-custom-tool, ...mappedArgs]
                 ↑ $0                    ↑ $1, $2, ...
```
`fixedCommand` 只能用 `"$1"`/`"$@"` 取参数——**参数从未进入 shell source**。

**D. powershell inline**
`-Command` 后的 native argv 跨版本会被重新解释，因此 v1 只允许：
```
[pwsh, -NoLogo, -NoProfile, -NonInteractive, -Command, PREAMBLE + fixedCommand]
```
参数走 **stdin JSON**（`[Console]::In.ReadToEnd()`）；复杂参数化请用 `.ps1 -File`。
**实测（Windows PowerShell 5.1）**：`powershell -Command 'Write-Output $args.Count' one two` 打印 `0`，
然后 `one`/`two` 各自被当成独立语句求值——尾部 token 并不绑定 `$args`，而是拼进命令文本。
因此 **powershell 模式禁止位置传参**：校验期报 `POWERSHELL_ARGV_UNSUPPORTED`，
声明了 parameters 却没有 stdin 绑定则报 `POWERSHELL_STDIN_REQUIRED`。
`PREAMBLE` 复用官方 UTF-8 preamble（`...\dsh-pwsh-local\lib\index.js:87-104`）。

**Windows 边界（已定）**：`pwsh` 7 优先，缺失时回退 `powershell.exe`；`.exe/.com` 走 executable；`.bat/.cmd` **排除**（`cmd.exe` 二次解析无法结构性保证）。
**bash 在 Windows 的受限档位只有一种运行时可用**（实测）：PATH 上的 `bash` 通常是 `C:\Windows\System32\bash.exe`（WSL 启动器，返回 UTF-16LE 的 `Bash/E_ACCESSDENIED`）；改用真实 MSYS2/Git Bash 后，它在受限令牌下连运行时都初始化不了——`Git\bin\bash.exe` 死于 `couldn't create signal pipe, Win32 error 5`（`0xC0000142`），更新的 msys2 运行时死于 `NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0S5-<hash>): 0xC0000022`；`read-only` 与 `workspace-write` 表现相同，同目录的 `ls.exe` 同样失败，而 mingw 原生 `git.exe` 正常。

唯一例外是 `dsh-ops` 自带并 stage 出去的那份运行时：pinned MSYS payload + `opsipc.dll`/`opsnt.dll` 两个 IPC 兼容代理，落在 `$DSH_HOME/dsh-ops/bash-ipc/<identity>/usr/bin/bash.exe`（`dsh-ops/lib/bash-ipc.js:confinedBash()` 生成，`restrictedRemedy()` 也明说自定义 bashPath「works only in danger-full-access」）。用未打补丁的官方 runner 实测：`bash -c`、`$0`/`$@` 位置传参（含空格、引号、内嵌换行、中文、`--notaflag`）、stdin 往返、`exit 7`、stdout/stderr 分离、staged `ls.exe` 全部正常，且**工作区外写仍被拒**（builtin 重定向与 staged `touch` 双证），`--mode read-only` 也成立。两个硬约束：子进程 PATH 必须以 staged 树打头（`<root>/usr/bin`、`<root>/ucrt64/bin`、`<root>/cmd`，再拼 ambient），否则外部命令解析到另一份未锁定 msys 并死于 signal pipe；Low IL 下 `$HOME` 只读，可写处只有工作区与 runner temp。

这段取证保留为历史：v1 已移除执行沙箱，`src/execution/dshbash.js`（`resolveStagedBash()` / `pathWithStaged()`）随沙箱一起删除。现在只剩一件事——PATH 上的 `bash` 若是 WSL 启动器，就按 `bashCandidates()` 的固定顺序找一个真实的 MSYS2/Git Bash；作者钉死 `executable` 时原样使用。

### 5.3 声明式参数映射 grammar（补完 F3 三个硬墙）

| YAML | 行为 |
|---|---|
| `{literal: "--verbose"}` | 固定一个 argv 元素 |
| `{arg: name}` | 标量 → 一个元素；缺失则省略 |
| `{flag: verbose, as: '--verbose'}` | **无值开关**：参数为 `true` → 产出这一个元素；`false`/缺失 → 什么都不产出 ← 补 |
| `{flag: format, as: ['-v', '-v']}` | 同一个开关产出多个元素（`as` 可为字符串数组） |
| `{arg: mode, enum: ['--enable-x','--disable-x']}` | 二选一开关：把 flag 文本当枚举值，用 `{arg}` 直接产出 |
| `{arg: name, prefix: "--out="}` | **`--opt=value` 拼接**（在前，单元素）← 补 |
| `{arg: name, suffix: ".json"}` | 后缀拼接 ← 补 |
| `{arg: tags, join: ","}` / `{arg: f, join: " "}` | 数组 → 单元素拼接 ← 补 |
| `{arg: tags, repeat: true}` | 数组 → 重复元素 |
| `{arg: payload, json: true}` | 对象/数组 → `JSON.stringify` 单元素 |
| `{arg: body, stdin: raw}` | 该标量**原样**作为 stdin ← 补（解决 `--body-file -`、`jq`、`python -`） |
| `{stdin: json}` | 全部参数序列化为 stdin JSON |

**`--` 绝不自动插**（F20）：插不插取决于目标程序是否支持，插件猜不出来，也**不提供 `optionsSeparator` 字段**。作者需要时显式写 `{literal: "--"}`，位置完全可控、可见、可测试。

附加防护：默认拒绝以 `-` 开头的 positional 值（防 option injection），需 `allowLeadingDash: true` 显式关闭；`@` 开头的值需 `allowResponseFile: true`（防 `@file`）。

**`{flag}` 的校验规则（加载期）**：①被引用的参数必须 `type: boolean`（否则 `INVALID_CONFIG`）；②同一 args 元素里 `flag` 与 `arg` 互斥；③`flag` 必须同时给出非空 `as`；④`as` 数组的元素不能为空串。UI 侧对应的编辑控件是「开关 + 文本」，渲染时按 `flag` 非空判定，不是按 `arg`。

---

## 6. 执行流水线（所有模式共用，含 test）

```
1. 取 exec.signal；校验后的 clampTimeout(tool.timeoutMs) —— 加载期已限制在 [1000, 600000]
2. 校参（DSH DSL + JSON 默认值填充 + 未声明键检查 + enum/范围校验）
3. cwd 预检：有 agent 时 workingDirectory.ensure(agent, signal)，否则用部署默认目录；
   解析相对 cwd → statSync 确认存在且是目录 → 否则 CWD_UNAVAILABLE
   （必须先于 spawn，坏 cwd 要报 CWD_UNAVAILABLE，而不是让 spawn 抛 SPAWN_FAILED）
4. approval：按 §6.3 决定是否 request；非 allowed-once 即失败
5. credentials：逐个 resolve(ref)，失败 → CREDENTIAL_UNAVAILABLE
6. resolveExecutable（当次）→ absolute；script 模式另做脚本存在性与可选 SHA-256 校验
   → EXECUTABLE_NOT_FOUND / SCRIPT_UNAVAILABLE
7. 构造 exact argv（§5.2）+ env overlay（受信 DSH_* + 静态明文 + 凭据 + 声明绑定）
8. spawn(argv) 直接交给 ctx.subprocess（**没有任何 confinement 层**，见 §6.4）
9. bounded collect；await handle.done；await waitForExit() 直到真退出
10. 分类：
    timeoutOf(e) → TIMED_OUT ；调用方 abort → ABORTED
    exitCode ≠ 0 → PROCESS_EXIT（Unix 约定：唯一成功码是 0，不做可配置白名单）
    signal ≠ null 且非本次 abort/timeout 所杀 → PROCESS_SIGNALED（外部被杀：任务管理器、系统关机等）
11. parse:json 仅当全程成功且未截断 → 否则 INVALID_JSON_OUTPUT / OUTPUT_LIMIT
12. 返回统一结构（§4.2）；v1 不落盘 counters
```

### 6.1 取消机制（B2 修复）

插件拿到的 `exec.signal` 是**只读引用，abort 不了**。所以每个在途调用：

```ts
const own = new AbortController()                    // ToolSlot 持有
const fused = AbortSignal.any([exec.signal, own.signal])
// 记入 slot.inflight: Map<token, {own, handle, startedAt}>
```

禁用工具 / 破坏性更新 → `own.abort()` → `handle.terminate()` → `await handle.waitForExit()` **才算 settle**（provider 在 POSIX 走 `process.kill(-pid)`、Windows 走 `taskkill /PID x /T /F`，`...\runner-launch-B2zsQ1Dz.js:724-758` 🔍）。

> 前置检查：若 `AbortSignal.any` 在目标 Node 上不可用，退化为手工 relay（`exec.signal` 的 abort 事件里 `own.abort(reason)`）。

### 6.2 关键纪律

- 没有任何隐式回退：cwd 不存在就 `CWD_UNAVAILABLE`，可执行器找不到就 `EXECUTABLE_NOT_FOUND`，绝不猜一个替代品顶上。
- 超时/取消后**必须** `terminate()` 并等真退出，不能 `Promise.race` 后遗弃进程。
- 所有值当次解析，**不缓存** policy / credential / executable。
- 默认 `isConcurrencySafe: () => false`（exclusive）；只有 manifest 显式 `concurrency: parallel` 才 `true`。
- `timeoutMs` 加载期限制在 `[1000, 600000]`（`clampTimeout` **无下限**，M5）。

### 6.3 审批（对齐宿主词汇，F8 修复）

- 工具字段是 `approval: inherit | always`（**不是** `auto`）。
- `inherit` → 完全交给宿主的会话策略 `ask|never`；插件不额外弹窗。
- `always` → 每次执行前强制 `ctx.approval.request()`，用于 `danger-full-access` / 有外部副作用 / 花凭据的工具。
- ⚠️ **`always` + 会话 `never` = 永远失败**：这是宿主的硬语义，不能绕过。因此：
  - 加载期检测会话策略不可行（会话未创建）→ 改为**运行期**给可执行诊断：`APPROVAL_UNAVAILABLE` + "本工具要求每次确认，但当前会话审批策略为 `never`；改会话设置或把工具改回 `inherit`"。
  - 文档必须写明，并在 `/custom-tools test` 时就把这条冲突**提前报出来**。
### 6.4 执行权限（v1：无 confinement）

v1 **不调用 `ctx.sandbox.confine()`**，也不读取 `ctx.sandboxPolicy`：工具进程与宿主同权限运行。

- 理由（用户决定）：自制小工具运行时必然写 `temp`、缓存、`~/.config`；要求作者为自己的工具适配 DSH 沙箱，等于把「接入工具」变成「倒腾沙箱配置」，与本插件目的相反。
- 因此 `effective = stricter(...)` 这一整套口径**已废弃**，`sandbox` 字段从 Config、plan、结果信封里全部移除。
- 权限边界的唯一保证变成：**模型参数只能填声明过的值**，永远改不了启动哪个程序、从哪个目录、带哪些环境变量键（§10 威胁模型）。
- 作者要隔离，自己用容器/虚拟机/受限账户；插件不做这个承诺，也不做部分承诺。

### 6.4.1 我们放弃了什么（写清楚，别假装）

| 放弃的能力 | 后果 | 谁该补 |
|---|---|---|
| 写路径白名单 | 工具进程可写 `~/.ssh`、`.env`、甚至本插件的 `index.js` | 用户与工具作者 |
| 网络隔离 | 工具可联网 | 用户与工具作者 |
| CPU/内存/PID 配额 | 一个失控工具能拖垮宿主 | 用户（超时只杀进程，不管资源） |
| 读保密 | `read-only` 本来就挡不住读，Windows 下 `enforcement` 也只到 `partial` | 无 |

### 6.5 观测（F4 修复，v1 刻意缩减）

v1 **不落盘任何状态**：没有 `state.json`，不写 patch，不做跨会话计数。理由：每次调用写文件既是 IO 抖动，也会把"是否需要清理"变成新问题；而浏览器侧读不到 Host 内存（§11.4），持久化 counters 在 v1 里没有任何消费方。

v1 可观测性由三处承担：①`/custom-tools status` 报告当前代际、last-good 与编译诊断；②`/custom-tools list` 标出未启用与被拒的工具；③失败结果自带稳定 code + hint。`callCount`/`lastUsedAt` 这类"配了但 agent 不用"的信号留到 v1.1，届时需要一个真正的读取通道。

### 6.6 「测试」与「预览」——一等公民

**这是 v1 的验收项，不是 nice-to-have。**

```
/custom-tools preview <name> [--args='{"path":"."}']
    只走 §6 的 1-2、6-7 步：打印逐元素 argv、cwd、env 键名（值脱敏）、
    按解释器注入的 autoEnvKeys。永不 spawn。

/custom-tools test <name> [--example=<n>] [--args='{...}']
    走 §6 的**全部**步骤——与模型调用完全同一条代码路径，只是 entry 不是 ToolSlot。
    输出：逐元素 argv / cwd / env 键名（值脱敏）/ autoEnvKeys /
          exit·signal·timedOut·durationMs / stdout·stderr /
          parse 结果 / 命中的错误码与修复建议。
    可以在工具 enabled:false 时运行（测试不要求 register），
    也可以测试因编译失败而被拒、未进入当前代际的工具定义。
```

测试路径的三条硬要求：
1. **同源代码**：`test` 与 `ToolSlot.execute` 必须调用同一个 `runCustomTool(plan, args, ctx)`，否则测过的和跑的不是一回事。
2. **同源环境**：与模型调用走同一套 env 收集与解释器解析，所以测出来的 argv 就是真会跑的 argv。
3. **不写会话工具日志**：`test` 不经过 `ctx.tools.execute`，不产生 `tool/result`；只在 `/custom-tools` 自己的输出里显示。

保存 Config 成功后，命令输出必须直接给出下一步：`校验通过，3 个工具就绪。下一个：/custom-tools test git_status`。

### 6.7 输出编码：插件只认 UTF-8（Windows 必读）

**契约**：插件按 **UTF-8** 解码子进程的 stdout/stderr，不做代码页探测、不做 BOM 嗅探。

**为什么会炸**（本机实测，Windows 中文区）：

```bash
python -c "print('中')"                          # → 字节 d6 d0     ← GBK/cp936
PYTHONIOENCODING=utf-8 python -c "print('中')"    # → 字节 e4 b8 ad  ← UTF-8
```

第一行的字节被 UTF-8 解码器变成 `�`（U+FFFD 替换字符）。**信息在到达插件之前就已经丢了**，所以这不是"插件再解码一次"能解决的问题——必须让程序自己输出 UTF-8。

**自助路径：工具级 `env`**

| 程序 | 设什么 |
|---|---|
| Python | `PYTHONIOENCODING: utf-8`（或在 argv 里加 `-X utf8`） |
| Java | `JAVA_TOOL_OPTIONS: -Dfile.encoding=UTF-8`，或在 argv 里加 `-Dfile.encoding=UTF-8`（Java 18+ 默认已是 UTF-8） |
| Node | 天然 UTF-8，不用设 |
| .NET | 代码里 `Console.OutputEncoding = Encoding.UTF8` |
| 第三方 exe | 查它自己的开关；没有就只能包一层 wrapper 转码 |

**症状 → 诊断**：输出里出现 `�` 或方块 = 编码问题，不是程序坏了。`/custom-tools test` 看 stdout 原样，再在命令行用 `python -c "print('中')" | xxd` 对字节。

**exe 模式的三件事（本机实测，2026-10-31）**：

| 通道 | 实际行为 | 结论 |
|---|---|---|
| **argv 输入** | `python -c "print([hex(ord(c)) for c in sys.argv[1]])" 中文测试` → `['0x4e2d','0x6587','0x6d4b','0x8bd5']` | **完好**。Windows 用 UTF-16 命令行，Node spawn 原样传递，不经过 shell，中文不会被转码或拆词 |
| **stdout 输出** | `cmd /c echo 中文输出` → `d6d0cec4cae4b3f6`（GBK）<br>`powershell -Command "[Console]::Write('中文输出')"` → `e4b8ade69687e8be93e587ba`（UTF-8） | **由 exe 自己决定**，同一个参数两种命运 |
| **`chcp 65001`** | `cmd /c "chcp 65001 >nul && echo 中文输出"` 输出**仍是 GBK**（Git Bash 下写成 `cmd //c`） | **不是解法**。输出被重定向到管道时 chcp 不改变 exe 的写入编码，别写进文档教用户 |

所以 exe 模式的可行动作只有三条：①exe 自带编码开关（`--charset`/`--encoding`/`-Dfile.encoding`）就用它；②没有就包一层 wrapper（python/powershell/node）转码；③输出是纯 ASCII（大量运维 CLI 就是这样）就什么都不用做。

**为什么 v1 不做 `outputEncoding: 'gbk'` 字段**（v1.1 候选）：技术上可行——`ctx.subprocess` 的 stdout 用 `'pipe'` 模式时，文档明确 "piped streams are handed to the caller raw"，我们自己 `TextDecoder('gbk')` 就能解。但代价是**放弃** collect 模式现成的有界缓冲与 offset 读取，要为 test 与输出上限重写一遍。v1 选简单：UTF-8 契约 + env 配方；遇到改不动的第三方程式再上 v1.1。

**照抄即可：四种常见程序**（每条等价命令均在本机验证）

Python 脚本：

```yaml
- name: py_script
  executable: python
  args:
    - { literal: "C:\\tools\\job.py" }
    - { arg: task }
```

`PYTHONIOENCODING` 由 §6.8 自动注入，**不用手写**。

uv 工程脚本（实测 uv 0.11.2）：

```yaml
- name: gauss_query
  executable: "C:\\Users\\mark\\.local\\bin\\uv.exe"   # 或裸名 uv
  cwd: "C:\\proj\\gauss-tool"
  args:
    - { literal: "run" }
    - { literal: "-q" }          # 压掉 uv 自己的 Using CPython… / Creating virtual environment…
    - { literal: "--no-sync" }   # 环境已就绪时不再动 .venv/.lock
    - { literal: "main.py" }
    - { arg: sql }
```

实测：argv 中文完好（`['0x4e2d','0x6587','0x6d4b','0x8bd5']`）、**退出码透传**（脚本 `exit 7` → uv `exit 7`）、热启动 `--no-sync` 约 0.09s。
注意 `uv run` 首次会在项目里建 `.venv` 与 `uv.lock` 并联网解析依赖——先手动 `uv sync` 一次、再固定 `--no-sync` 最稳。首次带依赖会联网，`timeoutMs` 按冷启动给。

jar：

```yaml
- name: erp_sync
  executable: java
  args:
    - { literal: "-jar" }
    - { literal: "C:\\tools\\erp-sync.jar" }
    - { arg: mode }
```

`-Dfile.encoding=UTF-8` 由 §6.8 自动插在 `-jar` 之前。

原生 exe：

```yaml
- name: vendor_cli
  executable: "C:\\Program Files\\Vendor\\cli.exe"
  args:
    - { literal: "query" }
    - { arg: sql }
```

纯 ASCII 输出的运维 CLI 什么都不用做；中文输出按上表三条动作处理。

### 6.8 编码默认值：按可执行器自动注入（默认开，可关）

用户不该为了绕过 §6.7 的契约去逐个查运行时的编码开关。插件在**构建 env/argv 的最后一步**（用户显式值已就位、spawn 之前）按识别出的可执行器自动注入：

| 识别到的可执行器 basename | 自动注入 | 理由 |
|---|---|---|
| `python` `python3` `pythonw` `py` `uv` `uvx` | `PYTHONIOENCODING=utf-8` | 实测默认 cp936；`uv run` 的子进程继承同一 env，所以认 `uv` 也有效 |
| `java` `javaw` | argv 前缀 `-Dfile.encoding=UTF-8`（插在 `-jar` 之前） | JVM 不读 `PYTHONIOENCODING`；**不用** `JAVA_TOOL_OPTIONS`，因为 JVM 会往 stderr 打 `Picked up JAVA_TOOL_OPTIONS: …`，等于每次调用加一行噪音 |
| `node` | 无 | 本身 UTF-8 |
| `powershell`（mode: powershell） | `-Command` 前拼 UTF-8 preamble（与 `dsh-pwsh-local` 同款：`[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = …`） | 复用宿主已验证做法 |
| `bash`（mode: bash） | 无 | Git Bash 输出本身 UTF-8 |
| 其他 exe | 无 | 走 §6.7 三条动作 |

**识别方式**：`resolveExecutable()` 出绝对路径后取 basename（去掉 `.exe`），大小写不敏感。所以 `uv`、`C:\Python312\python.exe`、`C:\Users\mark\.local\bin\uv.exe` 都能命中。

**优先级（高 → 低）**：用户 `env` 显式给了同名键 → 用户赢，不覆盖；`encodingDefaults: false` → 全部不注入；否则注入默认。

**想去掉单个**：`env: { PYTHONIOENCODING: "" }` —— 空串语义是"显式置空"，插件不注入也不把它传给子进程。

**必须可见**：`preview` / `test` / `show` 里自动项要带 `[auto]` 标记（如 `PYTHONIOENCODING=utf-8 [auto]`），否则用户看到自己没写过的变量会怀疑是 bug。

**风险声明**：`PYTHONIOENCODING` 同时影响 stdin 解码。我们的 stdin 本来就是 UTF-8，方向一致；但如果某个老脚本要读 GBK 二进制流，用户应显式关掉（置空或 `encodingDefaults: false`）。

---

## 7. 热更新与热启停

> **方案 A（已拍板）**：定义存在 Config 里 → 本节**没有** watcher、原子写、`runExclusive` 事务、磁盘 last-good。唯一触发点是 `ctx.on('loader/volatile-update')`：保存 Config → volatile 字段更新 → 事件同步发出 → Manager 编译候选并 commit。§7.1 / §7.2 / §7.4 / §7.5 仍然适用；§7.3 已按方案 A 重写。

### 7.1 运行时结构

```
Manager (1 个，全局)
├── current: Generation                ← 单点原子指针
├── retired: Set<Generation>           ← refcount 归零后销毁
├── closing: boolean                   ← dispose 开始后拒绝新 commit
├── diagnostics: { ok, revision, issues[] }   ← 上次编译结果（保留 last-good）
└── slots: Map<name, ToolSlot>         ← 每个名字一个稳定 ToolDefinition

Generation (结构不可变，只有 refcount 可变)
├── id / contentHash
├── tools: Map<name, CompiledTool>     ← 已编译、无副作用、冻结
├── contractHash: Map<name, string>    ← name+params+desc+timeout+concurrency
└── refcount: number                   ← 唯一的可变字段，由 release() 递减
```

没有 `watcherDisposer`：方案 A 下没有文件监听，生命周期只由插件 fiber 的 effect 与 `loader/volatile-update` 决定。

### 7.2 代际固定：只用方案 B（H2 修复）

```ts
// ToolSlot.execute
const gen = manager.current            // ① 进入 body 时快照
const target = gen.tools.get(name)     // ② 本调用只认这一代
if (!target) return { ok:false, code:'TOOL_RELOADING', ... }
gen.refcount++
try { return await runCustomTool(target, args, exec) }
finally { release(gen) }               // ③ release 幂等、永不抛
```

为什么这样就够、不需要 `tools/pre-execute`（原方案 A）：
- `createExecution` 捕获的旧 `render`/`projectContent` 会作用在新代际的结果上——但**输出 schema 是全局统一的**（§4.2），所以旧 presenter 对新结果依然正确。
- 方案 A 的 pin 点位于 `serviceAsk`（人类审批）**之前** → 审批期间一直持有旧代际，反而拉长生命周期（L3），且 release 在 `collapsed && aborted` 路径上会误调用（H2）。**放弃 A。**

### 7.3 刷新流水线（方案 A）

```
ctx.on('loader/volatile-update')          // 保存 Config 后同步到达
  ↓
读取 config.tools.get() / config.deferLoading.get()    // 整批快照一次
  ↓
compile(snapshot) —— 纯函数：validate → compile → 算 contractHash
  ↓ 失败 → 写 diagnostics，保留 last-good，不发 tools/change
  ↓
commit() —— 严格同步，全程无 await
  1. 编译期已算好差异：added / removed / compat / breaking
  2. 新增 name：逐个 register，每步 try/catch
       register 抛错 → Cordis effect 已回滚该次插入（ScopedLayers.effect 先 yield undo 再 onChange，
                       setup 失败时 Cordis 执行 undo）；仍断言 ctx.tools.get(name) === undefined
                   → 回滚本代已注册项 → 保留 prev → 记 diagnostic → 结束
  3. compat（只有 body/实现变）→ 什么都不做，换指针即可
  4. breaking / removed → 对受影响 ToolSlot 走 §7.4 的 quiesce（置状态 + abort，不 drain）
  5. manager.current = next      ← 单点换指针
  6. 事务外（下一 microtask）：drain 旧代际 → refcount 归零 → dispose 已移除的 slot
```

**为什么同步 commit 安全**：JS 单线程，同步段内没有工具 dispatch、也没有 `assemble()` 能插进来。唯一能看到中间态的是 `emit('tools/change')` 的同步 listener——v1 唯一的 listener（subagent reconcile）是**幂等**的（`...\dsh-tool-subagent\lib\index.js:570-591,601-604` 🔍）。register 本身的回滚由 Cordis effect 保证（见第 2 步），不需要私有 registry 补偿。

**H6（饿死 HMR 队列）在方案 A 下自动消失**：没有 `runExclusive` 事务可占，`volatile-update` 是同步 emit、不 await。drain 放到下一 microtask 只是不阻塞 commit，不涉及任何 HMR 队列。

**volatile-update 的实测义务（M0）**：live Event catalog 未收录该事件（§12.8 已改判），但 `...\cordis-plugin-loader\src\index.ts:23-42` 有声明、`...\src\config\entry.ts:141-196` 有同步 emit。M0 必须实测"保存 → 事件真的到达 `apply` 里的 listener"。

### 7.4 单工具状态机

```
enabled --禁用/breaking更新--> quiescing --(inflight=0 或 超时)--> hidden
   ↑                                                                  │
   └──────────────── enabled (register) ──────────────────────────────┘
```

- 用户已定：**禁用 / 破坏性更新 = 立即取消在途调用并拒绝新调用**，不是优雅 drain。
  `quiescing` 阶段直接 `own.abort()`（§6.1）→ `terminate()` → 等 settle → 再 dispose。
- **在途预警（F12 修复）**：禁用或 breaking 更新前，若 `inflight > 0`，命令必须要求二次确认并显示"N 个在途调用将被取消"（`/custom-tools disable <name> --force`）。`git push`/`npm publish` 留半成品是真实事故。
- drain 超时（默认 5s）→ 强制 dispose + 记 `FORCED_DISPOSE` 诊断；进程由 `terminate()` 收拾。

### 7.5 对用户的人话（F13）

`/custom-tools status` 必须直接回答这三个问题，而不是输出内部术语：

| 问题 | 回答 |
|---|---|
| 我刚才改的生效了吗？ | "已生效（rev 12，commit 于 14:03:02）。参数/描述变更在当前轮结束后对模型可见。" |
| 为什么 agent 没看到我的新工具？ | "工具在整个档位可见，但当前会话正在跑一轮；schema 在下一个 model step 装配。" |
| 改错了会不会全废？ | "不会。编译失败时保留上一版（rev 11）继续服务，坏的只影响它自己那一条。" |

---

## 8. 作用域：v1 只做全局

- v1：全部工具在插件自身 context `ctx.tools.register()` → **profile 全局可见**。
- **preset/agent 作用域移到 v2**。原因（M8）：`composedPreset()` 在无 preset registry 时返回 `undefined` → 带 `scope.presets` 的工具会**静默消失**；preset 切换也不回溯已存在的 agent；而且 `agent/created` 里必须用 `candidate.ctx.inject(["tools"], …)` 而不是直接 `agent.ctx.tools`。这三点都要求额外设计，不该压进 v1 的"简单"目标。
- v1 约定：**工具名全局唯一**；不做同名不同义。

---

## 9. Jobs：明确移出 v1

用户决定：**保证实现简单**。技术上也正好避开一个 BLOCKER（B1）：

`dsh-jobs-local/lib/index.js:439` 是 `const hooks = spec.run(handle)` —— `start()` **同步**调 `run()` 并要求**同步**返回 `{done, cancel}`；而 `confine` / `resolveExecutable` / `credentials.resolve` 全是 async。所以「先预检再在 run 里 spawn」排不出来：要么 run 变 async 直接 TypeError，要么跳过前沿安全检查裸 spawn。**jobs 无法复用「先异步预检、再同步 spawn」的流水线**。

连带消失的问题：`JobKindMap` 合并点（应合 `'@deepseek-ai/dsh-jobs/view'`，L1）、后台 Job 与 `approval:'always'` 的硬互斥（`approval.request` 要求未结束的 turn）、以及"起了就忘"的必然体验（无 settle 通知、无 job 列表 UI）。

**v2 前置条件**（留档）：①把异步前置全部移到 `start()` 之前，`run()` 内只做同步 spawn + `{done: waitForExit, cancel: terminate}`；②自定义 job kind 声明合并；③后台模式与 `approval` 的语义规则先定死。

---

## 10. 威胁模型

**可信（代码作者级）**：manifest 作者、配置管理员、manifest 中固定的 executable/interpreter/script/inline 命令。
**不可信**：模型生成的参数、workspace 内可被替换的文件/symlink、PATH shim、被攻陷的目标程序、进程 stdout/stderr、并发调用。

| 威胁 | 缓解 |
|---|---|
| shell injection | 参数永不进命令文本；作者可显式写 `{literal:"--"}` 分隔；默认拒 `-` 开头 positional |
| CLI option / response-file injection | 参数映射声明化；`@`/`-` 需显式允许 |
| PATH / 解释器替换 | 当次 `resolveExecutable` → absolute + `statSync` 复核；script 要求不可写目录或 hash pin |
| cwd / symlink 穿越 | cwd 只来自 `workingDirectory.ensure` 或管理员固定值；canonical 校验 + `statSync` |
| loader env 注入 | env allowlist；禁止 `PATH`/`NODE_OPTIONS`/`LD_PRELOAD`/`DYLD_*`/`PYTHONPATH` 由模型控制 |
| 秘密泄漏 | 仅 `credential ref` → 执行期 resolve → env/stdin；不进 argv/schema/log/error/输出文件；⚠️ 秘密进子进程 env 后 POSIX 可经 `/proc/<pid>/environ` 读到——文档要写明 |
| 输出 DoS | 硬上限 timeout/output/并发；v1 完全不落盘 spill（避免秘密落盘，同时少一条清理路径） |
| 孤儿进程 | `terminate()` + `waitForExit()`；不 `Promise.race` 遗弃 |
| 截断 JSON 误解析 | 仅完整、非 lossy、exit 0 且无信号时才 parse |
| denial / runner failure 混淆 | 双判据（argv[0] 被换 + 签名），签名只作 detail |
| 环境变量被静默吞掉 | 文档警告子串匹配会删 `MONKEY_PATH` 等 |
| 凭据轮换延迟 | 文档写明生效 ≈ watcher debounce 窗口，不承诺"立即" |

**插件不提供任何隔离**：没有网络隔离、没有 CPU/内存/PID 配额、没有读保密、没有写路径白名单（§6.4.1）。工具进程与宿主同权限——这份信任只能由「谁写的定义」承担。

**关于「agent 起草草稿」（v1.1，已定延后）**：它确实是最有效的冷启动手段，但它**推翻本节的"manifest 作者 = 可信代码作者"前提**——模型从此进入信任边界，被注入的网页可诱导 agent 起草危险命令。因此闸门必须是固定的、不可配置的：草稿目录**永不执行**、确认界面**只显示最终 argv 不显示 YAML**、必须**显式勾选**、**永不自动启用**。v1 不做。

---

## 11. 交互面：设置分页 + 宿主 settings 通道（已实证，推翻上一版"只做命令"）

### 11.1 结论

第三方 Client 插件**可以**直接 `ctx.remote.settings.describe()` / `mutate()` 读写自己这一行的 volatile Config —— **不需要** Typert 代码生成、**不需要** `webServer` 自建路由、**不需要** commands 借道，也**不写会话日志**。这条已在样例包里跑通并落盘验证。

证据（`research/sample/` 样例包）：

- 页面：`settings.section` 注册 `cts-section`，左侧栏出现「自定义工具（样例）」
- 读：`describe()` 返回 32 个 view，`cts-section` 的 `value = {"label":"custom section",...}`，secret 字段被剥离
- 写：点保存 → `revision` 从 0 涨到 3、再到 4，两次修改都生效
- 落盘：`C:\Users\mark\.dsh\profiles\desktop\cordis.patch.yml` 出现

  ```yaml
  - id: cts-section
    name: dsh-custom-tools-sample/section
    config:
      label: "123123"
      count: 11
      apiKey: "123456789"
      tools: []
  ```

### 11.2 三条硬性前置（缺一条就静默失败）

1. **Config 字段必须 `.volatile()`**。一个 volatile 字段都没有时，**整个命名空间根本不出现在 `describe()` 里**（不是显示空表单）——我为此排查了两轮。
2. **Client 模块的 `inject` 必须声明 `'remote'` 与 `'remote.<ns>'`**。只写 `ctx.get('remote')` 不够：访问未声明的命名空间会抛 `cannot get property "remote.settings" without inject`；该错误若发生在 `try` 之外会变成未处理拒绝，页面永远停在「读取中…」。参照 `dsh-better-sidebar\src\client\index.tsx:41-50` 的注释。
3. **命名空间 id = profile entry 的本地 id**（patch 里的 `id:`），不是包名、不是 moduleName。

### 11.3 已实测的契约

`describe()` → `{ writable, hasDocument, namespaces: [view] }`，每个 view 是：

| 字段 | 含义 |
|---|---|
| `ns` | 命名空间 = entry 本地 id |
| `autoGenerate` | 自动表单策略标记 |
| `schema` | Config 的 refs 图（`uid` / `refs` / `dict` / `inner`），可直接照着渲染控件 |
| `value` | 生效值（secret 已剥离） |
| `base` | 继承值 |
| `user` | profile 里的显式覆盖 |
| `applies` | 生效方式（`live`） |
| `secrets` | secret 字段名清单 |
| `revision` | 乐观并发版本 |

写：`mutate(ns, ops, revision)`，`ops` 为 `{op:'set', path:[...], value}` / `{op:'unset', path:[...]}`；数组元素删除可 `unset path:['tools', 2]`。返回 `RemoteResult`，冲突走 `settings/conflict`。

### 11.4 两个必须记住的坑

- **自动表单（`autoGenerate`）当前没有任何 UI 消费它**。`cts-auto` 的 Config 投影完全正常、命名空间也在，但插件页那行没有入口、设置里也没有页面；`dsh-ops` 同样如此。**要 UI 就自己画**，schema 已经随 `describe()` 到了浏览器。
- **`role('secret')` 只保证读方向剥离，不保证落盘加密**。上面 yaml 里 `apiKey: "123456789"` 是明文。所以真凭据必须用 credential reference（环境变量名），不能用 secret 字符串字段。

### 11.5 v1 页面内容

**页面能做的（有通道）**：

- 工具列表增删改：`name` / `title` / `mode` / `description` / `whenToUse` / `executable` / `interpreter` / `script` / `command` / `args` / `cwd` / `approval` / `timeoutMs` / `env` / `enabled`；JSON 字符串字段（`parameters.*.default`、`examples[].args`、`output.schema`）用带解析反馈的文本框
- 按 `describe().schema` 的 refs 图渲染控件（`dict` / `inner` / `meta.description` 都可读）
- 保存走 `mutate` + `revision` 冲突提示；**Host 侧仍是唯一写入者**
- 形状错误当场显示（`settings/rejected` 的消息）+ 空数组引导卡 + 「插入 3 个示例」按钮（纯客户端常量）

**页面做不到的（无通道）**：编译后的 argv 预览、真实试跑、last-good revision、上次调用与错误——这些都在 Host 内存里，浏览器读不到（§11.4）。归 `/custom-tools` 命令：

| 需求 | 命令 |
|---|---|
| 编译后的 argv 长什么样 | `/custom-tools preview <name> --args '<json>'` |
| 真跑一次（用户硬需求） | `/custom-tools test <name> --args '<json>'` |
| 为什么这个工具没注册上 | `/custom-tools status`（含编译期诊断与指针路径） |
| 该工具当前什么时候可用 | `/custom-tools list`（enabled / hidden / 诊断摘要） |
| 禁用会不会打断在跑的 | `/custom-tools disable <name>` 触发二次确认并显示 N |

页面里放一行提示：「保存后回到会话运行 `/custom-tools test <name>` 验证」，配一个「复制命令」按钮。将来若嫌跳来跳去，再讨论为"试跑"单独开一条小通道（§14 第 3 问）。

### 11.6 页面落点取舍

| 落点 | 评价 |
|---|---|
| `settings.section`（list/root） | **选它**：生态主流（表情包/bili/侧边卡片/插件市场都在这），ownerProps 只有 `{close}`，另有 `useRemoteAccess`/`useSessions` 等标准 hook |
| `settings.plugins.tab` | 备选：设置→插件 里的分页 |
| `settings.general.item` | 适合单个开关，不适合大表单 |
| `plugins.row.config` | 通道可用（`cts-page` 已跑通 `form.state`/`form.mutate`），但入口深：要先左侧栏「插件」→已安装→bundle→行末 `›` |
| `plugins.bundle.config` | bundle 级、会遮挡官方 UI，不用 |

### 11.7 由此产生的数据模型决断（**已拍板：方案 A**）

`remote.settings` **只能写 Config**（进 profile patch），写不了任意文件。用户已选 A：

- **方案 A（采用）**：工具定义放进插件 Config 的 `tools[]` → UI、持久化、锁、校验、revision 并发、secret 读方向剥离**全部免费**；保存时 volatile 字段变化**不 remount 插件**，Manager 收 `loader/volatile-update` 换注册表，热更新天然成立。代价：定义住在 `cordis.patch.yml` 里（可用 `ctx.settings.prepareDocument()` 定位给用户手改），文件形态不如独立 YAML 干净；编译期诊断进不了页面（§11.4），要靠命令看。
- **方案 B（作废）**：独立 `tools.yaml` → 手改友好、git 友好、`hmr.watchConfig` 热重载；但浏览器侧没有写文件通道，**要 UI 就必须自建 Host 路由 + 自建鉴权**。

方案 A 同时消掉 §7 的整条 watcher / 原子写 / 竞态子结构，是"实现简单"方向最强的一步。

---

## 12. 明确不做（附原因）

1. 每个工具一个 Loader row —— 工具是 data plane，不该伪装成 plugin。
2. 用 Plugin Manager 做单工具开关 —— 粒度错，会卸整个 fiber。
3. 手改 `cordis.patch.yml` / profile `package.json` —— 绕过锁、overlay 检查、回滚。
4. 自建 chokidar / 文件 watcher —— 方案 A 下没有文件可 watch；方案 B 里会与 HMR 队列竞态。
5. 在 HMR 的 refresh callback 内 `runExclusive()` —— 直接抛错（`HMR transactions cannot be nested`）。
6. 在 commit 里 `await` —— 会占住 `runReload` 的整条链，饿死模块 HMR。
7. 把全部 Config 标 `.volatile()` —— 需要重建后台资源的字段不会触发 cleanup。
8. ~~依赖 `loader/volatile-update` 作为主重载机制（live Event catalog 未收录）~~ —— **已改判**：方案 A 正是靠它；源码有声明与同步 emit（§7.3），live catalog 只是没收录。M0 实测。
9. 直接改 registry 私有结构 —— 不发规范 change，升级必碎。
10. 定义文件用动态 `import()` —— 模块缓存/副作用/HMR 图混乱。
11. **v1 做 Jobs** —— B1 不成立；且与审批、UI、`JobKindMap` 三处纠缠。
12. **v1 做 preset 作用域** —— M8 会让工具静默消失。
13. ~~v1 做 GUI 面板~~ —— **已推翻**：`settings.section` + `ctx.remote.settings` 实证可用（§11），GUI 进 v1。
14. **自动插 `--`** —— 目标程序是否支持不可判定（F20）。
15. **假装自己有隔离** —— v1 与宿主同权限，文档和文案都不许暗示相反。
16. **自动转义 / 模板插值** —— 见 §5。
17. **`allowedExits` 退出码白名单** —— 用户识别不了该怎么填；只保留 Unix 约定「0 成功、非 0 失败」。非零表示正常结果的程序（`grep` 那类）包 wrapper，或让它 `exit 0` 用 JSON 承载状态（§4.2.3）。

---

## 13. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M0 spike**（1–2 天） | ① 空插件注册 1 个 tool；② volatile Config 的 `tools[]` 能被设置页读写并落盘（`research/sample/` 已验证，收敛成正式 schema 即可）；③ 实测 JSON 字符串字段能往返 `mutate`/`describe`；④ 实测保存后 `loader/volatile-update` 真的到达 listener | 四条都过 |
| **M1 骨架** | Config schema + `.check()` 跨字段校验 + Manager + Generation + ToolSlot + 同步 commit + 回滚 + 指针诊断 | Config 里写坏一个工具，其他工具照常可用、旧版保留；注入抛错的 `tools/change` listener 后不残留注册 |
| **M2 执行 + 预览 + 试跑** | §6 流水线（含自建 abort 与 terminate+waitForExit）+ 统一输出 schema + `/custom-tools preview` + `/custom-tools test` | **`/custom-tools test` 跑通 3 个示例** |
| **M3 四模式** | executable / script（双轨+hash）/ bash inline / pwsh inline + stdin raw/json + 完整 mapper | 四个模式各一个可跑样例 |
| **M4 设置页** | `settings.section` 页面：列表增删改、按 `describe().schema` 渲染、`mutate` 保存 + revision 冲突 + 引导卡与示例按钮 | 不碰命令行，纯靠页面加一个工具并保存成功 |
| **M5 命令族补全** | `/custom-tools list/show/status/enable/disable` + last-good 与诊断呈现 + 在途预警 | 不看文档能完成"加一个工具并测通" |
| **M6 加固** | 威胁模型逐项测试、Windows 解释器探测与回退、secret 只能走 credential ref 的文档与 lint | 可发布 |

**当前不做**：Jobs（§9）、preset 作用域（§8）、agent 起草闸门（§10）。

---

## 13.5 已拍板的决策

| 议题 | 决定 |
|---|---|
| 参数绑定 | **零插值**。模型值只经 argv / stdin / env，永不进入 shell source；不做模板、不做转义 helper（§5） |
| script 位置 | **双轨 + 显式标记**：默认要求不可写目录，否则 `scriptTrust: user-managed` + 强制 hash pin，未标记拒绝加载 |
| Windows 边界 | **含 Windows Git Bash（MSYS）**，作为独立兼容目标单独验收；`pwsh` 7 优先；`.bat/.cmd` 排除 |
| Jobs | **不进 v1**，理由见 §9（实现简单 + B1 BLOCKER） |
| agent 起草草稿 | **做，但不在 v1**（v1.1），闸门固定不可配置（§10） |
| 测试功能 | **v1 一等公民**：`preview` 与 `test` 同源走真实流水线（§6.6） |
| 执行权限 | **与宿主同权限，无 confinement**（§6.4.1）；模型参数改不了程序、目录、环境键 |
| v1 范围 | 单 bundle（Host 半侧 + 一个 Client 半侧）；全局作用域；**定义存 Config**；设置分页 + `/custom-tools` 命令族 |
| **GUI 面板** | **已推翻"v1 无面板"**：`settings.section` + `ctx.remote.settings` 已实证可用（§11），不需要 Typert 生成、不需要自建 HTTP。面板进 v1 |
| **定义存放位置** | **方案 A，已拍板**：工具定义住插件 Config 的 `tools[]`（§3），UI/持久化/锁/校验/revision 全免费，volatile 变更不 remount → 热更新天然成立。独立 `tools.yaml` 方案作废 |
| **编码默认值** | **按可执行器自动注入，默认开**（python/uv → `PYTHONIOENCODING=utf-8`；java → argv 前缀 `-Dfile.encoding=UTF-8`）。用户显式 `env` 覆盖优先，`encodingDefaults: false` 或置空串可关（§6.8）。理由：编码坑是新用户第一个撞上的墙，默认对才是好默认 |
| **退出码语义** | **只有 0 = 成功**，非 0 一律 `PROCESS_EXIT`。**不做 `allowedExits` 白名单**——用户不知道怎么填，等于把复杂度转嫁给他们；非零即正常的程序包 wrapper（§4.2.3 / §12 第 17 条） |
| **模型侧措辞** | **照抄原生 `grep` 的四条规矩**（§4.2.4）：三段式骨架、空成功给一句人话、超限一律 `OUTPUT_LIMIT` 硬失败（v1 无 spill）、错误靠稳定 code 而非文案。**不抢 `systemPrompt.section`**——几十个自定义工具各占一行会把 context 吃光，引导写进 description |
| **参数 enum** | **做进 v1**：`type: string` + `enum: [...]` → DSL `{type:'string', enum:[...]}`，页面渲染成下拉。理由：封闭集合把「拼错选项」这类错误从运行期挪到不可能发生；数值枚举留 v1.1（§4.1） |
| **参数类型选择** | **默认 `string`，只在该用 `number` 时用 `number`**（数字语义 + 装得进 `2^53` + 无小数位）。argv 里一切都是字符串，`number` 的价值仅在「模型侧提示 + spawn 前拦截 + 控件形态」，代价是精度与 `1e+21` 这类坑（§4.1） |

---

## 14. 仍需你拍板

1. **工具默认是否 `deferLoading: true`**（工具多时不占首屏 schema）？——**默认：`false`**（不超过 20 个工具时没必要；`...\docs\persistence-changes\2026-09-16-session-format-v4.md:102` 明确写着 provider 序列化、自动发射与 UI 支持仍 deferred）。
2. **要不要支持 workspace 级定义**（可随项目提交、团队共享）？——**默认：只 profile 级**，需要时再加覆盖层。
3. **"试跑"要不要一条自建通道**（在设置页里直接跑一次），还是先只做 `/custom-tools test`？——**默认：先只做命令**；观察一段时间再决定是否为这一个小接口开 `webServer` 并自建鉴权。

> 已拍板项见 §13.5，不再重复提问。
