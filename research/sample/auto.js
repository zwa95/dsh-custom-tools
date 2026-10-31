/**
 * Sample A — the auto-generated settings form.
 *
 * Nothing in this file draws UI. The settings service projects the `volatile`
 * fields of this Config into a form descriptor, and the Plugins page renders it.
 */
import Schema from '@deepseek-ai/schemastery'

export const name = 'custom-tools-sample/auto'

export const Config = Schema.object({
  label: Schema.string().default('hello').description('一个普通字符串字段').volatile(),
  count: Schema.number().step(1).min(0).default(3).description('一个数字字段（整数、≥0）').volatile(),
  verbose: Schema.boolean().default(false).description('一个布尔字段').volatile(),
  endpoint: Schema.string().default('https://example.com').description('看起来像 URL 的字符串').volatile(),
  apiKey: Schema.string().role('secret').description('secret 字段：读不回来，只显示已配置').volatile(),
  tags: Schema.array(Schema.string())
    .default(['alpha', 'beta'])
    .description('字符串数组：能增删行吗？')
    .volatile(),
  tools: Schema.array(
    Schema.object({
      name: Schema.string().required().description('工具名'),
      target: Schema.string().default('').description('可执行文件或命令'),
      enabled: Schema.boolean().default(true).description('启用'),
    }),
  )
    .default([
      { name: 'git-status', target: 'C:/Program Files/Git/cmd/git.exe', enabled: true },
      { name: 'list-files', target: 'ls', enabled: false },
    ])
    .description('对象数组：自动表单能不能渲染嵌套结构？')
    .volatile(),
})

export function apply(ctx, config) {
  // Prove the volatile reference updates without a remount.
  ctx.effect(() =>
    ctx.on('loader/volatile-update', () => {
      ctx.logger?.info?.('[cts-auto] label=%s tools=%d', config.label.get(), config.tools.get().length)
    }),
  )
}
