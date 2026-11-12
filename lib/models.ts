/**
 * Model ids.
 *
 * A model id is an OpenRouter model id, verbatim: "moonshotai/kimi-k3",
 * "minimax/MiniMax-M2.7", or "~typesafe/jev-latest" for OpenRouter's floating
 * routers. OpenRouter gives separately tracked checkpoints their own ids
 * ("deepseek/deepseek-v4-pro-0813"); the checkpoint behind an id (its
 * permaslug) is published alongside in models.json rather than used as the
 * key, so a checkpoint swap does not rewrite every row.
 *
 * Models OpenRouter does not list get an id from model-aliases.toml or,
 * failing that, from models.dev's canonical_model_id (same "vendor/slug" shape).
 *
 * Other names resolve to a model id: its short name (the id without the vendor,
 * "kimi-k3"), its permaslug, ids it was renamed from, and the aliases and legacy
 * Surplus ids listed in model-aliases.toml.
 */
import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'smol-toml'
import { getJson } from './http.ts'
import { ALIASES_TOML, STATE_DIR } from './paths.ts'
import { MODEL_RE } from './rows.ts'

/**
 * Variants of a model, in OpenRouter's "model:variant" convention, for a host id
 * that is the model sold as a separate offer:
 *   - "web": with the host's web search built in ("glm-5.1:web");
 *   - "free": its free tier ("gemma-4-31b-it:free", with its own limits). When
 *     OpenRouter lists only the free tier, the catalog makes that the model itself;
 *   - "thinking", "non-thinking": a reasoning mode a host sells as its own id
 *     ("glm-5.1-non-thinking"; declared in model-aliases.toml, never guessed);
 *   - an operation of a media model other than its default (see operationOf).
 * Variants nest ("z-ai/glm-5.1:non-thinking:web"). Service tiers (":batch",
 * ":flex", ":priority") are left unmapped, and OpenRouter's ":online" is a
 * request option, not something a host lists.
 */
export const OPERATIONS = ['image-to-video', 'reference-to-video', 'enhanced-reference-to-video', 'transition', 'edit'] as const
export const VARIANTS = ['web', 'free', 'thinking', 'non-thinking', ...OPERATIONS] as const
const VARIANT_RE = new RegExp(`^(.+):(${VARIANTS.join('|')})$`, 'i')

/** "z-ai/glm-5.1:web" -> ["z-ai/glm-5.1", "web"]; undefined for an id without a variant. */
export function splitVariant(id: string): [string, string] | undefined {
  const m = id.trim().match(VARIANT_RE)
  return m && m[1]!.includes('/') === id.includes('/') ? [m[1]!, m[2]!.toLowerCase()] : undefined
}

/** The model a variant is of, through any nesting ("z-ai/glm-5.1:non-thinking:web" -> "z-ai/glm-5.1"). */
export function variantRoot(id: string): string {
  const v = splitVariant(id)
  return v ? variantRoot(v[0]) : id
}

/**
 * The operation a media host's native id names, when it is not the model's
 * default: "seedance-2-0-image-to-video-basic" -> "image-to-video",
 * "gpt-image-2/edit" -> "edit". Text-to-video ("-text-to-video", "-t2v") and
 * image generation are the model itself (undefined).
 */
export function operationOf(nativeId: string): string | undefined {
  const m = nativeId.trim().match(/[-/]((?:image|reference|enhanced-reference)-to-video|i2v|r2v|transition|edit)(?:-(?:basic|private))?$/i)
  if (!m) return undefined
  const op = m[1]!.toLowerCase()
  return op === 'i2v' ? 'image-to-video' : op === 'r2v' ? 'reference-to-video' : op
}

/** `model` as operation `op` ("bytedance/seedance-2.0:image-to-video"; by default the one `nativeId` names), unless the model id already is it. */
export function withOperation(nativeId: string, model: string, op = operationOf(nativeId)): string {
  if (!op || model.startsWith('~') || splitVariant(model) || shortName(model).endsWith(op)) return model
  return `${model}:${op}`
}

