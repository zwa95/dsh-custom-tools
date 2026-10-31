# dsh-custom-tools 对抗性审查汇总

> 对象：[research-design.md](research-design.md)（458 行设计稿）
> 方法：两个互不可见的独立审查 agent —— `d10885b1`（架构，逐条对照 `0.2.1-rc.3` 安装包源码）、`d6cbfabd`（产品/体验，读全文 + 宿主真实契约）。
> 本文件是**我的汇总与仲裁**，不是两份报告的拼接。凡两个独立视角都命中的，优先级最高；我不同意的，单列在 §6。
> 状态：**仍未进入实施**。本文件只改判断，不改代码。

---

## 0. 可信度分层

| 标记 | 含义 |
|---|---|
| ✅ 我已亲自验证 | 我自己读了源码/文档行号确认，可直接采信 |
| 🔍 审查员验证 | 审查员给了文件:行号，我未逐条复核；采信但保留复核权 |
| 💡 判断 | 无源码争议，属设计取舍 |

已亲自验证的两条关键事实：
- ✅ `...\official-docs\docs\subsystems\tools.md:387`：`ToolErrorInfo.reason` = "raw user-facing detail; durable projections preserve it but **model-facing content does not include it**"。→ 宿主本来就有"给用户看、不给模型看"的通道，我的设计没用。
- ✅ `...\official-docs\docs\subsystems\approval.md:86`：`ctx.approval.request(req)` **requires the requesting session to be inside an open turn**。→ 后台任务与 `approval:'always'` 天然互斥。

---

## 1. 交叉命中（两个独立审查员都打中 → 最高优先级）

### X1. 默认沙箱 `read-only` 是错的默认值 ⚠️ 我的设计缺陷
- 架构 H5：`dsh-sandbox-policy/lib/index.js:97-104` Config `mode` 默认 `"read-only"`；且**我的 §6 没定义"工具声明 mode"与"session override"谁优先**。
- 产品 F11：Windows 上 read-only 既不真安全（enforcement 只能 `partial`，§10 自己承认），又稳定制造拒绝；用户想固化的命令绝大多数要写盘。
- **处置**：默认 `workspace-write`；接受工具级声明，但语义定为 **只能收紧不能放宽**（`effective = min(declared, session)`），effective 值与来源写进诊断。

### X2. 提交协议会退化成"永久半提交" ⚠️ 我的设计缺陷
- 架构 H1：`cordis/lib/index.js:280-282` `emit` 无 try/catch，listener 抛错穿透调用者；`dsh-tools/lib/index.js:2982` 是**先 insert 后 onChange** → `register()` 抛错时工具其实已插入，重试触发 `tool "x" is already registered in this scope`，从此写不进去。
- 产品 F7：整批原子 + 文件级诊断 = 改第 18 个工具时被第 7 个的旧错挡住，且以为改的没生效。
- **处置**：三件事一起改 ①校验逐工具、提交整批；②提交 = 先建好新 generation → **单点换指针** → 事务外 dispose 旧的；③每步 try/catch + 失败时用 `ctx.tools.get(name, scope)` 复核实际状态。

### X3. GUI 只走 `commands` 传输不成立 ⚠️ 我上一轮的结论要修正
- 产品 F14：`@Remote execute(agent: Agent, ...)` **需要 agent**，而落点 `settings.section` 是**全局、无会话**的 → 全新装机打开设置加第一个工具，传不上去。
- 架构 M10：`recordInput:false` 是 **command 定义级**字段，不是 `execute` 的参数；且 `command/run`/`command/done` 仍写会话，**模型下一步能看到**"用户执行了 custom-tools:reload"。
- **我上一轮说"方案 A 无需 spike"是错的**。正确结论：`remote.commands` 确实已挂载（那部分没错），但**从全局设置页调用缺少 agent 上下文**，这是我漏掉的约束。→ 降级为"需要一处 spike"，并优先走注册用户命令 `/custom-tools`（设计已复用 commands 服务却从没给用户注册命令）。

