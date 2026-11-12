import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matcher, Registry, operationOf, settlePin, shortName, splitVariant, tierMismatch, toCatalog, undecorate, variantRoot, withOperation } from '../lib/models.ts'
import { parseBaseUrl } from '../lib/host.ts'
import { formatRows, guessPin, readRowsText, type RowsFile } from '../lib/rows.ts'
import { formatServed, merge, readServedText, undatedAlias, type HostFiles } from '../lib/store.ts'
import { mapEntries } from '../sync/hosts.ts'

test('short names and the registry', () => {
  assert.equal(shortName('moonshotai/Kimi-K3'), 'kimi-k3')
  assert.equal(shortName('baidu/ernie-5.5-flash-preview:free'), 'ernie-5.5-flash-preview')
  const reg = new Registry(
    {
      'moonshotai/kimi-k3': { permaslug: 'moonshotai/kimi-k3-20260715' },
      'openai/gpt-oss-120b': { permaslug: 'openai/gpt-oss-120b' },
      'voyageai/rerank-3': { permaslug: 'voyageai/rerank-3-20260930', formerly: ['mongodb/rerank-3'] },
      'a/dup': {}, 'b/dup': {},
      '~typesafe/jev-latest': { floating: true },
    },
    new Map([['openai/gpt-oss-120b', { aliases: [], surplusLegacy: ['openai-gpt-oss-120b'] }]]),
  )
  assert.equal(reg.resolve('kimi-k3'), 'moonshotai/kimi-k3')
  assert.equal(reg.resolve('MoonshotAI/Kimi-K3'), 'moonshotai/kimi-k3')
  assert.equal(reg.resolve('moonshotai/kimi-k3-20260715'), 'moonshotai/kimi-k3')
  assert.equal(reg.resolve('openai-gpt-oss-120b'), 'openai/gpt-oss-120b')
  assert.equal(reg.resolve('alibaba/kimi-k3'), 'moonshotai/kimi-k3') // models.dev vendor spelling
  assert.equal(reg.resolve('mongodb/rerank-3'), 'voyageai/rerank-3')
  assert.equal(reg.resolve('dup'), undefined) // ambiguous short name
  assert.equal(reg.ofSlug('aleph-alpha/kolibri-1'), 'aleph-alpha/kolibri-1')
  assert.deepEqual(reg.aliasesOf().get('openai/gpt-oss-120b'), ['gpt-oss-120b', 'openai-gpt-oss-120b'])
  assert.equal(reg.shortOf('moonshotai/kimi-k3'), 'kimi-k3')
  assert.equal(reg.shortOf('a/dup'), undefined)
  assert.deepEqual(reg.shortCollisions(), ['dup'])
  assert.equal(reg.floatingFor('accounts/fireworks/routers/jev-latest'), '~typesafe/jev-latest')
  assert.deepEqual(settlePin(reg, 'jev-latest', 'typesafe/jev-1.14', 'floating'), { model: '~typesafe/jev-latest', pin: 'floating' })
  assert.equal(settlePin(reg, 'syn:large:text', 'moonshotai/kimi-k3', 'floating'), undefined)
  assert.equal(reg.floatingFor('jev'), '~typesafe/jev-latest') // bare moving alias -> "~…-latest"
  assert.deepEqual(settlePin(reg, 'kimi-k3', 'moonshotai/kimi-k3', 'pinned'), { model: 'moonshotai/kimi-k3', pin: 'pinned' })
})

test('host keys', () => {
  const ok = (u: string) => { const p = parseBaseUrl(u); return p.kind === 'ok' ? [p.host, p.family] : p.kind }
  assert.deepEqual(ok('https://api.together.xyz/v1'), ['api.together.xyz', false])
  assert.deepEqual(ok('https://WWW.Example.COM:8443/v1/'), ['www.example.com', false])
  assert.deepEqual(ok('https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1'), ['api.cloudflare.com', false])
  assert.equal(ok('not_used'), 'none')
  assert.deepEqual(ok('https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api'), ['{account}.snowflakecomputing.com', true])
  assert.deepEqual(ok('https://bedrock-mantle.${AWS_REGION}.api.aws/v1'), ['bedrock-mantle.{region}.api.aws', true])
  assert.equal(ok('https://${DATABRICKS_HOST}/ai-gateway/v1'), 'none')
  assert.equal(ok('http://127.0.0.1:1234/v1'), 'none')
})

