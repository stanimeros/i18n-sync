import fs from 'node:fs';
import path from 'node:path';
import { resolvePattern } from '../config.js';

/**
 * @typedef {Object} LoadResult
 * @property {Map<string,string>} values  flat key -> translatable string
 * @property {Map<string,any>} extras     non-string leaves (numbers, booleans, null, empty containers), copied verbatim
 * @property {string[]} order             all keys (values + extras) in file order
 * @property {string[]} files             files that were read
 */

const INDEX = /^(0|[1-9]\d*)$/;
const SKIP_DIRS = new Set(['node_modules', '.git']);

/**
 * Flatten a nested object. Arrays become `path.0`, `path.1`, ...
 * @param {any} obj
 * @param {string} [prefix]
 * @returns {{values: Map<string,string>, extras: Map<string,any>, order: string[]}}
 */
export function flatten(obj, prefix = '') {
  const out = { values: new Map(), extras: new Map(), order: [] };
  const walk = (node, p) => {
    const entries = Array.isArray(node) ? node.map((v, i) => [String(i), v]) : Object.entries(node);
    for (const [k, v] of entries) {
      const key = p ? `${p}.${k}` : k;
      if (typeof v === 'string') {
        out.values.set(key, v);
        out.order.push(key);
      } else if (v && typeof v === 'object' && Object.keys(v).length > 0) {
        walk(v, key);
      } else {
        out.extras.set(key, v);
        out.order.push(key);
      }
    }
  };
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Top level of a locale file must be an object.');
  walk(obj, prefix);
  return out;
}

/** @param {Record<string,any>} node */
function arrayify(node) {
  for (const k of Object.keys(node)) {
    if (node[k] && typeof node[k] === 'object') node[k] = arrayify(node[k]);
  }
  const keys = Object.keys(node);
  if (keys.length > 0 && keys.every((k) => INDEX.test(k))) {
    const nums = keys.map(Number).sort((a, b) => a - b);
    if (nums.every((n, i) => n === i)) return nums.map((n) => node[String(n)]);
  }
  return node;
}

/**
 * Rebuild a nested object (arrays included) from flat entries.
 * @param {Iterable<[string, any]>} entries
 */
export function unflatten(entries) {
  const root = {};
  for (const [key, value] of entries) {
    const parts = key.split('.');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (node[p] === undefined) node[p] = {};
      else if (typeof node[p] !== 'object' || node[p] === null) {
        throw new Error(`Key conflict: "${key}" collides with the value at "${parts.slice(0, i + 1).join('.')}".`);
      }
      node = node[p];
    }
    const last = parts[parts.length - 1];
    if (node[last] !== undefined && typeof node[last] === 'object' && node[last] !== null && typeof value !== 'object') {
      throw new Error(`Key conflict: "${key}" is both a value and a parent object.`);
    }
    node[last] = value;
  }
  return arrayify(root);
}

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Namespaces discovered on disk for a language (only when the pattern has {ns}).
 * @param {import('../config.js').Config} cfg
 * @param {string} lang
 * @returns {string[]}
 */
export function discoverNamespaces(cfg, lang) {
  if (!cfg.files.includes('{ns}')) return [];
  const pattern = resolvePattern(cfg.files, { lang }).replaceAll('\\', '/');
  const [before, after] = pattern.split('{ns}');
  const re = new RegExp(`^${escapeRe(before)}([^/]+)${escapeRe(after)}$`);
  const slash = before.lastIndexOf('/');
  const rootRel = slash === -1 ? '' : before.slice(0, slash);
  const root = path.resolve(cfg.baseDir, rootRel);
  const found = [];
  const walk = (dir) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else {
        const rel = path.relative(cfg.baseDir, full).split(path.sep).join('/');
        const m = rel.match(re);
        if (m) found.push(m[1]);
      }
    }
  };
  walk(root);
  return found;
}

/**
 * File that holds `key` for `lang`.
 * @returns {{file: string, ns?: string}}
 */
