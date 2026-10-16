import { computeDiff } from './diff.js';
import { readLock, writeLock, buildLock, hashValue } from './lock.js';
import { validateTranslation, matchWhitespace, checkGlossary } from './placeholders.js';
import * as jsonFormat from './formats/json.js';
import * as arbFormat from './formats/arb.js';
import { fileAt, fileHistory } from './git.js';
import { provider as gemini } from './llm/gemini.js';
import { provider as anthropic } from './llm/anthropic.js';
import { provider as claudeCli } from './llm/claude-cli.js';
import { pool } from './pool.js';
import { groupJobs, buildItem, reviewConfig } from './jobs.js';
import { reviewEntries, formatReview } from './review.js';
import { estimateJobs, estimateReview } from './estimate.js';
import { createUsage, summarizeUsage, formatUsage } from './pricing.js';

const FORMATS = { json: jsonFormat, arb: arbFormat };
const PROVIDERS = { gemini, anthropic, 'claude-cli': claudeCli };

/**
 * @typedef {Object} SyncOptions
 * @property {boolean} [check]
 * @property {boolean} [dryRun]
 * @property {string} [only]
 * @property {boolean} [force]
 * @property {string} [lang]
 * @property {boolean} [review]  override `review.enabled` (CLI --review / --no-review)
 * @property {(estimatedUsd: number) => Promise<boolean>} [confirm] asked when the estimate exceeds `confirmAbove`
 * @property {(args: {items: any[], sourceLang: string, targetLang: string, cfg: any, note?: string, onUsage?: Function}) => Promise<Record<string,string>>} [translate]
 *   injected translate function (defaults to the configured provider)
 * @property {(args: {items: any[], sourceLang: string, targetLang: string, cfg: any, onUsage?: Function}) => Promise<Record<string,any>>} [reviewBatch]
 *   injected review function (defaults to the configured review provider)
 * @property {(msg: string) => void} [log]
 */

/** Load every language through the configured format. */
function loadAll(cfg) {
  const fmt = FORMATS[cfg.format];
  const loaded = {};
  for (const l of cfg.languages) loaded[l] = fmt.load(l, cfg);
  return loaded;
}

/**
 * Recover the previous source text and change notes from git.
 * Walks the source file's history back to the version whose value matches the lock hash
 * (the last synced text), so it works whether or not the edit is already committed.
 */
function enrichWithGit(jobs, cfg, lock) {
  const fmt = FORMATS[cfg.format];
  const historyCache = new Map();
  const parsedCache = new Map();
  const parsedAt = (file, ns, rev) => {
    const id = `${file}\u0000${rev}`;
    if (!parsedCache.has(id)) {
      let parsed = null;
      const text = fileAt(file, rev);
      if (text !== null) {
        try {
          parsed = fmt.parse(text, ns);
        } catch { /* ignore */ }
      }
      parsedCache.set(id, parsed);
    }
    return parsedCache.get(id);
  };
  for (const job of jobs) {
    if (job.mode !== 'update') continue;
    const syncedHash = lock?.languages?.[job.source]?.[job.key];
    if (!syncedHash) continue;
    const { file, ns } = fmt.fileForKey(job.source, job.key, cfg);
    if (!historyCache.has(file)) historyCache.set(file, fileHistory(file));
    const notes = [];
    for (const { rev, subject } of historyCache.get(file)) {
      const old = parsedAt(file, ns, rev)?.get(job.key);
      if (old !== undefined && hashValue(old) === syncedHash) {
        if (old !== job.sourceNew) job.sourceOld = old;
        break;
      }
      if (old !== undefined && subject) notes.push(subject);
    }
    if (notes.length) job.note = [...new Set(notes)].slice(0, 3).join('; ');
  }
}

/**
 * Translate all jobs. Returns results and failures.
 * @returns {Promise<{results: Map<string,string>, failures: {key: string, lang: string, reason: string}[]}>}
 *   results keyed by `${lang}\u0000${key}`
 */
