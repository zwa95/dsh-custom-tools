/**
 * Parameter specs → the host's restricted JSON-Schema DSL, plus the pure
 * argument normalisation that runs before anything is spawned.
 *
 * Two things are deliberate:
 *
 *   - The DSL is a *strict subset*: no `pattern`, `minimum`, `format` or
 *     `maxItems`. So range checks that the schema cannot express are enforced
 *     here, before spawn, and reported as `INVALID_ARGUMENT`.
 *   - `additionalProperties: false` is set explicitly. The author DSL leaves the
 *     implicit root object open, which would let a model smuggle extra keys.
 */
import { tryParseJson } from '../config/validate.js'

const SCALARS = new Set(['string', 'number', 'integer', 'boolean'])

function dslFor(spec) {
  switch (spec.type) {
    case 'string': {
      const node = { type: 'string' }
      if (typeof spec.description === 'string' && spec.description !== '') {
        node.description = spec.description
      }
      return node
    }
    case 'number':
    case 'integer':
    case 'boolean': {
      const node = { type: spec.type }
      if (typeof spec.description === 'string' && spec.description !== '') {
        node.description = spec.description
      }
      return node
    }
    case 'array': {
      const items = SCALARS.has(spec.items) ? { type: spec.items } : { type: 'string' }
      const node = { type: 'array', items }
      if (typeof spec.description === 'string' && spec.description !== '') {
        node.description = spec.description
      }
      return node
    }
    default:
      return { type: 'string' }
  }
}

/**
 * Build the *property map* handed to `defineTool`.
 *
 * The runtime's `parameters` option is not a whole object schema: it is a map
 * of `name -> value schema`, which `parameterSchemaSpecToJsonSchema` compiles
 * into the implicit root object itself. Passing `{type:'object', properties}`
 * here would declare a single parameter literally named `type`.
 *
 * Each property carries `required: true` inline (the DSL's own convention)
 * rather than a sibling `required` array — the runtime derives that array.
 */
export function toParameterProperties(parameters = {}) {
  const properties = {}
  for (const [name, spec] of Object.entries(parameters)) {
    const node = dslFor(spec)
    const optional = spec.default !== undefined && spec.default !== ''
    if (spec.required === true && !optional) node.required = true
    properties[name] = node
  }
  return properties
}

function coerceScalar(spec, name, value, errors) {
  const where = `参数 ${name}`

  if (spec.type === 'boolean') {
    if (typeof value === 'boolean') return value
    if (value === 'true') return true
    if (value === 'false') return false
    errors.push(`${where} 必须是布尔值`)
    return undefined
  }

  if (spec.type === 'number' || spec.type === 'integer') {
    const num = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(num)) {
      errors.push(`${where} 必须是数字`)
      return undefined
    }
    if (spec.type === 'integer' && !Number.isInteger(num)) {
      errors.push(`${where} 必须是整数`)
      return undefined
    }
    if (typeof spec.min === 'number' && num < spec.min) {
      errors.push(`${where} 不能小于 ${spec.min}`)
      return undefined
    }
    if (typeof spec.max === 'number' && num > spec.max) {
      errors.push(`${where} 不能大于 ${spec.max}`)
      return undefined
    }
    return num
  }

  // string
  if (typeof value !== 'string') {
    errors.push(`${where} 必须是字符串`)
    return undefined
  }
  if (typeof spec.minLength === 'number' && value.length < spec.minLength) {
    errors.push(`${where} 长度不能小于 ${spec.minLength}`)
    return undefined
  }
  if (typeof spec.maxLength === 'number' && value.length > spec.maxLength) {
    errors.push(`${where} 长度不能大于 ${spec.maxLength}`)
    return undefined
  }
  return value
}

function coerceArray(spec, name, value, errors) {
  if (!Array.isArray(value)) {
    errors.push(`参数 ${name} 必须是数组`)
    return undefined
  }
  const itemSpec = { type: SCALARS.has(spec.items) ? spec.items : 'string' }
  const out = []
  for (const item of value) {
    const coerced = coerceScalar(itemSpec, name, item, errors)
    if (coerced === undefined) return undefined
    out.push(coerced)
  }
  return out
}

/**
 * Normalise the model's arguments: reject unknown keys, apply defaults, coerce
 * and range-check. Returns a new object; never mutates the input.
 */
export function normalizeArguments(parameters, raw) {
  const errors = []
  const values = {}
  const input = raw === undefined || raw === null ? {} : raw

  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['参数必须是一个对象'] }
  }

  for (const key of Object.keys(input)) {
    if (!(key in parameters)) errors.push(`未声明的参数 ${key}`)
  }

  for (const [name, spec] of Object.entries(parameters)) {
    const provided = Object.prototype.hasOwnProperty.call(input, name)
    let value = provided ? input[name] : undefined

    if (!provided || value === undefined) {
      if (spec.default !== undefined && spec.default !== '') {
        const parsed = tryParseJson(spec.default)
        if (!parsed.ok) {
          errors.push(`参数 ${name} 的默认值不是合法 JSON`)
          continue
        }
        value = parsed.value
      } else if (spec.required === true) {
        errors.push(`缺少必填参数 ${name}`)
        continue
      } else {
        continue
      }
    }

    if (value === null) {
      if (spec.required === true) {
        errors.push(`参数 ${name} 不允许为 null`)
        continue
      }
      continue
    }

    const coerced = spec.type === 'array'
      ? coerceArray(spec, name, value, errors)
      : coerceScalar(spec, name, value, errors)
    if (coerced === undefined) continue
    values[name] = coerced
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, values }
}

export function parameterNames(parameters = {}) {
  return Object.keys(parameters)
}
