import { groupJobs, buildItem } from './jobs.js';
import { buildPrompt, buildReviewPrompt } from './llm/prompts.js';
import { summarizeUsage } from './pricing.js';

const CHARS_PER_TOKEN = 4;
const OUTPUT_FACTOR = 1.2;
/** Rough size of one reviewer verdict (`"12":{"ok":true}`) in tokens. */
const REVIEW_VERDICT_TOKENS = 12;
/**
 * Thinking is billed as output. Calibrated on real runs (2026-10): gemini-3.6-flash at its default
 * ("medium") level spends ~1,000 tokens per request; minimal thinking ~0; Claude (adaptive) ~400 per
 * request. Rough by nature, but keeps estimates within the right order of magnitude.
 */
function thinkingTokens(c, items, requests) {
  if (c.provider !== 'gemini') return requests * 400 + items * 20;
  const factor = { minimal: 0, medium: 1, high: 2 }[c.thinkingLevel ?? 'medium'] ?? 1;
  return factor * (requests * 1000 + items * 50);
}

/** Fixed input per request: the Claude CLI adds its own context (~8k tokens) even with a custom system prompt. */
const requestOverhead = (c) => (c.provider === 'claude-cli' ? 8000 : 0);

/**
 * Rough token and cost estimate for planned jobs (no API calls).
 * Input = (system prompt + JSON payload) / 4 per batch; output = source text / 4 * 1.2 per target.
 * @param {{jobs: import('./diff.js').Job[], cfg: import('./config.js').Config, loaded: any, review?: boolean}} args
 */
export function estimateJobs({ jobs, cfg, loaded, review = false }) {
  const t = { model: cfg.model, input: 0, output: 0 };
  const r = { model: cfg.review.model, input: 0, output: 0 };
  for (const { source, target, entries } of groupJobs(jobs).values()) {
    for (let i = 0; i < entries.length; i += cfg.batchSize) {
      const chunk = entries.slice(i, i + cfg.batchSize);
      const items = chunk.map((c, n) => buildItem(c.job, c.target, String(n), cfg, loaded));
      t.input += (buildPrompt({ sourceLang: source, targetLang: target, cfg }).length + JSON.stringify(items).length) / CHARS_PER_TOKEN + requestOverhead(cfg);
      t.output += chunk.reduce((s, c) => s + c.job.sourceNew.length, 0) / CHARS_PER_TOKEN * OUTPUT_FACTOR
        + thinkingTokens(cfg, chunk.length, 1);
    }
    if (review) {
      for (let i = 0; i < entries.length; i += cfg.review.batchSize) {
        const chunk = entries.slice(i, i + cfg.review.batchSize);
        const items = chunk.map((c, n) => ({ id: String(n), source: c.job.sourceNew, translation: c.job.sourceNew }));
        r.input += (buildReviewPrompt({ sourceLang: source, targetLang: target, cfg }).length + JSON.stringify(items).length) / CHARS_PER_TOKEN;
        r.output += chunk.length * REVIEW_VERDICT_TOKENS + thinkingTokens(cfg.review, chunk.length, 1);
      }
    }
  }
  return summarizeUsage({ translate: t, ...(review ? { review: r } : {}) }, cfg);
}

/**
 * Rough token and cost estimate for reviewing existing translations (no API calls).
 * @param {{entries: {sourceLang: string, targetLang: string, sourceText: string, translation: string}[], cfg: import('./config.js').Config}} args
 */
export function estimateReview({ entries, cfg }) {
  const r = { model: cfg.review.model, input: 0, output: 0 };
  const groups = new Map();
  for (const e of entries) {
    const g = `${e.sourceLang}->${e.targetLang}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  for (const list of groups.values()) {
    const { sourceLang, targetLang } = list[0];
    for (let i = 0; i < list.length; i += cfg.review.batchSize) {
      const chunk = list.slice(i, i + cfg.review.batchSize);
      const items = chunk.map((e, n) => ({ id: String(n), source: e.sourceText, translation: e.translation }));
      r.input += (buildReviewPrompt({ sourceLang, targetLang, cfg }).length + JSON.stringify(items).length) / CHARS_PER_TOKEN + requestOverhead(cfg.review);
      r.output += chunk.length * REVIEW_VERDICT_TOKENS + thinkingTokens(cfg.review, chunk.length, 1);
    }
  }
  return summarizeUsage({ review: r }, cfg);
}
