# provider-mappings

Which API host serves which model, and under which native model id.

`api.together.xyz` calls Kimi K3 `moonshotai/Kimi-K3`; `api.moonshot.ai` calls it
`kimi-k3`; `api.fireworks.ai` calls it `accounts/fireworks/models/kimi-k3`. This
repository records that as plain TOML, keeps it current with hourly syncs, and
publishes merged JSON.

## Use it

```
https://<owner>.github.io/provider-mappings/model-hosts.json
https://<owner>.github.io/provider-mappings/models.json
```

The site has two searchable views:
- **Models**: who serves each model, and the exact id to send.
- **Hosts**: what each host serves.

To view it locally, run `pnpm preview`.

`model-hosts.json` maps host → native id → model:

```jsonc
{
  "api.moonshot.ai":      { "kimi-k3":            { "model": "moonshotai/kimi-k3", "pin": "pinned" } },
  "api.together.xyz":     { "moonshotai/Kimi-K3": { "model": "moonshotai/kimi-k3", "pin": "pinned" } },
  "inference.baseten.co": { "moonshotai/Kimi-K3": { "model": "moonshotai/kimi-k3", "pin": "pinned", "quant": "fp8" } },
  "api.typesafe.ai":      { "jev-1.14.0":         { "model": "typesafe/jev-1.14",  "pin": "pinned" } },
  "api.deepseek.com":     { "deepseek-flash":     { "model": "~deepseek/deepseek-flash-latest", "pin": "floating",
                                                    "current": "deepseek/deepseek-v4.1-flash-1017" } }
}
```

- **Host key**: the lowercase hostname of the API base URL, with no scheme, port or
  path. For per-account or per-region hosts, it's a **host family** in which one label
  is a placeholder that matches any single DNS label. Examples:
  `bedrock-mantle.{region}.api.aws`, `{account}.snowflakecomputing.com`,
  `{resource}.services.ai.azure.com`.
- **Native id**: the exact string to send as `model` to that host. (On Bedrock and
  Vertex's native APIs the id goes in the URL path instead, and Bedrock's `eu.`/`us.`
  inference profiles work only in those regions.)
