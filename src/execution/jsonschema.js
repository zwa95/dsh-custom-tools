/**
 * A very small JSON-Schema subset validator for `output.schema`.
 *
 * Deliberately not a general implementation: it supports exactly the keywords a
 * tool author needs to pin a command's JSON shape (type, properties, required,
 * additionalProperties, items, enum, const, oneOf, anyOf, nullable via type
 * arrays), and it reports the first failure path. Unsupported keywords are
 * ignored rather than silently rejecting everything.
 */

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function matchesType(expected, value) {
  const actual = typeOf(value)
  if (expected === actual) return true
  // `number` accepts integers; `integer` does not accept 1.5.
  if (expected === 'number' && actual === 'integer') return true
  return false
}

/**
 * @returns {string|null} a dotted failure path, or null when valid
 */
export function validateJsonSubset(schema, value, path = '$') {
  if (schema === undefined || schema === null) return null
  if (typeof schema !== 'object') return null

  if (Array.isArray(schema.oneOf)) {
    const results = schema.oneOf.map((sub) => validateJsonSubset(sub, value, path))
    if (results.some((result) => result === null)) return null
    return `${path}（不符合 oneOf 的任何一支）`
  }
  if (Array.isArray(schema.anyOf)) {
    if (schema.anyOf.some((sub) => validateJsonSubset(sub, value, path) === null)) return null
    return `${path}（不符合 anyOf 的任何一支）`
  }

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!expected.some((type) => matchesType(type, value))) {
      return `${path} 应为 ${expected.join('|')}，实际是 ${typeOf(value)}`
    }
  }

  if (Array.isArray(schema.enum)) {
    const hit = schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))
    if (!hit) return `${path} 不在允许的取值内`
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
    if (JSON.stringify(schema.const) !== JSON.stringify(value)) {
      return `${path} 必须等于 ${JSON.stringify(schema.const)}`
    }
  }

  if (typeOf(value) === 'object' && schema.properties !== undefined) {
    const props = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        return `${path}.${key} 缺失`
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue
      const failure = validateJsonSubset(sub, value[key], `${path}.${key}`)
      if (failure) return failure
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) {
          return `${path}.${key} 不在 schema.properties 内`
        }
      }
    }
    return null
  }

  if (typeOf(value) === 'array' && schema.items !== undefined) {
    for (let index = 0; index < value.length; index += 1) {
      const failure = validateJsonSubset(schema.items, value[index], `${path}[${index}]`)
      if (failure) return failure
    }
  }

  return null
}

export default validateJsonSubset
