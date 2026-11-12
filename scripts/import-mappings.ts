/**
 * Import a marketplace's live mappings.
 *
 *   node scripts/import-mappings.ts <export.json> [--decisions decisions.json] [--write]
 *
 * export.json:
 *   {
 *     "pairs":  [{ "host": "api.deepseek.com", "native": "deepseek-v4-pro", "model": "<marketplace id>", "pin"?: "floating" }, ...],
 *     "models": [{ "id": "<marketplace id>", "name": "...", "vendor": "venice" },          // ids OpenRouter lacks
 *                { "id": "<marketplace id>", "openrouter": "google/veo-3.1-fast" },     // OpenRouter has it under another id
 *                ...]   // "uncertain": true marks a match made by name only
 *   }
 *
 * decisions.json (optional; a person's answers to an earlier run's review rows):
 *   {
 *     "models": { "<marketplace id>": "<model id>" },  // overrides; an id nothing knows is declared
 *     "ours":   ["<native>", "<host> <native>"],      // the export wins over published data
 *     "skip":   ["<native>", "<host> <native>"],      // leave the pair out (published data stands, or the row is wrong)
 *     "rows":   { "<native>" | "<host> <native>": "<model id>" }  // the export filed this pair under the wrong model
 *   }
 *
 * "host" is a hostname or a host family ("bedrock-mantle.{region}.api.aws");
 * "model" is the marketplace's own id. What it writes:
 *   - hosts/<host>/served.txt: every native id the export routes on a host without
 *     a keyless list. sync/hosts.ts maps these like a /models list. A host with
 *     one gets only ids its list has but host-config's `include` leaves out; an
 *     id its list lacks is a dead route.
 *   - model-aliases.toml: a marketplace id that is not its model's short name goes
 *     in that model's surplus_legacy (every catalog id that is the model: one per
 *     operation or variant the catalog lists); models OpenRouter lacks are
 *     declared as "<vendor>/<id>".
 * It writes no mappings itself. It prints the pairs the sync would map
 * differently or not at all, for a person to settle with an alias in
 * model-aliases.toml, a commented row in manual.toml, or not at all.
 * An "uncertain" match is accepted unless the ids differ by a tier word ("pro",
 * "e2ee", "fast"); those are held for review.
 * Without --write it only reports what it would do.
 */
import fs from 'node:fs'
import { parse } from 'smol-toml'
import { readCatalog } from '../build.ts'
import { isHostKey, loadAliases, parseBaseUrl, resolveHost } from '../lib/host.ts'
import type { Listed } from '../lib/hostsync.ts'
import { Registry, registryMatcher, settlePin, shortName, tierMismatch } from '../lib/models.ts'
import { ALIASES_TOML, hostFile, servedFile, type Source } from '../lib/paths.ts'
import { MODEL_RE, byKey, guessPin, readRowsFile, tomlString, writeIfChanged, type ReviewRow, type Row } from '../lib/rows.ts'
import { addRowEvidence, formatServed, loadHostFiles, merge, type HostFiles } from '../lib/store.ts'
import { fetchList, hostDef, mapEntries } from '../sync/hosts.ts'
import { readLists } from '../lib/state.ts'
import type { HostDef } from '../lib/hostsync.ts'

const args = process.argv.slice(2)
const write = args.includes('--write')
const decisionsFile = args.includes('--decisions') ? args[args.indexOf('--decisions') + 1] : undefined
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--decisions')
if (!file) {
  console.error('usage: node scripts/import-mappings.ts <export.json> [--decisions decisions.json] [--write]')
  process.exit(2)
}
type Pair = { host: string; native: string; model: string; pin?: 'pinned' | 'floating' }
const input = JSON.parse(fs.readFileSync(file, 'utf8')) as {
  pairs: Pair[]
  models?: { id: string; name?: string; vendor?: string; openrouter?: string; uncertain?: boolean }[]
}
const decisions = (decisionsFile ? JSON.parse(fs.readFileSync(decisionsFile, 'utf8')) : {}) as { models?: Record<string, string>; ours?: string[]; skip?: string[]; rows?: Record<string, string> }
const decided = (list: string[] | undefined, host: string, native: string) => !!list?.some((d) => d === native || d === `${host} ${native}`)

