# i18n-sync

Keep every locale file of your project in sync using an LLM (Google Gemini or Anthropic Claude).

**Any language can be the source of a change.** If a human edits the Greek string for a key, all other languages
(English included) are updated from Greek. Change detection uses a committed lock file of per-key, per-language
hashes, so it needs no particular git workflow.

- Zero runtime dependencies (Node >= 20, global `fetch`). The Claude provider needs the optional `@anthropic-ai/sdk` peer dependency.
- Token usage and cost are reported after every run; `--dry-run` / `--check` print an estimate.
- Optional second-model review of translations.
- Formats: nested JSON (i18next style, optional namespaces) and Flutter ARB.
- Placeholders (`{{x}}`, ICU `{x}` / plural / select) and HTML tags are validated; bad results are retried, then skipped.
- Minimal-edit updates: when a source string changes, the model gets the previous source and the current translation and is asked to change only what is needed.

## Install

```sh
npx github:stanimeros/i18n-sync --help      # no install
npm install --save-dev @stanimeros/i18n-sync   # as a dev dependency
```

## Quick start

```sh
npx i18n-sync init            # writes i18n-sync.config.json
export GEMINI_API_KEY=...     # or put it in a .env file (ANTHROPIC_API_KEY for Claude)
npx i18n-sync --dry-run       # see what would happen
npx i18n-sync                 # translate, write files, update i18n.lock.json
```

Commit `i18n.lock.json` together with your locale files.

## Config

`i18n-sync.config.json` in the working directory (or `--config path`). Paths are relative to the config file.

