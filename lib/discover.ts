/**
 * Where hosts' model lists might be: every API base URL models.dev and
 * OpenRouter report, plus https://<host>/v1 for every host that already has
 * rows. sync/hosts.ts probes `<base>/models` without credentials; a 200 with
 * `{ data: [{ id }, ...] }` makes the host a synced host.
 */
import { parseBaseUrl } from './host.ts'
import { getJson, getText } from './http.ts'
import { SDK_DEFAULT_BASE } from './sdk-hosts.ts'

/** host -> candidate base URLs (no trailing slash). */
export type Candidates = Map<string, Set<string>>

/** Plain URL characters only: these come from third-party data. */
const URL_RE = /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~/-]*)?$/

export function addCandidate(c: Candidates, raw: unknown) {
  if (typeof raw !== 'string' || !URL_RE.test(raw.trim())) return
  const p = parseBaseUrl(raw)
  // Families have no single hostname to call; OpenRouter is configured explicitly;
  // partner/integration paths are someone else's API behind OpenRouter's account.
  if (p.kind !== 'ok' || p.family || /openrouter/i.test(raw) || /\/partner\/|\/integrations\//.test(raw)) return
  const base = raw.trim().replace(/\/+$/, '').replace(/\/(chat\/)?completions$/, '')
  if (!c.has(p.host)) c.set(p.host, new Set())
  c.get(p.host)!.add(base)
}

export async function candidates(knownHosts: Iterable<string>): Promise<Candidates> {
  const c: Candidates = new Map()
  // Each upstream only adds candidates: if one fails, known hosts (and the other) still sync.
  try {
    const md = JSON.parse((await getText('https://models.dev/api.json', { cacheTtlMs: 30 * 60_000 })).text) as Record<string, { api?: string; models?: Record<string, { provider?: { api?: string } }> }>
    for (const p of Object.values(md)) {
      addCandidate(c, p.api)
      for (const m of Object.values(p.models ?? {})) addCandidate(c, m.provider?.api)
    }
  } catch (e) {
    console.warn(`discovery: models.dev unavailable (${(e as Error).message})`)
  }
  try {
    const providers = await getJson<{ data?: { baseUrl?: string }[] }>('https://openrouter.ai/api/frontend/v1/all-providers', { cacheTtlMs: 30 * 60_000, minIntervalMs: 1000 })
    for (const p of providers.data ?? []) addCandidate(c, p.baseUrl)
  } catch (e) {
    console.warn(`discovery: OpenRouter's provider list unavailable (${(e as Error).message})`)
  }
  for (const base of Object.values(SDK_DEFAULT_BASE)) addCandidate(c, base)
  for (const h of knownHosts) if (!h.includes('{')) addCandidate(c, `https://${h}/v1`)
  return c
}

/** Ids from a `{ data: [{ id }] }` response, or [] for anything else. */
export function listIds(res: unknown): string[] {
  const data = (res as { data?: unknown })?.data
  return Array.isArray(data) ? data.map((m) => (m as { id?: unknown })?.id).filter((x): x is string => typeof x === 'string' && !!x.trim()) : []
}

/**
 * The hour (0-23) of a name's daily refresh, from a hash of the name: spreads
 * once-a-day work over the hours with no state (sync/openrouter.ts uses it for
 * models below the hourly threshold).
 */
export function probeHour(host: string): number {
  let h = 0
  for (const ch of host) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % 24
}
