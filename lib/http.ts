import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { CACHE_DIR } from './paths.ts'

/** Generic on purpose: no names, no contact details, no keys. */
export const USER_AGENT = 'provider-mappings-sync/1.0'

export class HttpError extends Error {
  readonly status: number
  readonly url: string
  constructor(url: string, status: number, body: string) {
    super(`GET ${url} -> HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ''}`)
    this.status = status
    this.url = url
  }
}

export interface GetOptions {
  /** Reuse a cached response younger than this. 0 disables the cache. */
  cacheTtlMs?: number
  /** Minimum gap between requests to the same origin. */
  minIntervalMs?: number
  /** Attempts for 429 / 5xx / network errors. */
  attempts?: number
  timeoutMs?: number
}

const lastRequest = new Map<string, number>()
const cacheOff = process.env.SYNC_CACHE === '0'

function cachePath(url: string) {
  return path.join(CACHE_DIR, 'http', crypto.createHash('sha256').update(url).digest('hex').slice(0, 32) + '.json')
}

/** GET a URL as text, sequentially per origin, with retry/backoff and an optional on-disk cache. */
export async function getText(url: string, opts: GetOptions = {}): Promise<{ text: string; fetchedAt: Date; cached: boolean }> {
  const { cacheTtlMs = 0, minIntervalMs = 0, attempts = 5, timeoutMs = 60_000 } = opts
  const cp = cachePath(url)
  if (cacheTtlMs > 0 && !cacheOff && fs.existsSync(cp)) {
    const c = JSON.parse(fs.readFileSync(cp, 'utf8')) as { url: string; fetchedAt: string; text: string }
    if (c.url === url && Date.now() - Date.parse(c.fetchedAt) < cacheTtlMs) return { text: c.text, fetchedAt: new Date(c.fetchedAt), cached: true }
  }
  const origin = new URL(url).origin
  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const wait = (lastRequest.get(origin) ?? 0) + minIntervalMs - Date.now()
    if (wait > 0) await sleep(wait)
    lastRequest.set(origin, Date.now())
    let backoffMs = Math.min(60_000, 2_000 * 2 ** (attempt - 1))
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await res.text()
      if (res.ok) {
        const fetchedAt = new Date()
        if (cacheTtlMs > 0 && !cacheOff) {
          fs.mkdirSync(path.dirname(cp), { recursive: true })
          fs.writeFileSync(cp, JSON.stringify({ url, fetchedAt: fetchedAt.toISOString(), text }))
        }
        return { text, fetchedAt, cached: false }
      }
      lastErr = new HttpError(url, res.status, text)
      if (res.status !== 429 && res.status < 500) throw lastErr
      const retryAfter = Number(res.headers.get('retry-after'))
      if (retryAfter > 0) backoffMs = Math.min(120_000, retryAfter * 1000)
    } catch (e) {
      if (e instanceof HttpError && e.status !== 429 && e.status < 500) throw e
      lastErr = e
    }
    if (attempt < attempts) {
      console.warn(`  retry ${attempt}/${attempts - 1} in ${Math.round(backoffMs / 1000)}s: ${String((lastErr as Error)?.message ?? lastErr)}`)
      await sleep(backoffMs)
    }
  }
  throw lastErr
}

export async function getJson<T = unknown>(url: string, opts?: GetOptions): Promise<T> {
  const { text } = await getText(url, opts)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`GET ${url}: response is not JSON (${text.slice(0, 120)})`)
  }
}
