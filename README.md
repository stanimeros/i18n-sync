# i18n-sync

Keep every locale file of your project in sync using an LLM (Google Gemini).

**Any language can be the source of a change.** If a human edits the Greek string for a key, all other languages
(English included) are updated from Greek. Change detection uses a committed lock file of per-key, per-language
hashes, so it needs no particular git workflow.

- Zero runtime dependencies (Node >= 20, global `fetch`).
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
export GEMINI_API_KEY=...     # or put it in a .env file
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
| `provider` | `"gemini"` | Only `gemini` is implemented |
| `model` | `"gemini-2.5-flash"` | Gemini model |
| `apiKeyEnv` | `"GEMINI_API_KEY"` | Environment variable holding the key (`.env` in cwd is loaded automatically) |
| `batchSize` | `40` | Max strings per request |
| `concurrency` | `8` | Parallel requests |
| `context` | `""` | Free-text description of your product/audience for the translator |
| `glossary` | `{}` | `{"Acme": "Acme"}` (same value = never translate) or `{"term": {"el": "...", "de": "..."}}`. Checked on every result: a miss is retried once, then accepted with a warning |
| `tone` | `{}` | Per target language, e.g. `{"de": "formal (Sie)"}` |
| `gitContext` | `true` | Walk the source file's git history back to the last synced version, so the model sees the previous text and the commit messages since then (works for committed and uncommitted edits) |

CLI flags: `--check`, `--dry-run`, `--only <prefix>`, `--force`, `--lang <code>`, `--config <path>`, `--help`, `--version`.

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

**Does it send my data anywhere?** Only the strings to translate (plus your `context`, glossary and tone) go to the Gemini API.

## Limitations

- Only Gemini is implemented (the provider interface is small, so adding others is easy).
- Keys containing `.` in JSON are ambiguous with nesting; ARB/JSON keys containing `:` are ambiguous with namespaces.
- Empty arrays/objects are kept as-is; objects whose keys are all `0..n-1` are rebuilt as arrays.
- If a key fails for one target, the source's lock entry is also kept, so the next run re-sends that key to all of its targets.
- Plural/ICU structure is validated only by top-level argument names.

## License

MIT
