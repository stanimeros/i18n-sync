import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * @typedef {{ version: 1, languages: Record<string, Record<string,string>> }} Lock
 */

/** sha256 of the exact string, first 16 hex chars. @param {string} value */
export function hashValue(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Read a lock file. Returns null when it does not exist.
 * @param {string} file
 * @returns {Lock | null}
 */
export function readLock(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Lock file is not valid JSON (${file}): ${e.message}`);
  }
  if (!data || data.version !== 1 || typeof data.languages !== 'object' || data.languages === null) {
    throw new Error(`Unsupported lock file format: ${file}`);
  }
  return data;
}

/** Stable serialization with sorted keys. @param {Lock} lock */
export function serializeLock(lock) {
  const languages = {};
  for (const lang of Object.keys(lock.languages).sort()) {
    const entries = lock.languages[lang];
    languages[lang] = {};
    for (const key of Object.keys(entries).sort()) languages[lang][key] = entries[key];
  }
  return JSON.stringify({ version: 1, languages }, null, 2) + '\n';
}

/**
 * Write a lock file only if its content changed. Returns true if written.
 * @param {string} file @param {Lock} lock
 */
export function writeLock(file, lock) {
  const out = serializeLock(lock);
  try {
    if (fs.readFileSync(file, 'utf8') === out) return false;
  } catch { /* new file */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out);
  return true;
}

/**
 * Build a lock from current values.
 * @param {Record<string, Map<string,string>>} values
 * @param {string[]} languages
 * @returns {Lock}
 */
export function buildLock(values, languages) {
  /** @type {Lock} */
  const lock = { version: 1, languages: {} };
  for (const lang of languages) {
    lock.languages[lang] = {};
    for (const [key, v] of values[lang] ?? []) lock.languages[lang][key] = hashValue(v);
  }
  return lock;
}
