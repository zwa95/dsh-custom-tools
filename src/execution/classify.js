/**
 * Turn raw process facts into one stable error code.
 *
 * Order matters: a timeout that also has a non-zero exit code is a timeout. The
 * list below is the first-cause order from the design; each entry explains *why*
 * it outranks the ones after it.
 */

const HINTS = {
  TIMED_OUT: '把 timeoutMs 调大，或让命令自身支持更小的查询范围；插件不会替你重试',
  ABORTED: '调用已被取消（用户中断或工具被禁用/更新）。重新发起即可',
  OUTPUT_LIMIT: '输出超过上限被丢弃。请让命令少打印（分页、加过滤参数或 --quiet），插件不会截断后继续',
  PROCESS_EXIT: '命令以非零码退出；看 stderr 判断是参数问题还是业务失败',
  PROCESS_SIGNALED: '进程被外部信号终止（任务管理器、系统 OOM 等），不是插件取消的',
  INVALID_JSON_OUTPUT: 'output.parse 声明为 json，但 stdout 不是合法 JSON；确认命令在成功时只输出 JSON',
  OUTPUT_SCHEMA_MISMATCH: '输出不符合 output.schema；对照 schema 检查字段名与类型',
  EXECUTABLE_NOT_FOUND: '可执行文件找不到。填 PATH 名（如 git）或绝对路径；相对路径不受支持',
  SCRIPT_UNAVAILABLE: '脚本不存在或不是文件。检查 script 路径',
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

/**
 * @param {object} facts
 * @param {number|null} facts.exitCode
 * @param {string|null} facts.signal
 * @param {boolean} facts.timedOut
 * @param {boolean} facts.aborted
 * @param {boolean} facts.lossy
 * @returns {{code: string|null, message: string, hint: string}}
 */
export function classifyExit(facts) {
  const {
    exitCode, signal, timedOut, aborted, lossy,
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
