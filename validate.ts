/**
 * Checks the data before it is committed or merged.
 *
 *   node validate.ts [--base <git rev>]
 *
 * - every TOML file parses (duplicate keys are a parse error)
 * - hosts/ only holds hosts/<host>/{manual,sync,openrouter,modelsdev}.toml and served.txt
 * - host directory names are normalized host keys and not aliases
 * - every row is well formed: model is a model id ("vendor/slug") and pin agrees with it
 * - machine-written files are exactly what the formatter writes (sorted, stable quoting)
 * - no row disappears from a sync file unless that sync's run report says it
 *   dropped it (compared with --base, default HEAD)
 *
 * Hand-maintained content that has gone stale (a manual.toml row the host no
 * longer lists, host-config for a host that is gone, a short-name collision) is
 * reported apart from errors: the data is still fine to publish, but a person
 * must act. --strict exits non-zero for it, so the hourly job, which publishes
 * first, still ends red.
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { gzipSync } from 'node:zlib'
import { parse } from 'smol-toml'
import { build } from './build.ts'
import { Registry } from './lib/models.ts'
import { readCatalog } from './build.ts'
import hostConfig from './sync/host-config.ts'

import { isHostKey, loadAliases } from './lib/host.ts'
import { LOCK_FILE, ROOT, SYNC_SOURCES, type Source } from './lib/paths.ts'
import { formatRows, readRowsText, stableJson } from './lib/rows.ts'
import { readLists, readReports, readState } from './lib/state.ts'
import { formatServed, gitTree, loadHostFiles, readServedText, workTree } from './lib/store.ts'

const { values: args } = parseArgs({ options: { base: { type: 'string', default: 'HEAD' }, strict: { type: 'boolean', default: false } } })
const errors: string[] = []
const warnings: string[] = []
/** Hand-maintained content a person has to update; see the header. */
const stale: string[] = []

// 1. Parse and schema.
const { files, problems, strays } = loadHostFiles()
errors.push(...problems)
errors.push(...strays.map((f) => `${f}: unexpected file; hosts/<host>/ may only contain manual.toml, sync.toml, openrouter.toml, modelsdev.toml and served.txt`))
const aliases = loadAliases(errors)
Registry.load(readCatalog(), errors)
for (const f of [LOCK_FILE]) {
  try {
    if (fs.existsSync(f)) parse(fs.readFileSync(f, 'utf8'))
  } catch (e) {
    errors.push(`${path.relative(ROOT, f)}: ${(e as Error).message.split('\n')[0]}`)
  }
}

// 2. Host keys.
for (const host of files.keys()) {
  if (!isHostKey(host)) errors.push(`hosts/${host}: not a normalized host key (lowercase hostname, no scheme, port or path)`)
  if (aliases.has(host)) errors.push(`hosts/${host}: is an alias of ${aliases.get(host)}; move its rows there`)
}