async function runJobs(jobs, cfg, loaded, translate, log, onUsage) {
  const rk = (lang, key) => `${lang}\u0000${key}`;
  const groups = groupJobs(jobs);

  /** @type {(() => Promise<void>)[]} */
  const tasks = [];
  const results = new Map();
  const failures = [];

  const total = [...groups.values()].reduce((n, g) => n + g.entries.length, 0);
  let done = 0;
  for (const { source, target, entries } of groups.values()) {
    for (let i = 0; i < entries.length; i += cfg.batchSize) {
      const chunk = entries.slice(i, i + cfg.batchSize);
      tasks.push(async () => {
        const note = chunk.map((c) => c.job.note).find(Boolean);
        const ids = new Map(chunk.map((c, n) => [String(n), c]));
        const attempt = async (pending, failureNotes) => {
          const items = pending.map(([id, c]) => {
            const item = buildItem(c.job, c.target, id, cfg, loaded);
            if (failureNotes?.[id]) item.failure = failureNotes[id];
            return item;
          });
          const out = await translate({ items, sourceLang: source, targetLang: target, cfg, note, onUsage });
          const bad = {};
          for (const [id, c] of pending) {
            let v = out?.[id];
            if (typeof v === 'string') v = matchWhitespace(c.job.sourceNew, v);
            let res = v === undefined ? { ok: false, reason: 'missing from response' } : validateTranslation(c.job.sourceNew, v);
            if (res.ok) {
              // Glossary misses are soft: retried once, then accepted with a warning so the key is not stuck.
              const gl = checkGlossary(c.job.sourceNew, v, cfg.glossary, target);
              if (!gl.ok && !failureNotes) res = gl;
              else if (!gl.ok) log?.(`  warning: ${target} ${c.job.key}: ${gl.reason}`);
            }
            if (res.ok) results.set(rk(target, c.job.key), v);
            else bad[id] = res.reason;
          }
          return bad;
        };
        let bad;
        try {
          bad = await attempt([...ids], null);
          if (Object.keys(bad).length) {
            log?.(`  ${source} -> ${target}: retrying ${Object.keys(bad).length} invalid item(s)`);
            const notes = bad;
            bad = await attempt(Object.keys(notes).map((id) => [id, ids.get(id)]), notes);
          }
        } catch (e) {
          // request-level failure: everything not yet resolved fails
          bad = {};
          for (const [id, c] of ids) if (!results.has(rk(target, c.job.key))) bad[id] = e.message;
        }
        for (const [id, reason] of Object.entries(bad)) failures.push({ key: ids.get(id).job.key, lang: target, reason });
        done += chunk.length;
        log?.(`  [${done}/${total}] ${source} -> ${target}`);
      });
    }
  }
  await pool(tasks, cfg.concurrency);
  return { results, failures };
}

/** Write the given languages through the configured format. Returns the written file paths. */
function saveLanguages(langs, loaded, values, cfg) {
  const fmt = FORMATS[cfg.format];
  const written = [];
  const primaryOrder = loaded[cfg.primary].order;
  for (const l of langs) {
    const o = { order: primaryOrder };
    if (cfg.format === 'json') {
      o.extras = new Map([...loaded[l].extras, ...(l === cfg.primary ? [] : loaded[cfg.primary].extras)]);
    } else {
      o.meta = loaded[l].meta;
      o.globals = loaded[l].globals;
    }
    written.push(...fmt.save(l, values[l], cfg, o));
  }
  return written;
}

/** Fail early when the review provider has no API key. */
function assertReviewReady(cfg) {
  if (cfg.review.provider === 'claude-cli') return PROVIDERS['claude-cli'].assertReady();
  if (!process.env[cfg.review.apiKeyEnv]) {
    throw new Error(`Review is enabled but no API key was found.\nSet ${cfg.review.apiKeyEnv} (environment variable or .env file), or use --no-review.`);
  }
}

/**
 * Show the estimated cost before spending money and, above `cfg.confirmAbove` USD, ask `opts.confirm`.
 * Without a confirm callback (library use) nothing is asked.
 */
async function confirmCost(estimate, cfg, opts, log) {
  for (const l of formatUsage(estimate, { estimate: true })) log(l);
  const c = estimate.total.cost;
  if (cfg.confirmAbove === null || c === null || c <= cfg.confirmAbove || !opts.confirm) return;
  if (!(await opts.confirm(c))) throw new Error('Aborted: estimated cost not confirmed.');
}

