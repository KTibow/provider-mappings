/**
 * Merge every hosts/<host>/<source>.toml into dist/:
 *   model-hosts.json  { "<host>": { "<native id>": { model, pin, current?, quant? } } }
 *   unmapped.json     { "<host>": { "<native id>": ["<source>", ...] } }
 *   conflicts.json    [{ host, id, chosen: { source, model }, others: [...] }]
 *   needs-review.json [{ host, id, model, reason, source }]
 *   models.json       { "<model id>": { short?, name?, permaslug?, floating?, source, aliases?, surplus_legacy?, hosts } }
 *   hosts.json        { "<host>": { rows, models, sources, list?, mirrors? } }
 *   surplus-legacy-ids.json  { "<legacy Surplus id>": "<model id>" }   (from model-aliases.toml; backcompat)
 * A model id is an OpenRouter model id (see lib/models.ts).
 * Precedence per (host, native id): manual > sync > openrouter > modelsdev.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { Registry, readCatalogFile, splitVariant, variantRoot, type Catalog } from './lib/models.ts'
import { loadAliases, resolveHost } from './lib/host.ts'
import { DIST_DIR, ROOT, SOURCES, STATE_DIR, isMain } from './lib/paths.ts'
import { byKey, readRowsFile, stableJson } from './lib/rows.ts'
import { readLists, readReports, readState, type Conflict } from './lib/state.ts'
import hostConfig from './sync/host-config.ts'
import { loadHostFiles, merge, type HostFiles } from './lib/store.ts'

export interface BuildOutput {
  modelHosts: Record<string, Record<string, { model: string; pin: string; current?: string; quant?: string }>>
  unmapped: Record<string, Record<string, string[]>>
  conflicts: Conflict[]
  needsReview: { host: string; id: string; model: string; reason: string; source: string }[]
  models: Record<string, ModelEntry>
  surplusLegacy: Record<string, string>
  /** Short names more than one model has (those models get no `short`). */
  shortCollisions: string[]
  hosts: Record<string, HostEntry>
}

export interface HostEntry {
  rows: number
  models: number
  /** Where the rows come from ("sync", "openrouter", ...), most rows first. */
  sources: string[]
  /** The keyless list the host sync reads, when there is one. */
  list?: string
  /**
   * The host resells another host: most of its ids are that host's ids, mapped
   * the same way, and it serves a large part of that host's models.
   * `coverage` is the share of the upstream's models it serves; for a mirror
   * without a list of its own, `not_upstream` lists ids it routes that the
   * upstream's list doesn't have (often dead routes).
   * Also regional endpoints of one API ("api.eu.mistral.ai").
   */
  mirrors?: { of: string; coverage: number; not_upstream?: string[] }
  /** Ids any source maps here (by hand, served.txt, OpenRouter, models.dev) that the host's own list doesn't have: likely dead routes. */
  not_listed?: string[]
}

/** A mirror: this share of its rows match the upstream's exactly... */
const MIRROR_SHARE = 0.75
/** ...and it serves this share of the upstream's models. */
const MIRROR_COVERAGE = 0.5

export interface ModelEntry {
  /** The id without its vendor ("kimi-k3"): what a catalog that drops the vendor lists it as. Absent if two models share it. */
  short?: string
  name?: string
  /** For a variant id ("z-ai/glm-5.1:web": the model with the host's web search), the model it is a variant of. */
  variant_of?: string
  /** OpenRouter's permaslug: the checkpoint currently behind this id. */
  permaslug?: string
  /** Date OpenRouter stopped listing it; the model is still served elsewhere. */
  delisted?: string
  /** A moving alias (OpenRouter "~…-latest"). */
  floating?: true
  /** Where the id comes from: "openrouter", "model-aliases.toml", or the row sources that use it. */
  source: string
  /** Other names that resolve to this id: renamed ids and model-aliases.toml aliases (not `short`). */
  aliases?: string[]
  /** Legacy Surplus Intelligence ids (backcompat), from model-aliases.toml. */
  surplus_legacy?: string[]
  /** Input and output modalities, as OpenRouter lists them (e.g. ["text","image"] -> ["text"]). */
  input?: string[]
  output?: string[]
  /** Hosts with at least one row for it. */
  hosts: number
}