### X4. 工具名没有保留字/重名校验
- 架构 M9：`register()` 注册期不查重名，重名在 insert 时才抛；内建名（`bash`/`read`/`write`/`jobs`…）允许撞，`run_code` 被显式禁止但其它没禁。
- 产品 F23：只禁了 `run_code`。
- **处置**：加载期校验 `^[a-z][a-z0-9_]{0,63}$` + 与内建名单比对 + 批内查重。

---

## 2. BLOCKER（照文档实现就是不可用）

### B1. 后台 job 路径的时序不成立 🔍
- 证据：`dsh-jobs-local/lib/index.js:439` `const hooks = spec.run(handle)` —— `start()` **同步**调用 run 并要求同步返回 `{done, cancel}`；而 `confine`（`dsh-sandbox-local:305-334`）、`resolveExecutable`、`credentials.resolve` **全是 async**。
- 后果：要么 run 变 async 直接 TypeError，要么跳过 confine 裸 spawn（违反 §6 fail-closed）。→ **凡声明沙箱的工具都不能后台化**，而 §9 的全部卖点就是后台化。
- 修法：`preflight → await resolveExecutable → await sandboxPolicy.resolve → await sbine → await credentials → jobs.start(spec) → run 内只做同步 spawn + {done: waitForExit, cancel: terminate}`。

### B2. §7.3「abort 所有 call signal」在 DSH 里没有对应 API 🔍
- 证据：`dsh-tools/lib/index.js:3227-3300` 用的是调用方传入的 `exec.signal`；插件拿到的只是只读引用，**无法 abort**。
- 后果：「禁用工具」= 空操作。600s 的工具被禁用后仍跑满 600s，用户以为停了。
- 修法：ToolSlot 每次调用自建 `AbortController`，传 `AbortSignal.any([exec.signal, own.signal])` 给 confine/spawn/approval/credentials；禁用 = abort 自建 controller → provider 真的 taskkill 进程树 → `await waitForExit()` 才算 settle。

> **注：B1 在"砍掉 Jobs"后自动消失。** 这是本轮最重要的范围结论，见 §5。

---

## 3. HIGH（会出生产事故）

| # | 问题 | 证据 | 修法 |
|---|---|---|---|
| H2 | pin 释放跑在 `finishScheduledExecution` 里；collapsed+aborted 路径**从未 pin 却会调 release**，抛错会把成功结果替换成错误 | `dsh-tools:3486-3490`、`:3257/:3272-3283` | release 必须**幂等、无抛**、容忍未知 token；直接改用方案 B（closure 快照） |
| H3 | Windows `windows-acl` runner 探测失败 → `??=` 永久缓存 → 全进程所有工具 SANDBOX_UNAVAILABLE，重启才好 | `dsh-sandbox-local:490-494,514-520` | M0 硬验收：`confine(["cmd","/c","echo"])` 拿到 `enforcement:"partial"` 才过；启动即探测并暴露诊断 |
| H4 | `danger-full-access` **必须自己短路**，`sandbox.confine` 不会放过它 | `dsh-sandbox-local:305-334` 无 mode 短路；`dsh-bash-sandbox:65-75` 才是先短路 | §6 流水线加分支：full-access → 直接 spawn + `sandbox:{mode,denied:false}`（且该路径**没有 `enforcement` 字段**） |
| H6 | §7.2「commit 同步无 await」与「删除→drain」自相矛盾；真 await 会**饿死 HMR 队列** | `dsh-hmr:757-761,748-756` | commit 严格同步；drain/retire 移到事务外队列 |
| — | `enforcement` 若必填 → 每次 full-access 调用在**成功之后**报 OUTPUT_SCHEMA_MISMATCH | `dsh-tools/lib/index.js:3637-3667` 运行期强校验 | schema 改 optional；`exitCode`/`signal` 的 null 用子级 `oneOf`；ok/code 互斥 schema 表达不了 → 插件自检 |

---

## 4. 产品侧要点（P0/P1 精选）