/**
 * Run a full sync (or check / dry run).
 * @param {import('./config.js').Config} cfg
 * @param {SyncOptions} [opts]
 */
export async function runSync(cfg, opts = {}) {
  const log = opts.log ?? (() => {});
  if (opts.lang && !cfg.languages.includes(opts.lang)) {
    throw new Error(`--lang ${opts.lang} is not in "languages" (${cfg.languages.join(', ')}).`);
  }
  const loaded = loadAll(cfg);
  const values = Object.fromEntries(cfg.languages.map((l) => [l, loaded[l].values]));
  const lock = readLock(cfg.lockPath);

  const arrays = loaded[cfg.primary].arrays ? Object.fromEntries(cfg.languages.map((l) => [l, loaded[l].arrays])) : undefined;
  const full = computeDiff({ values, lock, config: cfg, arrays });
  const plan = computeDiff({ values, lock, config: cfg, only: opts.only, force: opts.force, lang: opts.lang, arrays });

  const report = {
    plan,
    pending: plan.jobs.length + plan.deletions.length > 0,
    perLang: Object.fromEntries(cfg.languages.map((l) => [l, { new: 0, updated: 0, deleted: 0, failed: 0 }])),
    failures: [],
    written: [],
    lockWritten: false,
    /** @type {ReturnType<typeof summarizeUsage> | null} estimate for the planned jobs (check / dry run) */
    estimate: null,
    /** @type {ReturnType<typeof summarizeUsage> | null} actual token usage and cost */
    usage: null,
    /** @type {import('./review.js').ReviewResult | null} */
    review: null,
  };
  const reviewOn = opts.review ?? cfg.review.enabled;
  if (opts.check || opts.dryRun) {
    if (plan.jobs.length) report.estimate = estimateJobs({ jobs: plan.jobs, cfg, loaded, review: reviewOn });
    return report;
  }

  if (plan.jobs.length) {
    if (!opts.translate) PROVIDERS[cfg.provider].assertReady(cfg);
    if (reviewOn && !opts.reviewBatch) assertReviewReady(cfg);
    await confirmCost(estimateJobs({ jobs: plan.jobs, cfg, loaded, review: reviewOn }), cfg, opts, log);
  }
  const translate = opts.translate ?? PROVIDERS[cfg.provider].translateBatch;
  const tUsage = createUsage();
  const rUsage = createUsage();

  if (cfg.gitContext) enrichWithGit(plan.jobs, cfg, lock);
  const { results, failures } = plan.jobs.length ? await runJobs(plan.jobs, cfg, loaded, translate, log, tUsage.add) : { results: new Map(), failures: [] };
  report.failures = failures;

  // Optional review of everything translated in this run, before anything is written.
  if (reviewOn && results.size) {
    const entries = [];
    for (const job of plan.jobs) {
      for (const t of job.targets) {
        const translation = results.get(`${t}\u0000${job.key}`);
        if (translation === undefined) continue;
        const e = { key: job.key, sourceLang: job.source, targetLang: t, sourceText: job.sourceNew, translation };
        if (job.source !== cfg.primary && t !== cfg.primary) {
          const ref = loaded[cfg.primary].values.get(job.key);
          if (ref !== undefined) e.reference = ref;
        }
        entries.push(e);
      }
    }
    report.review = await reviewEntries({
      entries,
      cfg,
      reviewCfg: reviewConfig(cfg),
      reviewBatch: opts.reviewBatch ?? PROVIDERS[cfg.review.provider].reviewBatch,
      onUsage: rUsage.add,
      log,
    });
    for (const f of report.review.fixes) results.set(`${f.lang}\u0000${f.key}`, f.new);
  }
  report.usage = summarizeUsage({
    translate: { model: cfg.model, ...tUsage.totals },
    review: { model: cfg.review.model, ...rUsage.totals },
  }, cfg);

  // Apply results.
  const touched = new Set();
  const executed = new Set(); // `${key}\0${target}` successfully applied
  for (const job of plan.jobs) {
    for (const t of job.targets) {
      const v = results.get(`${t}\u0000${job.key}`);
      if (v === undefined) continue;
      const existed = values[t].has(job.key);
      values[t].set(job.key, v);
      touched.add(t);
      executed.add(`${job.key}\u0000${t}`);
      report.perLang[t][existed ? 'updated' : 'new']++;
    }
  }
  for (const f of failures) report.perLang[f.lang].failed++;
  const executedDeletes = new Set();
  for (const d of plan.deletions) {
    for (const l of d.langs) {
      values[l].delete(d.key);
      touched.add(l);
      executedDeletes.add(d.key);
      report.perLang[l].deleted++;
    }
  }

  report.written.push(...saveLanguages(touched, loaded, values, cfg));

  // Lock: hashes of everything, except pairs that are still pending (failed or filtered out).
  const newLock = buildLock(values, cfg.languages);
  const restore = (lang, key) => {
    const old = lock?.languages?.[lang]?.[key];
    if (old === undefined) delete newLock.languages[lang][key];
    else newLock.languages[lang][key] = old;
  };
  for (const job of full.jobs) {
    for (const t of job.targets) {
      if (executed.has(`${job.key}\u0000${t}`)) continue;
      restore(t, job.key);
      restore(job.source, job.key);
    }
  }
  for (const d of full.deletions) {
    if (!executedDeletes.has(d.key) || d.langs.some((l) => values[l].has(d.key))) restore(cfg.primary, d.key);
  }
  report.lockWritten = writeLock(cfg.lockPath, newLock);
  return report;
}

