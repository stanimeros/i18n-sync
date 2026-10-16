import { hashValue } from './lock.js';

/**
 * @typedef {Object} Job
 * @property {string} key
 * @property {string} source          source language
 * @property {string[]} targets
 * @property {'new'|'update'} mode
 * @property {string} [sourceOld]     filled in later from git, if available
 * @property {string} sourceNew
 * @property {Record<string,string>} existing  current values of targets that already have one
 *
 * @typedef {Object} DiffResult
 * @property {Job[]} jobs
 * @property {{key: string, langs: string[]}[]} deletions
 * @property {{key: string, langs: string[], winner: string}[]} conflicts
 * @property {boolean} lockOnly   nothing to translate or delete, but the lock file needs (re)writing
 */

/**
 * Pure change detection.
 *
 * @param {Object} input
 * @param {Record<string, Map<string,string>>} input.values  current flat values per language
 * @param {import('./lock.js').Lock | null} input.lock
 * @param {{languages: string[], primary: string}} input.config
 * @param {string} [input.only]   restrict to keys starting with this prefix
 * @param {boolean} [input.force] treat the primary as changed for every selected key
 * @param {string} [input.lang]   restrict targets (and deletions) to this language
 * @returns {DiffResult}
 */
export function computeDiff({ values, lock, config, only, force = false, lang }) {
  const { languages, primary } = config;
  const order = [primary, ...languages.filter((l) => l !== primary)]; // for key discovery
  const val = (l, k) => values[l]?.get(k);

  const keys = [];
  const seen = new Set();
  const add = (k) => {
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  };
  for (const l of order) for (const k of values[l]?.keys() ?? []) add(k);
  if (lock?.languages?.[primary]) Object.keys(lock.languages[primary]).forEach(add); // deletion detection
  const selected = only ? keys.filter((k) => k.startsWith(only)) : keys;

  /** Human changed this key in language l? */
  const changed = (l, k) => {
    const v = val(l, k);
    if (v === undefined || !lock) return false;
    const tracked = lock.languages[l];
    if (!tracked) return false; // language not in the lock yet: treat existing values as in sync
    const h = tracked[k];
    return h === undefined ? true : h !== hashValue(v);
  };

  const jobs = [];
  const deletions = [];
  const conflicts = [];

  for (const key of selected) {
    const present = languages.filter((l) => val(l, key) !== undefined);

    // Deleted from the primary -> propagate.
    if (lock?.languages?.[primary]?.[key] !== undefined && val(primary, key) === undefined) {
      const langs = present.filter((l) => !lang || l === lang);
      if (langs.length) deletions.push({ key, langs });
      continue;
    }
    if (present.length === 0) continue;

    let changedLangs = languages.filter((l) => changed(l, key));
    if (force && val(primary, key) !== undefined) changedLangs = [primary];

    let source;
    let targets;
    if (changedLangs.length > 0) {
      source = changedLangs.includes(primary) ? primary : changedLangs[0];
      if (changedLangs.length > 1) conflicts.push({ key, langs: changedLangs, winner: source });
      targets = languages.filter((l) => l !== source);
    } else {
      const missing = languages.filter((l) => val(l, key) === undefined);
      if (missing.length === 0) continue;
      source = val(primary, key) !== undefined ? primary : present[0];
      targets = missing;
    }
    if (lang) targets = targets.filter((t) => t === lang);
    if (targets.length === 0) continue;

    const existing = {};
    for (const t of targets) if (val(t, key) !== undefined) existing[t] = val(t, key);
    jobs.push({
      key,
      source,
      targets,
      mode: Object.keys(existing).length > 0 ? 'update' : 'new',
      sourceNew: val(source, key),
      existing,
    });
  }

  // Does the lock need rewriting even though nothing is pending?
  let lockDiffers = !lock;
  if (lock && !lockDiffers) {
    for (const l of languages) {
      const entries = lock.languages[l];
      const cur = values[l] ?? new Map();
      if (!entries || Object.keys(entries).length !== cur.size) {
        lockDiffers = true;
        break;
      }
      for (const [k, v] of cur) {
        if (entries[k] !== hashValue(v)) {
          lockDiffers = true;
          break;
        }
      }
      if (lockDiffers) break;
    }
  }

  return { jobs, deletions, conflicts, lockOnly: jobs.length === 0 && deletions.length === 0 && lockDiffers };
}