/** Keys some catalogs use instead of hostnames. */
const NAMED_HOSTS: Record<string, string> = { openrouter: 'openrouter.ai', venice: 'api.venice.ai' }
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '')

const aliases = loadAliases()
const loaded = loadHostFiles().files
const published = merge(loaded).rows
const usedIds = () => new Set([...published.values()].flatMap((m) => [...m.values()].map((r) => r.model)))
// Same model ids the build knows: OpenRouter's catalog, model-aliases.toml, and ids rows already use (e.g. from models.dev).
let reg = Registry.load(readCatalog(), undefined, usedIds())
const matcher = registryMatcher(reg)

// 1. Marketplace ids -> model ids; declare only what nothing matches.
const declare = new Map<string, { name?: string; legacy: string }>()
/** Marketplace id -> existing model id it is another name for (written as surplus_legacy). */
const legacy = new Map<string, string>()
const modelFor = new Map<string, string>()
const unresolved = new Set<string>()
const held = new Map<string, string>() // marketplace id -> why its pairs wait for review
const meta = new Map((input.models ?? []).map((m) => [m.id, m]))
for (const id of new Set(input.pairs.map((p) => p.model))) {
  const m = meta.get(id)
  // A person's answer; then a name model-aliases.toml already resolves (curated
  // there, it beats the exporter's guess); then the exporter's OpenRouter id.
  const curated = !decisions.models?.[id] && reg.explicit(id)
  if (curated) {
    modelFor.set(id, curated)
    continue
  }
  const named = decisions.models?.[id] ?? m?.openrouter
  if (named) {
    const target = reg.resolve(named) ?? (decisions.models?.[id] && MODEL_RE.test(named) ? named : undefined)
    if (target) {
      if (!reg.resolve(named)) declare.set(target, { name: m?.name, legacy: id })
      else if (reg.resolve(id) !== target) legacy.set(id, target)
      modelFor.set(id, target)
      if (m?.uncertain && !decisions.models?.[id] && tierMismatch(id, target)) held.set(id, `the exporter matched ${id} to ${target} by name only, and the names differ by a tier word`)
      continue
    }
  }
  // "x:web" / "x:batch" are the marketplace's feature variants of x: same model.
  const base = id.includes(':') ? id.slice(0, id.indexOf(':')) : id
  const loose = matcher.match([base])?.model
  const hit = reg.resolve(id) ?? reg.resolve(base) ?? (loose && !tierMismatch(base, loose) ? loose : undefined)
  if (hit) {
    modelFor.set(id, hit)
    // A loose match is not a name the build resolves; record it so the id keeps working.
    if (base === id && reg.resolve(id) !== hit) legacy.set(id, hit)
    continue
  }
  const declared = m?.vendor ? reg.ofSlug(`${slug(m.vendor)}/${id}`) : undefined
  if (declared && MODEL_RE.test(declared)) {
    modelFor.set(id, declared)
    declare.set(declared, { name: m?.name, legacy: id })
  } else unresolved.add(id)
}

