/**
 * Minimal ASAR reader — read-only research helper.
 *
 * The shipped DSH runtime lives inside `app.asar`, which bash cannot traverse.
 * This script parses the ASAR header and either lists a directory or extracts a
 * single file to stdout, so exact type declarations and line numbers can be
 * checked against the runtime actually installed on this machine.
 *
 * Usage:
 *   node asar-extract.mjs <asar> ls <dir>
 *   node asar-extract.mjs <asar> cat <path>
 *   node asar-extract.mjs <asar> grep <dir> <needle>
 *
 * Paths are asar-internal, e.g. `node_modules/@deepseek-ai/dsh-tools/lib/index.js`.
 */
import { readFileSync } from 'node:fs'

const asarPath = process.argv[2]
const command = process.argv[3]
const target = process.argv[4]

const buffer = readFileSync(asarPath)
const headerSize = buffer.readUInt32LE(4)
const jsonLength = buffer.readUInt32LE(12)
const header = JSON.parse(buffer.subarray(16, 16 + jsonLength).toString('utf8'))
const dataOffset = 8 + headerSize

function lookup(path) {
  const parts = path.split('/').filter(Boolean)
  let node = header
  for (const part of parts) {
    if (!node.files || !node.files[part]) return undefined
    node = node.files[part]
  }
  return node
}

function readFileNode(node) {
  if (node.unpacked) {
    const external = `${asarPath}.unpacked/${target}`
    return readFileSync(external)
  }
  return buffer.subarray(dataOffset + Number(node.offset), dataOffset + Number(node.offset) + Number(node.size))
}

switch (command) {
  case 'ls': {
    const node = lookup(target)
    if (!node || !node.files) {
      console.error(`not a directory: ${target}`)
      process.exit(1)
    }
    for (const [name, child] of Object.entries(node.files)) {
      console.log(child.files ? `${name}/` : `${name}\t${child.size}`)
    }
    break
  }
  case 'cat': {
    const node = lookup(target)
    if (!node || !node.offset) {
      console.error(`not a file: ${target}`)
      process.exit(1)
    }
    process.stdout.write(readFileNode(node))
    break
  }
  case 'grep': {
    const needle = process.argv[5]
    const node = lookup(target)
    if (!node || !node.files) {
      console.error(`not a directory: ${target}`)
      process.exit(1)
    }
    const walk = (dir, prefix) => {
      for (const [name, child] of Object.entries(dir.files ?? {})) {
        const full = `${prefix}/${name}`
        if (child.files) {
          walk(child, full)
          continue
        }
        let text
        try {
          text = child.unpacked
            ? readFileSync(`${asarPath}.unpacked/${full}`).toString('utf8')
            : readFileNode(child).toString('utf8')
        } catch {
          continue
        }
        const lines = text.split('\n')
        lines.forEach((line, index) => {
          if (line.includes(needle)) console.log(`${full}:${index + 1}: ${line.trim().slice(0, 200)}`)
        })
      }
    }
    walk(node, target)
    break
  }
  default:
    console.error('usage: node asar-extract.mjs <asar> ls|cat|grep <path> [needle]')
    process.exit(1)
}
