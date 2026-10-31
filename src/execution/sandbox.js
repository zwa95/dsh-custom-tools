/**
 * Sandbox tier arithmetic.
 *
 * Two rules, both about not lying to the user:
 *
 *   - A definition may only be *stricter* than the session. `danger-full-access`
 *     in the manifest never widens a `read-only` session.
 *   - `danger-full-access` is the only tier that skips `confine()` — the host's
 *     confine has no mode short-circuit, so calling it with full access would
 *     wrap the process in the ACL runner anyway.
 */

export const SANDBOX_TIERS = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])

const RANK = new Map(SANDBOX_TIERS.map((tier, index) => [tier, index]))

export function stricter(declared, session) {
  const a = RANK.has(declared) ? RANK.get(declared) : RANK.get('workspace-write')
  const b = RANK.has(session) ? RANK.get(session) : RANK.get('workspace-write')
  return SANDBOX_TIERS[Math.min(a, b)]
}

export function isFullAccess(tier) {
  return tier === 'danger-full-access'
}

/**
 * The `SandboxExecutionPolicy` handed to `confine()` must be one of the two
 * confined tiers; full access never reaches this function.
 */
export function confinementPolicy(policy, effective) {
  if (isFullAccess(effective)) {
    throw new Error('confinementPolicy called for danger-full-access')
  }
  return { ...policy, mode: effective }
}