// 2. Pairs -> accepted (host, native -> row) and review rows.
const accepted = new Map<string, Map<string, Row>>()
const review = new Map<string, Map<string, ReviewRow>>()
const stats = { pairs: input.pairs.length, accepted: 0, review: 0, skipped: 0, badHost: 0, unresolvedModel: 0 }
const badHosts = new Set<string>()
const put = <T>(m: Map<string, Map<string, T>>, host: string, id: string, v: T) => (m.get(host) ?? m.set(host, new Map()).get(host)!).set(id, v)
for (const p of input.pairs) {
  const rawHost = NAMED_HOSTS[p.host] ?? p.host
  const parsed = isHostKey(rawHost.toLowerCase()) ? { kind: 'ok' as const, host: rawHost.toLowerCase() } : parseBaseUrl(`https://${rawHost}`)
  if (parsed.kind !== 'ok') {
    stats.badHost++
    badHosts.add(p.host)
    continue
  }
  const host = resolveHost(aliases, parsed.host)
  if (decided(decisions.skip, host, p.native)) {
    stats.skipped++
    continue
  }
  const forced = decisions.rows?.[`${host} ${p.native}`] ?? decisions.rows?.[p.native]
  const model = forced ? reg.resolve(forced) ?? forced : modelFor.get(p.model)
  if (!model) {
    stats.unresolvedModel++
    continue
  }
  const now = published.get(host)?.get(p.native)
  // The exporter knows which of its ids move; otherwise guess from the id.
  const settled = settlePin(reg, p.native, model, p.pin ?? guessPin(p.native))
  // A disagreement with published data waits for a person, except a moving id
  // the exporter knows is moving, settled onto a "~" id: that is strictly more
  // precise than a pinned row for an alias.
  const ours = !!forced || decided(decisions.ours, host, p.native)
  const reason = held.get(p.model)
    ?? (!settled ? `moving native id under the pinned model ${model}; map it to a "~" model id instead`
    : !ours && now && now.source !== 'manual' && (reg.explicit(now.model) ?? now.model) !== settled.model && !(p.pin === 'floating' && settled.model.startsWith('~'))
      ? `published data (${now.source}) maps this to ${now.model}; the export says ${settled.model}`
    : undefined)
  if (reason) {
    put(review, host, p.native, { model, pin: settled?.pin ?? 'pinned', reason })
    stats.review++
  } else {
    put(accepted, host, p.native, settled!)
    stats.accepted++
  }
}

// 3. model-aliases.toml first: the sync resolves declared and legacy ids through it.
const today = new Date().toISOString().slice(0, 10)
if (write && (declare.size || legacy.size)) {
  const doc = parse(fs.readFileSync(ALIASES_TOML, 'utf8')) as Record<string, { surplus_legacy?: string[] }>
  const blocks = [...declare].filter(([id]) => !(id in doc)).sort(([a], [b]) => byKey(a, b)).map(([id, d]) =>
    [`[${tomlString(id)}]`, ...(d.name ? [`name = ${tomlString(d.name)}`] : []), `surplus_legacy = [${tomlString(d.legacy)}]`].join('\n'))
  // Legacy ids for existing models: one block per model, listing all its legacy ids.
  const byTarget = new Map<string, string[]>()
  for (const [id, target] of legacy) if (!(doc[target]?.surplus_legacy ?? []).includes(id)) byTarget.set(target, [...(byTarget.get(target) ?? []), id])
  const legacyBlocks = [...byTarget].filter(([t]) => !(t in doc)).sort(([a], [b]) => byKey(a, b)).map(([t, ids]) =>
    `[${tomlString(t)}]\nsurplus_legacy = [${ids.sort(byKey).map(tomlString).join(', ')}]`)
  const clashes = [...byTarget.keys()].filter((t) => t in doc)
  if (clashes.length) console.log(`add these legacy ids by hand (model already has an entry): ${clashes.map((t) => `${t}: ${byTarget.get(t)!.join(', ')}`).join('; ')}`)
  blocks.push(...legacyBlocks)
  if (blocks.length) fs.appendFileSync(ALIASES_TOML, `\n# Models OpenRouter does not list, and legacy ids, from a marketplace's catalog (${today}).\n\n${blocks.join('\n\n')}\n`)
  reg = Registry.load(readCatalog())
}