/** A variant's short name keeps its variants ("glm-5.1:non-thinking:web"), apart from its model's. */
function shortKey(id: string): string {
  const v = splitVariant(id)
  return v ? `${shortKey(v[0])}:${v[1]}` : shortName(id)
}

/** "moonshotai/Kimi-K3:free" -> "kimi-k3"; "~typesafe/jev-latest" -> "jev-latest". */
export function shortName(id: string): string {
  let s = id.trim().toLowerCase().replace(/^~/, '')
  const colon = s.indexOf(':')
  if (colon > s.indexOf('/')) s = s.slice(0, colon)
  return s.slice(s.indexOf('/') + 1)
}

// ---------------------------------------------------------------- OpenRouter catalog

export interface OrModel {
  id: string
  canonical_slug: string
  hugging_face_id?: string | null
  name?: string
  created?: number
  pricing?: Record<string, unknown>
  architecture?: { input_modalities?: string[]; output_modalities?: string[] }
}

export const OR_MODELS_URL = 'https://openrouter.ai/api/v1/models?output_modalities=all'

/** Every listed model, raw (including "~" aliases and ":free" / ":batch" variants). */
export async function fetchOrModels(cacheTtlMs = 30 * 60_000): Promise<OrModel[]> {
  const res = await getJson<{ data?: unknown }>(OR_MODELS_URL, { cacheTtlMs, minIntervalMs: 1000 })
  if (!Array.isArray(res.data)) throw new Error('OpenRouter /api/v1/models: expected { data: [...] }')
  // One odd entry must not stop every sync: skip it and say so.
  const ok = (res.data as OrModel[]).filter((m) => {
    const good = typeof m?.id === 'string' && typeof m?.canonical_slug === 'string' && MODEL_RE.test(m.id)
    if (!good) console.warn(`OpenRouter /api/v1/models: skipped unexpected entry ${JSON.stringify(m).slice(0, 200)}`)
    return good
  })
  if (ok.length < 100) throw new Error(`OpenRouter /api/v1/models returned only ${ok.length} usable models; refusing to trust it`)
  return ok
}

/**
 * One model per canonical_slug, skipping "~" aliases and preferring the plain
 * id over ":free" / ":batch" variants of the same slug.
 */
export function baseModels(models: OrModel[]): OrModel[] {
  const bySlug = new Map<string, OrModel>()
  for (const m of models) {
    if (m.id.startsWith('~')) continue
    const prev = bySlug.get(m.canonical_slug)
    if (!prev || (prev.id.includes(':') && !m.id.includes(':'))) bySlug.set(m.canonical_slug, m)
  }
  return [...bySlug.values()]
}

/** What we keep of the catalog (state/catalog.json), keyed by model id. */
export interface CatalogEntry {
  /** OpenRouter's permaslug: the checkpoint behind the id. Absent for "~" aliases. */
  permaslug?: string
  name?: string
  hf?: string
  /** OpenRouter's floating "~…-latest" routers. */
  floating?: boolean
  /** Ids this permaslug was published under before (renames). */
  formerly?: string[]
  /**
   * Date (YYYY-MM-DD) OpenRouter stopped listing the model. Delisted models stay
   * known: sellers keep serving them and catalogs keep selling them.
   */
  delisted?: string
  /** What goes in and comes out: ["text","image"] -> ["text"], ["text"] -> ["embeddings"], ... */
  input?: string[]
  output?: string[]
}
export type Catalog = Record<string, CatalogEntry>

