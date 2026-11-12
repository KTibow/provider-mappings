/**
 * Hosts sync/hosts.ts finds every hour by probing <base>/models for each base URL
 * models.dev and OpenRouter report (lib/discover.ts). This file is only for
 * what that can't work out by itself:
 *   - `models`: the list URL, when it isn't <base>/models for a reported base URL
 *     (or the host isn't in models.dev or OpenRouter at all);
 *   - `hints`, `include`, `pin`, `quant`, `list`: quirks of a host's list
 *     (see lib/hostsync.ts).
 */
import { defaults, type HostConfig, type Listed } from '../lib/hostsync.ts'
import { VARIANTS, operationOf } from '../lib/models.ts'

/**
 * Venice's list format (also uncensored.com's): an entry's operation from its
 * display name ("Grok Imagine Reference-to-Video", "Seedance 2.0 I2V"), else
 * from constraints.model_type ("image-to-video", "image-edit").
 */
function specOperation(m: Listed): string | undefined {
  const spec = m.model_spec as { name?: unknown; constraints?: { model_type?: unknown } } | undefined
  const byName = typeof spec?.name === 'string' ? operationOf(spec.name.trim().replace(/\s+/g, '-')) : undefined
  const type = spec?.constraints?.model_type === 'image-edit' ? 'edit' : spec?.constraints?.model_type
  return byName ?? (typeof type === 'string' && (VARIANTS as readonly string[]).includes(type) ? type : undefined)
}

const config: Record<string, HostConfig> = {
  // OpenRouter's own ids are the model ids; ":free" ids are their free tiers
  // (variants). ":batch" is a service tier, not a model, so it is left out.
  'openrouter.ai': {
    models: 'https://openrouter.ai/api/v1/models?output_modalities=all',
    include: (m) => !String(m.id).includes(':') || String(m.id).endsWith(':free'),
  },

  // Ids like "z-ai-glm-5-3"; model_spec.modelSource is a Hugging Face URL for
  // open-weight models. "e2ee-*" ids are separate end-to-end-encrypted offerings
  // of the same weights, so they do not inherit the checkpoint hint. The default
  // list is text models only; type=all adds image, video, audio and embeddings.
  'api.venice.ai': {
    models: 'https://api.venice.ai/api/v1/models?type=all',
    hints: (m) => {
      const src = (m.model_spec as { modelSource?: unknown } | undefined)?.modelSource
      if (String(m.id).startsWith('e2ee-') || typeof src !== 'string') return []
      return [src.replace(/^https?:\/\/huggingface\.co\//, '')]
    },
    // "qwen-3-6-plus" is "Qwen 3.6 Plus Uncensored".
    name: (m) => (m.model_spec as { name?: unknown } | undefined)?.name as string | undefined,
    operation: specOperation,
  },

  // "hf:<repo>" ids are fixed checkpoints; "syn:*" / "infinite:*" are aliases
  // Synthetic repoints over time. Entries carry the HF id and OpenRouter slug.
  'api.synthetic.new': {
    hints: (m) => [m.hugging_face_id as string, (m.openrouter as { slug?: string } | undefined)?.slug],
    pin: (m) => (String(m.id).startsWith('hf:') ? 'pinned' : 'floating'),
  },

  // Ids like "moonshotai/Kimi-K3-TEE"; `root` is the Hugging Face checkpoint.
  'llm.chutes.ai': { hints: (m) => [m.root as string] },

  // Resell Venice under Venice's ids ("e2ee-*" exist nowhere else). agent-zero's
  // /v1/models is Venice's list; mordiem's API list needs a key, but its site's
  // list is public and gives each entry's Venice id.
  'llm.agent-zero.ai': { mirrors: 'api.venice.ai' },
  'api.mordiem.com': {
    models: 'https://mordiem.com/api/models',
    list: (r) => defaults.list(r).map((m) => ({ ...m, id: m.veniceModelId })),
    mirrors: 'api.venice.ai',
  },

  // No keyless list (served.txt only). Ids like
  // "accounts/fireworks/models/llama-v3p3-70b-instruct": "3p3" is "3.3".
  'api.fireworks.ai': {
    hints: (m) => [String(m.id).replace(/^accounts\/[^/]+\/models\//, '').replace(/(\d)p(\d)/g, '$1.$2').replace(/^llama-v(\d)/, 'llama-$1')],
  },

  // Bedrock's OpenAI-compatible endpoint takes bedrock-runtime's model ids
  // (AWS's model cards list the same id for both).
  'bedrock-mantle.{region}.api.aws': { mirrors: 'bedrock-runtime.{region}.amazonaws.com' },

  // Lists that live somewhere other than <base>/models.
  'ai-gateway.kilo.ai': { models: 'https://ai-gateway.kilo.ai/api/v1/models' },
  'api.blazeapi.org': { models: 'https://api.blazeapi.org/paid/v1/models' },
  // Proxies Venice under Venice's ids ("llama-3.3-70b"), next to its own
  // display-name ids ("Claude Opus 4.7") and ":web" (web search) variants.
  'api.mor.org': { models: 'https://api.mor.org/api/v1/models', mirrors: 'api.venice.ai' },
  'api.orbio.so': { models: 'https://api.orbio.so/api/v1/models' },
  // Neither models.dev nor OpenRouter knows it (formerly jatevo.ai, see host-aliases.toml).
  'inference.oyenza.com': { models: 'https://inference.oyenza.com/v1/models' },
  // Ids like "gemma4"; display_name says which one ("Gemma 4 31B").
  'api.sarvam.ai': { models: 'https://api.sarvam.ai/v2/models', hints: (m) => [m.display_name as string] },
  // type=all adds image and video models to the default text list.
  // Venice's list format; a bare video id is image-to-video ("seedance-2.0" is
  // "Seedance 2.0 I2V"; "seedance-2.0-t2v" is text-to-video).
  'api.uncensored.com': { models: 'https://api.uncensored.com/api/v1/models?type=all', operation: specOperation },
  'api.usedot.xyz': { models: 'https://api.usedot.xyz/agent/v1/models' },
}

export default config
