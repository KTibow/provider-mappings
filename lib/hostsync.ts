import { cleanQuant, guessPin, type Pin } from './rows.ts'

/** One entry from a host's GET /models. */
export type Listed = Record<string, unknown> & { id?: unknown }

export interface HostDef {
  /** Host key, e.g. "api.deepinfra.com". */
  host: string
  /** Public, keyless model list, usually `<base>/models`. */
  models: string
  /** Entries from the response. Default: `response.data`. */
  list?: (response: unknown) => Listed[]
  /** Skip entries that are not callable models (e.g. routers). Default: keep all. */
  include?: (m: Listed) => boolean
  /** Extra strings to match on besides the native id (HF ids, OpenRouter slugs, ...). */
  hints?: (m: Listed) => (string | null | undefined)[]
  /**
   * The entry's display name, when it says more than the id: its tier and
   * fine-tune words ("Qwen 3.6 Plus Uncensored") count like the id's, so a
   * heuristic match never files it under a model without them.
   */
  name?: (m: Listed) => string | undefined
  /**
   * The operation the entry is, when the list says so and the id doesn't
   * ("seedance-2.0" is "Seedance 2.0 I2V"): a variant name like "image-to-video"
   * (see operationOf in lib/models.ts), or undefined for the model's default.
   */
  operation?: (m: Listed) => string | undefined
  pin?: (m: Listed) => Pin
  /** Report ids we cannot map in unmapped.json (default: true unless the list has more than BIG_LIST entries). */
  reportUnmapped?: boolean
  quant?: (m: Listed) => string | undefined
  /**
   * This host resells another host's catalog under the same ids: an id the
   * upstream also has maps to the upstream's row (manual, openrouter, sync or
   * modelsdev, by precedence). Other ids are matched as usual.
   */
  mirrors?: string
}

/** sync/host-config.ts entry: an explicit list URL and/or quirks. */
export type HostConfig = Partial<Omit<HostDef, 'host'>>

/** Lists longer than this are mostly arbitrary checkpoints: their unmapped ids are not reported. */
export const BIG_LIST = 2000

export const defaults = {
  list(response: unknown): Listed[] {
    const data = (response as { data?: unknown })?.data
    if (!Array.isArray(data)) throw new Error(`expected { data: [...] }, got ${JSON.stringify(response).slice(0, 200)}`)
    return data as Listed[]
  },
  pin: (m: Listed): Pin => guessPin(String(m.id)),
  quant: (m: Listed) => cleanQuant(m.quantization),
}
