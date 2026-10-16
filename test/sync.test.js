import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSync } from '../src/sync.js';
import { readLock } from '../src/lock.js';
import { translateBatch } from '../src/llm/gemini.js';
import { tmpDir, write, readJson, makeConfig } from './helpers.js';

/** Fake provider: "<target>:<text>" and records calls. */
function fake(calls = []) {
  const fn = async (args) => {
    calls.push(args);
    return Object.fromEntries(args.items.map((i) => [i.id, `[${args.targetLang}] ${i.text}`]));
  };
  fn.calls = calls;
  return fn;
}

function setup(extraCfg = {}) {
  const dir = tmpDir();
  const cfg = makeConfig(dir, { gitContext: false, ...extraCfg });
  write(dir, 'locales/en.json', { b: 'B', a: 'A {{n}}', nested: { x: 'X' } });
  write(dir, 'locales/el.json', { a: 'Α {{n}}' });
  return { dir, cfg };
}

test('first run fills missing keys, preserves order, writes lock', async () => {
  const { dir, cfg } = setup();
  const t = fake();
  const report = await runSync(cfg, { translate: t });
  assert.equal(report.failures.length, 0);
  const el = readJson(dir, 'locales/el.json');
  assert.deepEqual(Object.keys(el), ['b', 'a', 'nested']);
  assert.equal(el.b, '[el] B');
  assert.equal(el.a, 'Α {{n}}');
  assert.deepEqual(readJson(dir, 'locales/de.json'), { b: '[de] B', a: '[de] A {{n}}', nested: { x: '[de] X' } });
  const lock = readLock(cfg.lockPath);
  assert.equal(Object.keys(lock.languages).length, 3);
  assert.equal(Object.keys(lock.languages.de).length, 3);
  assert.equal(report.perLang.de.new, 3);
  // second run is a no-op
  const t2 = fake();
  const r2 = await runSync(cfg, { translate: t2 });
  assert.equal(t2.calls.length, 0);
  assert.equal(r2.pending, false);
});

test('edit in Greek updates English and German; sends currentTranslation', async () => {
  const { cfg, dir } = setup();
  await runSync(cfg, { translate: fake() });
  write(dir, 'locales/el.json', { ...readJson(dir, 'locales/el.json'), b: 'Β!' });
  const t = fake();
  const report = await runSync(cfg, { translate: t });
  assert.equal(t.calls.length, 2);
  assert.deepEqual(t.calls.map((c) => c.targetLang).sort(), ['de', 'en']);
  assert.ok(t.calls.every((c) => c.sourceLang === 'el' && c.items[0].text === 'Β!' && c.items[0].currentTranslation));
  assert.equal(readJson(dir, 'locales/en.json').b, '[en] Β!');
  assert.equal(report.perLang.en.updated, 1);
});

test('deletion from primary propagates', async () => {
  const { cfg, dir } = setup();
  await runSync(cfg, { translate: fake() });
  const en = readJson(dir, 'locales/en.json');
  delete en.b;
  write(dir, 'locales/en.json', en);
  const report = await runSync(cfg, { translate: fake() });
  assert.equal(report.perLang.el.deleted, 1);
  assert.equal('b' in readJson(dir, 'locales/el.json'), false);
  assert.equal('b' in readLock(cfg.lockPath).languages.de, false);
});

test('--check and --dry-run do not write or call provider', async () => {
  const { cfg, dir } = setup();
  const t = fake();
  const r = await runSync(cfg, { check: true, translate: t });
  assert.equal(r.pending, true);
  const r2 = await runSync(cfg, { dryRun: true, translate: t });
  assert.equal(r2.plan.jobs.length > 0, true);
  assert.equal(t.calls.length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'locales/de.json')), false);
  assert.equal(readLock(cfg.lockPath), null);
});

