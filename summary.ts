/**
 * Print a commit message describing how the published data changed since a
 * git revision (default HEAD): rows added / removed / changed per host.
 *
 *   node summary.ts [--base <git rev>]
 *
 * Prints nothing when the published rows did not change.
 */
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { ROOT } from './lib/paths.ts'
import { byKey, sameRow, type Row } from './lib/rows.ts'
import { gitTree, loadHostFiles, merge, workTree } from './lib/store.ts'

const { values: args } = parseArgs({ options: { base: { type: 'string', default: 'HEAD' } } })
const base = gitTree(args.base!)
const before = base ? merge(loadHostFiles(base).files).rows : new Map()
const after = merge(loadHostFiles(workTree).files).rows

type Delta = { added: number; removed: number; changed: number }
const perHost = new Map<string, Delta>()
const examples: string[] = []
for (const host of [...new Set([...before.keys(), ...after.keys()])].sort(byKey)) {
  const a: Map<string, Row> = before.get(host) ?? new Map()
  const b: Map<string, Row> = after.get(host) ?? new Map()
  const d: Delta = { added: 0, removed: 0, changed: 0 }
  for (const [id, r] of b) {
    const old = a.get(id)
    if (!old) {
      d.added++
      if (examples.length < 15) examples.push(`+ ${host} ${id} -> ${r.model}`)
    } else if (!sameRow(old, r)) {
      d.changed++
      if (examples.length < 15) examples.push(`~ ${host} ${id}: ${old.model} -> ${r.model}${old.pin !== r.pin ? ` (${r.pin})` : ''}`)
    }
  }
  for (const [id, r] of a)
    if (!b.has(id)) {
      d.removed++
      if (examples.length < 15) examples.push(`- ${host} ${id} (${r.model})`)
    }
  if (d.added || d.removed || d.changed) perHost.set(host, d)
}

// Files that changed without changing published rows (review rows, unmapped lists, lock).
const status = execFileSync('git', ['status', '--porcelain', '--', 'hosts', 'state', 'upstream.lock'], { cwd: ROOT, encoding: 'utf8' }).trim()

if (!perHost.size) {
  if (status) console.log('sync: update review rows, unmapped ids, host lists and upstream lock\n\nNo published rows changed.')
} else {
  const t = [...perHost.values()].reduce((s, d) => ({ added: s.added + d.added, removed: s.removed + d.removed, changed: s.changed + d.changed }), { added: 0, removed: 0, changed: 0 })
  const fmt = (d: Delta) => [d.added && `+${d.added}`, d.removed && `-${d.removed}`, d.changed && `~${d.changed}`].filter(Boolean).join(' ')
  const lines = [`sync: ${fmt(t)} rows across ${perHost.size} host${perHost.size === 1 ? '' : 's'}`, '']
  const sorted = [...perHost].sort(([ha, a], [hb, b]) => b.added + b.removed + b.changed - (a.added + a.removed + a.changed) || byKey(ha, hb))
  for (const [host, d] of sorted.slice(0, 40)) lines.push(`${host}: ${fmt(d)}`)
  if (sorted.length > 40) lines.push(`… and ${sorted.length - 40} more hosts`)
  lines.push('', ...examples)
  console.log(lines.join('\n'))
}
