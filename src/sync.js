import { computeDiff } from './diff.js';
import { readLock, writeLock, buildLock, hashValue } from './lock.js';
import { validateTranslation } from './placeholders.js';
import * as jsonFormat from './formats/json.js';
import * as arbFormat from './formats/arb.js';
import { fileAt, fileHistory } from './git.js';
import { provider as gemini } from './llm/gemini.js';

const FORMATS = { json: jsonFormat, arb: arbFormat };
const PROVIDERS = { gemini };
const CONCURRENCY = 4;

/**
 * @typedef {Object} SyncOptions
 * @property {boolean} [check]
 * @property {boolean} [dryRun]
 * @property {string} [only]
 * @property {boolean} [force]
 * @property {string} [lang]
 * @property {(args: {items: any[], sourceLang: string, targetLang: string, cfg: any, note?: string}) => Promise<Record<string,string>>} [translate]
 *   injected translate function (defaults to the configured provider)
 * @property {(msg: string) => void} [log]
 */

/** Run async tasks with a concurrency limit. */
async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

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
async function runJobs(jobs, cfg, loaded, translate, log) {
  const rk = (lang, key) => `${lang}\u0000${key}`;
  const groups = new Map(); // `${source}->${target}` -> {source, target, entries}
  for (const job of jobs) {
    for (const target of job.targets) {
      const g = `${job.source}->${target}`;
      if (!groups.has(g)) groups.set(g, { source: job.source, target, entries: [] });
      groups.get(g).entries.push({ job, target });
    }
  }

  /** @type {(() => Promise<void>)[]} */
  const tasks = [];
  const results = new Map();
  const failures = [];

  const buildItem = (job, target, id) => {
    const item = { id, text: job.sourceNew };
    const current = job.existing[target];
    if (current !== undefined && job.sourceOld !== undefined) {
      item.previousSource = job.sourceOld;
      item.currentTranslation = current;
    } else if (current !== undefined) {
      item.currentTranslation = current;
    }
    if (job.source !== cfg.primary && target !== cfg.primary) {
      const ref = loaded[cfg.primary].values.get(job.key);
      if (ref !== undefined) item.reference = ref;
    }
    return item;
  };

  for (const { source, target, entries } of groups.values()) {
    for (let i = 0; i < entries.length; i += cfg.batchSize) {
      const chunk = entries.slice(i, i + cfg.batchSize);
      tasks.push(async () => {
        const note = chunk.map((c) => c.job.note).find(Boolean);
        const ids = new Map(chunk.map((c, n) => [String(n), c]));
        const attempt = async (pending, failureNotes) => {
          const items = pending.map(([id, c]) => {
            const item = buildItem(c.job, c.target, id);
            if (failureNotes?.[id]) item.failure = failureNotes[id];
            return item;
          });
          const out = await translate({ items, sourceLang: source, targetLang: target, cfg, note });
          const bad = {};
          for (const [id, c] of pending) {
            const v = out?.[id];
            const res = v === undefined ? { ok: false, reason: 'missing from response' } : validateTranslation(c.job.sourceNew, v);
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
      });
    }
  }
  await pool(tasks, CONCURRENCY);
  return { results, failures };
}

/**
 * Run a full sync (or check / dry run).
 * @param {import('./config.js').Config} cfg
 * @param {SyncOptions} [opts]
 */
export async function runSync(cfg, opts = {}) {
  const log = opts.log ?? (() => {});
  const fmt = FORMATS[cfg.format];
  if (opts.lang && !cfg.languages.includes(opts.lang)) {
    throw new Error(`--lang ${opts.lang} is not in "languages" (${cfg.languages.join(', ')}).`);
  }
  const loaded = loadAll(cfg);
  const values = Object.fromEntries(cfg.languages.map((l) => [l, loaded[l].values]));
  const lock = readLock(cfg.lockPath);

  const full = computeDiff({ values, lock, config: cfg });
  const plan = computeDiff({ values, lock, config: cfg, only: opts.only, force: opts.force, lang: opts.lang });

  const report = {
    plan,
    pending: plan.jobs.length + plan.deletions.length > 0,
    perLang: Object.fromEntries(cfg.languages.map((l) => [l, { new: 0, updated: 0, deleted: 0, failed: 0 }])),
    failures: [],
    written: [],
    lockWritten: false,
  };
  if (opts.check || opts.dryRun) return report;

  if (plan.jobs.length) {
    if (!opts.translate) PROVIDERS[cfg.provider].assertReady(cfg);
  }
  const translate = opts.translate ?? PROVIDERS[cfg.provider].translateBatch;

  if (cfg.gitContext) enrichWithGit(plan.jobs, cfg, lock);
  const { results, failures } = plan.jobs.length ? await runJobs(plan.jobs, cfg, loaded, translate, log) : { results: new Map(), failures: [] };
  report.failures = failures;

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

  // Write files (only languages that changed).
  const primaryOrder = loaded[cfg.primary].order;
  for (const l of touched) {
    const o = { order: primaryOrder };
    if (cfg.format === 'json') {
      o.extras = new Map([...loaded[l].extras, ...(l === cfg.primary ? [] : loaded[cfg.primary].extras)]);
    } else {
      o.meta = loaded[l].meta;
      o.globals = loaded[l].globals;
    }
    report.written.push(...fmt.save(l, values[l], cfg, o));
  }

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

/** Human readable plan (dry-run / check). @param {ReturnType<typeof computeDiff>} plan */
export function formatPlan(plan) {
  const lines = [];
  for (const c of plan.conflicts) {
    lines.push(`warning: ${c.key} changed in ${c.langs.join(', ')}; using ${c.winner}`);
  }
  for (const j of plan.jobs) {
    lines.push(`${j.mode === 'new' ? 'new   ' : 'update'} ${j.key}  ${j.source} -> ${j.targets.join(', ')}`);
  }
  for (const d of plan.deletions) lines.push(`delete ${d.key}  (${d.langs.join(', ')})`);
  return lines;
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
  if (!report.pending) lines.push(report.lockWritten ? 'Everything in sync; lock file updated.' : 'Everything in sync.');
  return lines;
}
