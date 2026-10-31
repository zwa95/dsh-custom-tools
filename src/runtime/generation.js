/**
 * An immutable snapshot of every compiled tool plus a reference counter.
 *
 * Why a snapshot at all: the host's tool registry has no execution barrier. A
 * definition can be replaced while a call is already past `projectContent`, and
 * the call would then finish against a different body. Pinning a generation for
 * the duration of one call means the only thing that can change mid-call is
 * which generation is *current* — never what this call is running.
 *
 * `refcount` is the single mutable field; everything else is frozen.
 */
export class Generation {
  constructor({ id, contentHash, tools }) {
    this.id = id
    this.contentHash = contentHash
    this.tools = tools
    this.contractHashes = new Map(
      [...tools.entries()].map(([name, entry]) => [name, entry.contractHash]),
    )
    this.refcount = 0
    this.retired = false
    this._idle = undefined
    this._idlePromise = new Promise((resolve) => {
      this._idle = resolve
    })
    // `this.tools` / `this.contractHashes` stay unfrozen (a frozen Map is not
    // immutable anyway); the contract is that nothing mutates them after
    // construction.
  }

  retain() {
    this.refcount += 1
    return this
  }

  release() {
    if (this.refcount > 0) this.refcount -= 1
    if (this.refcount === 0 && this.retired && this._idle) {
      const done = this._idle
      this._idle = undefined
      done()
    }
    return this.refcount
  }

  /** Resolves once no call is still pinning this generation. */
  whenIdle() {
    if (this.refcount === 0) return Promise.resolve()
    return this._idlePromise
  }

  retire() {
    this.retired = true
    if (this.refcount === 0 && this._idle) {
      const done = this._idle
      this._idle = undefined
      done()
    }
    return this
  }

  entry(name) {
    return this.tools.get(name)
  }

  names() {
    return [...this.tools.keys()]
  }
}

export default Generation