export function fileForKey(lang, key, cfg) {
  if (cfg.files.includes('{ns}')) {
    const idx = key.indexOf(':');
    const ns = idx === -1 ? '' : key.slice(0, idx);
    return { file: path.resolve(cfg.baseDir, resolvePattern(cfg.files, { lang, ns })), ns };
  }
  return { file: path.resolve(cfg.baseDir, resolvePattern(cfg.files, { lang })) };
}

/**
 * Parse the text of one file into a flat Map of translatable strings (keys prefixed with ns if given).
 * @param {string} text @param {string} [ns]
 */
export function parse(text, ns) {
  const { values } = flatten(JSON.parse(text));
  if (ns === undefined) return values;
  return new Map([...values].map(([k, v]) => [`${ns}:${k}`, v]));
}

/**
 * @param {string} lang
 * @param {import('../config.js').Config} cfg
 * @returns {LoadResult}
 */
export function load(lang, cfg) {
  const res = { values: new Map(), extras: new Map(), order: [], files: [] };
  const hasNs = cfg.files.includes('{ns}');
  const nsList = hasNs ? [...new Set([...discoverNamespaces(cfg, cfg.primary), ...discoverNamespaces(cfg, lang)])] : [undefined];
  for (const ns of nsList) {
    const file = path.resolve(cfg.baseDir, resolvePattern(cfg.files, { lang, ns }));
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // missing file -> empty
    }
    let flat;
    try {
      flat = flatten(JSON.parse(text));
    } catch (e) {
      throw new Error(`Cannot read ${file}: ${e.message}`);
    }
    const pre = ns === undefined ? '' : `${ns}:`;
    for (const [k, v] of flat.values) res.values.set(pre + k, v);
    for (const [k, v] of flat.extras) res.extras.set(pre + k, v);
    for (const k of flat.order) res.order.push(pre + k);
    res.files.push(file);
  }
  return res;
}

/**
 * Write a language's values. Key order follows `opts.order` (the primary's order), remaining keys are appended.
 * @param {string} lang
 * @param {Map<string,string>} values
 * @param {import('../config.js').Config} cfg
 * @param {{order?: string[], extras?: Map<string,any>}} [opts]
 * @returns {string[]} files written
 */
export function save(lang, values, cfg, opts = {}) {
  const extras = opts.extras ?? new Map();
  const ordered = [];
  const seen = new Set();
  const push = (k) => {
    if (!seen.has(k) && (values.has(k) || extras.has(k))) {
      seen.add(k);
      ordered.push(k);
    }
  };
  (opts.order ?? []).forEach(push);
  [...values.keys()].forEach(push);
  [...extras.keys()].forEach(push);

  const hasNs = cfg.files.includes('{ns}');
  /** @type {Map<string|undefined, Array<[string, any]>>} */
  const groups = new Map();
  if (hasNs) for (const ns of discoverNamespaces(cfg, lang)) groups.set(ns, []);
  for (const k of ordered) {
    let ns;
    let sub = k;
    if (hasNs) {
      const idx = k.indexOf(':');
      ns = idx === -1 ? '' : k.slice(0, idx);
      sub = idx === -1 ? k : k.slice(idx + 1);
    }
    if (!groups.has(ns)) groups.set(ns, []);
    groups.get(ns).push([sub, values.has(k) ? values.get(k) : extras.get(k)]);
  }
  if (!hasNs && !groups.has(undefined)) groups.set(undefined, []);

  const written = [];
  for (const [ns, entries] of groups) {
    const file = path.resolve(cfg.baseDir, resolvePattern(cfg.files, { lang, ns }));
    const out = JSON.stringify(unflatten(entries), null, 2) + '\n';
    let existing = null;
    try {
      existing = fs.readFileSync(file, 'utf8');
    } catch { /* new file */ }
    if (existing === out) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, out);
    written.push(file);
  }
  return written;
}
