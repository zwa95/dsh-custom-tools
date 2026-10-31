/**
 * Test double for `@deepseek-ai/dsh-tools`.
 *
 * It reproduces the parts of `defineTool` this plugin depends on, and — more
 * importantly — reproduces its *failures*: the author-schema assertions and
 * the option-shape checks, so a definition mistake fails here instead of at
 * profile load.
 *
 * Rules mirrored from `dsh-tools/lib/types/schema.js` (verified against the
 * shipped runtime): annotations are `description|title|default|examples`,
 * property maps may add `required: true`, `oneOf` forbids a sibling `type` and
 * needs two or more branches, object nodes need an explicit
 * `additionalProperties` boolean, scalar nodes accept only `enum`/`const`.
 */

const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']
const SCALARS = ['string', 'number', 'integer', 'boolean', 'null']

function authorError(message) {
  throw new TypeError(message)
}

function compileNode(input, path, allowRequired) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    authorError(`${path} must be a value schema object`)
  }
  const annotation = [...ANNOTATION_KEYS, ...(allowRequired ? ['required'] : [])]

  if (Object.hasOwn(input, 'oneOf')) {
    const allowed = [...annotation, 'oneOf']
    for (const key of Object.keys(input)) {
      if (!allowed.includes(key)) authorError(`${path}.${key} is not supported by the value schema DSL`)
    }
    if (Object.hasOwn(input, 'type')) authorError(`${path} cannot declare both type and oneOf`)
    if (!Array.isArray(input.oneOf) || input.oneOf.length < 2) {
      authorError(`${path}.oneOf must be an array of at least two value schemas`)
    }
    return { oneOf: input.oneOf.map((branch, index) => compileNode(branch, `${path}.oneOf[${index}]`, false)) }
  }

  const type = input.type
  let allowed
  if (type === 'json') allowed = [...annotation, 'type']
  else if (type === 'object') allowed = [...annotation, 'type', 'properties', 'additionalProperties']
  else if (type === 'array') allowed = [...annotation, 'type', 'items']
  else if (SCALARS.includes(type)) allowed = [...annotation, 'type', 'enum', 'const']
  else authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`)

  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) authorError(`${path}.${key} is not supported by the value schema DSL`)
  }

  if (type === 'object') {
    if (typeof input.additionalProperties !== 'boolean') {
      authorError(`${path}.additionalProperties must be explicitly true or false`)
    }
    const node = { type: 'object', additionalProperties: input.additionalProperties, properties: {} }
    for (const [name, property] of Object.entries(input.properties ?? {})) {
      node.properties[name] = compileNode(property, `${path}.properties.${name}`, true)
    }
    return node
  }

  if (type === 'array') {
    return {
      type: 'array',
      ...(Object.hasOwn(input, 'items') ? { items: compileNode(input.items, `${path}.items`, false) } : {}),
    }
  }

  return {
    type,
    ...(Object.hasOwn(input, 'enum') ? { enum: [...input.enum] } : {}),
    ...(Object.hasOwn(input, 'const') ? { const: input.const } : {}),
  }
}

/** Compile the per-property parameter map into an object schema with `required`. */
export function parameterSchemaSpecToJsonSchema(spec) {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    authorError('parameters must be an object of value schemas')
  }
  const properties = {}
  const required = []
  for (const [name, property] of Object.entries(spec)) {
    if (typeof property !== 'object' || property === null) authorError(`parameters.${name} must be a value schema object`)
    if (Object.hasOwn(property, 'required') && property.required !== true) {
      authorError(`parameters.${name}.required must be true when present`)
    }
    if (property.required === true) required.push(name)
    properties[name] = compileNode(property, `parameters.${name}`, true)
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
}

/** Minimal structural validation, enough to catch wrong argument shapes. */
function validateValue(schema, value, path, violations) {
  if (schema.oneOf !== undefined) {
    const branchOk = schema.oneOf.some((branch) => {
      const local = []
      validateValue(branch, value, path, local)
      return local.length === 0
    })
    if (!branchOk) violations.push(`${path || 'value'} does not match any allowed shape`)
    return
  }
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') violations.push(`${path || 'value'} must be a string`)
      else if (schema.enum !== undefined && !schema.enum.includes(value)) {
        violations.push(`${path || 'value'} must be one of ${schema.enum.join(', ')}`)
      }
      return
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) violations.push(`${path || 'value'} must be a number`)
      return
    case 'integer':
      if (!Number.isInteger(value)) violations.push(`${path || 'value'} must be an integer`)
      return
    case 'boolean':
      if (typeof value !== 'boolean') violations.push(`${path || 'value'} must be a boolean`)
      return
    case 'null':
      if (value !== null) violations.push(`${path || 'value'} must be null`)
      return
    case 'array': {
      if (!Array.isArray(value)) {
        violations.push(`${path || 'value'} must be an array`)
        return
      }
      if (schema.items !== undefined) {
        value.forEach((item, index) => validateValue(schema.items, item, `${path}[${index}]`, violations))
      }
      return
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        violations.push(`${path || 'value'} must be an object`)
        return
      }
      for (const name of schema.required ?? []) {
        if (!Object.hasOwn(value, name)) violations.push(`${name} is required`)
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(schema.properties ?? {}, key)) violations.push(`${key} is not a declared property`)
        }
      }
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        if (Object.hasOwn(value, name)) validateValue(property, value[name], path === '' ? name : `${path}.${name}`, violations)
      }
      return
    }
    default:
      return
  }
}

/** Thrown for invalid model-generated arguments, like the real runtime. */
export class ToolArgsError extends Error {
  constructor(violations) {
    super(`invalid arguments: ${violations.join('; ')}`)
    this.name = 'ToolArgsError'
    this.code = 'INVALID_ARGS'
    this.violations = violations
  }
}

/** Build a registry-ready definition with the runtime's option shapes. */
export function defineTool(options) {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`)
  }
  if (options.isConcurrencySafe !== undefined && typeof options.isConcurrencySafe !== 'function') {
    throw new TypeError(`defineTool(${options.name}): isConcurrencySafe must be a function`)
  }
  const parameters = parameterSchemaSpecToJsonSchema(options.parameters)
  if (options.output === undefined || typeof options.output.render !== 'function') {
    throw new TypeError(`defineTool(${options.name}): output.render is required`)
  }
  const outputSchema = compileNode(options.output.schema, 'schema', false)

  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: options.output.render,
      ...(options.output.presentationMeta === undefined
        ? {}
        : { presentationMeta: options.output.presentationMeta }),
    },
    ...(options.deferLoading === true ? { deferLoading: true } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.isConcurrencySafe === undefined ? {} : { isConcurrencySafe: options.isConcurrencySafe }),
    async execute(args, exec) {
      const violations = []
      validateValue(parameters, args, '', violations)
      if (violations.length > 0) throw new ToolArgsError(violations)
      return options.execute(args, exec)
    },
  }
}
