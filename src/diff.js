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
 * @property {boolean} [realign]       target array was misaligned; retranslated as a whole
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
 * @param {Record<string, Map<string,number>>} [input.arrays]  array path -> length per language (json format)
 * @returns {DiffResult}
 */
export function computeDiff({ values, lock, config, only, force = false, lang, arrays }) {
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
    // A key new to every language (e.g. added to en and el in one commit) is not an edit of anything:
    // the languages that have it are taken as already translated, the rest are filled from the primary.
    if (h === undefined) return languages.some((x) => lock.languages[x]?.[k] !== undefined);
    return h !== hashValue(v);
  };

  const jobs = [];
  const deletions = [];
  const conflicts = [];

  // Arrays are positional: when a language's array has a different length than the source's, its
  // elements no longer line up, so per-key comparison is meaningless. Re-translate that language's
  // whole array from the source and drop its surplus elements.
  const handled = new Set(); // `${lang}\0${key}` taken care of here, skipped by the per-key pass below
  const isHandled = (l, k) => handled.has(`${l}\u0000${k}`);
  if (arrays) {
    const paths = [...new Set(languages.flatMap((l) => [...(arrays[l]?.keys() ?? [])]))].sort((a, b) => a.length - b.length);
    const done = Object.fromEntries(languages.map((l) => [l, []])); // misaligned paths per language
    const under = (keys, p) => [...keys].filter((k) => k.startsWith(`${p}.`));
    for (const p of paths) {
      const withArr = languages.filter((l) => arrays[l]?.has(p));
      if (new Set(withArr.map((l) => arrays[l].get(p))).size <= 1) continue;
      const touched = withArr.filter((l) => {
        const cur = under(values[l]?.keys() ?? [], p);
        const tracked = lock?.languages?.[l];
        if (!tracked) return false;
        // removals only count for the primary (same rule as single keys: deletions propagate from the primary only)
        // additions count for every language
        const before = under(Object.keys(tracked), p).length;
        return cur.some((k) => changed(l, k)) || cur.length > before || (l === primary && before !== cur.length);
      });
      let src = force && withArr.includes(primary) ? primary : touched.includes(primary) ? primary : touched[0];
      if (!src) src = withArr.includes(primary) ? primary : withArr[0];
      if (!force && touched.length > 1) conflicts.push({ key: p, langs: touched, winner: src });
      const srcKeys = under(values[src].keys(), p);
      for (const l of withArr) {
        if (l === src || arrays[l].get(p) === arrays[src].get(p)) continue;
        if (done[l].some((q) => p.startsWith(`${q}.`))) continue; // an outer array already covers it
        done[l].push(p);
        const own = under(values[l].keys(), p);
        for (const k of [...own, ...srcKeys]) handled.add(`${l}\u0000${k}`);
        if (lang && l !== lang) continue;
        const surplus = own.filter((k) => !values[src].has(k) && (!only || k.startsWith(only)));
        if (surplus.length) surplus.forEach((k) => deletions.push({ key: k, langs: [l] }));
        for (const k of srcKeys) {
          if (only && !k.startsWith(only)) continue;
          jobs.push({ key: k, source: src, targets: [l], mode: 'new', realign: true, sourceNew: val(src, k), existing: {} });
        }
      }
    }
  }

  for (const key of selected) {
    const present = languages.filter((l) => val(l, key) !== undefined && !isHandled(l, key));

    // Deleted from the primary -> propagate.
    if (lock?.languages?.[primary]?.[key] !== undefined && val(primary, key) === undefined) {
      const langs = present.filter((l) => !lang || l === lang);
      if (langs.length) deletions.push({ key, langs });
      continue;
    }
    if (present.length === 0) continue;

    let changedLangs = languages.filter((l) => !isHandled(l, key) && changed(l, key));
    if (force && val(primary, key) !== undefined) changedLangs = [primary];

    let source;
    let targets;
    if (changedLangs.length > 0) {
      source = changedLangs.includes(primary) ? primary : changedLangs[0];
      if (changedLangs.length > 1) conflicts.push({ key, langs: changedLangs, winner: source });
      targets = languages.filter((l) => l !== source && !isHandled(l, key));
    } else {
      const missing = languages.filter((l) => val(l, key) === undefined && !isHandled(l, key));
      if (missing.length === 0) continue;
      source = present.includes(primary) ? primary : present[0];
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
