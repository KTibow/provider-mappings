import fs from 'node:fs'
import { parse } from 'smol-toml'
import { ALIASES_FILE } from './paths.ts'

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
/** One DNS label may be a named placeholder ("{region}") for per-account / per-region host families. */
const HOST_RE = new RegExp(`^(?=.{1,253}$)(?:(?:${LABEL}|\\{[a-z]+\\})\\.)+[a-z][a-z0-9-]{0,62}$`)

/**
 * A host key: a lowercase hostname (no scheme, port or path), or a host family
 * where exactly one label is a placeholder such as "{region}" or "{account}":
 * "bedrock-mantle.{region}.api.aws", "{account}.snowflakecomputing.com".
 * A placeholder label matches any single DNS label.
 */
export const isHostKey = (h: string) => HOST_RE.test(h) && (h.match(/\{/g)?.length ?? 0) <= 1 && h.split('.').filter((l) => !l.startsWith('{')).length >= 2

/** Name for a placeholder label, from the variable it stands for. */
function placeholderName(v: string): string {
  const s = v.replace(/[${}]/g, '').toLowerCase()
  if (/region|location/.test(s)) return 'region'
  if (/account/.test(s)) return 'account'
  if (/resource/.test(s)) return 'resource'
  if (/project/.test(s)) return 'project'
  return s.replace(/[^a-z]/g, '') || 'x'
}

export type BaseUrl =
  | { kind: 'ok'; host: string; url: URL | null; family: boolean }
  | { kind: 'none'; reason: string }

/**
 * Turn an API base URL into a host key: the lowercase hostname, without scheme,
 * port or path. The path is ignored, placeholders in it included
 * ("…/accounts/{accountId}/ai/v1" is still api.cloudflare.com). One placeholder
 * label in the hostname gives a host family ("bedrock-mantle.{region}.api.aws");
 * a hostname that is entirely a placeholder gives no host.
 */
export function parseBaseUrl(raw: string | null | undefined): BaseUrl {
  if (!raw || typeof raw !== 'string') return { kind: 'none', reason: 'no base URL' }
  const s = raw.trim()
  if (s === 'not_used') return { kind: 'none', reason: 'base URL is "not_used" (provider SDK, not HTTP)' }
  const m = /^([a-z]+):\/\/([^/?#]*)/i.exec(s)
  if (!m) return { kind: 'none', reason: `unparseable base URL (${s})` }
  if (m[1]!.toLowerCase() !== 'https' && m[1]!.toLowerCase() !== 'http') return { kind: 'none', reason: `not an HTTP URL (${s})` }
  const authority = m[2]!.replace(/:\d+$/, '').toLowerCase().replace(/\.$/, '')
  if (/[{}$<>]/.test(authority)) {
    const labels = authority.split('.')
    const ph = labels.filter((l) => /^\$?\{[^}]+\}$/.test(l))
    if (ph.length !== 1 || labels.some((l) => /[{}$]/.test(l) && !/^\$?\{[^}]+\}$/.test(l)))
      return { kind: 'none', reason: `hostname is a per-account placeholder (${s})` }
    const host = labels.map((l) => (/^\$?\{[^}]+\}$/.test(l) ? `{${placeholderName(l)}}` : l)).join('.')
    if (!isHostKey(host)) return { kind: 'none', reason: `hostname is a per-account placeholder (${s})` }
    return { kind: 'ok', host, url: null, family: true }
  }
  let url: URL
  try {
    url = new URL(s.replace(/\$?\{[^}]*\}/g, 'x'))
  } catch {
    return { kind: 'none', reason: `unparseable base URL (${s})` }
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || /^(127|10|0)\.|^192\.168\.|^\[|^\d+\.\d+\.\d+\.\d+$/.test(host)) return { kind: 'none', reason: `local or bare-IP host (${s})` }
  if (!isHostKey(host)) return { kind: 'none', reason: `not a valid hostname (${s})` }
  return { kind: 'ok', host, url, family: false }
}

/** host-aliases.toml: `"<canonical host>" = ["<alias>", ...]`. Returns alias -> canonical host. */
export function loadAliases(problems?: string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (!fs.existsSync(ALIASES_FILE)) return out
  const doc = parse(fs.readFileSync(ALIASES_FILE, 'utf8')) as Record<string, unknown>
  for (const [target, list] of Object.entries(doc)) {
    if (!isHostKey(target)) problems?.push(`host-aliases.toml: "${target}" is not a normalized host key`)
    if (!Array.isArray(list) || list.some((a) => typeof a !== 'string')) {
      problems?.push(`host-aliases.toml: "${target}" must be an array of hostnames`)
      continue
    }
    for (const alias of list as string[]) {
      if (!isHostKey(alias)) problems?.push(`host-aliases.toml: alias "${alias}" is not a normalized host key`)
      if (out.has(alias)) problems?.push(`host-aliases.toml: "${alias}" is listed twice`)
      out.set(alias, target)
    }
  }
  for (const [alias, target] of out) if (out.has(target)) problems?.push(`host-aliases.toml: "${alias}" -> "${target}" is a chain; point it at the final host`)
  return out
}

export const resolveHost = (aliases: Map<string, string>, host: string) => aliases.get(host) ?? host