export function toCatalog(models: OrModel[], previous: Catalog = {}, today = new Date().toISOString().slice(0, 10)): Catalog {
  const out: Catalog = {}
  const prevBySlug = new Map<string, string>()
  for (const [id, e] of Object.entries(previous)) if (e.permaslug) prevBySlug.set(e.permaslug, id)
  const bases = baseModels(models)
  const plainIds = new Set(bases.map((m) => m.id).filter((id) => !id.includes(':')))
  for (const m of bases) {
    // OpenRouter's own routers ("openrouter/auto") pick a model per request: not a model anyone else serves.
    if (m.id.startsWith('openrouter/')) continue
    // ":free" / ":batch" are OpenRouter pricing variants; its permaslug has no
    // suffix. When only the variant is listed, the model id is the plain id, and
    // the variant id resolves to it.
    const plain = m.id.includes(':') ? m.id.slice(0, m.id.indexOf(':')) : m.id
    const id = plain !== m.id && !plainIds.has(plain) ? plain : m.id
    const e: CatalogEntry = { permaslug: m.canonical_slug }
    if (m.name) e.name = id === m.id ? m.name : m.name.replace(/\s*\((free|batch|[a-z]+)\)$/i, '')
    if (m.hugging_face_id) e.hf = m.hugging_face_id
    if (m.architecture?.input_modalities?.length) e.input = [...m.architecture.input_modalities].sort()
    if (m.architecture?.output_modalities?.length) e.output = [...m.architecture.output_modalities].sort()
    const formerly = new Set(previous[id]?.formerly ?? [])
    if (id !== m.id) formerly.add(m.id)
    const old = prevBySlug.get(m.canonical_slug)
    if (old && old !== id) for (const f of [old, ...(previous[old]?.formerly ?? [])]) formerly.add(f)
    formerly.delete(id)
    if (formerly.size) e.formerly = [...formerly].sort()
    out[id] = e
  }
  for (const m of models) if (m.id.startsWith('~')) out[m.id] = { ...(m.name ? { name: m.name } : {}), floating: true }
  // Models OpenRouter stopped listing stay, marked delisted (unless they were renamed).
  const renamed = new Set(Object.values(out).flatMap((e) => e.formerly ?? []))
  for (const [id, e] of Object.entries(previous))
    if (!(id in out) && !renamed.has(id) && !id.startsWith('openrouter/')) out[id] = { ...e, delisted: e.delisted ?? today }
  return out
}

/**
 * Other names upstream data uses for a vendor OpenRouter spells differently
 * (models.dev's "mistral/…" is OpenRouter's "mistralai/…"), and provider ids
 * that are not vendors. Keys are lowercase alphanumerics.
 */
const VENDOR_NAMES: Record<string, string> = {
  mistral: 'mistralai',
  zhipuai: 'z-ai',
  zhipu: 'z-ai',
  zai: 'z-ai',
  xai: 'x-ai',
  moonshot: 'moonshotai',
  kuaishou: 'kwaivgi',
  klingai: 'kwaivgi',
  alibabacn: 'alibaba',
  tencentcodingplan: 'tencent',
  bailing: 'inclusionai',
  nova: 'amazon',
}

// ---------------------------------------------------------------- registry

export interface Declared {
  name?: string
  /** Other spellings of this id. */
  aliases: string[]
  /** The Surplus Intelligence catalog's ids that are this model, other than the short name (backcompat only). */
  surplusLegacy: string[]
}

/**
 * Every known model id and every other name it goes by.
 * `resolve` answers "which model id is this name?" without guessing:
 * exact ids, permaslugs, former ids and declared aliases first, then the
 * vendor-less short name when exactly one model has it.
 */
export class Registry {
  readonly catalog: Catalog
  readonly declared: Map<string, Declared>
  readonly extra: string[]
  private exact = new Map<string, string>()
  private short = new Map<string, string | null>()
  private floatingShort = new Map<string, string | null>()

