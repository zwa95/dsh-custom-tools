/**
 * Stable hashing helpers.
 *
 * Two hashes matter:
 *
 *   - `contractHash` decides whether a definition change is *compatible* (same
 *     name, parameters, description, timeout, concurrency → the model-facing
 *     contract is untouched, so the live ToolSlot can keep running and only the
 *     generation pointer moves) or *breaking* (anything else → in-flight calls
 *     are cancelled and the slot is re-registered).
 *   - `contentHash` identifies a whole generation so the manager can skip a
 *     no-op commit when a save produced an identical document.
 *
 * Keys are sorted so that a key order change in the patch file is not a change.
 */
import { createHash } from 'node:crypto'

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function stableHash(value) {
  return sha256Hex(canonical(value))
}

/**
 * The fields a model can observe. A change here must be visible to the next
 * assembled schema, which is why it cannot be applied in place.
 */
export function contractOf(plan) {
  return {
    name: plan.name,
    description: plan.description,
    whenToUse: plan.whenToUse ?? null,
    parameters: plan.parameterSchema ?? null,
    timeoutMs: plan.timeoutMs,
    concurrency: plan.concurrency,
    // Rendering reads this, and the presenter is captured when the execution is
    // created — changing it in place would render with the wrong mode.
    outputParse: plan.output?.parse ?? 'text',
    deferLoading: plan.deferLoading ?? false,
  }
}

export function contractHashOf(plan) {
  return stableHash(contractOf(plan))
}
