import { readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'

const manifest = JSON.parse(
  await readFile(new URL('../dist/.vite/manifest.json', import.meta.url), 'utf8'),
)
const entryKey = Object.keys(manifest).find((key) => manifest[key].isEntry)
if (!entryKey) throw new Error('Build the application before checking its bundle budget.')
const sizes = new Map()
for (const chunk of Object.values(manifest)) {
  if (chunk.file.endsWith('.js') && !sizes.has(chunk.file)) {
    const file = await readFile(new URL(`../dist/${chunk.file}`, import.meta.url))
    sizes.set(chunk.file, gzipSync(file).length)
  }
}

function dependencyBytes(keys) {
  const seen = new Set()
  const visiting = new Set()
  const visit = (key) => {
    if (visiting.has(key))
      throw new Error(`Circular chunk dependency at ${key}. Review the vendor split.`)
    if (seen.has(key)) return
    visiting.add(key)
    manifest[key].imports?.forEach(visit)
    visiting.delete(key)
    seen.add(key)
  }
  keys.forEach(visit)
  return [...seen].reduce((total, key) => total + (sizes.get(manifest[key].file) ?? 0), 0)
}

// Account for the simulator required at startup, even though it uses a dynamic import.
const budgets = [
  ['Application entry', sizes.get(manifest[entryKey].file), 150],
  ['Initial static JavaScript', dependencyBytes([entryKey]), 400],
  ['Startup including simulation', dependencyBytes([entryKey, 'src/mocks/browser.ts']), 550],
  [
    'All JavaScript including optional panels',
    [...sizes.values()].reduce((sum, size) => sum + size, 0),
    600,
  ],
]
for (const [label, bytes, limitKiB] of budgets) {
  console.log(`${label}: ${(bytes / 1024).toFixed(1)} KiB gzip / ${limitKiB} KiB budget`)
  if (bytes > limitKiB * 1024) process.exitCode = 1
}
