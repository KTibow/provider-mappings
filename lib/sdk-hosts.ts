/**
 * Providers whose upstream data gives no usable HTTP base URL, and what to do
 * about each. models.dev lists providers with `api: null` when their AI SDK
 * package hard-codes the base URL; OpenRouter reports "not_used" for providers
 * it calls through an SDK. Better fixed upstream by giving them an explicit URL.
 *
 * A provider with no URL that is in neither table is logged by the syncs as
 * unexplained, so new ones get looked at.
 */

/** The base URL (or host family) a seller would use. */
export const SDK_DEFAULT_BASE: Record<string, string> = {
  aihubmix: 'https://aihubmix.com/v1',
  // Azure OpenAI / Foundry: one host per customer resource.
  azure: 'https://{resource}.openai.azure.com/openai/v1',
  'azure-cognitive-services': 'https://{resource}.cognitiveservices.azure.com/openai/v1',
  // Account and gateway ids are in the path.
  'cloudflare-ai-gateway': 'https://gateway.ai.cloudflare.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  cohere: 'https://api.cohere.com/v2',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  // Vertex: the global endpoint; project and region are in the path, not the host.
  'google-vertex': 'https://aiplatform.googleapis.com/v1',
  'google-vertex-anthropic': 'https://aiplatform.googleapis.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  openai: 'https://api.openai.com/v1',
  perplexity: 'https://api.perplexity.ai',
  togetherai: 'https://api.together.xyz/v1',
  venice: 'https://api.venice.ai/api/v1',
  vercel: 'https://ai-gateway.vercel.sh/v1',
  // watsonx.ai: one host per region (us-south, eu-de, ...).
  watsonx: 'https://{region}.ml.cloud.ibm.com/ml/v1',
  xai: 'https://api.x.ai/v1',
  // OpenRouter provider slugs.
  'amazon-bedrock': 'https://bedrock-runtime.{region}.amazonaws.com',
}

/** Providers deliberately not mapped, and why. */
export const NO_HOST: Record<string, string> = {
  gitlab: 'GitLab Duo models are only callable inside GitLab',
  qvac: 'runs models locally',
  'salad-cloud': 'SaladCloud AI Gateway has no documented shared hostname',
  'sap-ai-core': 'SAP AI Core selects the model by deployment id in the URL path',
  neon: 'the gateway URL is per account (${NEON_AI_GATEWAY_BASE_URL})',
  lmstudio: 'local server',
  'atomic-chat': 'local server',
  lynkr: 'local server',
  'privatemode-ai': 'local proxy',
}

/**
 * Variables that stand for a whole hostname (or one label of it), with the
 * provider's documented default. One-label variables such as ${AWS_REGION}
 * need no entry: they become host families like "bedrock-mantle.{region}.api.aws".
 */
export function fillHostVariables(url: string): string {
  return url
    .replace('${GOOGLE_VERTEX_ENDPOINT}', 'aiplatform.googleapis.com') // Vertex global endpoint
    .replace(/\$\{GOOGLE_VERTEX_LOCATION\}-aiplatform\.googleapis\.com/, 'aiplatform.googleapis.com')
    .replace('${DATABRICKS_HOST}', '{workspace}.cloud.databricks.com') // AWS workspaces
}
