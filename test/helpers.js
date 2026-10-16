import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig } from '../src/config.js';
import { hashValue } from '../src/lock.js';

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-sync-'));
}

export function write(dir, rel, content) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
}

export function read(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), 'utf8');
}

export function readJson(dir, rel) {
  return JSON.parse(read(dir, rel));
}

export function makeConfig(dir, extra = {}) {
  return normalizeConfig({ files: 'locales/{lang}.json', languages: ['en', 'el', 'de'], primary: 'en', ...extra }, dir);
}

/** values: { en: {k: v}, ... } -> Record<lang, Map> */
export function maps(obj) {
  return Object.fromEntries(Object.entries(obj).map(([l, o]) => [l, new Map(Object.entries(o))]));
}

/** lock builder: { en: {k: v} } -> lock of hashes */
export function lockOf(obj) {
  return { version: 1, languages: Object.fromEntries(Object.entries(obj).map(([l, o]) => [l, Object.fromEntries(Object.entries(o).map(([k, v]) => [k, hashValue(v)]))])) };
}
