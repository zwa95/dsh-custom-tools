import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const roots = process.argv.slice(2)
const needles = ['E_ACCESSDENIED', '系统提示']
const results = []

function scan(dir, depth) {
  if (depth > 6) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      scan(path, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    if (stat.size > 40 * 1024 * 1024) continue
    let buffer
    try {
      buffer = readFileSync(path)
    } catch {
      continue
    }
    for (const needle of needles) {
      const ascii = buffer.indexOf(needle, 0, 'latin1')
      const wide = buffer.indexOf(needle, 0, 'utf16le')
      if (ascii !== -1 || wide !== -1) {
        results.push(`${path}  [${wide !== -1 ? 'utf16' : 'ascii'}] ${needle}`)
        break
      }
    }
  }
}

for (const root of roots) scan(root, 0)
console.log(results.join('\n') || '(nothing found)')
