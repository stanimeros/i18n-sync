# Changelog

## 0.2.0

- Arrays are positional: when a language's array length differs from the source's, the whole array is retranslated and surplus elements are dropped (instead of misaligned per-index updates). Shown as `realign` in plans.
- Git context walks the source file's history back to the last synced version, so the previous text and commit messages are found for committed and uncommitted edits alike.
- Leading/trailing whitespace of the source is restored on every translation.
- Glossary terms are checked on every result; a miss is retried once, then accepted with a warning.
- New `concurrency` option (default 8) and per-batch progress output.

## 0.1.0

- Initial release: JSON (i18next style) and ARB (Flutter) formats, Gemini provider,
  hash-based lock file, `--check`, `--dry-run`, `--only`, `--force`, `--lang`, `init`.