  /** `extra`: model ids only seen in rows (e.g. from models.dev), so their short names resolve too. */
  constructor(catalog: Catalog, declared = new Map<string, Declared>(), problems?: string[], extra: Iterable<string> = []) {
    this.catalog = catalog
    this.declared = declared
    const put = (name: string, id: string, what: string) => {
      const k = name.trim().toLowerCase()
      const prev = this.exact.get(k)
      if (prev && prev !== id) problems?.push(`model-aliases.toml: "${name}" (${what}) already names "${prev}", cannot also name "${id}"`)
      else this.exact.set(k, id)
    }
    // Declared names win over everything, so model-aliases.toml can merge two OpenRouter ids.
    for (const [id, d] of declared) {
      for (const a of d.aliases) put(a, id, `alias of ${id}`)
      for (const a of d.surplusLegacy) put(a, id, `legacy Surplus id of ${id}`)
    }
    this.extra = [...extra].filter((id) => !(id in catalog) && !declared.has(id))
    const all = [...Object.keys(catalog), ...declared.keys(), ...this.extra]
    for (const id of all) if (!this.exact.has(id.toLowerCase())) this.exact.set(id.toLowerCase(), id)
    for (const [id, e] of Object.entries(catalog))
      for (const n of [e.permaslug, ...(e.formerly ?? [])]) if (n && !this.exact.has(n.toLowerCase())) this.exact.set(n.toLowerCase(), this.exact.get(id.toLowerCase())!)
    for (const id of all) {
      if (id.startsWith('~')) {
        const s = shortKey(id)
        const prev = this.floatingShort.get(s)
        this.floatingShort.set(s, prev === undefined || prev === id ? id : null)
        continue
      }
      const target = this.exact.get(id.toLowerCase())!
      const s = shortKey(id)
      const prev = this.short.get(s)
      this.short.set(s, prev === undefined || prev === target ? target : null)
    }
  }

  static load(catalog: Catalog, problems?: string[], extra?: Iterable<string>): Registry {
    const declared = new Map<string, Declared>()
    if (fs.existsSync(ALIASES_TOML)) {
      const doc = parse(fs.readFileSync(ALIASES_TOML, 'utf8')) as Record<string, unknown>
      const list = (id: string, v: unknown, field: string) => {
        if (v === undefined) return []
        if (Array.isArray(v) && v.every((a) => typeof a === 'string' && a.trim())) return v as string[]
        problems?.push(`model-aliases.toml: [${JSON.stringify(id)}] ${field} must be a list of strings`)
        return []
      }
      for (const [id, v] of Object.entries(doc)) {
        const d = v as { name?: unknown; aliases?: unknown; surplus_legacy?: unknown }
        if (!MODEL_RE.test(id)) problems?.push(`model-aliases.toml: [${JSON.stringify(id)}] is not a well-formed model id ("vendor/slug")`)
        else if (typeof d !== 'object' || d === null || Object.keys(d).some((k) => !['name', 'aliases', 'surplus_legacy'].includes(k))) problems?.push(`model-aliases.toml: [${JSON.stringify(id)}] may only have "name", "aliases" and "surplus_legacy"`)
        else if (d.name !== undefined && typeof d.name !== 'string') problems?.push(`model-aliases.toml: [${JSON.stringify(id)}] name must be a string`)
        else declared.set(id, { ...(typeof d.name === 'string' ? { name: d.name } : {}), aliases: list(id, d.aliases, 'aliases'), surplusLegacy: list(id, d.surplus_legacy, 'surplus_legacy') })
      }
    }
    return new Registry(catalog, declared, problems, extra)
  }

  /** Exact names only: model ids, permaslugs, former ids, declared aliases and legacy ids. */
  explicit(name: string): string | undefined {
    return this.exact.get(name.trim().toLowerCase())
  }

  /** Exact names, then the unique vendor-less short name (also of `name` itself). */
  resolve(name: string): string | undefined {
    return this.explicit(name) ?? this.short.get(name.trim().toLowerCase()) ?? this.short.get(shortName(name)) ?? undefined
  }

  /** Model id for an OpenRouter id (itself, unless model-aliases.toml merges it into another). */
  ofOpenRouter(id: string): string {
    return this.explicit(id) ?? id
  }

  /**
   * Model id for a slug from another source: a known one if it resolves,
   * else the slug itself, with its vendor spelled the way OpenRouter spells it
   * when they differ only in punctuation ("xai/…" -> "x-ai/…").
   */
  ofSlug(slug: string): string | undefined {
    const hit = this.resolve(slug)
    if (hit) return hit
    const i = slug.indexOf('/')
    if (i > 0) {
      const vendor = this.vendorSpelling().get(slug.slice(0, i).toLowerCase().replace(/[^a-z0-9]/g, ''))
      if (vendor) slug = `${vendor}/${slug.slice(i + 1)}`
    }
    return this.resolve(slug) ?? (MODEL_RE.test(slug) ? slug : undefined)
  }