- **`model`**: the model id, which is the **OpenRouter model id** (see
  [Model ids](#model-ids)).
- **`pin`**: `pinned` for a fixed model. `floating` marks a moving alias such as
  `kimi-latest` or DeepSeek's `deepseek-flash`. Floating rows appear only under
  floating `~…` model ids. `pin` is read from the id ("…-latest") or set by a
  person, so an undated name a vendor quietly repoints can still be published as
  pinned to the checkpoint it serves today.
- **`current`**: on a floating row, the checkpoint it serves today, when OpenRouter or
  models.dev names one for the same native id. It changes when the host repoints the
  alias. The site lists the row under that checkpoint too, marked "floating, today".
- **`quant`**: the quantization, when a source reports one.

`models.json` lists every model id: OpenRouter's whole catalog plus models only
other sources know. `source` says where an id comes from: `openrouter`,
`model-aliases.toml` (declared here), `modelsdev` (made from models.dev's
`canonical_model_id`; a few of these name a model OpenRouter lists under another
id), or `sync` (a variant only a host's own list shows, like `z-ai/glm-5.1:web`);
several are joined by commas.

```jsonc
"moonshotai/kimi-k3": {
  "short": "kimi-k3",                          // the id without its vendor
  "name": "MoonshotAI: Kimi K3",
  "permaslug": "moonshotai/kimi-k3-20260715",  // the checkpoint behind the id right now
  "source": "openrouter",
  "output": ["text"],                          // what it returns; not every model is a chat model
  "hosts": 26
}
```

`input` and `output` say which API a model needs: a model whose `output` is
`["embeddings"]` or `["decisions"]` (Gemini Decision 1) is not called through chat
completions.

A model OpenRouter stops listing stays in `models.json` with a `delisted` date, its
rows stay published, and the syncs keep matching other hosts' ids to it, because
hosts usually keep serving it. A new OpenRouter
model shows up in `models.json` within the hour. OpenRouter's
endpoints for it, and any host whose `/models` lists it, show up in
`model-hosts.json` on the same run. `short` is the id with the vendor dropped. It is
left out when two models share a short name (validate warns about it).

Every row is a claim by one of the sources below, not a call we made: we never use
keys. `hosts.json` says which sources each host's rows come from, and lists as
`not_listed` the ids the host's own keyless list doesn't show (often dead routes,
sometimes ids a host accepts without listing, such as region suffixes or another
provider's prefix). `meta.json` has the build time and commit, and, for a build
that followed a sync, how each source did; `stats.json` has counts.

The site also publishes:
- `surplus-legacy-ids.json`: every older Surplus Intelligence id that isn't simply
  `short`, mapped to its model id (backcompat): the inverse of `surplus_legacy` in
  `models.json`;
- `hosts.json`: per host, its row count, sources, keyless list URL, the host it
  mirrors, and `not_listed` ids (claimed served, missing from its own list);
- `unmapped.json`: ids a host lists that nothing could map;
- `conflicts.json`: ids where sources disagree;
- `needs-review.json`: rows held back for a person to check;
- `host-aliases.toml`: hostnames that are the same API as another host.

## Layout

```
hosts/<host>/manual.toml      people's PRs                     highest precedence
hosts/<host>/sync.toml        sync/hosts.ts: /models and served.txt
hosts/<host>/openrouter.toml  sync/openrouter.ts
hosts/<host>/modelsdev.toml   sync/modelsdev.ts (models.dev)   lowest precedence
hosts/<host>/served.txt       input to sync/hosts.ts: ids the host serves that no keyless list shows
model-aliases.toml            extra names for model ids; models OpenRouter lacks
host-aliases.toml             several hostnames, one API
state/catalog.json            OpenRouter catalog snapshot: ids, permaslugs, names, renames
state/<source>.json           what each sync could not map (feeds unmapped.json)
state/host-lists.json         every host with a keyless /models, and the URL it answers at
state/health.json             hosts whose list has stopped answering, since when
sync/host-config.ts           list URLs discovery can't guess; hosts' quirks
upstream.lock                 sha256 of the models.dev snapshot in use
```

Each sync writes only its own file, so it can never overwrite a hand edit. (The
host sync also prunes `served.txt`, an input, of ids a host's list supersedes; see
below.) For each
(host, native id), the highest-precedence source wins. The host sync doesn't map an
id that `manual.toml` or OpenRouter already maps on that host, so in practice
OpenRouter's endpoint data comes before matching on a host's list. When sources disagree on the
model id, the disagreement is listed in `conflicts.json`.

A row looks like this:

```toml
["moonshotai/Kimi-K3"]
model = "moonshotai/kimi-k3"
pin = "pinned"   # optional in manual.toml: "~" model ids are floating, the rest pinned
quant = "fp8"    # optional
```

Rows that need a person to check them are written commented out, with the reason
above them. This covers OpenRouter-only ids, endpoints OpenRouter has disabled or
hidden, and moving aliases with no `~` model. To confirm one, copy it uncommented
into `manual.toml`.

## Model ids

A model id is an **OpenRouter model id**, exactly as OpenRouter writes it:
`moonshotai/kimi-k3`, `minimax/MiniMax-M2.7`. OpenRouter's floating `~…-latest`
routers, such as `~typesafe/jev-latest`, are model ids too. When OpenRouter tracks a
checkpoint separately, it gets its own id: `deepseek/deepseek-v4-pro-0813`.

A host id that sells a model as a separate offer maps to that model's variant
id, in OpenRouter's `model:variant` form; `models.json` lists it with `variant_of`:
- web search built in: "glm-5.1:web" on mor.org is `z-ai/glm-5.1:web`;
- a free tier: OpenRouter's `google/gemma-4-31b-it:free`. When OpenRouter lists
  only the free tier, that is the model itself;
- a reasoning mode sold as its own id: "glm-5.1:thinking" is
  `z-ai/glm-5.1:thinking`. A mode a host spells into the name
  ("glm-5.1-non-thinking") is declared in `model-aliases.toml`, never guessed;
- a media operation other than the model's default. Text-to-video and image
  generation are the model itself; `:image-to-video`, `:reference-to-video`,
  `:enhanced-reference-to-video`, `:transition` and `:edit` are variants. The
  operation comes from the id ("seedance-2-0-image-to-video",
  "veo3.1/image-to-video", "gpt-image-2/edit") or, on Venice and uncensored.com,
  from the list ("seedance-2.0" is "Seedance 2.0 I2V"). A model that does only one
  operation is the model itself: name the host's id in `model-aliases.toml`.

Variants nest (`z-ai/glm-5.1:non-thinking:web`). Service tiers (`:batch`, `:flex`,
`:priority`) are not mapped.

Rows are keyed by the id, not the permaslug. Permaslugs change whenever OpenRouter
swaps the checkpoint behind an id, so keying by them would rewrite every row with
no routing change. `models.json` publishes each id's current permaslug instead.

Each model id also resolves from these names, case-insensitively:
- its short name (`kimi-k3`), when only one model has it;
- its permaslug;
- any id OpenRouter renamed it from (detected automatically);
- names listed in `model-aliases.toml`.

`model-aliases.toml` holds only:
- `surplus_legacy`: every older Surplus Intelligence catalog id that is this model
  or variant, other than the short name (`kling-o3-4k-image-to-video` on
  `kwaivgi/kling-o3-4k:image-to-video`). The catalog sometimes has one id per
  seller for the same offer (`uncensored-seedance-2-0-t2v`); the model lists each;
- other `aliases`;
- ids for models OpenRouter doesn't list, in the same `vendor/slug` shape.

Models only models.dev knows use its `canonical_model_id`, which mostly follows
OpenRouter's naming but not always (`mistralai/mistral-medium-2604` is OpenRouter's
`mistral-medium-3-5`). Merge such pairs with an alias in `model-aliases.toml`.

## Sources

1. **models.dev** ([api.json](https://models.dev/api.json), MIT).
   - Any provider with an HTTP base URL becomes a host.
   - The model key is the native id.
   - The model id comes from `canonical_model_id`.
2. **OpenRouter public data**, unauthenticated, at about one request per second.
   - **Fetched**: every hour for models with roughly $100/month or more of traffic
     and models OpenRouter added in the last 30 days; once a day for every other
     model. A full pass (`OPENROUTER_ALL=1`) takes about 10 minutes at 1 request
     per second.
   - **What it gives**: the provider's model id (`provider_model_id`) and the base
     URL OpenRouter calls.
   - **Hosts**: providers OpenRouter calls through an SDK get their HTTP host
     (Bedrock → `bedrock-runtime.{region}.amazonaws.com`, Vertex →
     `aiplatform.googleapis.com`). OpenRouter's own Azure or Alibaba resource becomes
     the family every customer's resource belongs to
     (`{resource}.services.ai.azure.com`). Hostnames made only for OpenRouter
     (`openrouter.*`) are skipped: nobody else can call them.
3. **Per-host syncs** for every host with a public, keyless `GET /models`. Each
   hour the sync probes `<base>/models` for every base URL models.dev and OpenRouter
   report (about 400 URLs, about 25 seconds). Any host that answers is synced, with no
   file to add, and `state/host-lists.json` records it, so a new host shows up in
   the commit. The sync also maps the ids in each host's `served.txt`, which covers
   hosts whose list needs a key; it was seeded from a marketplace's live routing.
   A host with a keyless list needs no `served.txt`, except for ids its list has
   that `include` in host-config filters out; the sync deletes every other id from
   it (listed already, or a dead route) and the file once it is empty. A list host
   whose list has failed for 14 days loses its rows and its `served.txt`. A host
   with only a `served.txt` is dropped the same way once its hostname has not
   resolved for 14 days.

   A host declared in `sync/host-config.ts` as a `mirror` of another (agent-zero,
   mordiem and mor.org resell Venice under Venice's ids) maps every id the upstream
   also has the way the upstream does, including its `manual.toml` rows.

   Otherwise a native id is mapped using the first of these that applies:
   - an exact name (model id, permaslug, alias), also after a router's prefix
     (`vercel-ai-gateway/sakana/fugu-max`) and for OpenRouter's floating ids
     (`jev-latest` is `~typesafe/jev-latest`);
   - an exact match on a Hugging Face id, or the same id OpenRouter or a person
     mapped on another host. Not when that host resolved an undated name to a
     dated checkpoint (`deepseek-r1` → `deepseek-r1-0528`): another host may
     resolve it differently;
   - a normalized match, ignoring routing decorations (`@region`, `-maas`,
     `-v1:0`) and the operation a media host sells separately (`-text-to-video`,
     `-i2v`).

   These are never mapped automatically, from any source (an OpenRouter row that
   would do it is held for review; models.dev and host-list ids stay unmapped):
   - ids with a tier or variant word the model id lacks: `-fast`, `-flex`,
     `-lightning`, `e2ee-`, `:web`, and fine-tunes such as `-abliterated`,
     `-uncensored`, `-distill` (also checked against a host's display name where
     configured, so Venice's "Qwen 3.6 Plus Uncensored" is not Qwen 3.6 Plus);
   - moving aliases that have no `~` model to sit under.

   Anything unmapped goes to `unmapped.json`; nothing is guessed.
4. **Manual**: pull requests.

If a source fails or changes shape, its previous rows are kept and the hourly job
fails visibly after publishing; if OpenRouter's catalog is unavailable, the other syncs use the last
snapshot. Rows are removed when a source answers normally and no longer lists
them, and otherwise only after a set time:
- a host whose list has failed, or whose hostname has not resolved, for 14 days;
- OpenRouter rows of a model OpenRouter delisted, or has listed with no endpoints,
  for 30 days (nothing refreshes them; hosts' own lists and models.dev still carry
  routes that stay live).

## Contributing

**Add or fix a mapping.** Edit or create `hosts/<host>/manual.toml`. Don't edit
the other files in `hosts/`; the syncs rewrite them every hour.

**Add a host that has a public `/models` endpoint.** Usually there's nothing to
do: any host models.dev or OpenRouter knows is found within the hour. Add an entry
to `sync/host-config.ts` only in these cases:
- the list isn't at `<base>/models`;
- neither upstream knows the host;
- its list needs hints or filtering (see `lib/hostsync.ts`).

```ts
'api.example.com': { models: 'https://api.example.com/api/v1/models' },
```

`node sync/hosts.ts api.example.com` syncs one host.

**A host has no keyless `/models`.** Add the ids it serves to
`hosts/<host>/served.txt`, one per line, sorted, and remove them when the host
retires them (check its deprecation page: the sync only notices once the host
gets a keyless list or its hostname stops resolving). The hourly
sync maps them like listed ids. Add a `manual.toml` row only for an id the sync
maps wrongly or can't map; `unmapped.json` lists those. Give the row a comment
with the evidence.

**Two hostnames for one API.** Add a line to `host-aliases.toml`.

**Import an existing mapping table.** Use `node scripts/import-mappings.ts
export.json [--decisions decisions.json] [--write]`. The format is documented in
the script.
- Native ids go into `served.txt` for hosts without a keyless list; for a host with
  one, only ids its list has but `include` filters out.
- It writes no mappings. It runs the sync's own matching and prints every pair the
  sync would map differently or not at all; settle each with an alias in
  `model-aliases.toml`, a commented `manual.toml` row, or nothing.
- `decisions.json` records a person's answers to an earlier run.
- Ids that OpenRouter doesn't list are declared in `model-aliases.toml`.

Every pull request runs `validate.ts`, which checks:
- every TOML file parses and has no duplicate keys;
- host keys are normalized;
- every `model` is a well-formed model id, and `pin` agrees with it;
- machine-written files are byte-for-byte what the formatter produces;
- no synced row disappears unless its own sync dropped it.

It also reports hand-maintained content that has gone stale: a `manual.toml` row
the host no longer lists, a `host-config.ts` or `host-aliases.toml` entry for a
host that is gone, a short name two models share. These don't block a pull
request or the hourly commit; `validate.ts --strict` fails on them.

## Run locally

Node 22.18+ runs the `.ts` files directly, with no build step (CI uses Node 26).

```sh
pnpm install
pnpm sync           # all sources (OpenRouter's hourly selection takes a few minutes at 1 req/s)
pnpm sync:hosts     # or one source; `node sync/hosts.ts api.deepinfra.com` for one host
pnpm build          # -> dist/
pnpm validate
pnpm test && pnpm typecheck
```

For debugging: `VERBOSE=1` logs every non-exact match, `OR_LIMIT=<n>` fetches only
the first n OpenRouter models, `OPENROUTER_ALL=1` fetches all of them, and
`SYNC_CACHE=0` turns off the 30-minute cache of upstream responses in `.cache/`.

`scripts/seed-aliases.ts <ids-url>` proposes `surplus_legacy` entries by diffing a
list of model ids against the OpenRouter catalog. It is a one-off tool, not part
of the sync.

## Automation

`.github/workflows/sync.yml` runs every hour:
1. sync
2. build
3. validate (errors stop the run here)
4. commit to `main`
5. publish `dist/` to GitHub Pages
6. fail if a source failed or something hand-maintained is stale
   (`validate.ts --strict`), so the run ends red with the data already published.

The commit message summarises the rows added, removed and changed per host.
Dependabot opens weekly pull requests for the pinned actions and dependencies. A push
to `main`, such as a merged PR, rebuilds and republishes. `main` must allow pushes
from `github-actions[bot]`.

## Notes

Not affiliated with OpenRouter or models.dev. OpenRouter's `stats/endpoint` and
`rankings` routes are undocumented and may change; this repo only reads them,
without a key, slowly. Some upstream ids and base URLs only work through
OpenRouter's own accounts; those rows stay commented out.
