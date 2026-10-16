import fs from 'node:fs';
import path from 'node:path';
import { resolvePattern } from '../config.js';

/**
 * @typedef {Object} ArbLoadResult
 * @property {Map<string,string>} values
 * @property {Map<string,any>} meta      `@key` blocks, keyed without the "@"
 * @property {Map<string,any>} globals   `@@xyz` entries other than `@@locale`
 * @property {string[]} order
 * @property {string[]} files
 */

/** @param {string} lang @param {import('../config.js').Config} cfg */
function filePath(lang, cfg) {
  return path.resolve(cfg.baseDir, resolvePattern(cfg.files, { lang }));
}

/** @returns {{file: string}} */
export function fileForKey(lang, _key, cfg) {
  return { file: filePath(lang, cfg) };
}

/** Parse text of an ARB file into message strings. @param {string} text */
export function parse(text) {
  return parseObject(JSON.parse(text)).values;
}

/** @param {any} obj */
function parseObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Top level of an ARB file must be an object.');
  const values = new Map();
  const meta = new Map();
  const globals = new Map();
  const order = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k === '@@locale') continue;
    if (k.startsWith('@@')) globals.set(k, v);
    else if (k.startsWith('@')) meta.set(k.slice(1), v);
    else if (typeof v === 'string') {
      values.set(k, v);
      order.push(k);
    }
  }
  return { values, meta, globals, order };
}

/**
 * @param {string} lang
 * @param {import('../config.js').Config} cfg
 * @returns {ArbLoadResult}
 */
export function load(lang, cfg) {
  const file = filePath(lang, cfg);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { values: new Map(), meta: new Map(), globals: new Map(), order: [], files: [] };
  }
  try {
    return { ...parseObject(JSON.parse(text)), files: [file] };
  } catch (e) {
    throw new Error(`Cannot read ${file}: ${e.message}`);
  }
}

/**
 * Write an ARB file. `@@locale` is set to `lang`. `opts.meta` holds the file's own `@key` blocks
 * (the sync engine passes each file's own existing blocks, so only the primary file ever gets new ones).
 * @param {string} lang
 * @param {Map<string,string>} values
 * @param {import('../config.js').Config} cfg
 * @param {{order?: string[], meta?: Map<string,any>, globals?: Map<string,any>}} [opts]
 * @returns {string[]} files written
 */
export function save(lang, values, cfg, opts = {}) {
  const meta = opts.meta ?? new Map();
  const out = { '@@locale': lang };
  for (const [k, v] of opts.globals ?? []) out[k] = v;
  const seen = new Set();
  const emit = (k) => {
    if (seen.has(k) || !values.has(k)) return;
    seen.add(k);
    out[k] = values.get(k);
    if (meta.has(k)) out[`@${k}`] = meta.get(k);
  };
  (opts.order ?? []).forEach(emit);
  [...values.keys()].forEach(emit);

  const file = filePath(lang, cfg);
  const text = JSON.stringify(out, null, 2) + '\n';
  try {
    if (fs.readFileSync(file, 'utf8') === text) return [];
  } catch { /* new file */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return [file];
}