/**
 * @typedef {Object} ReviewOptions
 * @property {string} [lang]   only this (non-primary) language
 * @property {string} [only]   only keys starting with this prefix
 * @property {boolean} [dryRun] print fixes without applying them
 * @property {(args: any) => Promise<Record<string,any>>} [reviewBatch] injected review function
 * @property {(msg: string) => void} [log]
 * @property {(estimatedUsd: number) => Promise<boolean>} [confirm] asked when the estimate exceeds `confirmAbove`
 */

/**
 * Review ALL existing translations of the selected target languages against the primary text.
 * @param {import('./config.js').Config} cfg
 * @param {ReviewOptions} [opts]
 */
export async function runReview(cfg, opts = {}) {
  const log = opts.log ?? (() => {});
  if (opts.lang && !cfg.languages.includes(opts.lang)) {
    throw new Error(`--lang ${opts.lang} is not in "languages" (${cfg.languages.join(', ')}).`);
  }
  if (opts.lang === cfg.primary) throw new Error(`--lang ${opts.lang} is the primary language; choose a target language to review.`);
  const loaded = loadAll(cfg);
  const values = Object.fromEntries(cfg.languages.map((l) => [l, loaded[l].values]));
  const lock = readLock(cfg.lockPath);
  const arrays = loaded[cfg.primary].arrays ? Object.fromEntries(cfg.languages.map((l) => [l, loaded[l].arrays])) : undefined;
  const full = computeDiff({ values, lock, config: cfg, arrays });
  if (full.jobs.length + full.deletions.length > 0) {
    throw new Error('Translations are pending (run "i18n-sync" first, then review); refusing to review a half-synced project.');
  }
  if (!opts.reviewBatch) assertReviewReady(cfg);

  const targets = opts.lang ? [opts.lang] : cfg.languages.filter((l) => l !== cfg.primary);
  const entries = [];
  for (const t of targets) {
    for (const [key, translation] of values[t]) {
      if (opts.only && !key.startsWith(opts.only)) continue;
      const sourceText = values[cfg.primary].get(key);
      if (sourceText === undefined || sourceText.trim() === '') continue;
      entries.push({ key, sourceLang: cfg.primary, targetLang: t, sourceText, translation });
    }
  }

  await confirmCost(estimateReview({ entries, cfg }), cfg, opts, log);
  const usage = createUsage();
  const result = await reviewEntries({
    entries,
    cfg,
    reviewCfg: reviewConfig(cfg),
    reviewBatch: opts.reviewBatch ?? PROVIDERS[cfg.review.provider].reviewBatch,
    onUsage: usage.add,
    log,
  });
  const report = {
    review: result,
    dryRun: !!opts.dryRun,
    usage: summarizeUsage({ review: { model: cfg.review.model, ...usage.totals } }, cfg),
    written: [],
    lockWritten: false,
  };
  if (opts.dryRun || !result.fixes.length) return report;

  const touched = new Set();
  for (const f of result.fixes) {
    values[f.lang].set(f.key, f.new);
    touched.add(f.lang);
    // Keep the lock in step so the fix is not mistaken for a human edit on the next sync.
    if (lock?.languages?.[f.lang]) lock.languages[f.lang][f.key] = hashValue(f.new);
  }
  report.written = saveLanguages(touched, loaded, values, cfg);
  if (lock) report.lockWritten = writeLock(cfg.lockPath, lock);
  return report;
}

