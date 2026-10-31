/**
 * Turn raw process facts into one stable error code.
 *
 * Order matters: a timeout that also has a non-zero exit code is a timeout, and
 * a sandbox denial that also has exit code 1 is a denial. The list below is the
 * first-cause order from the design; each entry explains *why* it outranks the
 * ones after it.
 */

const HINTS = {
  TIMED_OUT: '把 timeoutMs 调大，或让命令自身支持更小的查询范围；插件不会替你重试',
  ABORTED: '调用已被取消（用户中断或工具被禁用/更新）。重新发起即可',
  OUTPUT_LIMIT: '输出超过上限被丢弃。请让命令少打印（分页、加过滤参数或 --quiet），插件不会截断后继续',
  SANDBOX_UNAVAILABLE: '沙箱 runner 未能启动。检查宿主沙箱配置；非 full-access 档位下插件不会裸跑',
  SANDBOX_DENIED: '目标路径被沙箱拒绝。把 cwd 或要写的路径放进工作区，或放宽该工具的 sandbox 档位',
  BASH_SANDBOX_UNSUPPORTED: 'Windows 上的 bash 只能在 danger-full-access 下运行（MSYS2 运行时无法在受限令牌中初始化）；改成 powershell/executable 模式，或把该工具的 sandbox 设为 danger-full-access',
  PROCESS_EXIT: '命令以非零码退出；看 stderr 判断是参数问题还是业务失败',
  PROCESS_SIGNALED: '进程被外部信号终止（任务管理器、系统 OOM 等），不是插件取消的',
  INVALID_JSON_OUTPUT: 'output.parse 声明为 json，但 stdout 不是合法 JSON；确认命令在成功时只输出 JSON',
  OUTPUT_SCHEMA_MISMATCH: '输出不符合 output.schema；对照 schema 检查字段名与类型',
  EXECUTABLE_NOT_FOUND: '可执行文件找不到。填 PATH 名（如 git）或绝对路径；相对路径不受支持',
  SCRIPT_UNAVAILABLE: '脚本不存在、不是文件或哈希不匹配。检查 script 路径与 scriptSha256',
  SPAWN_FAILED: '进程启动失败。常见原因：权限不足、可执行文件损坏、cwd 已被删除',
  CWD_UNAVAILABLE: '工作目录不存在或不是目录。改 cwd，或先让会话工作目录可用',
  CREDENTIAL_UNAVAILABLE: '凭据未配置。先在宿主凭据里建好该引用名，再重试',
  APPROVAL_REJECTED: '本次调用被拒绝',
  APPROVAL_UNAVAILABLE: '当前没有可用的审批通道（会话策略为 never，或不在一个打开的轮次里）',
  INVALID_ARGUMENT: '参数不符合声明。按错误信息修正后重试',
  INVALID_CONFIG: '工具定义有误，先修正定义再调用',
  TOOL_RELOADING: '工具正在热更新，本次调用没进入执行。稍后重试',
  CUSTOM_TOOL_INTERNAL: '插件内部错误。请看 /custom-tools status 的诊断',
}

function matchesSignatures(text, signatures) {
  if (!text || !Array.isArray(signatures) || signatures.length === 0) return false
  return signatures.some((sig) => typeof sig === 'string' && sig !== '' && text.includes(sig))
}

/**
 * @param {object} facts
 * @param {number|null} facts.exitCode
 * @param {string|null} facts.signal
 * @param {boolean} facts.timedOut
 * @param {boolean} facts.aborted
 * @param {boolean} facts.lossy
 * @param {string} facts.stderr
 * @param {{originalArgv0?: string, confinedArgv0?: string,
 *          denialSignatures?: string[], runnerFailureRules?: string[]}} facts.sandbox
 * @returns {{code: string|null, message: string, hint: string}}
 */
export function classifyExit(facts) {
  const {
    exitCode, signal, timedOut, aborted, lossy, stderr = '', sandbox = {},
  } = facts

  if (timedOut) {
    return { code: 'TIMED_OUT', message: '命令超时，已终止并等待其真实退出', hint: HINTS.TIMED_OUT }
  }
  if (aborted) {
    return { code: 'ABORTED', message: '调用被取消，已终止并等待其真实退出', hint: HINTS.ABORTED }
  }
  if (lossy) {
    return { code: 'OUTPUT_LIMIT', message: '输出超过上限，已丢弃全部输出', hint: HINTS.OUTPUT_LIMIT }
  }

  // The runner swapped argv[0]; a failure in that situation is about the runner,
  // not about the user's program. stderr signatures are a *secondary* judge —
  // a program that prints "bwrap: " itself must not be misread as a sandbox fault.
  const runnerSwapped = typeof sandbox.confinedArgv0 === 'string'
    && typeof sandbox.originalArgv0 === 'string'
    && sandbox.confinedArgv0 !== sandbox.originalArgv0
  const runnerContext = runnerSwapped && exitCode !== 0

  if (runnerContext && matchesSignatures(stderr, sandbox.denialSignatures)) {
    return {
      code: 'SANDBOX_DENIED',
      message: '沙箱拒绝了这次执行',
      hint: HINTS.SANDBOX_DENIED,
    }
  }
  if (runnerContext && matchesSignatures(stderr, sandbox.runnerFailureRules)) {
    return {
      code: 'SANDBOX_UNAVAILABLE',
      message: '沙箱 runner 未能正常运行',
      hint: HINTS.SANDBOX_UNAVAILABLE,
    }
  }

  if (exitCode !== null && exitCode !== 0) {
    return {
      code: 'PROCESS_EXIT',
      message: `命令以退出码 ${exitCode} 结束`,
      hint: HINTS.PROCESS_EXIT,
    }
  }

  if (signal !== null && signal !== undefined) {
    return {
      code: 'PROCESS_SIGNALED',
      message: `命令被信号 ${signal} 终止`,
      hint: HINTS.PROCESS_SIGNALED,
    }
  }

  return { code: null, message: '', hint: '' }
}

export function hintFor(code) {
  return HINTS[code] ?? ''
}

export default classifyExit
