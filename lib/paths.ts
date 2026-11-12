import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const HOSTS_DIR = path.join(ROOT, 'hosts')
export const STATE_DIR = path.join(ROOT, 'state')
export const DIST_DIR = path.join(ROOT, 'dist')
export const CACHE_DIR = path.join(ROOT, '.cache')
export const REPORTS_DIR = path.join(CACHE_DIR, 'reports')
export const ALIASES_TOML = path.join(ROOT, 'model-aliases.toml')
export const ALIASES_FILE = path.join(ROOT, 'host-aliases.toml')
export const LOCK_FILE = path.join(ROOT, 'upstream.lock')

/** Source files inside hosts/<host>/, highest precedence first. */
export const SOURCES = ['manual', 'sync', 'openrouter', 'modelsdev'] as const
export type Source = (typeof SOURCES)[number]
export const SYNC_SOURCES = ['sync', 'openrouter', 'modelsdev'] as const satisfies readonly Source[]

export const hostFile = (host: string, source: Source) => path.join(HOSTS_DIR, host, `${source}.toml`)
/** hosts/<host>/served.txt: native ids the host is known to serve, mapped by sync/hosts.ts like a /models list. */
export const servedFile = (host: string) => path.join(HOSTS_DIR, host, 'served.txt')

/** True when the module at `url` is the script node was started with. */
export const isMain = (url: string) => !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(url)
