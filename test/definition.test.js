/**
 * Conformance of the *definition we hand to the host* with the host's author
 * schema DSL, plus the option shapes `defineTool` actually accepts.
 *
 * These assertions are duplicated from the shipped DSL on purpose: the real
 * `defineTool` compiles the schema lazily, so a mistake here surfaces as a
 * plugin that fails to load — the worst place to find it. Everything below is
 * a rule read off `dsh-tools/lib/types/schema.js`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { OUTPUT_SCHEMA } from '../src/result/contract.js'
import { toParameterProperties } from '../src/compiler/parameters.js'

const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']
const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean', 'null']

/**
 * Walk one author value-schema node the way `runSchemaCompiler` does.
 * @param {unknown} node
 * @param {string} path
 * @param {boolean} allowRequired properties may carry `required: true`
 */
function assertAuthorNode(node, path, allowRequired) {
  assert.equal(typeof node, 'object', `${path} must be a value schema object`)
  assert.ok(node !== null && !Array.isArray(node), `${path} must be a value schema object`)

  const annotation = [...ANNOTATION_KEYS, ...(allowRequired ? ['required'] : [])]

  if (Object.hasOwn(node, 'required')) {
    assert.equal(node.required, true, `${path}.required must be true when present`)
  }

  if (Object.hasOwn(node, 'oneOf')) {
    const allowed = [...annotation, 'oneOf']
    for (const key of Object.keys(node)) {
      assert.ok(allowed.includes(key), `${path}.${key} is not supported by the value schema DSL`)
    }
    assert.ok(!Object.hasOwn(node, 'type'), `${path} cannot declare both type and oneOf`)
    assert.ok(Array.isArray(node.oneOf) && node.oneOf.length >= 2, `${path}.oneOf needs two or more branches`)
    node.oneOf.forEach((branch, index) => assertAuthorNode(branch, `${path}.oneOf[${index}]`, false))
    return
  }

  const type = node.type
  let allowed
  if (type === 'json') {
    allowed = [...annotation, 'type']
  } else if (type === 'object') {
    allowed = [...annotation, 'type', 'properties', 'additionalProperties']
  } else if (type === 'array') {
    allowed = [...annotation, 'type', 'items']
  } else if (SCALAR_TYPES.includes(type)) {
    allowed = [...annotation, 'type', 'enum', 'const']
  } else {
    assert.fail(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`)
  }

  for (const key of Object.keys(node)) {
    assert.ok(allowed.includes(key), `${path}.${key} is not supported by the value schema DSL`)
  }

  if (type === 'object') {
    assert.equal(
      typeof node.additionalProperties,
      'boolean',
      `${path}.additionalProperties must be explicitly true or false`,
    )
    for (const [name, property] of Object.entries(node.properties ?? {})) {
      assertAuthorNode(property, `${path}.properties.${name}`, true)
    }
    return
  }

  if (type === 'array' && Object.hasOwn(node, 'items')) {
    assertAuthorNode(node.items, `${path}.items`, false)
  }
}

test('the universal output schema is expressible in the author DSL', () => {
  assertAuthorNode(OUTPUT_SCHEMA, 'schema', false)
})

test('the parameter map is a map of value schemas, not an object schema', () => {
  const parameters = toParameterProperties({
    query: { type: 'string', required: true, description: 'what to search for' },
    limit: { type: 'number', description: 'how many' },
    tags: { type: 'array', items: 'string' },
    flag: { type: 'boolean' },
  })

  // A whole object schema here would declare one parameter named `type`.
  assert.deepEqual(Object.keys(parameters).sort(), ['flag', 'limit', 'query', 'tags'])
  for (const [name, node] of Object.entries(parameters)) {
    assertAuthorNode(node, `parameters.${name}`, true)
  }

  // The runtime derives the required list from the inline flags.
  assert.deepEqual(
    Object.entries(parameters).filter(([, node]) => node.required === true).map(([name]) => name),
    ['query'],
  )
})

test('a default makes a parameter optional in the schema', () => {
  const parameters = toParameterProperties({
    limit: { type: 'number', required: true, default: '25' },
  })
  assert.equal(Object.hasOwn(parameters.limit, 'required'), false)
})
