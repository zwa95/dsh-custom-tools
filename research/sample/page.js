/**
 * Sample B — the hand-written settings page.
 *
 * The Host half only declares the Config. The page lives in `client.js` and is
 * mounted into `plugins.row.config`, keyed by `<package name>#<row id>`.
 */
import Schema from '@deepseek-ai/schemastery'

export const name = 'custom-tools-sample/page'

export const Config = Schema.object({
  label: Schema.string().default('custom page').description('标题').volatile(),
  count: Schema.number().step(1).min(0).default(1).description('数量').volatile(),
  note: Schema.string().default('').description('备注').volatile(),
  apiKey: Schema.string().role('secret').description('secret 字段').volatile(),
  tools: Schema.array(
    Schema.object({
      name: Schema.string().required().description('工具名'),
      target: Schema.string().default('').description('可执行文件或命令'),
      enabled: Schema.boolean().default(true).description('启用'),
    }),
  )
    .default([{ name: 'demo', target: 'C:/Windows/System32/cmd.exe', enabled: true }])
    .description('对象数组：自定义页面直接编辑它')
    .volatile(),
})

export function apply() {}
