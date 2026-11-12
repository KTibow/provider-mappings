import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { HOSTS_DIR, ROOT, SOURCES, type Source } from './paths.ts'
import { byKey, readRowsText, type Row, type RowsFile } from './rows.ts'
import type { Conflict } from './state.ts'
import type { Matcher } from './models.ts'

/** Reads repo files either from the working tree or from a git revision. */
export interface Tree {
  list(dir: string): string[]
  read(file: string): string | null
}

export const workTree: Tree = {
  list(dir) {
    const abs = path.join(ROOT, dir)
    if (!fs.existsSync(abs)) return []
    return fs.readdirSync(abs, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => path.relative(ROOT, path.join(d.parentPath, d.name)))
  },
  read(file) {
    const abs = path.join(ROOT, file)
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null
  },
}

export function gitTree(rev: string): Tree | null {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { cwd: ROOT, stdio: 'pipe' })
  } catch {
    return null
  }
  return {
    list(dir) {
      const out = execFileSync('git', ['ls-tree', '-r', '--name-only', rev, '--', dir], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
      return out.split('\n').filter(Boolean)
    },
    read(file) {
      try {
        return execFileSync('git', ['show', `${rev}:${file}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 })
      } catch {
        return null
      }
    },
  }
}

/** host -> source -> parsed file */
export type HostFiles = Map<string, Map<Source, RowsFile>>

export interface LoadResult {
  files: HostFiles
  /** host -> native ids from hosts/<host>/served.txt. */
  served: Map<string, string[]>
  /** Files that did not parse or have schema errors. */
  problems: string[]
  /** Files under hosts/ that are not <host>/<source>.toml. */
  strays: string[]
}

export function loadHostFiles(tree: Tree = workTree): LoadResult {
  const files: HostFiles = new Map()
  const served = new Map<string, string[]>()
  const problems: string[] = []
  const strays: string[] = []
  const rel = path.relative(ROOT, HOSTS_DIR)
  for (const f of tree.list(rel).sort(byKey)) {
    const parts = path.relative(rel, f).split(path.sep)
    const source = parts[1]?.replace(/\.toml$/, '') as Source
    if (parts.length === 2 && parts[1] === 'served.txt') {
      const text = tree.read(f)
      if (text !== null) served.set(parts[0]!, readServedText(text, (x) => problems.push(`${f}: ${x}`)))
      continue
    }
    if (parts.length !== 2 || !parts[1]!.endsWith('.toml') || !SOURCES.includes(source)) {
      if (!parts.at(-1)!.startsWith('.')) strays.push(f)
      continue
    }
    const host = parts[0]!
    const text = tree.read(f)
    if (text === null) continue
    const p: string[] = []
    try {
      const rf = readRowsText(text, p, { requirePin: source !== 'manual' })
      if (!files.has(host)) files.set(host, new Map())
      files.get(host)!.set(source, rf)
    } catch (e) {
      p.push(String((e as Error).message).split('\n')[0]!)
    }
    problems.push(...p.map((x) => `${f}: ${x}`))
  }
  return { files, served, problems, strays }
}

/** served.txt: one native id per line; "#" lines are comments. */
export function readServedText(text: string, problem: (p: string) => void = () => {}): string[] {
  const ids = text.split('\n').filter((l) => l.trim() && !l.startsWith('#'))
  for (const id of ids) if (id !== id.trim()) problem(`${JSON.stringify(id)} has surrounding whitespace`)
  if (new Set(ids).size !== ids.length) problem('lists an id twice')
  return ids.map((i) => i.trim())
}

export function formatServed(header: string[], ids: Iterable<string>): string {
  return [...header.map((l) => (l ? `# ${l}` : '#')), ...[...new Set(ids)].sort(byKey)].join('\n') + '\n'
}

/** The merged view: per host, per native id, the row from the highest-precedence source. */
export type MergedRow = Row & { source: Source; current?: string }
export interface Merged {
  rows: Map<string, Map<string, MergedRow>>
  conflicts: Conflict[]
}

export function merge(files: HostFiles): Merged {
  const rows: Merged['rows'] = new Map()
  const conflicts: Conflict[] = []
  for (const host of [...files.keys()].sort(byKey)) {
    const bySource = files.get(host)!
    const ids = new Set<string>()
    for (const f of bySource.values()) for (const id of f.rows.keys()) ids.add(id)
    const out = new Map<string, MergedRow>()
    for (const id of [...ids].sort(byKey)) {
      const found = SOURCES.flatMap((s) => {
        const r = bySource.get(s)?.rows.get(id)
        return r ? [{ ...r, source: s }] : []
      })
      const top: MergedRow = found[0]!
      // A floating row ("deepseek-flash" -> "~deepseek/deepseek-flash-latest")
      // takes what it serves today from the highest lower source that names a
      // fixed model for the same id (OpenRouter, models.dev). That is not a
      // disagreement, so it is not a conflict.
      if (top.pin === 'floating') {
        const now = found.slice(1).find((r) => !r.model.startsWith('~'))?.model
        if (now) top.current = now
      }
      out.set(id, top)
      const others = found.slice(1).filter((r) => r.model !== top.model && r.model !== top.current)
      if (others.length) conflicts.push({ host, id, chosen: { source: top.source, model: top.model }, others: others.map((o) => ({ source: o.source, model: o.model })) })
    }
    if (out.size) rows.set(host, out)
  }
  return { rows, conflicts }
}

/**
 * True when the model id ends in a checkpoint date the native id doesn't name:
 * that host resolves an undated name ("deepseek-r1") to one checkpoint
 * ("deepseek-r1-0528"), and another host may resolve it to a different one.
 */
export function undatedAlias(nativeId: string, model: string): boolean {
  const d = model.match(/-(\d{4}(?:\d{2}){0,2})$/)
  return !!d && !nativeId.replace(/\D/g, '').includes(d[1]!)
}

/**
 * Native ids people or OpenRouter already mapped on any host are strong
 * evidence for the same id elsewhere. Only these two sources, so one heuristic
 * match can never vouch for the next.
 */
export function addRowEvidence(matcher: Matcher, files: HostFiles) {
  for (const byHost of files.values()) {
    for (const src of ['manual', 'openrouter'] as const)
      for (const [id, r] of byHost.get(src)?.rows ?? []) if (r.pin === 'pinned' && id.length >= 4 && !undatedAlias(id, r.model)) matcher.addExact(id, r.model)
    // Model ids people or OpenRouter use are known model ids. Not ids from sync or
    // models.dev rows: a wrong id there would otherwise vouch for itself next run.
    for (const src of ['manual', 'openrouter'] as const) for (const r of byHost.get(src)?.rows.values() ?? []) matcher.add(r.model, r.model)
  }
}
