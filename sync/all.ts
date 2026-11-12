/**
 * Run every sync, one after another. A failing sync keeps its last good rows
 * and makes this exit non-zero, but does not stop the others.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { ROOT } from '../lib/paths.ts'

let failed = 0
for (const s of ['openrouter', 'modelsdev', 'hosts']) {
  console.log(`\n== sync/${s}.ts`)
  const r = spawnSync(process.execPath, [path.join(ROOT, 'sync', `${s}.ts`)], { stdio: 'inherit' })
  if (r.status !== 0) failed++
}
if (failed) {
  console.error(`\n${failed} sync(s) failed; see above. Their previous rows were kept.`)
  process.exitCode = 1
}
