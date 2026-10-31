/**
 * Third sample: a row whose settings live in the "settings.section" left-nav
 * page (the pattern most third-party plugins use), instead of the Plugins
 * page slots. This half only declares volatile Config; the page itself is in
 * client.js and reads/writes through the shipped `ctx.remote.settings`
 * namespace, so no custom HTTP bridge is needed.
 */
import Schema from '@deepseek-ai/schemastery'

export const name = 'custom-tools-sample-section'

export const Config = Schema.object({
  label: Schema.string().default('custom section').description('显示名（这一项会同步到左侧分页标题旁边的表单）').volatile(),
  count: Schema.number().step(1).min(0).default(2).description('数量').volatile(),
  note: Schema.string().default('').description('备注').volatile(),
  apiKey: Schema.string().role('secret').description('密钥：保存后不会再回显').volatile(),
  tools: Schema.array(Schema.object({
    name: Schema.string().required().description('工具名'),
    target: Schema.string().description('目标可执行文件'),
    enabled: Schema.boolean().default(true).description('是否启用'),
  })).default([]).description('工具列表').volatile(),
})

export function apply(ctx, config) {
  ctx.effect(() => ctx.on('loader/volatile-update', () => {
    const value = config.label
    const label = value && typeof value.get === 'function' ? value.get() : value
    const list = config.tools
    const tools = list && typeof list.get === 'function' ? list.get() : list
    ctx.logger?.info?.('[custom-tools-sample] section label=%s tools=%d', label, Array.isArray(tools) ? tools.length : 0)
  }))
}
