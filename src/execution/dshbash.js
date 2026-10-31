/**
 * Windows has no bash that can start inside DSH's restricted token: every
 * MSYS2/Cygwin runtime dies in its own startup (signal pipe / BaseNamedObjects)
 * before argv is parsed. `dsh-ops` works around that by shipping a pinned MSYS
 * payload plus two IPC compatibility proxies and staging a patched copy under
 * `$DSH_HOME/dsh-ops/bash-ipc/<identity>`.
 *
 * This module locates that staged copy. It deliberately does NOT import
 * `dsh-ops`: the plugin is installed in the profile, not beside us, and its
 * module layout is not a public API. We only read the content-addressed cache
 * directory it publishes, and verify the three files that make the runtime
 * work before trusting it.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** The DLLs `dsh-ops` stages beside `bash.exe` once the runtime is patched. */
const REQUIRED = ['bash.exe', 'msys-2.0.dll', 'opsipc.dll']
const SUBDIRS = ['usr/bin', 'ucrt64/bin', 'cmd']

function dshHome(env) {
  if (env.DSH_HOME) return env.DSH_HOME
  const profileHome = env.USERPROFILE ?? env.HOME
  return join(profileHome ?? homedir(), '.dsh')
}

function looksStaged(directory) {
  try {
    return REQUIRED.every((name) => statSync(join(directory, name)).isFile())
  } catch {
    return false
  }
}

/**
 * Find the newest staged, proxy-patched bash.
 *
 * @returns {{ file: string, directories: string[], root: string } | undefined}
 */
export function resolveStagedBash(env = process.env) {
  const base = join(dshHome(env), 'dsh-ops', 'bash-ipc')
  let identities
  try {
    identities = readdirSync(base)
  } catch {
    return undefined
  }

  let best
  for (const identity of identities) {
    const root = join(base, identity)
    const bin = join(root, 'usr', 'bin')
    if (!looksStaged(bin)) continue
    let mtime = 0
    try {
      mtime = statSync(join(bin, 'bash.exe')).mtimeMs
    } catch {
      continue
    }
    if (best === undefined || mtime > best.mtime) best = { root, mtime }
  }
  if (best === undefined) return undefined

  const directories = SUBDIRS
    .map((sub) => join(best.root, ...sub.split('/')))
    .filter((directory) => existsSync(directory))
  return { file: join(best.root, 'usr', 'bin', 'bash.exe'), directories, root: best.root }
}

/**
 * The staged runtime resolves `cat`, `ls`, … through its own tree. Inheriting the
 * ambient PATH (which starts with an unpinned MSYS install) gives a bash whose
 * every external command dies with the signal-pipe error, so the staged
 * directories must lead, exactly as `dsh-ops` does it.
 */
export function pathWithStaged(directories, ambient = process.env.PATH ?? '') {
  return [...directories, ambient].filter((part) => part !== '').join(delimiter)
}
