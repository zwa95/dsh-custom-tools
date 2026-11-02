import { bashCandidates, isStubBash } from '../../src/execution/interpreters.js'

for (const path of [
  'C:\\Windows\\System32\\bash.exe',
  'C:\\Users\\<user>\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe',
  'C:\\Software\\Git\\bin\\bash.exe',
]) {
  console.log('stub?', JSON.stringify(path), isStubBash(path))
}

const git = 'C:\\Software\\Git\\cmd\\git.exe'
console.log('candidates:', bashCandidates(process.env, git))
