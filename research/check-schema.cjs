// Throwaway probe: confirm the Schemastery surface this sample relies on.
const mod = require('C:/Users/<user>/.dsh/profiles/desktop/node_modules/@deepseek-ai/schemastery/lib/index.cjs')
const S = mod.default || mod

console.log(
  'builders:',
  ['object', 'array', 'string', 'number', 'boolean', 'union', 'dict', 'const']
    .map((k) => k + '=' + typeof S[k])
    .join(' '),
)

const s = S.string()
console.log(
  'string methods:',
  ['role', 'volatile', 'description', 'default', 'required', 'step', 'min']
    .map((k) => k + '=' + typeof s[k])
    .join(' '),
)

try {
  const c = S.object({
    label: S.string().default('hello').description('d').volatile(),
    count: S.number().step(1).min(0).default(3).description('d').volatile(),
    verbose: S.boolean().default(false).description('d').volatile(),
    apiKey: S.string().role('secret').description('d').volatile(),
    tags: S.array(S.string()).default(['a']).description('d').volatile(),
    tools: S.array(
      S.object({
        name: S.string().required().description('n'),
        target: S.string().default('').description('t'),
        enabled: S.boolean().default(true).description('e'),
      }),
    )
      .default([{ name: 'x', target: 'y', enabled: true }])
      .description('d')
      .volatile(),
  })
  console.log('object schema: OK')
  const json = typeof c.toJSON === 'function' ? c.toJSON() : c
  console.log('projected:', JSON.stringify(json).slice(0, 600))
} catch (error) {
  console.log('object schema: FAIL', error && error.message)
}
