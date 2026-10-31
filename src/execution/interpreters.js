/**
 * Interpreter resolution for the two shell modes.
 *
 * On Windows `bash` on `PATH` is usually `C:\Windows\System32\bash.exe` — the
 * WSL launcher, which is not bash and cannot start inside a confined run. A
 * `mode: bash` tool that leaves `executable` unset therefore has to look for a
 * real bash the same way a person would: next to `git`, in the usual install
 * roots, or in an MSYS2 tree.
 *
 * The order is fixed and derived only from the deployment environment. A model
 * argument can never influence it, and an explicit `executable` always wins.
 */
import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** True for an existing regular file (not a directory, not a dangling link). */
export function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The `bash.exe` Windows ships in System32 is the WSL launcher; the Microsoft
 * Store alias under WindowsApps is a stub that opens the store. Neither is a
 * usable bash for an exact-argv spawn.
 */
export function isStubBash(path) {
  const lower = String(path).toLowerCase().replaceAll('/', '\\')
  if (!lower.endsWith('\\bash.exe')) return false
  return lower.includes('\\windows\\system32\\') || lower.includes('\\windowsapps\\')
}

/**
 * Candidate `bash.exe` locations derived from the deployment environment, in a
 * stable order. Only paths that actually exist are returned.
 *
 * @param {Record<string, string | undefined>} env the spawn environment
 * @param {string | undefined} gitPath resolved path of `git`, when available
 */
export function bashCandidates(env = {}, gitPath) {
  const roots = []
  if (typeof gitPath === 'string' && gitPath.length > 0) {
    // <gitRoot>\cmd\git.exe → <gitRoot>, which also holds bin\ and usr\bin\.
    roots.push(dirname(dirname(gitPath)))
  }
  for (const key of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)']) {
    if (env[key]) roots.push(join(env[key], 'Git'))
  }
  if (env.USERPROFILE) {
    roots.push(join(env.USERPROFILE, 'scoop', 'apps', 'git', 'current'))
    roots.push(join(env.USERPROFILE, 'scoop', 'apps', 'msys2', 'current'))
  }
  if (env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, 'Programs', 'Git'))
  if (env.MSYS2_ROOT) roots.push(env.MSYS2_ROOT)

  const candidates = []
  for (const root of roots) {
    candidates.push(join(root, 'bin', 'bash.exe'), join(root, 'usr', 'bin', 'bash.exe'))
  }
  candidates.push('C:\\msys64\\usr\\bin\\bash.exe')

  const seen = new Set()
  const found = []
  for (const candidate of candidates) {
    const key = candidate.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (isFile(candidate)) found.push(candidate)
  }
  return found
}

/**
 * `pwsh` (PowerShell 7) is not installed on every Windows box; Windows
 * PowerShell 5.1 ships with the OS and accepts the same `-Command` shape we
 * emit minus the `-NoProfile`/`-NonInteractive` set we already pass.
 */
export const POWERSHELL_FALLBACK = 'powershell.exe'