export const readCatalog = readCatalogFile

export const SCHEMA_VERSION = 1

export function build(files: HostFiles): BuildOutput {
  const aliases = loadAliases()
  const { rows, conflicts } = merge(files)
  // Rows written before OpenRouter renamed a model (or before model-aliases.toml
  // merged two ids) are published under the current id.
  const current = Registry.load(readCatalog())
  for (const m of rows.values())
    for (const r of m.values()) {
      r.model = current.explicit(r.model) ?? r.model
      if (r.current) r.current = current.explicit(r.current) ?? r.current
    }

  const modelHosts: BuildOutput['modelHosts'] = {}
  for (const [host, m] of rows) {
    const out: BuildOutput['modelHosts'][string] = {}
    for (const [id, r] of m) out[id] = { model: r.model, pin: r.pin, ...(r.current ? { current: r.current } : {}), ...(r.quant ? { quant: r.quant } : {}) }
    modelHosts[host] = out
  }

  const unmapped: BuildOutput['unmapped'] = {}
  for (const source of ['hosts', 'modelsdev'])
    for (const [h, ids] of Object.entries(readState(source).unmapped)) {
      const host = resolveHost(aliases, h)
      for (const id of ids) {
        if (modelHosts[host]?.[id]) continue // someone mapped it (e.g. manual.toml)
        ;((unmapped[host] ??= {})[id] ??= []).push(source)
      }
    }

  for (const source of ['openrouter', 'modelsdev']) conflicts.push(...readState(source).conflicts)
  conflicts.sort((a, b) => byKey(a.host, b.host) || byKey(a.id, b.id))

  const needsReview: BuildOutput['needsReview'] = []
  for (const [host, bySource] of files)
    for (const s of SOURCES)
      for (const [id, r] of bySource.get(s)?.review ?? [])
        if (!modelHosts[host]?.[id]) needsReview.push({ host, id, model: r.model, reason: r.reason, source: s })

  // models.json: every model id we know, with every other name for it.
  const used = new Map<string, Set<string>>() // model id -> hosts
  const usedBy = new Map<string, Set<string>>() // model id -> sources
  for (const [host, m] of rows)
    for (const r of m.values()) {
      if (!used.has(r.model)) used.set(r.model, new Set())
      used.get(r.model)!.add(host)
      if (!usedBy.has(r.model)) usedBy.set(r.model, new Set())
      usedBy.get(r.model)!.add(r.source)
    }
  const reg = Registry.load(readCatalog(), undefined, used.keys())
  const aliasMap = reg.aliasesOf()
  const models: Record<string, ModelEntry> = {}
  const surplusLegacy: Record<string, string> = {}
  // "GLM 5.1 (non-thinking) (web)": a variant is named after its model.
  const nameOf = (id: string): string | undefined => {
    const v = splitVariant(id)
    const own = reg.declared.get(id)?.name ?? (v ? undefined : reg.catalog[id]?.name)
    if (own || !v) return own
    const base = nameOf(v[0])
    return base && `${base} (${v[1]})`
  }
  for (const id of reg.ids()) {
    const variant = splitVariant(id)
    // A variant ("z-ai/glm-5.1:web") is described by its model; its names are its own.
    const c = reg.catalog[id] ?? (variant ? reg.catalog[variantRoot(id)] : undefined)
    const d = reg.declared.get(id)
    const baseD = variant ? reg.declared.get(variant[0]) : undefined
    const e: ModelEntry = { source: reg.catalog[id] ? 'openrouter' : reg.declared.has(id) ? 'model-aliases.toml' : [...(usedBy.get(id) ?? [])].sort().join(','), hosts: used.get(id)?.size ?? 0 }
    if (variant) e.variant_of = variant[0]
    const short = reg.shortOf(id)
    if (short) e.short = short
    const name = nameOf(id)
    if (name) e.name = name
    if (c?.permaslug && !variant) e.permaslug = c.permaslug
    if (c?.delisted) e.delisted = c.delisted
    if (c?.floating || id.startsWith('~')) e.floating = true
    if (c?.input) e.input = c.input
    if (c?.output) e.output = c.output
    // Every catalog id that is this model; a ":web" or ":free" variant's also its model's plus the variant.
    const legacy = new Set([...(d?.surplusLegacy ?? []), ...(variant && (variant[1] === 'web' || variant[1] === 'free') ? (baseD?.surplusLegacy ?? []).map((l) => `${l}:${variant[1]}`) : [])])
    const other = (aliasMap.get(id) ?? []).filter((a) => a !== short && !legacy.has(a))
    if (other.length) e.aliases = other
    if (legacy.size) {
      e.surplus_legacy = [...legacy].sort(byKey)
      for (const l of legacy) surplusLegacy[l] = id
    }
    models[id] = e
  }

  // hosts.json: per-host facts, and which hosts just resell another host.
  const lists = readLists()
  const hostState = readState('hosts')
  const hosts: Record<string, HostEntry> = {}
  for (const [host, m] of [...rows].sort(([a], [b]) => byKey(a, b))) {
    const bySource = new Map<string, number>()
    for (const r of m.values()) bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1)
    const e: HostEntry = { rows: m.size, models: new Set([...m.values()].map((r) => r.model)).size, sources: [...bySource].sort((a, b) => b[1] - a[1] || byKey(a[0], b[0])).map(([s]) => s) }
    if (lists[host]) e.list = lists[host]
    const gone = hostState.unlisted?.[host]
    if (gone?.length) e.not_listed = gone
    hosts[host] = e
  }
  // Largest hosts first: a host can only mirror a larger host that is not itself a mirror.
  const bySize = [...rows.keys()].filter((h) => !h.includes('{')).sort((a, b) => rows.get(b)!.size - rows.get(a)!.size || byKey(a, b))
  const upstreams: string[] = []
  for (const host of bySize) {
    const m = rows.get(host)!
    let best: { of: string; shared: number } | undefined
    const declared = hostConfig[host]?.mirrors
    if (declared && rows.has(declared)) best = { of: declared, shared: [...m].filter(([id, r]) => rows.get(declared)!.get(id)?.model === r.model).length }
    else if (m.size >= 20)
      for (const up of upstreams) {
        const u = rows.get(up)!
        let shared = 0
        for (const [id, r] of m) if (u.get(id)?.model === r.model) shared++
        if (shared >= m.size * MIRROR_SHARE && shared >= u.size * MIRROR_COVERAGE && (!best || shared > best.shared)) best = { of: up, shared }
      }
    if (!best) {
      upstreams.push(host)
      continue
    }
    const u = rows.get(best.of)!
    const upstreamUnmapped = unmapped[best.of] ?? {}
    const upstreamGone = new Set(hostState.unlisted?.[best.of] ?? [])
    const gone = [...m.keys()].filter((id) => (!u.has(id) && !(id in upstreamUnmapped)) || upstreamGone.has(id))
    // A mirror with its own list says itself which ids are live (not_listed).
    const report = gone.length && hosts[best.of]!.list && !hosts[host]!.list
    hosts[host]!.mirrors = { of: best.of, coverage: Math.round((best.shared / u.size) * 100) / 100, ...(report ? { not_upstream: gone.sort(byKey) } : {}) }
  }

  return { modelHosts, unmapped, conflicts, needsReview, models, surplusLegacy, shortCollisions: reg.shortCollisions(), hosts }
}

