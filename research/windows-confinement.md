# Windows 受限令牌下能跑什么（实测矩阵）

这是 v1 的一条平台级事实，直接决定了 `mode: bash` 在 Windows 上的行为。数据来自在临时 lab
（`C:\Users\<user>\AppData\Local\Temp\acl-lab`）里直接用 `@deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js`
跑命令：

```
node <lab>\node_modules\@deepseek-ai\dsh-sandbox-windows-acl\lib\runner.js \
  --workspace <lab>\ws --temp <lab>\tmp --mode workspace-write -- <bin> -c "echo hi"
```

## 结果

| 解释器 | 未包裹 | 包裹后 |
|---|---|---|
| `C:\Software\Git\bin\bash.exe` | exit 0 | `0xC0000142`；`couldn't create signal pipe, Win32 error 5` |
| `C:\msys64\usr\bin\bash.exe` | exit 0 | 同上 |
| `@dsh-ops\bash-win32-x64\usr\bin\bash.exe` | exit 0 | `0xC0000142`；`NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0S5-…): 0xC0000022` |
| `C:\Windows\System32\bash.exe`（WSL 启动器） | exit 0 | exit 1，stdout 70 B UTF-16LE：`拒绝访问。\r\n错误代码: Bash/E_ACCESSDENIED` |
| `powershell.exe` / `cmd.exe` / `node` / `python` / `py` / `git.exe` | exit 0 | **exit 0**（stdin JSON 往返也正常） |

结论：被拦的是 **Cygwin/MSYS2 运行时**，不是 `bash` 这个名字——同一个安装里的 `ls.exe` 同样失败，
而 mingw 原生的 `git.exe` 正常。`read-only` 与 `workspace-write` 表现一致。

## 为什么插件层修不了

`ctx.sandbox.confine()` 只返回 argv；构造受限令牌的 restricting SID 列表在
`dsh-sandbox-windows-acl` 内部（`types-*.js`）。真实 bash 需要的共享内存/信号管道安全描述符点名
**用户自己的 SID**，write-restricted 令牌的第二遍访问检查满足不了它。lab 里把当前用户 SID 加进
restricting 列表确实能让 Git bash 跑起来（低完整性 + 用户 SID 时仍保持写限制，但 `$HOME` 不可写；
中完整性 + 用户 SID 则连写限制都没了），这属于上游 DSH 的改动范围，插件无法触达。

因此插件的行为是：Windows 上 `mode: bash` 在非 `danger-full-access` 档位**提前**失败并返回
`BASH_SANDBOX_UNSUPPORTED`，提示改用 `powershell`/`executable` 或放宽该工具档位。

## 对作者的建议

- 需要「快、稳、可沙箱」：`mode: executable`（`git`、`node`、`python`、`rg` 等原生程序）。
- 需要脚本逻辑：`mode: powershell` + `args: [{ stdin: 'json' }]`（`-Command` 之后的 token 不会进
  `$args`，只会被拼进命令文本，因此位置传参被禁止）。
- 坚持用 bash：把该工具写成 `sandbox: danger-full-access`，并注意此时没有任何写限制。