// 4. Which accepted pairs does the host sync derive by itself? Run it the way the
// hourly job will, with these ids served.
const defs = new Map<string, HostDef>(Object.entries(readLists()).map(([h, url]) => [h, hostDef(h, url)]))
const live = new Map<string, Listed[] & { ids?: Set<string> }>()
await Promise.all([...accepted.keys()].filter((h) => defs.has(h)).map(async (h) => { try { live.set(h, await fetchList(defs.get(h)!)) } catch {} }))
const same = (a: { model: string; pin: string } | undefined, b: Row) => !!a && (reg.explicit(a.model) ?? a.model) === (reg.explicit(b.model) ?? b.model) && a.pin === b.pin
const underived: string[] = []
const dead = new Map<string, string[]>()
const servedOnly = new Map<string, string[]>()
const syncReg = Registry.load(readCatalog())
const matcher2 = registryMatcher(syncReg)
addRowEvidence(matcher2, loaded)
for (const [host, rows] of accepted) {
  const listed = live.get(host)
  // A host with a keyless list: an id it doesn't list is a dead route.
  if (listed) {
    const all = listed.ids ?? new Set(listed.map((x) => String(x.id).trim()))
    for (const id of [...rows.keys()]) if (!all.has(id)) { rows.delete(id); dead.set(host, [...(dead.get(host) ?? []), id]) }
  }
  const ids = new Set((listed ?? []).map((x) => String(x.id).trim()))
  // A list host's served.txt only needs the ids its list has but host-config's `include` drops.
  if (listed) servedOnly.set(host, [...rows.keys()].filter((id) => !ids.has(id)))
  const entries = [...(listed ?? []), ...[...rows.keys()].filter((id) => !ids.has(id)).map((id): Listed => ({ id }))]
  const others = loaded.get(host)
  const out = mapEntries({ reg: syncReg, matcher: matcher2 }, defs.get(host), entries, readRowsFile(hostFile(host, 'sync')).rows, others)
  for (const [id, want] of rows) {
    const top = (['manual', 'sync', 'openrouter', 'modelsdev'] as Source[]).map((s) => (s === 'sync' ? out.rows.get(id) : others?.get(s)?.rows.get(id))).find(Boolean)
    if (!same(top, want)) underived.push(`${host}  ${id}: export says ${want.model}; published data ${top ? `says ${top.model}` : 'has nothing'}`)
  }
}
for (const [host, rows] of review) for (const [id, r] of rows) underived.push(`${host}  ${id}: export says ${r.model}; held: ${r.reason}`)

// 5. Report, and write.
console.log(JSON.stringify({ ...stats, hosts: accepted.size, dead: [...dead.values()].flat().length, underived: underived.length, declareModels: declare.size, legacyIds: legacy.size, unresolvedModels: unresolved.size }, null, 1))
if (badHosts.size) console.log(`hosts that are not hostnames (skipped): ${[...badHosts].sort().join(', ')}`)
if (unresolved.size) console.log(`marketplace ids with no model id and no vendor given (skipped): ${[...unresolved].sort().join(', ')}`)
for (const [host, ids] of dead) console.log(`not in ${host}'s own list (left out of served.txt): ${ids.sort(byKey).join(', ')}`)
if (underived.length) console.log(`\nPairs the sync maps differently or not at all; settle each with an alias, a commented manual.toml row, or nothing:\n${underived.sort(byKey).join('\n')}`)
if (!write) {
  console.log('dry run; pass --write to write served.txt and model-aliases.toml')
  process.exit(0)
}

for (const [host, rows] of [...accepted].sort(([a], [b]) => byKey(a, b))) {
  const served = servedOnly.get(host) ?? [...rows.keys()]
  if (!served.length) continue
  const f = servedFile(host)
  const prev = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')) : []
  writeIfChanged(f, formatServed([
    `Native ids ${host} is known to serve, from a marketplace's live routing`,
    `(scripts/import-mappings.ts, ${today}). sync/hosts.ts maps each one like an`,
    'entry in a /models list; the rows land in sync.toml. Remove an id the host',
    'no longer serves; put a mapping the sync gets wrong in manual.toml.',
  ], [...prev, ...served]))
}
console.log('written; run node sync/hosts.ts, then node validate.ts')
