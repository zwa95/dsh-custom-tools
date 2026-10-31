/**
 * `node --test` module hooks.
 *
 * The plugin's peer dependencies (`@deepseek-ai/dsh-tools`,
 * `@deepseek-ai/schemastery`) only exist inside an installed profile. Unit
 * tests still need the *real* composition root to load, so those two
 * specifiers are redirected to the faithful doubles in this directory. The
 * doubles are test-only: nothing in `src/` or `index.js` knows about them.
 */
const STUBS = new Map([
  ['@deepseek-ai/dsh-tools', new URL('./dsh-tools.js', import.meta.url).href],
  ['@deepseek-ai/schemastery', new URL('./schemastery.js', import.meta.url).href],
])

export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS.get(specifier)
  if (stub !== undefined) return { url: stub, shortCircuit: true }
  return nextResolve(specifier, context)
}