  private vendors?: Map<string, string>
  /** alnum(vendor) -> OpenRouter's spelling of it. */
  vendorSpelling(): Map<string, string> {
    if (!this.vendors) {
      this.vendors = new Map()
      for (const id of Object.keys(this.catalog)) {
        const v = id.replace(/^~/, '').split('/')[0]!
        this.vendors.set(v.toLowerCase().replace(/[^a-z0-9]/g, ''), v)
      }
      for (const [other, v] of Object.entries(VENDOR_NAMES)) if (!this.vendors.has(other)) this.vendors.set(other, v)
    }
    return this.vendors
  }

  /**
   * The short name a model is listed under when you drop the vendor
   * ("moonshotai/kimi-k3" -> "kimi-k3"), or undefined if another model shares it.
   */
  shortOf(id: string): string | undefined {
    const s = shortKey(id)
    if (id.startsWith('~')) return this.floatingShort.get(s) === id ? s : undefined
    return this.short.get(s) === this.explicit(id) ? s : undefined
  }

  /** Short names more than one model has: those models publish no `short`. */
  shortCollisions(): string[] {
    return [...this.short, ...this.floatingShort].filter(([, v]) => v === null).map(([k]) => k).sort()
  }

  /** The floating ("~") model whose short name is exactly the id's last segment ("jev-latest"), if exactly one. */
  floatingNamed(nativeId: string): string | undefined {
    const n = nativeId.trim().toLowerCase()
    return this.floatingShort.get(n.slice(n.lastIndexOf('/') + 1)) ?? undefined
  }

  /** The floating ("~") model a moving native id like ".../kimi-latest" stands for, if exactly one matches. */
  floatingFor(nativeId: string): string | undefined {
    const n = nativeId.trim().toLowerCase()
    const last = n.slice(n.lastIndexOf('/') + 1)
    // "kimi-latest" is "~moonshotai/kimi-latest"; a bare moving alias such as
    // DeepSeek's "deepseek-flash" is OpenRouter's "~deepseek/deepseek-flash-latest".
    return this.floatingShort.get(last) ?? this.floatingShort.get(shortName(n)) ?? (last.endsWith('-latest') ? undefined : this.floatingShort.get(`${last}-latest`)) ?? undefined
  }

  ids(): string[] {
    return [...new Set([...Object.keys(this.catalog), ...this.declared.keys(), ...this.extra])]
  }

  /** model id -> other names that resolve to it, for models.json. */
  aliasesOf(): Map<string, string[]> {
    const out = new Map<string, Set<string>>()
    const add = (id: string, n: string) => {
      if (n.toLowerCase() === id.toLowerCase()) return
      if (!out.has(id)) out.set(id, new Set())
      out.get(id)!.add(n)
    }
    for (const [id, d] of this.declared) for (const a of [...d.aliases, ...d.surplusLegacy]) add(id, a)
    for (const [id, e] of Object.entries(this.catalog)) for (const f of e.formerly ?? []) add(this.explicit(id)!, f)
    for (const [s, id] of this.short) if (id && !this.exact.has(s)) add(id, s)
    return new Map([...out].map(([k, v]) => [k, [...v].sort()]))
  }
}

// ---------------------------------------------------------------- matching native ids

const QUANT_SUFFIX = /[-_.](?:fp8|fp4|mxfp4|nvfp4|bf16|fp16|int4|int8|awq|gptq|w4a16|w8a8|tee)$/
const alnum = (s: string) => s.replace(/[^a-z0-9]/g, '')

