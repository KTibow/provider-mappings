/**
 * Per-host syncs -> hosts/<host>/sync.toml.
 *
 * Every hour, for every base URL models.dev and OpenRouter report (and every
 * host that already has rows), GET <base>/models without credentials. A host
 * that answers with `{ data: [{ id }] }` is synced; the URL is recorded in
 * state/host-lists.json, so a new host shows up in the commit. sync/host-config.ts
 * holds list URLs discovery can't guess and hosts' quirks. A hosts/<host>/served.txt
 * adds native ids the host is known to serve (e.g. from a marketplace's traffic),
 * for hosts whose list needs a key or leaves ids out; they are mapped exactly
 * like listed ids.
 *
 * Ids that manual.toml or openrouter.toml already map on this host are left to
 * them (sync.toml would outrank OpenRouter and make a copy sticky). Every other
 * native id is mapped to a model id (an OpenRouter id), using the first of:
 *   1. an exact registry name for the id or one of its hints (model id,
 *      permaslug, former id, model-aliases.toml name),
 *   2. an exact match (OpenRouter id / slug / Hugging Face id, or the same
 *      native id mapped by OpenRouter or a person on another host),
 *   3. a normalized match (case, punctuation, vendor prefix, quant suffix).
 * Tiers ("-fast", "e2ee-") and moving aliases without a "~" model id are never
 * mapped by a heuristic. Anything else goes to state/hosts.json and then
 * dist/unmapped.json.
 *
 * A host whose list stops answering keeps its rows and is recorded in
 * state/health.json. After DEAD_AFTER_DAYS of failing, its rows are dropped. The
 * run only exits non-zero when a large share of hosts fails at once.
 *
 * Usage: node sync/hosts.ts [host ...]
 */
import dns from 'node:dns/promises'
import fs from 'node:fs'
import path from 'node:path'
import { candidates, listIds } from '../lib/discover.ts'
import { loadAliases, resolveHost } from '../lib/host.ts'
import { BIG_LIST, defaults, type HostDef, type Listed } from '../lib/hostsync.ts'
import { getJson } from '../lib/http.ts'
import { loadRegistry, registryMatcher, operationOf, settlePin, splitVariant, tierMismatch, withOperation, type MatchVia, type Matcher, type Registry } from '../lib/models.ts'
import { HOSTS_DIR, STATE_DIR, hostFile, isMain, servedFile, type Source } from '../lib/paths.ts'
import { byKey, formatRows, readRowsFile, stableJson, writeIfChanged, type Row, type RowsFile } from '../lib/rows.ts'
import { LISTS_FILE, readLists, readState, writeReport, writeState, type Drop } from '../lib/state.ts'
import { addRowEvidence, formatServed, loadHostFiles } from '../lib/store.ts'
import config from './host-config.ts'

const HEALTH_FILE = path.join(STATE_DIR, 'health.json')
const DEAD_AFTER_DAYS = 14
const FAIL_RUN_SHARE = 0.25
const CONCURRENCY = 16

