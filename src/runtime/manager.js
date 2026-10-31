/**
 * Owns the live set of custom tools and every transition between generations.
 *
 * The commit rules, in one place:
 *
 *   1. Compile the whole candidate first. Nothing is torn down until a usable
 *      candidate exists — a broken edit costs the *previous* definitions, not
 *      the running ones.
 *   2. Diff by `contractHash`. Same hash ⇒ the model-facing contract is
 *      unchanged ⇒ move the pointer and leave the registration alone (a call in
 *      flight keeps its own pinned generation).
 *   3. Different hash, newly enabled, or newly removed ⇒ quiesce that one slot
 *      (abort + wait), then register/unregister. Only that tool is disturbed.
 *   4. Disabled keeps the compiled entry but drops the registration, so
 *      `preview`, `test`, `show` and `list` still work on it.
 *
 * Registrations are effect-owned: the slot's dispose function is registered on
 * the plugin's context, so a plugin teardown removes every tool even mid-reload.
 */
import { compile } from '../compiler/compile.js'
import { stableHash } from '../compiler/hash.js'
import { runCustomTool } from '../execution/run.js'
import { OUTPUT_SCHEMA } from '../result/contract.js'
import { Generation } from './generation.js'
import { ToolSlot } from './tool-slot.js'

export class Manager {
  constructor({ registry, services, defineTool, outputSchema = OUTPUT_SCHEMA }) {
    this.registry = registry
    this.services = services
    this.defineTool = defineTool
    this.outputSchema = outputSchema

    this.slots = new Map()
    this.current = new Generation({ id: 0, contentHash: stableHash({ tools: [] }), tools: new Map() })
    this.nextId = 1
    this.issues = []
    this.usedLastGood = []
    this.lastCommitAt = undefined
    this.closing = false
    this.applying = Promise.resolve()
  }

  /**
   * Apply a snapshot. Serialised: two saves landing together must not interleave
   * two diffs.
   */
  apply(snapshot) {
    const run = () => this.applyNow(snapshot)
    const chained = this.applying.then(run, run)
    this.applying = chained.then(() => undefined, () => undefined)
    return chained
  }

  async applyNow(snapshot) {
    if (this.closing) return { changed: false, issues: this.issues }

    const candidate = compile(snapshot, this.current.tools)
    this.issues = candidate.issues
    this.usedLastGood = candidate.usedLastGood

    if (!candidate.ok) {
      // Whole-document failure: keep the previous generation untouched.
      return { changed: false, issues: candidate.issues, usedLastGood: candidate.usedLastGood }
    }

    // The content hash must cover the *whole* plan, not just the contract: a
    // body-only edit (new argv, new env) changes nothing the model sees, but a
    // no-op here would silently keep the old generation serving the old argv.
    const contentHash = stableHash(
      [...candidate.tools.entries()]
        .map(([name, entry]) => [name, entry.contractHash, stableHash(entry.plan)])
        .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    )
    if (contentHash === this.current.contentHash) {
      return { changed: false, issues: candidate.issues, usedLastGood: candidate.usedLastGood }
    }

    const previous = this.current
    const next = new Generation({ id: this.nextId, contentHash, tools: candidate.tools })
    this.nextId += 1

    // Publish first: new calls reach the new content even while we swap slots.
    this.current = next

    for (const [name, entry] of candidate.tools) {
      const slot = this.slots.get(name)
      const wantsRegistration = entry.plan.enabled !== false

      if (!slot) {
        if (!wantsRegistration) continue
        const created = new ToolSlot({
          name,
          manager: this,
          services: this.services,
          defineTool: this.defineTool,
          registry: this.registry,
        })
        this.slots.set(name, created)
        created.register()
        continue
      }

      const previousHash = previous.contractHashes.get(name)

      if (!wantsRegistration) {
        if (slot.active) {
          await slot.quiesce()
          slot.unregister()
        }
        continue
      }

      if (previousHash === entry.contractHash && slot.active) {
        continue // compatible change: the slot already routes to `this.current`
      }

      if (!slot.active) {
        slot.register()
        continue
      }

      // Breaking change: no call may straddle two shapes.
      await slot.quiesce()
      slot.register()
    }

    for (const [name, slot] of this.slots) {
      if (candidate.tools.has(name)) continue
      if (slot.active) {
        await slot.quiesce()
        slot.unregister()
      }
      this.slots.delete(name)
    }

    previous.retire()
    previous.whenIdle().catch(() => {})
    this.lastCommitAt = Date.now()

    return { changed: true, issues: candidate.issues, usedLastGood: candidate.usedLastGood }
  }

  pin() {
    return this.current.retain()
  }

  entryFor(generation, name) {
    return generation.tools.get(name)
  }

  currentEntry(name) {
    return this.current.tools.get(name)
  }

  concurrencyOf(name) {
    return this.currentEntry(name)?.plan.concurrency ?? 'exclusive'
  }

  get(name) {
    return this.current.tools.get(name)
  }

  list() {
    return [...this.current.tools.values()].map((entry) => ({
      name: entry.plan.name,
      title: entry.plan.title,
      mode: entry.plan.mode,
      enabled: entry.plan.enabled !== false,
      registered: this.slots.get(entry.plan.name)?.active === true,
      concurrency: entry.plan.concurrency,
      timeoutMs: entry.plan.timeoutMs,
      approval: entry.plan.approval,
    }))
  }

  /** Preview renders argv without spawning, using the same builder as execution. */
  async preview(name, args) {
    const entry = this.current.tools.get(name)
    if (!entry) return undefined
    return runCustomTool(this.services, entry, args ?? {}, {}, { spawn: false })
  }

  /** Test runs the real pipeline, including for disabled tools. */
  async test(name, args, exec = {}) {
    const entry = this.current.tools.get(name)
    if (!entry) return undefined
    return runCustomTool(this.services, entry, args ?? {}, exec)
  }

  status() {
    return {
      ok: this.issues.every((issue) => issue.severity !== 'error'),
      generationId: this.current.id,
      toolCount: this.current.tools.size,
      registeredCount: [...this.slots.values()].filter((slot) => slot.active).length,
      lastCommitAt: this.lastCommitAt,
      usedLastGood: this.usedLastGood,
      issues: this.issues,
    }
  }

  async dispose() {
    this.closing = true
    for (const slot of this.slots.values()) {
      await slot.quiesce()
      slot.unregister()
    }
    this.slots.clear()
    this.current.retire()
  }
}

export default Manager
