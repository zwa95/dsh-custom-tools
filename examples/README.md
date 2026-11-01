# Examples

五个可以直接用的工具定义。每个文件都是一个完整的工具对象，校验通过后写进配置。

## 怎么用

在任意会话里：

```
/custom-tools add <把文件内容整段贴进来>
```

`add` 不会盲写：它先用与保存时相同的校验器检查整份定义（名字格式、保留名、参数、argv 绑定、mode 必填字段、输出 schema…），有错就一条条列出来并**放弃写入**；通过后才以一次 `mutate` 连同读到的 revision 一起提交，所以和浏览器同时保存会得到冲突而不是互相覆盖。

加完先看一眼真实 argv：

```
/custom-tools preview git_status
/custom-tools test git_status
```

`preview` 不启动进程，只打印逐元素 argv、cwd 与环境变量键名；`test` 与模型调用走**同一条流水线**，因此它成功不代表模型一定能调——两者的差别只有审批与调用方。

## 清单

| 文件 | mode | 演示什么 |
| --- | --- | --- |
| [`git-status.json`](git-status.json) | executable | 最小可用定义：固定程序 + 固定参数，只读、可并发 |
| [`ripgrep-search.json`](ripgrep-search.json) | executable | 参数 → argv 元素、`omitIfEmpty`、只读搜索、legacy `examples` |
| [`node-script.json`](node-script.json) | script | 固定解释器 + 固定脚本路径，模型只能填参数值 |
| [`pwsh-disk-report.json`](pwsh-disk-report.json) | powershell | 固定命令文本，模型值只经 stdin JSON 进入，不做字符串拼接 |
| [`project-metadata.json`](project-metadata.json) | executable | `parse: "json"` + 输出 schema 校验 |

## 三条容易踩的线

1. **模型的值永远不会被拼进 shell 源码。** bash/powershell 两种模式的命令文本完全由作者固定；模型值要么是独立 argv 元素（bash 走 `$@`，pwsh 走 `$args`），要么是 stdin 字节。
2. **工具以宿主权限运行。** 插件没有 confinement 层：写定义的人就为它的读写行为负责。想让某个工具只读，靠的是命令本身（例如 `rg_search` 只读），不是靠声明。
3. **以 `-` 或 `@` 开头的值默认被拒绝。** 这是防止模型传一个 `--output=/etc/passwd` 变成参数注入；确实需要时在对应的 binding 上写 `allowLeadingDash` / `allowResponseFile`，并清楚为什么。
