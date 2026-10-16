import { validateTranslation, matchWhitespace, checkGlossary } from './placeholders.js';
import { pool } from './pool.js';

/**
 * @typedef {Object} ReviewEntry
 * @property {string} key
 * @property {string} sourceLang
 * @property {string} targetLang
 * @property {string} sourceText     text in `sourceLang`
 * @property {string} translation
 * @property {string} [reference]    primary-language text when `sourceLang` is not the primary
 *
 * @typedef {Object} ReviewResult
 * @property {number} reviewed
 * @property {number} flagged
 * @property {{lang: string, key: string, old: string, new: string, issue: string}[]} fixes     valid fixes
 * @property {{lang: string, key: string, issue: string, reason: string}[]} rejected            invalid fixes (original kept)
 * @property {{lang: string, count: number, reason: string}[]} errors                            batches that could not be reviewed
 */

/**
 * Review translations in batches per language pair. Never mutates anything; callers apply `fixes`.
 * @param {Object} args
 * @param {ReviewEntry[]} args.entries
 * @param {import('./config.js').Config} args.cfg          original config (glossary, concurrency, ...)
 * @param {import('./config.js').Config} args.reviewCfg    config as seen by the review provider
 * @param {Function} args.reviewBatch
 * @param {import('./llm/prompts.js').OnUsage} [args.onUsage]
 * @param {(msg: string) => void} [args.log]
 * @returns {Promise<ReviewResult>}
 */
export async function reviewEntries({ entries, cfg, reviewCfg, reviewBatch, onUsage, log }) {
  /** @type {ReviewResult} */
  const out = { reviewed: 0, flagged: 0, fixes: [], rejected: [], errors: [] };
  const groups = new Map();
  for (const e of entries) {
    const g = `${e.sourceLang}->${e.targetLang}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  const size = cfg.review.batchSize;
  const total = entries.length;
  let done = 0;
  const tasks = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += size) {
      const chunk = group.slice(i, i + size);
      tasks.push(async () => {
        const { sourceLang, targetLang } = chunk[0];
        const items = chunk.map((e, n) => {
          const item = { id: String(n), source: e.sourceText, translation: e.translation };
          if (e.reference !== undefined) item.reference = e.reference;
          return item;
        });
        let verdicts;
        try {
          verdicts = await reviewBatch({ items, sourceLang, targetLang, cfg: reviewCfg, onUsage });
        } catch (e) {
          out.errors.push({ lang: targetLang, count: chunk.length, reason: e.message });
          done += chunk.length;
          return;
        }
        chunk.forEach((e, n) => {
          const v = verdicts?.[String(n)];
          if (!v || typeof v !== 'object' || typeof v.ok !== 'boolean') return;
          out.reviewed++;
          if (v.ok) return;
          const issue = typeof v.issue === 'string' ? v.issue : 'unspecified';
          if (typeof v.fixed !== 'string') {
            out.flagged++;
            out.rejected.push({ lang: targetLang, key: e.key, issue, reason: 'no corrected translation provided' });
            return;
          }
          const fixed = matchWhitespace(e.sourceText, v.fixed);
          if (fixed === e.translation) return; // nothing to change
          out.flagged++;
          let res = validateTranslation(e.sourceText, fixed);
          if (res.ok) res = checkGlossary(e.sourceText, fixed, cfg.glossary, targetLang);
          if (res.ok) out.fixes.push({ lang: targetLang, key: e.key, old: e.translation, new: fixed, issue });
          else out.rejected.push({ lang: targetLang, key: e.key, issue, reason: res.reason });
        });
        done += chunk.length;
        log?.(`  review [${done}/${total}] ${sourceLang} -> ${targetLang}`);
      });
    }
  }
  await pool(tasks, cfg.concurrency);
  return out;
}

/** Human readable review result. @param {ReviewResult} r @param {{dryRun?: boolean}} [opts] */
export function formatReview(r, { dryRun = false } = {}) {
  const lines = [];
  for (const f of r.fixes) lines.push(`${f.lang} ${f.key}: "${f.old}" -> "${f.new}" (${f.issue})`);
  for (const f of r.rejected) lines.push(`rejected: ${f.lang} ${f.key}: ${f.reason} (${f.issue}); kept original`);
  for (const e of r.errors) lines.push(`review failed: ${e.lang}: ${e.count} item(s) not reviewed: ${e.reason}`);
  lines.push(`review: ${r.reviewed} reviewed, ${r.flagged} flagged, ${dryRun ? `${r.fixes.length} fixable (not applied)` : `${r.fixes.length} applied`}, ${r.rejected.length} rejected`);
  return lines;
}
