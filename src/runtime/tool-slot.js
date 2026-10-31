/**
 * One registered tool name, one stable definition, many generations behind it.
 *
 * The slot is what makes hot reload safe in both directions:
 *
 *   - A *compatible* change (same model-facing contract) only moves the pointer
 *     that `execute` reads, so there is no unregister/re-register window and no
 *     way for a call to see a half-applied update.
 *   - A *breaking* change disposes this registration and registers a new one, so
 *     in-flight calls are cancelled first rather than finishing against a body
 *     that no longer matches the schema they were validated with.
 *
 * Every call gets its own `AbortController`: `exec.signal` is a read-only
 * reference the plugin cannot abort, so cancellation has to be owned here.
 */
import { runCustomTool } from '../execution/run.js'
import { renderResult } from '../result/render.js'
import { failure } from '../result/contract.js'

function anySignal(signals) {
  const list = signals.filter((signal) => signal !== undefined && signal !== null)
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any(list)
  }
  // Node 22+ has AbortSignal.any; this fallback exists only for exotic hosts.
  const controller = new AbortController()
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

export class ToolSlot {
  /**
   * @param {object} options
   * @param {string} options.name
   * @param {object} options.manager owner, used for generation pinning
   * @param {object} options.services injected host services
   * @param {Function} options.defineTool host `defineTool`
   * @param {object} options.registry `{register, get}` registration seam
   */
  constructor({ name, manager, services, defineTool, registry }) {
    this.name = name
    this.manager = manager
    this.services = services
    this.defineTool = defineTool
    this.registry = registry
    this.dispose = undefined
    this.definition = undefined
    this.inflight = new Set()
    this.active = true
    this.exclusiveQueue = Promise.resolve()
  }

  /** Register (or re-register) using the definition currently in the manager. */
  register() {
    const compiled = this.manager.currentEntry(this.name)
    if (!compiled) {
      this.dispose?.()
      this.dispose = undefined
      this.definition = undefined
      this.active = false
      return
    }

    const plan = compiled.plan
    const definition = this.defineTool({
      name: plan.name,
      description: plan.description,
      // `parameters` is the *property map*, not a whole object schema: the
      // runtime compiles the implicit root object itself.
      parameters: plan.parameterSchema,
      output: {
        schema: this.manager.outputSchema,
        render: (args, value) => [{
          type: 'text',
          text: renderResult(value, { parse: plan.output.parse }),
        }],
        // Display-only facts for the UI card. Must stay lossless JSON; it is
        // snapshotted and frozen by the host before it is stored.
        presentationMeta: (args, value) => ({
          cwd: value.cwd,
          exitCode: value.exitCode,
          durationMs: value.durationMs,
          code: value.code,
        }),
      },
      timeoutMs: plan.timeoutMs,
      // A function, not a boolean: the host calls it per call with the args.
      isConcurrencySafe: () => plan.concurrency === 'parallel',
      deferLoading: plan.deferLoading === true,
      execute: (args, exec) => this.execute(args, exec),
    })

    if (this.dispose) {
      this.dispose()
      this.dispose = undefined
    }
    this.definition = definition
    this.active = true
    this.dispose = this.registry.register(definition)
  }

  async execute(args, exec) {
    if (!this.active) {
      return failure('TOOL_RELOADING', '工具正在热更新，本次调用未进入执行')
    }

    const controller = new AbortController()
    this.inflight.add(controller)
    const generation = this.manager.pin()
    const signal = anySignal([exec?.signal, controller.signal])

    const run = () => runCustomTool(
      this.services,
      this.manager.entryFor(generation, this.name) ?? this.manager.currentEntry(this.name),
      args,
      exec ? { ...exec, signal } : { signal },
    )

    try {
      if (this.manager.concurrencyOf(this.name) === 'exclusive') {
        // Serialise per tool: a tool that touches a file or a device must not
        // race against itself just because the model issued two calls.
        const result = this.exclusiveQueue.then(run, run)
        this.exclusiveQueue = result.then(() => undefined, () => undefined)
        return await result
      }
      return await run()
    } finally {
      this.inflight.delete(controller)
      generation.release()
    }
  }

  /** Cancel every call currently inside this slot and wait for them to settle. */
  async quiesce() {
    const pending = [...this.inflight]
    for (const controller of pending) controller.abort()
    // The calls observe the abort themselves; waiting for the set to drain is
    // what makes the following unregister safe.
    while (this.inflight.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  unregister() {
    this.dispose?.()
    this.dispose = undefined
    this.definition = undefined
    this.active = false
  }
}

export default ToolSlot