/** Looser spellings of an id: last path segment / vendor-joined, punctuation removed, quant suffixes stripped. */
export function normalizedForms(id: string): string[] {
  const s = id.trim().toLowerCase().replace(/^~/, '')
  const last = s.slice(s.lastIndexOf('/') + 1)
  let bare = last
  while (QUANT_SUFFIX.test(bare)) bare = bare.replace(QUANT_SUFFIX, '')
  // Short digit-free words ("auto", "fusion") are too generic to match loosely.
  return [...new Set([alnum(last), alnum(s), alnum(bare)].filter((f) => (/\d/.test(f) ? f.length >= 3 : f.length >= 8)))]
}

/**
 * An id without the routing decorations routers add: a region ("…@eu",
 * "…@us-east-1"; a version pin like "@20250929" starts with a digit and stays),
 * a context window ("…[1m]"), Bedrock's API version ("…-v1:0", "…-1:0"),
 * Vertex's model-as-a-service suffix ("…-maas"), and the operation a media
 * host sells separately ("seedance-2-0-text-to-video-basic", "wan-2.7-t2v",
 * "mmaudio-v2-text-to-audio"), so it matches its model; the sync then maps a
 * non-default operation to that model's variant (withOperation). Not
 * "-to-image" (Wan's image model is not its video model) or "video-to-video"
 * (sometimes a separate editing model).
 */
export function undecorate(id: string): string {
  return id
    .trim()
    .replace(/\[\d+[km]\]$/i, '')
    .replace(/@[a-z][a-z0-9-]*$/i, '')
    .replace(/-v?\d+:\d+$/, '')
    .replace(/-maas$/i, '')
    .replace(/[-/](?:(?:text|image|reference|enhanced-reference)-to-video|t2v|i2v|r2v|text-to-audio)(?:-(?:basic|private))?$/i, '')
}

export type MatchVia = 'explicit' | 'exact' | 'normalized'

/**
 * Index of known names -> model id. A name that points at two different
 * model ids is ambiguous and never matches; we would rather leave a native id
 * unmapped than guess.
 */
export class Matcher {
  private exact = new Map<string, string | null>()
  private norm = new Map<string, string | null>()

  private static put(m: Map<string, string | null>, k: string, canonical: string) {
    const prev = m.get(k)
    if (prev === undefined) m.set(k, canonical)
    else if (prev !== canonical) m.set(k, null)
  }
  add(id: string | null | undefined, canonical: string) {
    if (!id) return
    Matcher.put(this.exact, id.trim().toLowerCase(), canonical)
    for (const f of normalizedForms(id)) Matcher.put(this.norm, f, canonical)
  }
  /** Exact spelling only, no normalized forms (for evidence that should not generalize). */
  addExact(id: string, canonical: string) {
    Matcher.put(this.exact, id.trim().toLowerCase(), canonical)
  }
  /** Exact (case-insensitive) lookup only. */
  exactOf(id: string): string | undefined {
    return this.exact.get(id.trim().toLowerCase()) ?? undefined
  }
  match(names: string[]): { model: string; via: MatchVia } | undefined {
    const candidates = [...new Set(names.flatMap((c) => [c, undecorate(c)]))]
    for (const c of candidates) {
      const m = this.exact.get(c.trim().toLowerCase())
      if (m) return { model: m, via: 'exact' }
    }
    for (const c of candidates)
      for (const f of normalizedForms(c)) {
        const m = this.norm.get(f)
        if (m) return { model: m, via: 'normalized' }
      }
    return undefined
  }
}

/** Matcher over every name in the registry: ids, short names, permaslugs, HF ids, aliases. */
export function registryMatcher(reg: Registry): Matcher {
  const m = new Matcher()
  for (const [id, e] of Object.entries(reg.catalog)) {
    if (id.startsWith('openrouter/') || e.floating) continue // OpenRouter's own routers; floating aliases
    const c = reg.ofOpenRouter(id)
    for (const n of [id, shortName(id), e.permaslug, e.hf, ...(e.formerly ?? [])]) m.add(n, c)
  }
  // A variant ("tencent/hy3:free") is matched only by its own names: its short name
  // without the variant is the model's. An operation's names find its model, and the
  // native id then says the operation (withOperation): "runway-gen4-5" is Venice's
  // image-to-video, but Poe's "runway-gen-4.5" is the model.
  for (const [id, d] of reg.declared) {
    const v = splitVariant(id)
    const target = v && (OPERATIONS as readonly string[]).includes(v[1]) ? variantRoot(id) : id
    for (const n of [...(v ? [] : [id, shortName(id)]), ...d.aliases, ...d.surplusLegacy]) m.add(n, target)
  }
  for (const id of reg.extra) if (!splitVariant(id)) for (const n of [id, shortName(id)]) m.add(n, id)
  return m
}

