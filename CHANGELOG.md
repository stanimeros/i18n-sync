# Changelog

## 0.3.1

- A key added to several languages at once (absent from the lock everywhere) is no longer a conflict: those languages are kept as translated and only the missing ones are filled. Array additions are still detected in any language.

## 0.3.0

- `claude-cli` provider: review (or translate) through the logged-in Claude Code CLI (`claude -p`), no API key; its reported cost is used as-is.
- `--review-with <gemini|claude-cli|anthropic>` picks the reviewer for one run.
- The estimated cost is printed before every run; above `confirmAbove` (default $1) the CLI asks for confirmation (`--yes` to skip; non-interactive runs stop).
- Estimates include thinking tokens and the Claude CLI's fixed per-request context.
- Cost tracking: providers report token usage (Gemini thinking tokens count as output); each run prints per-phase tokens and USD cost. Built-in price table, overridable with the `pricing` config key.
- `--dry-run` / `--check` print an estimate of tokens and cost for the planned work.
- New `thinkingLevel` option for Gemini 3.x (default `"minimal"` for translation). The `temperature` parameter is no longer sent.
- Optional review step (`review` config, `--review` / `--no-review`) that has a second model check new translations and apply validated fixes before files are written.
- New `i18n-sync review [--lang] [--only] [--dry-run]` command to review all existing translations; applied fixes update the lock file.
- Anthropic Claude provider (`provider: "anthropic"`, also usable for review) via the optional `@anthropic-ai/sdk` peer dependency.
- Default Gemini model is now `gemini-3.5-flash-lite`; the default Gemini review model is `gemini-3.6-flash`.
- Prompt builders moved to `src/llm/prompts.js`, shared by all providers.

## 0.2.0

- Arrays are positional: when a language's array length differs from the source's, the whole array is retranslated and surplus elements are dropped (instead of misaligned per-index updates). Shown as `realign` in plans.
- Git context walks the source file's history back to the last synced version, so the previous text and commit messages are found for committed and uncommitted edits alike.
- Leading/trailing whitespace of the source is restored on every translation.
- Glossary terms are checked on every result; a miss is retried once, then accepted with a warning.
- New `concurrency` option (default 8) and per-batch progress output.

## 0.1.0

- Initial release: JSON (i18next style) and ARB (Flutter) formats, Gemini provider,
  hash-based lock file, `--check`, `--dry-run`, `--only`, `--force`, `--lang`, `init`.