/** host -> since when it has been failing, and the last error. Only failing hosts are listed, so it changes only when health does. */
type Health = Record<string, { failing_since: string; error: string }>
const readHealth = (): Health => (fs.existsSync(HEALTH_FILE) ? (JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')) as Health) : {})

/** Rewrite hosts/<host>/served.txt with only `ids`, keeping its header; delete it when none are left. */
function rewriteServed(host: string, ids: string[]) {
  const f = servedFile(host)
  const header = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith('#')).map((l) => l.replace(/^# ?/, ''))
  writeIfChanged(f, ids.length ? formatServed(header, ids) : null)
}


/** The full definition for a host: its list URL plus any quirks from sync/host-config.ts. */
export const hostDef = (host: string, url: string): HostDef => ({ host, ...config[host], models: config[host]?.models ?? url })

/** Entries the host sync maps (after `include`); `ids` is every id the list has, filtered or not. */
export async function fetchList(def: HostDef, opts: { attempts?: number; timeoutMs?: number } = {}): Promise<Listed[] & { ids?: Set<string> }> {
  const res = await getJson(def.models, { cacheTtlMs: 30 * 60_000, attempts: opts.attempts ?? 2, timeoutMs: opts.timeoutMs ?? 20_000 })
  const all = (def.list ?? defaults.list)(res).filter((m) => typeof m?.id === 'string' && m.id.trim())
  return Object.assign(all.filter((m) => (def.include ?? (() => true))(m)), { ids: new Set(all.map((m) => String(m.id).trim())) })
}

/**
 * A host's list: its configured or recorded URL when that answers (retried, so
 * one blip isn't an outage); otherwise every guessed URL at once, longest list
 * winning. An Error if none answers.
 */
async function probe(host: string, known: string | undefined, guesses: string[]): Promise<{ url: string; listed: Listed[] & { ids?: Set<string> } } | Error> {
  let err: unknown
  if (known) {
    try {
      const listed = await fetchList(hostDef(host, known))
      if (listed.length) return { url: known, listed }
    } catch (e) {
      err = e
    }
  }
  const tries = await Promise.all(guesses.filter((u) => u !== known).map(async (url) => {
    try {
      return { url, listed: await fetchList(hostDef(host, url), { attempts: 1, timeoutMs: 10_000 }) }
    } catch (e) {
      err ??= e
      return undefined
    }
  }))
  const best = tries.filter((t) => t && t.listed.length).sort((x, y) => y!.listed.length - x!.listed.length || byKey(x!.url, y!.url))[0]
  return best ?? (err instanceof Error ? err : new Error(`no list at ${[known, ...guesses].filter(Boolean).join(', ')}`))
}

/** What a host sync needs to map ids: the registry, and a matcher with row evidence. */
export interface MapContext {
  reg: Registry
  matcher: Matcher
}

export interface Mapped {
  rows: Map<string, Row>
  unmapped: string[]
  via: Record<MatchVia | 'mirror', number>
}

/**
 * Map one host's listed entries (from /models, served.txt, or both) to rows.
 * `prev` is this sync's previous sync.toml rows; `others` the host's other
 * source files; `upstream` the rows of the host this one is a declared mirror
 * of (see upstreamRows). The importer calls this too, so it can tell which
 * of a marketplace's pairs the sync derives by itself.
 */
export function mapEntries(ctx: MapContext, def: Pick<HostDef, 'hints' | 'name' | 'operation' | 'pin' | 'quant'> | undefined, entries: Listed[], prev: Map<string, Row> = new Map(), others?: Map<Source, RowsFile>, upstream?: Map<string, Row>): Mapped {
  const { reg, matcher } = ctx
  const rows = new Map<string, Row>()
  const unmapped: string[] = []
  const via: Mapped['via'] = { explicit: 0, exact: 0, normalized: 0, mirror: 0 }
  for (const m of entries) {
    const id = (m.id as string).trim()
    // Already mapped by a person or by OpenRouter on this host: theirs to publish.
    if (others?.get('manual')?.rows.has(id) || others?.get('openrouter')?.rows.has(id)) continue
    // "x:web": the model x maps to, as that variant ("z-ai/glm-5.1:web").
    // (Not when the id itself names a model: a model OpenRouter lists only as ":free" is that model.)
    const variant = reg.explicit(id) ? undefined : splitVariant(id)
    if (variant) {
      const [baseId, v] = variant
      const base = others?.get('manual')?.rows.get(baseId) ?? others?.get('openrouter')?.rows.get(baseId) ?? mapEntries(ctx, def, [{ ...m, id: baseId }], prev, undefined, upstream).rows.get(baseId)
      if (base && !base.model.startsWith('~')) {
        via.exact++
        const quant = (def?.quant ?? defaults.quant)(m)
        rows.set(id, { model: `${base.model}:${v}`, pin: base.pin, ...(quant ? { quant } : {}) })
      } else unmapped.push(id)
      continue
    }
    // A declared mirror serves the upstream's id as the upstream does.
    const up = upstream?.get(id)
    if (up) {
      via.mirror++
      const quant = (def?.quant ?? defaults.quant)(m)
      rows.set(id, { model: up.model, pin: up.pin, ...(quant ? { quant } : {}) })
      continue
    }
    const hints = [id, ...(def?.hints?.(m) ?? []).filter((h): h is string => typeof h === 'string' && h.length > 0)]
    // Matched fresh every run, never from our own earlier row: a row matched
    // under worse knowledge must not outlive the fix.
    let model: string | undefined
    let how: MatchVia | undefined
    const explicit = hints.map((h) => reg.explicit(h)).find(Boolean)
    // A router's prefix in front of a model id ("vercel-ai-gateway/sakana/fugu-max"):
    // the last two segments, but only as an exact model name, never a loose match.
    const routed = !explicit && id.split('/').length > 2 ? reg.resolve(id.split('/').slice(-2).join('/')) : undefined
    if (explicit) [model, how] = [explicit, 'explicit']
    else if (routed) [model, how] = [routed, 'exact']
    else {
      const hit = matcher.match(hints)
      if (hit) [model, how] = [hit.model, hit.via]
      // The matcher leaves out floating ids; "jev-latest" is OpenRouter's "~typesafe/jev-latest" by name.
      else {
        const f = reg.floatingNamed(id)
        if (f) [model, how] = [f, 'exact']
      }
    }
    // Never let a heuristic fold a tier ("-fast", "e2ee-") into its base model.
    const name = def?.name?.(m)
    if (model && !(how === 'explicit' && reg.explicit(id)) && (tierMismatch(id, model) || (name && tierMismatch(name.replace(/\s+/g, '-'), model)))) model = undefined
    // A moving native id only goes live under a "~" model id.
    const settled = model ? settlePin(reg, id, model, (def?.pin ?? defaults.pin)(m)) : undefined
    if (!settled || !how) {
      unmapped.push(id)
      continue
    }
    via[how]++
    if (process.env.VERBOSE && how !== 'exact') console.log(`    ${how}: ${id} -> ${settled.model}`)
    const quant = (def?.quant ?? defaults.quant)(m)
    // "seedance-2-0-image-to-video": that operation of the model it matched. An
    // operation only the list states ("seedance-2.0" is "Seedance 2.0 I2V") counts
    // unless model-aliases.toml names the id ("runway-gen4-turbo": its model only
    // does image-to-video).
    const op = operationOf(id) ?? (how === 'explicit' ? undefined : def?.operation?.(m))
    rows.set(id, { ...settled, model: withOperation(id, settled.model, op), ...(quant ? { quant } : {}) })
  }
  return { rows, unmapped, via }
}

async function main() {
  const only = process.argv.slice(2)
  const { reg } = await loadRegistry()
  const matcher = registryMatcher(reg)
  const { files: allFiles, served } = loadHostFiles()
  addRowEvidence(matcher, allFiles)
  const aliases = loadAliases()
  const lists = readLists()
  const health = readHealth()
  const state = readState('hosts')

  // Where each host's list is: its configured URL, else the URL it answered at
  // last time; failing that, <base>/models for every base URL upstream data reports.
  const known = fs.existsSync(HOSTS_DIR) ? fs.readdirSync(HOSTS_DIR) : []
  const knownUrl = new Map<string, string>()
  // A hostname that became an alias is synced as its canonical host.
  for (const h of Object.keys(lists)) if (resolveHost(aliases, h) !== h) delete lists[h]
  for (const [h, url] of Object.entries(lists)) knownUrl.set(h, url)
  for (const [h, c] of Object.entries(config)) if (c.models) knownUrl.set(h, c.models)
  const guesses = new Map<string, string[]>()
  for (const [h, bases] of await candidates([...known, ...Object.keys(config)])) {
    const host = resolveHost(aliases, h)
    if (config[host]?.models) continue
    guesses.set(host, [...new Set([...(guesses.get(host) ?? []), ...[...bases].map((b) => `${b}/models`)])].sort(byKey))
  }
  const urlsOf = new Set([...knownUrl.keys(), ...guesses.keys()])

  const pick = (hs: Iterable<string>) => [...hs].filter((h) => !only.length || only.includes(h))
  const probing = pick(urlsOf).sort(byKey)
  const failures: string[] = []
  const drops: Drop[] = []
  const stats = { hosts: 0, rows: 0, unmapped: 0, found: 0, failing: 0, dead: 0, drops: 0, probed: probing.length, servedPruned: 0, dnsFailing: 0 }
  const now = new Date()

  // Probe in parallel (each host is its own origin), then map in a fixed order.
  const results = new Map<string, { url: string; listed: Listed[] & { ids?: Set<string> } } | Error>()
  let next = 0
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < probing.length) {
        const h = probing[next++]!
        results.set(h, await probe(h, knownUrl.get(h), guesses.get(h) ?? []))
      }
    }),
  )

  // A host with only a served.txt has no list to fail; it dies when its name stops
  // resolving ("api.kairence.ai"). Only a nonexistent name counts, never a timeout.
  const answered = (h: string) => { const r = results.get(h); return !!r && !(r instanceof Error) }
  const servedOnly = pick(served.keys()).filter((h) => !(h in lists) && !answered(h) && !h.includes('{'))
  await Promise.all(servedOnly.map(async (h) => {
    try {
      await dns.lookup(h)
      if (health[h]?.error.startsWith('DNS:')) delete health[h]
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOTFOUND' && code !== 'ENODATA') return
      const rec = (health[h] ??= { failing_since: now.toISOString().slice(0, 10), error: '' })
      rec.error = `DNS: ${code}`
      if ((now.getTime() - Date.parse(rec.failing_since)) / 86_400_000 < DEAD_AFTER_DAYS) return void stats.dnsFailing++
      for (const id of readRowsFile(hostFile(h, 'sync')).rows.keys()) drops.push({ host: h, id, reason: `no DNS record since ${rec.failing_since}` })
      writeIfChanged(hostFile(h, 'sync'), null)
      rewriteServed(h, [])
      served.delete(h)
      delete health[h]
      stats.dead++
      console.error(`  ! ${h}: name has not resolved for ${DEAD_AFTER_DAYS}+ days; dropped it`)
    }
  }))

  // Synced hosts: those answering now, those that answered before, and those with a served.txt.
  // Hosts that others are declared mirrors of go first, so mirrors see this run's rows.
  const upstreams = new Set(Object.values(config).map((c) => c.mirrors).filter((h): h is string => !!h))
  const targets = pick(new Set([...[...results].filter(([, r]) => !(r instanceof Error)).map(([h]) => h), ...Object.keys(lists), ...served.keys()]))
    .sort((a, b) => Number(upstreams.has(b)) - Number(upstreams.has(a)) || byKey(a, b))
  const syncedRows = new Map<string, Map<string, Row>>()
  /** What a declared mirror inherits: the upstream's rows, by precedence. */
  const upstreamRows = (h: string): Map<string, Row> => {
    const files = allFiles.get(h)
    return new Map([
      ...(files?.get('modelsdev')?.rows ?? []),
      ...(syncedRows.get(h) ?? readRowsFile(hostFile(h, 'sync')).rows),
      ...(files?.get('openrouter')?.rows ?? []),
      ...(files?.get('manual')?.rows ?? []),
    ])
  }
  for (const host of targets) {
    const file = hostFile(host, 'sync')
    const prev = readRowsFile(file)
    const servedIds = served.get(host) ?? []
    let result: { url: string; listed: Listed[] & { ids?: Set<string> } } | Error | undefined = results.get(host)
    const wasListed = host in lists
    if (result instanceof Error && !wasListed) result = undefined // never answered: not a list host
    if (result && !(result instanceof Error)) {
      // An empty or collapsed list is more likely an outage than real removals.
      const fromList = [...prev.rows.keys()].filter((id) => !servedIds.includes(id)).length
      if (fromList >= 10 && result.listed.length < fromList * 0.5) result = new Error(`list shrank to ${result.listed.length} entries (had ${fromList} mapped rows)`)
    }

    if (result instanceof Error) {
      const h = (health[host] ??= { failing_since: now.toISOString().slice(0, 10), error: '' })
      h.error = result.message.slice(0, 200)
      const days = (now.getTime() - Date.parse(h.failing_since)) / 86_400_000
      if (days >= DEAD_AFTER_DAYS) {
        // Its list is gone for good, and its served.txt (only ids the list had) with it.
        for (const id of prev.rows.keys()) drops.push({ host, id, reason: `list failing since ${h.failing_since}: ${h.error}` })
        writeIfChanged(file, null)
        if (servedIds.length) rewriteServed(host, [])
        delete lists[host]
        delete health[host]
        delete state.unmapped[host]
        stats.dead++
        console.error(`  ! ${host}: list failing for ${Math.floor(days)} days; dropped its ${prev.rows.size} rows`)
      } else {
        stats.failing++
        console.warn(`  ~ ${host}: ${result.message} (failing since ${h.failing_since}; rows kept)`)
      }
      failures.push(`${host}: ${result.message}`)
      continue
    }
    if (result) delete health[host] // a served-only host's health is its DNS (above)
    if (result) {
      if (!wasListed) stats.found++
      lists[host] = result.url
    }

    // Hosts without a list (served.txt only) still get their host-config quirks.
    const def = result ? hostDef(host, result.url) : config[host] ? ({ host, models: '', ...config[host] } as HostDef) : undefined
    const listed = result?.listed ?? []
    // Every id the host's own list has, before host-config's `include` filter.
    const have = result ? (result.listed.ids ?? new Set(listed.map((m) => String(m.id).trim()))) : undefined
    // Ids any source says this host serves that its own list doesn't have: dead
    // routes, or ids only one customer (OpenRouter) can call. Published as
    // hosts.json `not_listed`; validate flags the manual.toml ones.
    if (have) {
      const files = allFiles.get(host)
      const claimed = new Set([...servedIds, ...(['manual', 'openrouter', 'modelsdev'] as const).flatMap((s) => [...(files?.get(s)?.rows.keys() ?? [])])])
      ;(state.unlisted ??= {})[host] = [...claimed].filter((id) => !have.has(id))
    } else if (state.unlisted) delete state.unlisted[host]
    const from = [def?.models, servedIds.length ? `hosts/${host}/served.txt` : undefined].filter(Boolean).join(' and ')
    // served.txt adds ids the live list leaves out (by `include`); an id the host's
    // own list doesn't have at all is a dead route, so the list wins. Hosts without
    // a list rely on served.txt alone.
    const live = new Set(listed.map((m) => String(m.id).trim()))
    // served.txt is superseded where the list answers: keep only ids the list has but
    // `include` leaves out. The rest are listed already or dead routes. Not on the run
    // that first finds the list (its URL may be a guess; a collapsed list is an error above).
    if (have && wasListed && servedIds.length) {
      const keep = servedIds.filter((id) => have.has(id) && !live.has(id))
      if (keep.length < servedIds.length) {
        rewriteServed(host, keep)
        stats.servedPruned += servedIds.length - keep.length
      }
    }
    const entries = [...listed, ...servedIds.filter((id) => !live.has(id) && (!have || have.has(id))).map((id): Listed => ({ id }))]
    const others = allFiles.get(host)
    const mirrorOf = config[host]?.mirrors
    const out = mapEntries({ reg, matcher }, def, entries, prev.rows, others, mirrorOf ? upstreamRows(mirrorOf) : undefined)
    syncedRows.set(host, out.rows)
    for (const id of prev.rows.keys())
      if (!out.rows.has(id))
        drops.push({ host, id, reason: others?.get('manual')?.rows.has(id) || others?.get('openrouter')?.rows.has(id) ? 'now mapped by manual.toml or openrouter.toml'
          : out.unmapped.includes(id) ? 'still listed, but no longer maps to a model id' : `no longer listed by ${from || 'anything'}` })

    writeIfChanged(file, out.rows.size ? formatRows([
      `Generated by sync/hosts.ts from ${from}.`,
      'Do not edit: this file is rewritten every hour. Put fixes and additions in',
      'manual.toml next to it, which takes precedence. Ids this sync could not map',
      'are listed in state/hosts.json.',
    ], { rows: out.rows, review: new Map() }) : null)
    const report = def?.reportUnmapped ?? listed.length <= BIG_LIST
    state.unmapped[host] = report ? out.unmapped : []
    stats.hosts++
    stats.rows += out.rows.size
    stats.unmapped += report ? out.unmapped.length : 0
    if (process.env.VERBOSE || (result && !wasListed)) console.log(`  ${host}: ${entries.length} listed, ${out.rows.size} mapped (${Object.entries(out.via).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ')}), ${out.unmapped.length} unmapped${result && !wasListed ? ` (new: ${result.url})` : ''}`)
  }

  if (!only.length) {
    // A host with rows but neither a list nor a served.txt any more: drop them.
    const synced = new Set(targets)
    for (const h of known) {
      if (synced.has(h) || !fs.existsSync(hostFile(h, 'sync'))) continue
      for (const id of readRowsFile(hostFile(h, 'sync')).rows.keys()) drops.push({ host: h, id, reason: `no list and no hosts/${h}/served.txt` })
      writeIfChanged(hostFile(h, 'sync'), null)
    }
    for (const h of Object.keys(state.unmapped)) if (!synced.has(h)) delete state.unmapped[h]
    for (const h of Object.keys(state.unlisted ?? {})) if (!(h in lists)) delete state.unlisted![h]
    for (const h of Object.keys(health)) if (!(h in lists) && !served.has(h)) delete health[h]
  }
  writeState('hosts', state)
  writeIfChanged(HEALTH_FILE, stableJson(health, 1))
  writeIfChanged(LISTS_FILE, stableJson(Object.fromEntries(Object.entries(lists).sort(([a], [b]) => byKey(a, b))), 1))
  stats.drops = drops.length

  // One flaky host is normal; a quarter of them failing at once is not.
  const listHosts = Object.keys(lists).length
  const failingNow = stats.failing + stats.dead
  const bad = listHosts >= 8 && failingNow > listHosts * FAIL_RUN_SHARE
  writeReport({ source: 'hosts', finishedAt: new Date().toISOString(), ok: !bad, failures, drops, stats })
  console.log(`hosts: ${JSON.stringify(stats)}`)
  if (bad) {
    console.error(`hosts: ${failingNow} of ${listHosts} list hosts failed in one run; something upstream (or here) is wrong`)
    process.exitCode = 1
  }
}

if (isMain(import.meta.url)) await main().catch((e) => {
  console.error(`hosts: FAILED, nothing written: ${(e as Error).stack ?? e}`)
  writeReport({ source: 'hosts', finishedAt: new Date().toISOString(), ok: false, failures: [String((e as Error).message)], drops: [], stats: {} })
  process.exitCode = 1
})
