/**
 * Test double for `@deepseek-ai/schemastery`.
 *
 * The plugin only *builds* schemas; validation and persistence belong to the
 * host. This double therefore records what it was told and nothing more — its
 * job is to keep the composition root loadable in unit tests and to make the
 * one rule this plugin genuinely depends on fail loudly: Schemastery refuses
 * `.volatile()` beneath another volatile field, and so do we.
 */

class SchemaNode {
  constructor(type, extra = {}) {
    this.type = type
    this.meta = { ...extra }
  }

  #clone(mutate) {
    const copy = new SchemaNode(this.type, this.meta)
    copy.dict = this.dict
    copy.list = this.list
    copy.branches = this.branches
    mutate(copy.meta, copy)
    return copy
  }

  get isVolatile() {
    return this.meta.volatile === true
  }

  default(value) { return this.#clone((meta) => { meta.default = value }) }
  description(text) { return this.#clone((meta) => { meta.description = text }) }
  required() { return this.#clone((meta) => { meta.required = true }) }
  step(value) { return this.#clone((meta) => { meta.step = value }) }
  min(value) { return this.#clone((meta) => { meta.min = value }) }
  max(value) { return this.#clone((meta) => { meta.max = value }) }
  role(value) { return this.#clone((meta) => { meta.role = value }) }
  hidden() { return this.#clone((meta) => { meta.hidden = true }) }
  check(fn) { return this.#clone((meta) => { meta.check = fn }) }

  volatile() {
    // A volatile field must sit at a fixed object path; declaring one beneath
    // another volatile field is rejected by the real Schemastery.
    if (this.meta.volatileAncestor === true) {
      throw new Error('volatile fields require a fixed object path without an enclosing volatile field')
    }
    const copy = this.#clone((meta) => { meta.volatile = true })
    markVolatile(copy)
    return copy
  }
}

function markVolatile(node) {
  const children = node.type === 'object'
    ? Object.values(node.dict ?? {})
    : [...(node.list ?? []), ...(node.branches ?? [])]
  for (const child of children) {
    child.meta.volatileAncestor = true
    markVolatile(child)
  }
}

function leaf(type) {
  return new SchemaNode(type)
}

/** Schemastery wraps bare literals as constants; so does the double. */
function wrap(value) {
  if (value instanceof SchemaNode) return value
  return new SchemaNode('const', { value: value })
}

const Schema = {
  string: () => leaf('string'),
  number: () => leaf('number'),
  boolean: () => leaf('boolean'),
  any: () => leaf('any'),
  object(fields) {
    const node = new SchemaNode('object')
    node.dict = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, wrap(value)]))
    return node
  },
  array(inner) {
    const node = new SchemaNode('array')
    node.list = [wrap(inner)]
    return node
  },
  dict(inner) {
    const node = new SchemaNode('dict')
    node.list = [wrap(inner)]
    return node
  },
  union(branches) {
    const node = new SchemaNode('union')
    node.branches = branches.map(wrap)
    return node
  },
}

export { Schema }
export default Schema