test('invalid translations are retried once, then skipped without lock update', async () => {
  const { cfg, dir } = setup({ languages: ['en', 'el'] });
  let calls = 0;
  const bad = async ({ items }) => {
    calls++;
    return Object.fromEntries(items.map((i) => [i.id, 'broken'])); // drops {{n}} for the key that has one
  };
  const report = await runSync(cfg, { translate: bad });
  // keys b and nested.x have no placeholders so "broken" is accepted; "a" exists already
  assert.equal(report.failures.length, 0);
  assert.ok(calls >= 1);

  write(dir, 'locales/en.json', { ...readJson(dir, 'locales/en.json'), a: 'A {{n}} {{m}}' });
  const before = readLock(cfg.lockPath).languages.el.a;
  calls = 0;
  const r2 = await runSync(cfg, { translate: bad });
  assert.equal(calls, 2); // original + one retry
  assert.equal(r2.failures.length, 1);
  assert.equal(r2.failures[0].key, 'a');
  assert.equal(readLock(cfg.lockPath).languages.el.a, before);
  // retried next run
  const t = fake();
  const r3 = await runSync(cfg, { translate: t });
  assert.equal(t.calls.length, 1);
  assert.equal(r3.failures.length, 0);
});

test('failure note is sent on retry', async () => {
  const { cfg } = setup({ languages: ['en', 'el'] });
  const seen = [];
  let n = 0;
  await runSync(cfg, {
    translate: async ({ items }) => {
      seen.push(items.map((i) => i.failure));
      n++;
      return Object.fromEntries(items.map((i) => [i.id, n === 1 ? '' : `ok ${i.text}`]));
    },
  });
  assert.ok(seen[1].every((f) => typeof f === 'string' && f.length > 0));
});

test('--only and --lang leave unselected work pending in the lock', async () => {
  const { cfg } = setup();
  const t = fake();
  await runSync(cfg, { translate: t, only: 'nested', lang: 'de' });
  assert.deepEqual(t.calls.map((c) => c.targetLang), ['de']);
  const r = await runSync(cfg, { check: true });
  assert.equal(r.pending, true);
  const keys = r.plan.jobs.map((j) => `${j.key}:${j.targets.join('+')}`).sort();
  assert.ok(keys.includes('b:el+de'));
  assert.ok(keys.some((k) => k.startsWith('nested.x:el')));
});

test('conflicts are reported and primary wins', async () => {
  const { cfg, dir } = setup();
  await runSync(cfg, { translate: fake() });
  write(dir, 'locales/en.json', { ...readJson(dir, 'locales/en.json'), b: 'B2' });
  write(dir, 'locales/el.json', { ...readJson(dir, 'locales/el.json'), b: 'Β2' });
  const t = fake();
  const r = await runSync(cfg, { translate: t });
  assert.equal(r.plan.conflicts[0].winner, 'en');
  assert.equal(readJson(dir, 'locales/el.json').b, '[el] B2');
});

test('missing API key with pending jobs is a clear error', async () => {
  const { cfg } = setup({ apiKeyEnv: 'I18N_SYNC_TEST_NO_SUCH_KEY' });
  await assert.rejects(() => runSync(cfg, {}), /no API key|I18N_SYNC_TEST_NO_SUCH_KEY/);
});

test('arb end-to-end keeps @@locale and primary metadata', async () => {
  const dir = tmpDir();
  const cfg = makeConfig(dir, { format: 'arb', files: 'l10n/app_{lang}.arb', languages: ['en', 'el'], gitContext: false });
  write(dir, 'l10n/app_en.arb', { '@@locale': 'en', hi: 'Hi {name}', '@hi': { description: 'd' } });
  await runSync(cfg, { translate: fake() });
  const el = readJson(dir, 'l10n/app_el.arb');
  assert.equal(el['@@locale'], 'el');
  assert.equal(el.hi, '[el] Hi {name}');
  assert.equal('@hi' in el, false);
  assert.ok('@hi' in readJson(dir, 'l10n/app_en.arb'));
});

test('gemini provider retries on 429 and parses JSON', async () => {
  process.env.I18N_SYNC_TEST_KEY = 'k';
  const cfg = makeConfig(tmpDir(), { apiKeyEnv: 'I18N_SYNC_TEST_KEY' });
  let n = 0;
  let seenReq;
  const fetchImpl = async (url, init) => {
    n++;
    seenReq = { url, init };
    if (n === 1) return { ok: false, status: 429, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"0":"Γεια"}' }] } }] }) };
  };
  const out = await translateBatch({ items: [{ id: '0', text: 'Hi' }], sourceLang: 'en', targetLang: 'el', cfg, fetchImpl, baseDelayMs: 1 });
  assert.deepEqual(out, { 0: 'Γεια' });
  assert.equal(n, 2);
  assert.match(seenReq.url, /gemini-2\.5-flash:generateContent$/);
  assert.equal(seenReq.init.headers['x-goog-api-key'], 'k');
  const body = JSON.parse(seenReq.init.body);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
});
