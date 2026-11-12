import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'smol-toml'

export type Pin = 'pinned' | 'floating'
export interface Row {
  /** Canonical model id. */
  model: string
  pin: Pin
  quant?: string
}
/** A row written commented out because a person should look at it first. */
export interface ReviewRow extends Row {
  reason: string
}
export interface RowsFile {
  rows: Map<string, Row>
  review: Map<string, ReviewRow>
}

/** Canonical id: "vendor/slug" as OpenRouter writes it, "~" prefix for floating aliases. */
export const MODEL_RE = /^~?[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/
export const QUANT_RE = /^[a-z0-9]+$/
export const PINS: readonly Pin[] = ['pinned', 'floating']
const ROW_KEYS = new Set(['model', 'pin', 'quant'])

/** Quantization labels that carry no information. */
export function cleanQuant(q: unknown): string | undefined {
  if (typeof q !== 'string') return undefined
  const v = q.trim().toLowerCase()
  if (!v || v === 'unknown' || v === 'none' || v === 'null') return undefined
  return QUANT_RE.test(v) ? v : undefined
}

/** Native ids that are moving aliases rather than a fixed model. */
export function guessPin(nativeId: string): Pin {
  return /(^|[-_.:/@])latest($|[-_.:@])/i.test(nativeId) ? 'floating' : 'pinned'
}

export const emptyRows = (): RowsFile => ({ rows: new Map(), review: new Map() })

// ---------------------------------------------------------------- reading

/** Problems found while reading a row; empty when the row is well formed. */
export function rowProblems(id: string, v: unknown, { requirePin = true } = {}): string[] {
  const p: string[] = []
  if (!id || id !== id.trim() || /[\u0000-\u001f\u007f]/.test(id)) p.push(`native id ${JSON.stringify(id)} is empty, padded or has control characters`)
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return [...p, `${JSON.stringify(id)} is not a table`]
  const r = v as Record<string, unknown>
  for (const k of Object.keys(r)) if (!ROW_KEYS.has(k)) p.push(`${JSON.stringify(id)}: unknown field "${k}"`)
  if (typeof r.model !== 'string' || !MODEL_RE.test(r.model)) p.push(`${JSON.stringify(id)}: model ${JSON.stringify(r.model)} is not a well-formed canonical id ("vendor/slug")`)
  if (r.pin === undefined ? requirePin : !PINS.includes(r.pin as Pin)) p.push(`${JSON.stringify(id)}: pin must be "pinned" or "floating"`)
  // Floating rows go only under "~" model ids, and "~" model ids are always floating.
  if (typeof r.model === 'string' && r.pin !== undefined && (r.pin === 'floating') !== r.model.startsWith('~'))
    p.push(`${JSON.stringify(id)}: pin "${String(r.pin)}" disagrees with model ${JSON.stringify(r.model)}; floating rows go only under "~" model ids`)
  if (r.quant !== undefined && (typeof r.quant !== 'string' || !QUANT_RE.test(r.quant))) p.push(`${JSON.stringify(id)}: quant ${JSON.stringify(r.quant)} must be lowercase alphanumeric`)
  return p
}

function toRow(v: Record<string, unknown>): Row {
  const model = v.model as string
  const row: Row = { model, pin: (v.pin as Pin | undefined) ?? (model.startsWith('~') ? 'floating' : 'pinned') }
  if (typeof v.quant === 'string') row.quant = v.quant
  return row
}

/** Parse the commented-out review blocks of a rows file. */
export function parseReview(text: string): Map<string, ReviewRow> {
  const out = new Map<string, ReviewRow>()
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^# needs review: (.*)$/.exec(lines[i]!)
    if (!m) continue
    const body: string[] = []
    while (i + 1 < lines.length && lines[i + 1]!.startsWith('# ') && !lines[i + 1]!.startsWith('# needs review:')) body.push(lines[++i]!.slice(2))
    try {
      const t = parse(body.join('\n')) as Record<string, Record<string, unknown>>
      // Review rows may be the very disagreement they flag (a moving id under a pinned model).
      for (const [id, v] of Object.entries(t)) if (rowProblems(id, v).every((x) => x.includes('disagrees'))) out.set(id, { ...toRow(v), reason: m[1]! })
    } catch {
      // A hand-mangled comment is not worth failing over; it is just a comment.
    }
  }
  return out
}

/** Read a rows file. Throws on TOML errors; `problems` collects schema errors. */
export function readRowsText(text: string, problems?: string[], opts?: { requirePin?: boolean }): RowsFile {
  const doc = parse(text) as Record<string, unknown>
  const rows = new Map<string, Row>()
  for (const [id, v] of Object.entries(doc)) {
    const p = rowProblems(id, v, opts)
    if (p.length) {
      problems?.push(...p)
      continue
    }
    rows.set(id, toRow(v as Record<string, unknown>))
  }
  return { rows, review: parseReview(text) }
}

export function readRowsFile(file: string, problems?: string[], opts?: { requirePin?: boolean }): RowsFile {
  if (!fs.existsSync(file)) return emptyRows()
  return readRowsText(fs.readFileSync(file, 'utf8'), problems, opts)
}

// ---------------------------------------------------------------- writing

/** Code-point order, so output never depends on locale. */
export const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** TOML basic string. JSON escapes are a subset of TOML's, except DEL which we reject anyway. */
export const tomlString = (s: string) => JSON.stringify(s)

function rowLines(id: string, r: Row): string[] {
  const l = [`[${tomlString(id)}]`, `model = ${tomlString(r.model)}`, `pin = ${tomlString(r.pin)}`]
  if (r.quant) l.push(`quant = ${tomlString(r.quant)}`)
  return l
}

/** Deterministic TOML for a rows file: sorted keys, quoted keys, review rows at the end. */
export function formatRows(header: string[], file: RowsFile): string {
  const out: string[] = header.map((h) => (h ? `# ${h}` : '#'))
  for (const id of [...file.rows.keys()].sort(byKey)) out.push('', ...rowLines(id, file.rows.get(id)!))
  const review = [...file.review.keys()].filter((id) => !file.rows.has(id)).sort(byKey)
  if (review.length) {
    out.push('', '# ---------------------------------------------------------------------------')
    out.push('# Rows below need a person to check them, so they are commented out.')
    out.push('# Once verified, copy the row (uncommented) into manual.toml.')
    for (const id of review) {
      const r = file.review.get(id)!
      out.push('', `# needs review: ${r.reason.replace(/\s+/g, ' ')}`, ...rowLines(id, r).map((l) => `# ${l}`))
    }
  }
  return out.join('\n') + '\n'
}

/** Write a file only when its content changed; remove it when `text` is null. Returns true if anything changed. */
export function writeIfChanged(file: string, text: string | null): boolean {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  if (old === text) return false
  if (text === null) {
    fs.rmSync(file)
    const dir = path.dirname(file)
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
    return true
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return true
}

export const sameRow = (a: Row, b: Row) => a.model === b.model && a.pin === b.pin && a.quant === b.quant

/** Stable JSON: object keys sorted recursively. */
export function stableJson(v: unknown, indent?: number): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort)
    if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort(byKey).map((k) => [k, sort((x as Record<string, unknown>)[k])]))
    return x
  }
  return JSON.stringify(sort(v), null, indent) + (indent ? '\n' : '')
}