// 3. Machine-written files must be byte-for-byte what the formatter produces.
const header = (text: string) => {
  const h: string[] = []
  for (const l of text.split('\n')) {
    if (!l.startsWith('#')) break
    h.push(l.replace(/^# ?/, ''))
  }
  return h
}
const machineFiles = [
  ...workTree.list('hosts').filter((f) => SYNC_SOURCES.some((s) => f.endsWith(`/${s}.toml`))),
]
for (const f of machineFiles) {
  const text = workTree.read(f)!
  try {
    if (formatRows(header(text), readRowsText(text)) !== text) errors.push(`${f}: not formatted the way the sync writes it; it is machine-written, so regenerate it with the sync instead of editing it`)
  } catch {
    // parse errors were reported above
  }
}

for (const f of workTree.list('hosts').filter((f) => f.endsWith('/served.txt'))) {
  const text = workTree.read(f)!
  if (formatServed(header(text), readServedText(text)) !== text) errors.push(`${f}: ids must be one per line, sorted, after the "#" header, no duplicates`)
}

// 4. No row disappears unless its own source dropped it.
const reportName: Record<string, string> = { sync: 'hosts', openrouter: 'openrouter', modelsdev: 'modelsdev' }
const base = gitTree(args.base!)
if (!base) warnings.push(`no git revision "${args.base}"; skipped the disappeared-rows check`)
else {
  const before = loadHostFiles(base).files
  const reports = new Map(readReports().map((r) => [r.source, r]))
  const dropped = new Set<string>()
  for (const r of reports.values()) for (const d of r.drops) dropped.add(`${r.source}\0${d.host}\0${d.id}`)
  for (const [host, bySource] of before)
    for (const [source, f] of bySource) {
      for (const id of f.rows.keys()) {
        if (files.get(host)?.get(source as Source)?.rows.has(id)) continue
        if (source === 'manual') {
          warnings.push(`hosts/${host}/${source}.toml: row ${JSON.stringify(id)} removed`)
          continue
        }
        const rep = reportName[source]!
        if (!dropped.has(`${rep}\0${host}\0${id}`))
          errors.push(`hosts/${host}/${source}.toml: row ${JSON.stringify(id)} disappeared, but the ${rep} sync did not report dropping it (sync files are machine-written; use manual.toml to override)`)
      }
    }
}

// 5. sync/host-config.ts and state/host-lists.json: normalized, non-alias hosts; https list URLs.
const checkUrl = (where: string, url: unknown) => {
  try {
    if (new URL(String(url)).protocol !== 'https:') errors.push(`${where}: list URL must be https`)
  } catch {
    errors.push(`${where}: ${JSON.stringify(url)} is not a URL`)
  }
}
for (const [what, entries] of [['sync/host-config.ts', Object.entries(hostConfig).map(([h, c]) => [h, c.models] as const)], ['state/host-lists.json', Object.entries(readLists())]] as const)
  for (const [host, url] of entries) {
    if (!isHostKey(host)) errors.push(`${what}: "${host}" is not a normalized host key`)
    if (aliases.has(host)) errors.push(`${what}: "${host}" is an alias of ${aliases.get(host)}; use that host`)
    if (url !== undefined) checkUrl(`${what} ${host}`, url)
  }

// 6. Model ids people write must exist: an OpenRouter id, one declared in model-aliases.toml,
// or one a sync already publishes (a models.dev canonical_model_id).
const usedIds = new Set<string>()
for (const bySource of files.values()) for (const [src, f] of bySource) if (src !== 'manual') for (const r of f.rows.values()) usedIds.add(r.model)
const reg = Registry.load(readCatalog(), [], usedIds)
const known = new Set(reg.ids())
for (const [host, bySource] of files)
  for (const src of ['manual'] as const)
    for (const [id, r] of bySource.get(src)?.rows ?? [])
      if (!known.has(r.model) && !reg.explicit(r.model))
        errors.push(`hosts/${host}/${src}.toml: ${JSON.stringify(id)} -> ${JSON.stringify(r.model)} is neither an OpenRouter id nor declared in model-aliases.toml`)

// 7. Two models may not share a short name: the short name is a catalog id downstream.
// Not an error: those models just publish no `short`, and blocking every hourly commit over it would be worse.
for (const s of reg.shortCollisions()) stale.push(`short name "${s}" is shared by several models, so none of them publishes it; merge them or rename one via model-aliases.toml`)

// 8. The build must succeed and stay small.
try {
  const out = build(files)
  const gz = gzipSync(stableJson(out.modelHosts), { level: 9 }).length
  if (gz > 100 * 1024) warnings.push(`model-hosts.json is ${(gz / 1024).toFixed(0)} KB gzipped (target < 100 KB)`)
} catch (e) {
  errors.push(`build failed: ${(e as Error).stack}`)
}

// 9. Hand-maintained files that went stale.
const unlisted = (readState('hosts') as { unlisted?: Record<string, string[]> }).unlisted ?? {}
for (const [host, ids] of Object.entries(unlisted))
  for (const id of ids)
    if (files.get(host)?.get('manual')?.rows.has(id)) stale.push(`hosts/${host}/manual.toml: ${JSON.stringify(id)} is no longer in the host's own list; remove the row if the host stopped serving it`)
const listsNow = readLists()
for (const host of Object.keys(hostConfig))
  if (!files.has(host) && !(host in listsNow)) stale.push(`sync/host-config.ts: "${host}" has no rows and no list any more; remove its entry`)
for (const [alias, target] of aliases) if (!files.has(target) && !(target in listsNow)) stale.push(`host-aliases.toml: "${alias}" points at "${target}", which has no rows and no list any more`)

// In GitHub Actions, as annotations on the run.
const gh = process.env.GITHUB_ACTIONS === 'true'
for (const w of warnings) console.warn(gh ? `::warning::${w}` : `warning: ${w}`)
for (const w of stale) console.warn(gh ? `::warning title=Needs a person::${w}` : `stale: ${w}`)
for (const e of errors) console.error(gh ? `::error::${e}` : `error: ${e}`)
if (args.strict && stale.length && process.env.GITHUB_STEP_SUMMARY)
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Needs a person\n\nThe data was published; these hand-maintained files are out of date:\n\n${stale.map((w) => `- ${w}`).join('\n')}\n`)
if (errors.length) {
  console.error(`validate: ${errors.length} error(s)`)
  process.exit(1)
}
if (args.strict && stale.length) {
  console.error(`validate: ${stale.length} stale item(s) need a person`)
  process.exit(1)
}
console.log(`validate: ok (${files.size} hosts, ${warnings.length} warning(s), ${stale.length} stale)`)
