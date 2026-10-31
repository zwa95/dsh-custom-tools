/**
 * The shipped examples are documentation that can rot. This test keeps them
 * honest: every `examples/*.json` must pass the same validator the settings
 * page and `/custom-tools add` use, and must survive compilation into a plan.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { compile } from '../src/compiler/compile.js'
import { validateTool } from '../src/config/validate.js'

const directory = join(import.meta.dirname, '..', 'examples')
const files = readdirSync(directory).filter((file) => file.endsWith('.json'))

test('every example is a valid tool definition', () => {
  assert.ok(files.length > 0, 'examples are not empty')

  for (const file of files) {
    const spec = JSON.parse(readFileSync(join(directory, file), 'utf8'))
    const issues = validateTool(spec, file)
    assert.deepEqual(issues, [], `${file} must validate: ${JSON.stringify(issues, null, 2)}`)

    const result = compile({ tools: [spec] })
    assert.equal(result.ok, true, `${file} must compile`)
    assert.deepEqual(result.issues, [], `${file} must compile without issues`)
    assert.ok(result.tools.has(spec.name), `${file} produces a plan for ${spec.name}`)
  }
})

test('every example declares a description the model can route on', () => {
  for (const file of files) {
    const spec = JSON.parse(readFileSync(join(directory, file), 'utf8'))
    assert.ok(spec.description.length > 10, `${file} needs a real description`)
    assert.equal(typeof spec.whenToUse, 'string', `${file} should say when to use it`)
  }
})