test('matcher: exact, normalized, ambiguity', () => {
  const m = new Matcher()
  m.add('z-ai/glm-5.3', 'glm-5.3')
  m.add('moonshotai/Kimi-K3', 'kimi-k3')
  assert.deepEqual(m.match(['z-ai-glm-5-3']), { model: 'glm-5.3', via: 'normalized' })
  assert.deepEqual(m.match(['moonshotai/kimi-k3']), { model: 'kimi-k3', via: 'exact' })
  assert.equal(m.match(['moonshotai/Kimi-K3-TEE'])?.model, 'kimi-k3')
  m.add('other/glm-5.3', 'something-else')
  assert.equal(m.match(['glm-5-3']), undefined) // ambiguous now
  assert.equal(m.match(['auto']), undefined)
})

test('tier words block heuristic folding', () => {
  assert.equal(tierMismatch('kimi-k3-fast', 'kimi-k3'), 'fast')
  assert.equal(tierMismatch('e2ee-gpt-oss-120b-p', 'openai-gpt-oss-120b'), 'e2ee')
  assert.equal(tierMismatch('glm-5v-turbo', 'glm-5v-turbo'), undefined)
})

test('pin guess', () => {
  assert.equal(guessPin('jev-latest'), 'floating')
  assert.equal(guessPin('mistral-large-latest'), 'floating')
  assert.equal(guessPin('jev-1.14.0'), 'pinned')
})

test('rows file round-trips, review rows included', () => {
  const f: RowsFile = {
    rows: new Map([['moonshotai/Kimi-K3', { model: 'moonshotai/kimi-k3', pin: 'pinned', quant: 'fp8' }], ['a"b', { model: '~typesafe/jev-latest', pin: 'floating' }]]),
    review: new Map([['moonshotai/kimi-k3:openrouter', { model: 'moonshotai/kimi-k3', pin: 'pinned', reason: 'model id is OpenRouter-only (decart)' }]]),
  }
  const text = formatRows(['header'], f)
  const back = readRowsText(text)
  assert.deepEqual(back.rows, f.rows)
  assert.deepEqual(back.review, f.review)
  assert.equal(formatRows(['header'], back), text)
})

test('catalog: routers excluded, renames remembered, modalities kept', () => {
  const v1 = toCatalog([
    { id: 'openrouter/auto', canonical_slug: 'openrouter/auto' },
    { id: 'mongodb/rerank-3', canonical_slug: 'voyageai/rerank-3-20260930', architecture: { input_modalities: ['text'], output_modalities: ['rerank'] } },
    { id: '~typesafe/jev-latest', canonical_slug: '~typesafe/jev-latest' },
  ])
  assert.equal(v1['openrouter/auto'], undefined)
  assert.deepEqual(v1['mongodb/rerank-3']?.output, ['rerank'])
  assert.equal(v1['~typesafe/jev-latest']?.floating, true)
  const v2 = toCatalog([{ id: 'voyageai/rerank-3', canonical_slug: 'voyageai/rerank-3-20260930' }], v1)
  assert.deepEqual(v2['voyageai/rerank-3']?.formerly, ['mongodb/rerank-3'])
  const reg = new Registry(v2)
  assert.equal(reg.resolve('auto'), undefined)
  assert.equal(reg.explicit('mongodb/rerank-3'), 'voyageai/rerank-3')
})

test('pin must agree with the model id', () => {
  const p: string[] = []
  readRowsText('["kimi-latest"]\nmodel = "moonshotai/kimi-k3"\npin = "floating"\n\n["x"]\nmodel = "~moonshotai/kimi-latest"\npin = "pinned"\n\n["y"]\nmodel = "~moonshotai/kimi-latest"\n', p, { requirePin: false })
  assert.equal(p.length, 2)
  assert.equal(readRowsText('["y"]\nmodel = "~moonshotai/kimi-latest"\n', [], { requirePin: false }).rows.get('y')?.pin, 'floating')
})