| Key | Default | Description |
| --- | --- | --- |
| `format` | `"json"` | `"json"` or `"arb"` |
| `files` | required | Pattern with `{lang}` and optionally `{ns}` (json only), e.g. `src/locales/{lang}/{ns}.json`, `lib/l10n/app_{lang}.arb` |
| `languages` | required | Language codes. Order matters: it decides conflicts and fallback sources |
| `primary` | first language | Wins conflicts; deletions from it propagate |
| `lockFile` | `"i18n.lock.json"` | Lock file path |
| `provider` | `"gemini"` | `"gemini"` or `"anthropic"` (Claude needs `npm i -D @anthropic-ai/sdk`) |
| `model` | `"gemini-3.5-flash-lite"` | Model id (default `"claude-sonnet-5-5"` with the `anthropic` provider) |
| `apiKeyEnv` | `"GEMINI_API_KEY"` | Environment variable holding the key (`"ANTHROPIC_API_KEY"` for `anthropic`; `.env` in cwd is loaded automatically) |
| `thinkingLevel` | `"minimal"` | Gemini only: `"minimal"`, `"medium"`, `"high"` or `null` (model default). Sent as `generationConfig.thinkingConfig.thinkingLevel`. Translation does not need reasoning, so the default keeps output tokens low. Gemini 2.5 models do not support it, so the default is `null` for `gemini-2.*` ids |
| `effort` | `"medium"` | Claude only: `output_config.effort` for translation requests (sent only to models that support it) |
| `pricing` | `{}` | USD per 1M tokens, `{"<model>": {"input": 1, "output": 5}}`. Overrides or extends the built-in table (see [Cost](#cost)) |
| `review` | disabled | Optional review step, see [Review](#review) |
| `confirmAbove` | `1` | Ask before a run whose estimated cost exceeds this many USD (`null` = never ask), see [Cost](#cost) |
| `batchSize` | `40` | Max strings per request |
| `concurrency` | `8` | Parallel requests |
| `context` | `""` | Free-text description of your product/audience for the translator |
| `glossary` | `{}` | `{"Acme": "Acme"}` (same value = never translate) or `{"term": {"el": "...", "de": "..."}}`. Checked on every result: a miss is retried once, then accepted with a warning |
| `tone` | `{}` | Per target language, e.g. `{"de": "formal (Sie)"}` |
| `gitContext` | `true` | Walk the source file's git history back to the last synced version, so the model sees the previous text and the commit messages since then (works for committed and uncommitted edits) |

CLI flags: `--check`, `--dry-run`, `--only <prefix>`, `--force`, `--lang <code>`, `--review`, `--no-review`, `--review-with <provider>`, `--yes`, `--config <path>`, `--help`, `--version`. Subcommands: `init`, `review`, `accept`.

## Cost

Providers report token usage and every run ends with a per-phase summary (thinking tokens count as output):

```
translate: 12,345 in / 6,789 out tokens, $0.0213 (gemini-3.5-flash-lite)
review: 9,100 in / 480 out tokens, $0.0086 (gemini-3.6-flash)
total: 21,445 in / 7,269 out tokens, $0.0299
```

Built-in prices (USD per 1M tokens, input / output; standard tier as of 2026-10, and 3.6 / 3.8 Flash double on 2027-01-01):

| Model | Input | Output |
| --- | --- | --- |
| `gemini-3.1-flash-lite` | 0.25 | 1.50 |
| `gemini-3.5-flash-lite` | 0.30 | 2.50 |
| `gemini-3.6-flash`, `gemini-3.8-flash` | 0.75 | 3.75 |
| `gemini-3.1-pro-preview` | 2.00 | 12.00 |
| `gemini-2.5-flash` | 0.30 | 2.50 |
| `gemini-2.5-flash-lite` | 0.10 | 0.40 |
| `gemini-2.5-pro` | 1.25 | 10.00 |
| `claude-opus-5-5` | 4 | 20 |
| `claude-sonnet-5-5` | 2 | 10 |
| `claude-haiku-4-5` | 1 | 5 |

Override or add models in the config; a model without a price prints `cost unknown (no pricing for X; set "pricing" in config)`:

```json
{ "pricing": { "my-model": { "input": 0.5, "output": 2 } } }
```

Every run that calls a model first prints an **estimate**, and `--dry-run` / `--check` print it without any API call. Input tokens are (system prompt + JSON payload) / 4 per batch; output tokens are the source text length / 4 x 1.2 per target, plus an allowance for thinking tokens (billed as output) when thinking is not `"minimal"`. Treat it as a ballpark. After the run the actual usage and cost are printed (the Claude CLI reports its exact cost).

```
estimated cost: ~$0.04 (estimate only; actual usage varies)
```

**Confirmation above a limit.** When the estimate exceeds `confirmAbove` (USD, default `1`), the CLI asks `Continue? [y/N]` before calling any model. Without a terminal (CI, scripts) it stops instead; pass `--yes` (`-y`) to proceed. Set `"confirmAbove": null` to never ask.

## Review

A second model can check translations before they are written. It looks for meaning errors, omissions or additions, fluency, tone, glossary and consistency problems, and broken placeholders/HTML, and only flags real problems (not style preferences). Every proposed fix goes through the same placeholder, HTML and glossary validation as a translation; an invalid fix is rejected and the original is kept.

```json
{
  "review": {
    "enabled": false,
    "provider": "gemini",
    "model": "gemini-3.6-flash",
    "apiKeyEnv": "GEMINI_API_KEY",
    "batchSize": 40,
    "effort": "medium",
    "thinkingLevel": null
  }
}
```

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `false` | Review every string translated in a run before files are written (`--review` / `--no-review` override) |
| `provider` | `"gemini"` | `"gemini"`, `"claude-cli"` (your logged-in [Claude Code](https://claude.com/claude-code), no API key) or `"anthropic"` (API key + SDK) |
| `model` | `"gemini-3.6-flash"` / `"claude-opus-5-5"` | Default depends on the provider |
| `apiKeyEnv` | `"GEMINI_API_KEY"` / `"ANTHROPIC_API_KEY"` | Default depends on the provider (not used by `claude-cli`) |
| `batchSize` | `40` (`200` for `claude-cli`) | Strings per review request |
| `effort` | `"medium"` | Claude only |
| `thinkingLevel` | `null` | Gemini only: `"minimal"`, `"medium"`, `"high"`, `null` = model default |

Examples:

```json
{ "review": { "enabled": true } }
```
```json
{ "review": { "enabled": true, "provider": "anthropic", "model": "claude-opus-5-5", "effort": "high" } }
```

Or pick the reviewer for a single run, without touching the config:

```sh
npx i18n-sync --review-with gemini       # gemini-3.6-flash
npx i18n-sync --review-with claude-cli   # Claude Code CLI (claude -p), claude-opus-5-5
```

`claude-cli` runs `claude -p` with the review prompt as the system prompt, no tools and no saved session, from a temp directory; it uses whatever account Claude Code is logged in with. The `anthropic` provider calls the API directly and needs the optional SDK: `npm i -D @anthropic-ai/sdk`. Both Claude providers can also translate (`"provider": "claude-cli"` / `"anthropic"`).

### Reviewing existing translations

```sh
npx i18n-sync review                    # review ALL non-primary languages against the primary text and apply fixes
npx i18n-sync review --lang de          # one language
npx i18n-sync review --only hero.       # keys with a prefix
npx i18n-sync review --dry-run          # call the reviewer, print the fixes, change nothing
```

This is a one-time quality pass, e.g. after adding a language. Applied fixes also update the lock file, so they are not later mistaken for human edits. If anything is pending sync, `review` refuses: run `i18n-sync` first. Output:

```
de main:hero.title: "Willkommen zurueck" -> "Willkommen zurueck bei Acme" (omitted product name)
review: 120 reviewed, 5 flagged, 4 applied, 1 rejected
review: 9,100 in / 480 out tokens, $0.0086 (gemini-3.6-flash)
```

## Fixing one language by hand

Editing a translation counts as a human edit, so by default it propagates to every other language (that is the point: any language can be the source). To fix a typo in one language only, edit it and then mark it as in sync:

```sh
npx i18n-sync accept --lang it --only main:seo.jsonLd.jobTitle
```

`accept` rewrites the lock entries of the selected keys to their current values and translates nothing.

## How change detection works

The lock file stores a hash of every value per language. A key is "changed" in language L if it exists in L and its
hash differs from the lock (or the key is absent from L's lock entries while L is tracked, i.e. a human added it).

| Situation | Result |
| --- | --- |
| No lock file (first run) | Existing values are assumed in sync; only missing keys are filled (source: primary, else first language having the key) |
| Key changed in exactly one language | That language is the source; all others are updated (`update` if they have a value, else `new`) |
| Key changed in several languages | Primary wins if involved, otherwise the first in config order; a warning is printed |
| Key missing in some languages, unchanged | Missing ones are filled from the primary (or first language having it) |
| Key deleted from the primary (was in lock) | Deleted from every language |
| Key deleted from a non-primary language only | Refilled from the primary |
| Language added to config | Its lock entries do not exist: a missing file is fully filled; an existing file is trusted as in sync |
| `--only <prefix>` | Restricts all of the above to keys with that prefix |
| `--force` | Treats the primary as changed for every selected key (retranslates everything from it) |
| `--lang <code>` | Only that language is written |

Work that is skipped (failed validation, `--only`, `--lang`) keeps its old lock entries so it is picked up again next run.

## CI

```yaml
- run: npx i18n-sync --check   # exit 1 if translations are out of date; no API key, no network
```

## Deploy / release

Run `npx i18n-sync` as a pre-commit step or a release step with the API key set, and commit the result. `--check` in CI
guarantees nothing ships with stale translations.

## Formats

- **json**: nested objects are flattened with `.` (`a.b.c`); arrays of strings become `path.0`, `path.1`, ... and are rebuilt on save. With `{ns}` in the pattern, keys are `ns:path` and namespaces are discovered from the primary language's files. Non-string leaves (numbers, booleans, `null`) are copied from the primary, never translated. Target files follow the primary's key order; output is 2-space indented with a trailing newline.
- **arb**: keys not starting with `@` are messages; `@@locale` is set on save; `@key` metadata blocks stay in the file they came from (only the primary normally has them).

Missing target files are created (directories included).

## FAQ

**Why a lock file instead of `git diff`?** Hashes work with uncommitted changes, rebases, squashes and shallow CI clones, and
they work no matter which language was edited. Git is only used, optionally, to recover the previous source text as a hint.

**What if the model returns a broken placeholder?** The item is retried once with the failure reason. If it still fails the key is
skipped, reported, and retried on the next run.

**Does it send my data anywhere?** Only the strings to translate (plus your `context`, glossary and tone) go to the configured provider's API (Gemini or Claude), and to the review model when review is enabled.

## Limitations

- Gemini and Claude are implemented (the provider interface is small, so adding others is easy).
- Keys containing `.` in JSON are ambiguous with nesting; ARB/JSON keys containing `:` are ambiguous with namespaces.
- Empty arrays/objects are kept as-is; objects whose keys are all `0..n-1` are rebuilt as arrays.
- If a key fails for one target, the source's lock entry is also kept, so the next run re-sends that key to all of its targets.
- Plural/ICU structure is validated only by top-level argument names.

## License

MIT