- **P0-F1 首次打开是空的**：无文件、无模板、无入口；空文件 parse 成功 = 静默成功。→ 首次**经用户动作**（打开面板/启用插件）写出一份可运行样例，用 PATH 名而非绝对路径。
- **P0-F2 没有试运行 / argv 预览**（全文检索确认无 dry-run）。插件的唯一产品输出物是"一段 argv"，却从不展示。→ 最高性价比功能：预览逐元素、标出来自 `literal` 还是 `arg:name`、显示 resolved 绝对路径、标出插件插入的 `--`。
- **P0-F3 声明式映射三道硬墙**：①拼不出 `--opt=value`（`{literal}` 与 `{arg}` 只能各自成元素）；②stdin 只能 JSON（`--body-file -`、`jq`、`python -` 无解）；③没有 default。撞墙时**加载期不报错**，运行期报的是目标程序的 usage 错误 → 用户归因为"git 的用法问题"。
- **P0-F4 配好了 agent 不用，且零观测**：agent 本来就有 bash/pwsh，`description` 竞争是劣势方；无 lastUsed/callCount。→ 加调用计数（v1 内存级即可）。
- **P1-F5 文档唯一 YAML 示例抄下来是坏的**：§3 的 `C:\\Program Files\\...` 在 YAML 纯量里不转义反斜杠 → 字面双反斜杠 → 直接 EXECUTABLE_NOT_FOUND，而报错里的路径眼睛看不出多一个 `\`。**这是我的 doc bug**，示例改用 PATH 名。
- **P1-F8 `approval: auto|always` 是自造词**，宿主词汇是会话级 `ask|never`；`always` + 会话 `never` → 每次调用失败且**永不弹窗**，加载期不报。
- **P1-F9 沙箱拒绝不可自助修复，且提示文案在撒谎**：宿主拒绝标记带**固定升级提示**（`dsh-sandbox:64-77`），而设计定 `allowEscalation:false` → 用户看到"你可以批准升级"却没东西可批。
- **P1-F10 15 个错误码是模型可见、用户不可读**：→ 基础设施失败抛 `ToolError` + `reason` 写人话；业务失败返回值 + terminal 卡片；对外压成 4 类 ✅（已验证 reason 语义）
- **P1-F12 禁用正在跑的工具无预警**：对 `git push`/`npm publish` 会留半成品，而这是设置页点一下就能触发。
- **P1-F13 热更新真实预期没人话答案**：schema 变更在**下一个 model step** 才 assemble（一轮里前 2 次调用仍用旧定义）→ 用户认为"热更新坏了"。
- **P2-F17 `degraded` 徽标语义不成立**：校验失败的工具没有编译产物也就没有 ToolSlot。active/quiescing/hidden/degraded 上界面 = 内部词泄漏。
- **P2-F19 单文件爆炸半径**：运行期有 last-good，**磁盘上没有历史** —— 误删 + 保存 = 20 个定义全没。保存前必须留快照。
- **P2-F16 凭据旁就是明文 `env:`**：`SENSITIVE_ENV_PATTERN=/KEY|PASSWORD|SECRET|TOKEN/i` 会把用户自己的 `MONKEY_PATH`/`KEYBOARD_LAYOUT`/`GIT_ASKPASS` **静默删掉**（架构 M6 独立命中），用户必然把 token 粘进 `env:`。

---

## 5. 处置表

### 5.1 改设计（必须）
1. 取消机制：自建 AbortController（B2）
2. 提交协议：单点换指针 + 逐步 try/catch + 事后复核（X2/H1）
3. 沙箱流水线：full-access 短路（H4）+ effective mode = min(declared, session)（X1）
4. 默认沙箱改 `workspace-write`（X1）
5. 输出契约：`enforcement` optional、nullable 用子级 oneOf、ok/code 插件自检（M4）
6. pin 方案直接选 B（closure 快照），release 幂等无抛（H2）
7. 错误分层：`ToolError.reason` 给用户、coded value 给模型（F10 ✅）
8. 参数映射 grammar 补 `prefix`/`join`/`suffix`/`default`/`stdin:raw`（F3）
9. 加载期校验：名字规则 + 内建名单 + 批内查重（X4）、timeoutMs 下限 1000（M5）

### 5.2 改实现（便宜但必须有）
试运行/argv 预览（F2）、首次样例（F1）、逐工具诊断带行号+字段路径（F7）、调用计数（F4）、env 键诊断（M6）、manifest BOM/CRLF 归一化（L7）、用 `dsh-atomic-write` 而非手写原子写（L8）、watch 首次 refresh 不是文件变更（L5）。

### 5.3 砍范围（关键判断）
| 砍掉 | 连带消失的问题 | 代价 |
|---|---|---|
| **Jobs 进 v2** | B1（BLOCKER）、L1（kind 合并点写错）、F18（无 settle 通知/无 UI list/与 approval 互斥）、M10 的一部分 | 失去"10 分钟构建做成类型化工具"；宿主 bash 自带 jobs，用户无净损失 |
| **preset 作用域进 v2** | M8（无 preset 时静默消失、切换不回溯）、F21（用户面对查不到的词） | 只做 global；代价小 |
| **GUI 的 YAML+表单双编辑器** | —— | 表单救不了不会 YAML 的人；向导（粘贴命令→勾选哪几个词是参数→预览 argv）才行 |

砍完 v1 = executable / script / inline-shell 三模式 + 补全的 argv mapper + 沙箱/超时/统一输出 + 热更新 + 一个「列表 + 行内五个标量 + YAML 编辑校验 + 试运行」页。

> **一次砍掉 Jobs 就消灭了一个 BLOCKER + 三个未解问题**，这是本轮收益最高的单一决策。

---

## 6. 我不同意的三条

1. **不同意砍 PowerShell inline。** 产品审查建议只留 `.ps1 -File`。但 PS inline 与 bash inline 的代码路径**同构**（固定命令 + stdin JSON，只是 argv 前缀不同），成本是一个常量；而砍掉它，Windows 用户想跑一段内联逻辑就必须先写 `.ps1` 文件并过"脚本双轨标记"，反而更麻烦。保留。
2. **不同意"`sandbox.enforcement` 误判就降级"可以省掉。** 架构 M2（签名匹配是 stderr 子串匹配，目标程序自己打印 `bwrap: ` 会被误判成基础设施故障）是真问题，但它的修法（`confined.argv[0] === runnerProgram` 独立判据）很便宜，不该省。
3. **不同意把"agent 可写草稿 + 人工确认"当作可以直接采纳的结论。** 这是产品审查最有价值的洞察，但它**直接推翻 §10 的威胁模型**（manifest 作者 = 可信代码作者）。让模型起草工具定义 = 把模型拖进信任边界，被注入的网页可以诱导 agent 起草一条危险命令，而用户可能随手确认。**这是产品战略选择，不是技术修法，必须由你拍板**（见 §7）。

---

## 7. 需要你拍板的一件事

**要不要做「agent 起草 + 人工确认启用」？**

- 不做：`§10` 威胁模型干净（manifest 作者 = 可信），但"5 分钟上手"判死刑 —— 用户必须自己会写 YAML，而文档同时承认定义文件位置还没定。
- 做：唯一能实现"粘贴一条命令 → 变成工具"的路径。闸门必须固定为：草稿目录**永不执行**、确认界面**只显示最终 argv 不显示 YAML**、必须**显式勾选**"我已检查这条命令"、**永不自动启用**；且 `§10` 必须改写为"草稿由模型生成 → 属于不可信输入 → 启用是用户的一次授权动作"。

其余偏离（默认沙箱、砍 Jobs、砍 preset、GUI 收敛）我建议直接按 §5 改，不再问。

---

## 8. 定位（产品审查给的，我认同）

> **把你每天敲的那几条命令，固化成 agent 只能按你定的参数调用的工具——它不能改命令、不能加参数、不能换成别的执行方式，跑的还是你那条命令。**

"安全"是副产品，**"agent 不能自作主张"** 才是用户愿意要的东西，也是相对 `bash` 唯一站得住的护城河：bash 能跑一切 = agent 能跑一切，自定义工具的价值是**收窄**而非扩展。

**产品审查指出的定位级风险**：这是"5 个以上工具才划算"的产品，但首个 5 分钟是按"只加 1 个工具"设计的——冷启动成本全压在第一件收益最小的工具上。对应动作不是加功能，而是让**第一个工具就有正反馈**：自动样例 + 试运行 + 调用记录。