function main() {
  const { files, problems } = loadHostFiles()
  if (problems.length) {
    console.error(problems.join('\n'))
    console.error(`build: ${problems.length} problem(s); run validate.ts for details`)
    process.exit(1)
  }
  const out = build(files)
  fs.rmSync(DIST_DIR, { recursive: true, force: true })
  fs.mkdirSync(DIST_DIR, { recursive: true })
  const modelHosts = stableJson(out.modelHosts)
  fs.writeFileSync(path.join(DIST_DIR, 'model-hosts.json'), modelHosts)
  fs.writeFileSync(path.join(DIST_DIR, 'unmapped.json'), stableJson(out.unmapped, 1))
  fs.writeFileSync(path.join(DIST_DIR, 'conflicts.json'), stableJson(out.conflicts, 1))
  fs.writeFileSync(path.join(DIST_DIR, 'needs-review.json'), stableJson(out.needsReview, 1))
  fs.writeFileSync(path.join(DIST_DIR, 'surplus-legacy-ids.json'), stableJson(out.surplusLegacy, 1))
  fs.writeFileSync(path.join(DIST_DIR, 'hosts.json'), stableJson(out.hosts, 1))
  const modelsJson = stableJson(out.models)
  fs.writeFileSync(path.join(DIST_DIR, 'models.json'), modelsJson)
  fs.copyFileSync(path.join(ROOT, 'host-aliases.toml'), path.join(DIST_DIR, 'host-aliases.toml'))
  // When and from what commit this was built (the workflow builds again after
  // committing), and how each source did, when this build follows a sync run.
  let commit = ''
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {}
  const reports = readReports()
  const sources = Object.fromEntries(reports.map((r) => [r.source, { ok: r.ok, finished_at: r.finishedAt, failures: r.failures.length }]))
  fs.writeFileSync(path.join(DIST_DIR, 'meta.json'), stableJson({ schema_version: SCHEMA_VERSION, generated_at: new Date().toISOString(), commit, ...(reports.length ? { sources } : {}) }, 1))

  // Per-source counts (rows in each source's files, before precedence).
  const perSource: Record<string, { hosts: number; rows: number; review: number }> = {}
  for (const s of SOURCES) perSource[s] = { hosts: 0, rows: 0, review: 0 }
  for (const bySource of files.values())
    for (const [s, f] of bySource) {
      if (f.rows.size) perSource[s]!.hosts++
      perSource[s]!.rows += f.rows.size
      perSource[s]!.review += [...f.review.keys()].filter((k) => !f.rows.has(k)).length
    }
  const hosts = Object.keys(out.modelHosts).length
  const rows = Object.values(out.modelHosts).reduce((n, m) => n + Object.keys(m).length, 0)
  const unmappedCount = Object.values(out.unmapped).reduce((n, m) => n + Object.keys(m).length, 0)
  const gz = gzipSync(modelHosts, { level: 9 }).length
  const modelIds = Object.keys(out.models).length
  const stats = { hosts, rows, modelIds, modelsGzipBytes: gzipSync(modelsJson, { level: 9 }).length, surplusLegacyIds: Object.keys(out.surplusLegacy).length, shortCollisions: out.shortCollisions.length, conflicts: out.conflicts.length, needsReview: out.needsReview.length, unmapped: unmappedCount, bytes: modelHosts.length, gzipBytes: gz }

  fs.writeFileSync(path.join(DIST_DIR, 'stats.json'), stableJson({ ...stats, perSource }, 1))
  // The browsable site: one static page that reads the JSON above.
  fs.copyFileSync(path.join(ROOT, 'site', 'index.html'), path.join(DIST_DIR, 'index.html'))
  console.log('build:', JSON.stringify(stats))
  if (out.shortCollisions.length) console.warn(`  short names shared by several models (no "short" published): ${out.shortCollisions.join(', ')}`)
  for (const [s, c] of Object.entries(perSource)) console.log(`  ${s.padEnd(10)} ${String(c.hosts).padStart(4)} hosts ${String(c.rows).padStart(6)} rows ${String(c.review).padStart(5)} needs review`)
}

if (isMain(import.meta.url)) main()
