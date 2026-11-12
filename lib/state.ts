import fs from 'node:fs'
import path from 'node:path'
import { REPORTS_DIR, STATE_DIR } from './paths.ts'
import { byKey, stableJson, writeIfChanged } from './rows.ts'

/** A native id two sources (or one source, twice) map to different model ids. */
export interface Conflict {
  host: string
  id: string
  chosen: { source: string; model: string; note?: string }
  others: { source: string; model: string; note?: string }[]
}

/**
 * Committed per-source state: what the last successful sync could not map.
 * Kept in git (not dist/) so a build is reproducible from the repo alone.
 */
export interface SourceState {
  /** host -> native ids the source lists but we could not map. */
  unmapped: Record<string, string[]>
  /** Disagreements inside one source (e.g. one native id under two OpenRouter models). */
  conflicts: Conflict[]
  /** host -> ids people or served.txt map on a host whose own list doesn't have them (hosts sync only). */
  unlisted?: Record<string, string[]>
  /** model -> since when OpenRouter has listed it with no endpoints at all (OpenRouter sync only). */
  empty?: Record<string, string>
}

export const stateFile = (source: string) => path.join(STATE_DIR, `${source}.json`)

/** state/host-lists.json: host -> the keyless list URL the host sync reads. */
export const LISTS_FILE = path.join(STATE_DIR, 'host-lists.json')
export const readLists = (): Record<string, string> => (fs.existsSync(LISTS_FILE) ? (JSON.parse(fs.readFileSync(LISTS_FILE, 'utf8')) as Record<string, string>) : {})

export function readState(source: string): SourceState {
  const f = stateFile(source)
  if (!fs.existsSync(f)) return { unmapped: {}, conflicts: [] }
  const s = JSON.parse(fs.readFileSync(f, 'utf8')) as Partial<SourceState>
  return { unmapped: s.unmapped ?? {}, conflicts: s.conflicts ?? [], ...(s.unlisted ? { unlisted: s.unlisted } : {}), ...(s.empty ? { empty: s.empty } : {}) }
}

export function writeState(source: string, s: SourceState) {
  const unmapped: Record<string, string[]> = {}
  for (const h of Object.keys(s.unmapped).sort(byKey)) if (s.unmapped[h]!.length) unmapped[h] = [...new Set(s.unmapped[h])].sort(byKey)
  const conflicts = [...s.conflicts].sort((a, b) => byKey(a.host, b.host) || byKey(a.id, b.id))
  const unlisted: Record<string, string[]> = {}
  for (const h of Object.keys(s.unlisted ?? {}).sort(byKey)) if (s.unlisted![h]!.length) unlisted[h] = [...new Set(s.unlisted![h])].sort(byKey)
  const empty = Object.fromEntries(Object.entries(s.empty ?? {}).sort(([a], [b]) => byKey(a, b)))
  writeIfChanged(stateFile(source), stableJson({ unmapped, conflicts, ...(s.unlisted ? { unlisted } : {}), ...(Object.keys(empty).length ? { empty } : {}) }, 2))
}

/** A row a sync removed, and why. validate.ts checks every removed row has one. */
export interface Drop {
  host: string
  id: string
  reason: string
}

/** Per-run report (not committed): drops and failures, for validate and the CI log. */
export interface RunReport {
  source: string
  finishedAt: string
  ok: boolean
  failures: string[]
  drops: Drop[]
  stats: Record<string, number>
}

export function writeReport(r: RunReport) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true })
  fs.writeFileSync(path.join(REPORTS_DIR, `${r.source}.json`), stableJson(r, 2))
}

export function readReports(): RunReport[] {
  if (!fs.existsSync(REPORTS_DIR)) return []
  return fs
    .readdirSync(REPORTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8')) as RunReport)
}