test('served.txt round-trips and maps like a /models list', () => {
  const text = formatServed(['Native ids h serves.'], ['kimi-k3', 'chroma', 'kimi-k3'])
  assert.equal(text, '# Native ids h serves.\nchroma\nkimi-k3\n')
  assert.deepEqual(readServedText(text), ['chroma', 'kimi-k3'])
  const reg = new Registry({ 'moonshotai/kimi-k3': {} }, new Map())
  const matcher = new Matcher()
  matcher.add('moonshotai/kimi-k3', 'moonshotai/kimi-k3')
  const out = mapEntries({ reg, matcher }, undefined, readServedText(text).map((id) => ({ id })))
  assert.deepEqual(out.rows.get('kimi-k3'), { model: 'moonshotai/kimi-k3', pin: 'pinned' })
  assert.deepEqual(out.unmapped, ['chroma'])
})

test('a floating row takes its current checkpoint from lower sources, without a conflict', () => {
  const rows = (o: Record<string, [string, 'pinned' | 'floating']>): RowsFile => ({ rows: new Map(Object.entries(o).map(([k, [model, pin]]) => [k, { model, pin }])), review: new Map() })
  const files: HostFiles = new Map([['api.deepseek.com', new Map([
    ['manual', rows({ 'deepseek-flash': ['~deepseek/deepseek-flash-latest', 'floating'] })],
    ['openrouter', rows({ 'deepseek-flash': ['deepseek/deepseek-v4.1-flash-1017', 'pinned'] })],
    ['modelsdev', rows({ 'deepseek-flash': ['deepseek/deepseek-v4.1-flash', 'pinned'] })],
  ])]])
  const { rows: merged, conflicts } = merge(files)
  const r = merged.get('api.deepseek.com')!.get('deepseek-flash')!
  assert.equal(r.model, '~deepseek/deepseek-flash-latest')
  assert.equal(r.current, 'deepseek/deepseek-v4.1-flash-1017') // highest lower source
  assert.equal(conflicts.length, 1) // models.dev still disagrees with OpenRouter about which checkpoint
  assert.deepEqual(conflicts[0]!.others, [{ source: 'modelsdev', model: 'deepseek/deepseek-v4.1-flash' }])
})

test('catalog: a variant-only OpenRouter id becomes its plain id', () => {
  const m = (id: string, slug: string, name: string) => ({ id, canonical_slug: slug, name }) as Parameters<typeof toCatalog>[0][number]
  const c = toCatalog([m('nvidia/rerank-vl:free', 'nvidia/rerank-vl', 'NVIDIA: Rerank VL (free)'), m('a/x', 'a/x-1', 'X'), m('a/x:free', 'a/x-1', 'X (free)')])
  assert.deepEqual(c['nvidia/rerank-vl'], { permaslug: 'nvidia/rerank-vl', name: 'NVIDIA: Rerank VL', formerly: ['nvidia/rerank-vl:free'] })
  assert.equal(c['nvidia/rerank-vl:free'], undefined)
  assert.ok(c['a/x'] && !c['a/x:free']) // plain id listed: variant dropped as before
})

test('routing decorations are not part of the model', () => {
  assert.equal(undecorate('amazon/anthropic.claude-opus-4-7@eu'), 'amazon/anthropic.claude-opus-4-7')
  assert.equal(undecorate('azure/gpt-5.1@swedencentral'), 'azure/gpt-5.1')
  assert.equal(undecorate('claude-opus-4.7[1m]'), 'claude-opus-4.7')
  assert.equal(undecorate('anthropic.claude-haiku-4-5-20251001-v1:0'), 'anthropic.claude-haiku-4-5-20251001')
  assert.equal(undecorate('claude-sonnet-4-5@20250929'), 'claude-sonnet-4-5@20250929') // a version pin stays
  const m = new Matcher()
  m.add('anthropic/claude-opus-4.7', 'anthropic/claude-opus-4.7')
  assert.equal(m.match(['amazon/anthropic.claude-opus-4-7@eu'])?.model, 'anthropic/claude-opus-4.7')
  // The operation a media host sells separately is not part of the model either.
  assert.equal(undecorate('seedance-2-0-text-to-video-basic'), 'seedance-2-0')
  assert.equal(undecorate('wan-2.7-t2v'), 'wan-2.7')
  assert.equal(undecorate('grok-imagine-1-5-image-to-video-private'), 'grok-imagine-1-5')
  assert.equal(undecorate('wan-2-7-text-to-image'), 'wan-2-7-text-to-image') // Wan's image model is another model
})