/** state/catalog.json: the catalog as of the last OpenRouter sync, delisted models included. */
export function readCatalogFile(): Catalog {
  const f = path.join(STATE_DIR, 'catalog.json')
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as Catalog) : {}
}

/**
 * OpenRouter's live catalog on top of the recorded one: a model OpenRouter
 * stops listing is still a model other hosts serve, so it stays known.
 */
/** Fetch the catalog and load model-aliases.toml: what every sync starts from. */
export async function loadRegistry(): Promise<{ reg: Registry; models: OrModel[] }> {
  const recorded = readCatalogFile()
  try {
    const models = await fetchOrModels()
    return { reg: Registry.load(toCatalog(models, recorded)), models }
  } catch (e) {
    // OpenRouter down or changed shape: the other syncs carry on with the last snapshot.
    if (!Object.keys(recorded).length) throw e
    console.warn(`OpenRouter catalog unavailable (${(e as Error).message}); using state/catalog.json`)
    return { reg: Registry.load(recorded), models: [] }
  }
}

// ---------------------------------------------------------------- tiers

/**
 * Words that mark a service tier or variant rather than a different checkpoint.
 * Heuristic matches never map an id carrying one of these onto a model id
 * that lacks it: "kimi-k3-fast" is not silently "kimi-k3". People can still map
 * it in manual.toml. "distill" is here too: "deepseek-r1-distill-qwen-32b" is a
 * different model from "deepseek-r1", and so are fine-tunes ("-abliterated",
 * "-uncensored", "-heretic"): models.dev links some of them to their base model.
 * "web" (a host's web-search variant, "glm-4.7:web") is a different product, and
 * so are "lightning" (MiniMax's highspeed tier), "flashx" (Z.ai's faster Flash),
 * "ultra" and "spot" (serving tiers) and "contributor" (Meta's Muse Spark
 * builds, which OpenRouter lists separately).
 * "free" is not one: like OpenRouter's ":free", it is a pricing variant of the
 * same model.
 */
const TIER_WORDS = new Set(['fast', 'faster', 'highspeed', 'ultrafast', 'ultraspeed', 'speed', 'flex', 'turbo', 'priority', 'batch', 'e2ee', 'lite', 'mini', 'nano', 'pro', 'max', 'distill', 'distilled', 'lightning', 'flashx', 'ultra', 'spot', 'contributor', 'abliterated', 'uncensored', 'heretic', 'web'])
const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))

export function tierMismatch(nativeId: string, canonical: string): string | undefined {
  const c = words(shortName(canonical))
  for (const w of words(nativeId.slice(nativeId.lastIndexOf('/') + 1))) if (TIER_WORDS.has(w) && !c.has(w)) return w
  return undefined
}

// ---------------------------------------------------------------- pin

/**
 * Settle a row's pin against its model id. Floating rows only ever sit under
 * floating ("~") model ids, so a consumer that imports only pinned ids never
 * routes to a moving alias:
 *   - a "~" model id is always floating;
 *   - a moving native id maps to the matching "~" model if there is one,
 *     and otherwise is not mapped at all (undefined).
 */
export function settlePin(reg: Registry, nativeId: string, model: string, pin: 'pinned' | 'floating'): { model: string; pin: 'pinned' | 'floating' } | undefined {
  if (model.startsWith('~')) return { model, pin: 'floating' }
  if (pin === 'pinned') return { model, pin }
  const f = reg.floatingFor(nativeId)
  return f ? { model: f, pin: 'floating' } : undefined
}
