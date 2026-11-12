/**
 * Propose model-aliases.toml surplus_legacy entries by diffing a list of model ids (e.g. a
 * marketplace's public ids) against the OpenRouter catalog.
 *
 *   node scripts/seed-aliases.ts <ids-url> [<ids-url> ...] > proposals.toml
 *
 * Each URL must return JSON with `markets[].model` or `data[].id`. Ids that
 * already resolve (an OpenRouter id, or its vendor-less short name) need
 * nothing. For the rest, find OpenRouter models whose spelling normalizes to
 * the id; only one-to-one matches are proposed, and only when that model's own
 * short name is not itself a listed id. Review the output before committing.
 */
import { Registry, baseModels, fetchOrModels, normalizedForms, shortName, toCatalog } from '../lib/models.ts'
import { getJson } from '../lib/http.ts'
import { byKey, tomlString } from '../lib/rows.ts'

const urls = process.argv.slice(2)
if (!urls.length) {
  console.error('usage: node scripts/seed-aliases.ts <ids-url> [...]')
  process.exit(2)
}
const listed = new Set<string>()
for (const u of urls) {
  const j = await getJson<{ markets?: { model: string }[]; data?: { id: string }[] }>(u, { cacheTtlMs: 60 * 60_000 })
  for (const x of j.markets ?? []) listed.add(x.model)
  for (const x of j.data ?? []) listed.add(x.id)
}
const models = await fetchOrModels()
const reg = Registry.load(toCatalog(models))
const catalog = baseModels(models).filter((m) => !m.id.startsWith('openrouter/'))

const byForm = new Map<string, Set<string>>()
for (const m of catalog) {
  if (listed.has(shortName(m.id))) continue
  for (const s of [m.id, m.canonical_slug, m.hugging_face_id]) if (s) for (const f of normalizedForms(s)) byForm.set(f, (byForm.get(f) ?? new Set()).add(m.id))
}

const proposals = new Map<string, string[]>()
let resolved = 0
const misses: string[] = []
for (const id of [...listed].sort(byKey)) {
  if (reg.resolve(id)) {
    resolved++
    continue
  }
  if (id.includes(':')) continue // marketplace variants such as ":web"
  const hits = new Set(normalizedForms(id).flatMap((f) => [...(byForm.get(f) ?? [])]))
  if (hits.size === 1) {
    const orId = [...hits][0]!
    proposals.set(orId, [...(proposals.get(orId) ?? []), id])
  } else misses.push(hits.size ? `${id} (ambiguous: ${[...hits].join(', ')})` : id)
}

const out: string[] = []
for (const [orId, ids] of [...proposals].sort(([a], [b]) => byKey(a, b))) out.push(`[${tomlString(orId)}]`, `surplus_legacy = [${ids.map(tomlString).join(', ')}]`, '')
console.log(out.join('\n'))
console.error(`${listed.size} listed ids: ${resolved} already resolve, ${proposals.size} proposed, ${misses.length} without a unique OpenRouter match`)
if (process.env.VERBOSE) console.error(misses.join('\n'))