test('fine-tunes and host variants are not their base model', () => {
  assert.equal(tierMismatch('deepseek-v4.1-flash-1017-abliterated', 'deepseek/deepseek-v4.1-flash-1017'), 'abliterated')
  assert.equal(tierMismatch('glm-4.7:web', 'z-ai/glm-4.7'), 'web')
  assert.equal(tierMismatch('minimax/minimax-m2.1-lightning', 'minimax/minimax-m2.1'), 'lightning')
  assert.equal(tierMismatch('nvidia/nemotron-3.5-lightning', 'nvidia/nemotron-3.5-lightning'), undefined)
})

test('an undated name one host resolves to a checkpoint is not evidence for others', () => {
  assert.equal(undatedAlias('deepseek-r1', 'deepseek/deepseek-r1-0528'), true)
  assert.equal(undatedAlias('deepseek-ai/DeepSeek-R1-0528', 'deepseek/deepseek-r1-0528'), false)
  assert.equal(undatedAlias('deepseek41-flash-20261017', 'deepseek/deepseek-v4.1-flash-1017'), false)
  assert.equal(undatedAlias('parasail-glm-53', 'z-ai/glm-5.3'), false)
})

test('host sync: mirrors, router prefixes, floating names, display-name tiers', () => {
  const reg = new Registry({ 'sakana/fugu-max': {}, 'qwen/qwen3.6-plus': {}, '~typesafe/jev-latest': { floating: true } }, new Map())
  const matcher = new Matcher()
  for (const id of ['sakana/fugu-max', 'qwen/qwen3.6-plus']) matcher.add(id, id)
  const ctx = { reg, matcher }
  // A declared mirror takes the upstream's row, even where matching alone would differ.
  const upstream = new Map([['qwen-3-6-plus', { model: 'venice/qwen3.6-plus-uncensored', pin: 'pinned' as const }]])
  assert.equal(mapEntries(ctx, undefined, [{ id: 'qwen-3-6-plus' }], undefined, undefined, upstream).rows.get('qwen-3-6-plus')?.model, 'venice/qwen3.6-plus-uncensored')
  // Without it, the display name's "Uncensored" keeps the heuristic match off the base model.
  const def = { name: (m: Record<string, unknown>) => m.name as string }
  assert.deepEqual(mapEntries(ctx, def, [{ id: 'qwen-3-6-plus', name: 'Qwen 3.6 Plus Uncensored' }]).unmapped, ['qwen-3-6-plus'])
  assert.equal(mapEntries(ctx, undefined, [{ id: 'qwen-3-6-plus' }]).rows.get('qwen-3-6-plus')?.model, 'qwen/qwen3.6-plus')
  const out = mapEntries(ctx, undefined, [{ id: 'vercel-ai-gateway/sakana/fugu-max' }, { id: 'jev-latest' }])
  assert.equal(out.rows.get('vercel-ai-gateway/sakana/fugu-max')?.model, 'sakana/fugu-max')
  assert.deepEqual(out.rows.get('jev-latest'), { model: '~typesafe/jev-latest', pin: 'floating' })
})

test('web-search variants map as "model:web"; service tiers stay unmapped', () => {
  assert.deepEqual(splitVariant('glm-5.1:web'), ['glm-5.1', 'web'])
  assert.equal(splitVariant('anthropic/claude-haiku-5.5:batch'), undefined)
  assert.deepEqual(splitVariant('google/gemma-4-31b-it:free'), ['google/gemma-4-31b-it', 'free'])
  const reg = new Registry({ 'z-ai/glm-5.1': {}, 'z-ai/glm-5.1:web': {} }, new Map())
  assert.equal(reg.shortOf('z-ai/glm-5.1'), 'glm-5.1') // no collision with its variant
  assert.equal(reg.shortOf('z-ai/glm-5.1:web'), 'glm-5.1:web')
  const matcher = new Matcher()
  matcher.add('z-ai/glm-5.1', 'z-ai/glm-5.1')
  const out = mapEntries({ reg, matcher }, undefined, [{ id: 'glm-5.1:web' }, { id: 'glm-5.1:batch' }])
  assert.equal(out.rows.get('glm-5.1:web')?.model, 'z-ai/glm-5.1:web')
  assert.deepEqual(out.unmapped, ['glm-5.1:batch'])
})

