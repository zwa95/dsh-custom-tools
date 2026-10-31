/**
 * dsh-custom-tools — user-declared tools for DeepSeek Harness.
 *
 * The composition root does four things and nothing else:
 *
 *   1. translate the host context into the plain `services` object the
 *      executor wants (lazily — a deployment may compose no sandbox, and that
 *      must fail per call as `SANDBOX_UNAVAILABLE`, not at load);
 *   2. own the {@link Manager} and feed it the volatile config snapshot;
 *   3. register `/custom-tools`;
 *   4. tie every registration to this plugin's effect scope.
 *
 * Config is `volatile`, so a settings save reaches us as
 * `loader/volatile-update` and re-compiles in place — no remount, no restart,
 * and a broken definition keeps its previous generation serving.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import { Manager } from './src/runtime/manager.js'
import { registerCommands } from './src/commands/index.js'
import { OUTPUT_SCHEMA } from './src/result/contract.js'

/** The profile row id; it doubles as the settings namespace. */
export const name = 'custom-tools'

export { Config } from './src/config/schema.js'

/**
 * Only the tool registry is a hard dependency: without it there is nothing to
 * register. Everything else is consumed opportunistically per call, so a
 * profile with no sandbox or no credential store still loads and explains
 * itself.
 */
export const inject = ['tools']

/** Volatile config holders are `{get()}` refs; tolerate a plain value too. */
function readRef(ref, fallback) {
  if (ref === undefined || ref === null) return fallback
  if (typeof ref.get === 'function') {
    const value = ref.get()
    return value === undefined ? fallback : value
  }
  return ref
}

function snapshotOf(config) {
  return {
    tools: readRef(config?.tools, []),
    deferLoading: readRef(config?.deferLoading, false) === true,
  }
}

export function apply(ctx, config) {
  // Services are looked up per call: a sandbox or approval channel may be
  // mounted later, and a teardown must surface as a clean failure.
  const services = {
    get subprocess() { return ctx.get('subprocess') },
    get sandbox() { return ctx.get('sandbox') },
    get sandboxPolicy() { return ctx.get('sandboxPolicy') },
    get shellEnv() { return ctx.get('shellEnv') },
    get workingDirectory() { return ctx.get('workingDirectory') },
    get credentials() { return ctx.get('credentials') },
    async requestApproval(exec, plan) {
      const approval = ctx.get('approval')
      if (!approval || !exec?.agent) return 'unavailable'
      try {
        return await approval.request({
          agent: exec.agent,
          toolName: plan.name,
          callId: exec.callId ?? plan.name,
          reason: `工具 ${plan.name} 声明了每次调用都需要确认`,
          signal: exec.signal,
        })
      } catch {
        return 'unavailable'
      }
    },
  }

  const registry = {
    register: (definition) => ctx.tools.register(definition),
    get: (toolName) => ctx.tools.get(toolName),
  }

  const manager = new Manager({ registry, services, defineTool, outputSchema: OUTPUT_SCHEMA })

  // `logger` is a guarded service in Cordis: reading it without declaring the
  // dependency throws, which would turn a merely noisy config into a failing
  // fiber. Fall back to the console instead of taking the plugin down.
  const warn = (message) => {
    try {
      const logger = ctx.logger
      if (typeof logger?.warn === 'function') {
        logger.warn(message)
        return
      }
    } catch {}
    console.warn(message)
  }

  const report = (outcome) => {
    if (!outcome || outcome.changed !== true) return
    const failed = outcome.issues.filter((issue) => issue.severity === 'error')
    if (failed.length > 0) {
      warn(`custom-tools: ${failed.length} issue(s): ${failed.map((i) => i.code).join(', ')}`)
    }
  }

  const refresh = () => {
    manager.apply(snapshotOf(config)).then(report, (error) => {
      warn(`custom-tools: apply failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  // Initial compile: a profile that already declares tools gets them registered
  // as soon as this plugin is mounted.
  refresh()

  ctx.effect(() => ctx.on('loader/volatile-update', () => { refresh() }), 'custom-tools: config')
  ctx.effect(() => () => manager.dispose(), 'custom-tools: tools')

  registerCommands(ctx, { manager, namespace: name })
}