/** Human readable review command result. */
export function formatReviewReport(report) {
  return [...formatReview(report.review, { dryRun: report.dryRun }), ...formatUsage(report.usage)];
}

/** Human readable plan (dry-run / check). @param {ReturnType<typeof computeDiff>} plan */
export function formatPlan(plan) {
  const lines = [];
  for (const c of plan.conflicts) {
    lines.push(`warning: ${c.key} changed in ${c.langs.join(', ')}; using ${c.winner}`);
  }
  for (const j of plan.jobs) {
    lines.push(`${j.realign ? 'realign' : j.mode === 'new' ? 'new    ' : 'update '} ${j.key}  ${j.source} -> ${j.targets.join(', ')}`);
  }
  for (const d of plan.deletions) lines.push(`delete  ${d.key}  (${d.langs.join(', ')})`);
  return lines;
}

/** Estimated token usage and cost lines (dry-run / check). @param {{estimate: any}} report */
export function formatEstimate(report) {
  return report.estimate ? formatUsage(report.estimate, { estimate: true }) : [];
}

/** Human readable result summary. */
export function formatReport(report) {
  const lines = [];
  for (const c of report.plan.conflicts) {
    lines.push(`warning: ${c.key} changed in ${c.langs.join(', ')}; using ${c.winner}`);
  }
  for (const [lang, s] of Object.entries(report.perLang)) {
    if (s.new + s.updated + s.deleted + s.failed === 0) continue;
    lines.push(`${lang}: ${s.updated} updated, ${s.new} new, ${s.deleted} deleted${s.failed ? `, ${s.failed} FAILED` : ''}`);
  }
  for (const f of report.failures) lines.push(`failed: ${f.lang} ${f.key}: ${f.reason} (will retry next run)`);
  if (report.review) lines.push(...formatReview(report.review));
  if (report.usage) lines.push(...formatUsage(report.usage));
  if (!report.pending) lines.push(report.lockWritten ? 'Everything in sync; lock file updated.' : 'Everything in sync.');
  return lines;
}

/**
 * Mark the current values of the selected keys as in sync without translating anything, e.g. after
 * hand-fixing a typo in one language that should NOT propagate to the others.
 * @param {import('./config.js').Config} cfg
 * @param {{lang?: string, only?: string, log?: (msg: string) => void}} [opts]
 * @returns {{accepted: {lang: string, key: string}[], lockWritten: boolean}}
 */
export function runAccept(cfg, opts = {}) {
  if (opts.lang && !cfg.languages.includes(opts.lang)) {
    throw new Error(`--lang ${opts.lang} is not in "languages" (${cfg.languages.join(', ')}).`);
  }
  const loaded = loadAll(cfg);
  const values = Object.fromEntries(cfg.languages.map((l) => [l, loaded[l].values]));
  const lock = readLock(cfg.lockPath) ?? buildLock(values, cfg.languages);
  const accepted = [];
  for (const l of opts.lang ? [opts.lang] : cfg.languages) {
    const entries = (lock.languages[l] ??= {});
    for (const [key, v] of values[l]) {
      if (opts.only && !key.startsWith(opts.only)) continue;
      const h = hashValue(v);
      if (entries[key] === h) continue;
      entries[key] = h;
      accepted.push({ lang: l, key });
    }
  }
  return { accepted, lockWritten: writeLock(cfg.lockPath, lock) };
}