test('media operations and reasoning modes are variants of their model', () => {
  // The id names the operation; text-to-video and generation are the model itself.
  assert.equal(operationOf('seedance-2-0-image-to-video-basic'), 'image-to-video')
  assert.equal(operationOf('minimax-h3-enhanced-reference-to-video'), 'enhanced-reference-to-video')
  assert.equal(operationOf('gpt-image-2/edit'), 'edit')
  assert.equal(operationOf('wan-2.7-i2v'), 'image-to-video')
  assert.equal(operationOf('seedance-2-0-text-to-video-basic'), undefined)
  assert.equal(operationOf('wan-2.7-t2v'), undefined)
  assert.equal(withOperation('nano-banana-pro-edit', 'google/gemini-3-pro-image-preview'), 'google/gemini-3-pro-image-preview:edit')
  assert.equal(withOperation('k3-edit', 'krea/k3-edit'), 'krea/k3-edit') // the model is the edit model
  assert.equal(withOperation('x-edit', 'a/x:edit'), 'a/x:edit')
  // Variants nest, and keep their own short names.
  assert.deepEqual(splitVariant('z-ai/glm-5.1:non-thinking:web'), ['z-ai/glm-5.1:non-thinking', 'web'])
  assert.equal(variantRoot('z-ai/glm-5.1:non-thinking:web'), 'z-ai/glm-5.1')
  const reg = new Registry({ 'z-ai/glm-5.1': {}, 'bytedance/seedance-2.0': {} }, new Map([['z-ai/glm-5.1:non-thinking', { aliases: [], surplusLegacy: ['glm-5.1-non-thinking'] }]]))
  assert.equal(reg.shortOf('z-ai/glm-5.1:non-thinking'), 'glm-5.1:non-thinking')
  const matcher = new Matcher()
  matcher.add('seedance-2.0', 'bytedance/seedance-2.0')
  matcher.add('glm-5.1', 'z-ai/glm-5.1')
  const listed = [
    { id: 'seedance-2.0-image-to-video' }, { id: 'seedance-2.0-t2v' },
    // The list says what a bare id is (uncensored.com: "Seedance 2.0 I2V").
    { id: 'seedance-2.0', op: 'image-to-video' },
    { id: 'glm-5.1-non-thinking' }, { id: 'glm-5.1-non-thinking:web' },
  ]
  const out = mapEntries({ reg, matcher }, { operation: (m) => m.op as string | undefined }, listed)
  assert.equal(out.rows.get('seedance-2.0-image-to-video')?.model, 'bytedance/seedance-2.0:image-to-video')
  assert.equal(out.rows.get('seedance-2.0-t2v')?.model, 'bytedance/seedance-2.0')
  assert.equal(out.rows.get('seedance-2.0')?.model, 'bytedance/seedance-2.0:image-to-video')
  assert.equal(out.rows.get('glm-5.1-non-thinking')?.model, 'z-ai/glm-5.1:non-thinking')
  assert.equal(out.rows.get('glm-5.1-non-thinking:web')?.model, 'z-ai/glm-5.1:non-thinking:web')
  // Unless model-aliases.toml names the id: a model that only does image-to-video.
  const reg2 = new Registry({ 'runway/gen-4-turbo': {} }, new Map([['runway/gen-4-turbo', { aliases: [], surplusLegacy: ['runway-gen4-turbo'] }]]))
  const one = mapEntries({ reg: reg2, matcher: new Matcher() }, { operation: (m) => m.op as string | undefined }, [{ id: 'runway-gen4-turbo', op: 'image-to-video' }])
  assert.equal(one.rows.get('runway-gen4-turbo')?.model, 'runway/gen-4-turbo')
})
