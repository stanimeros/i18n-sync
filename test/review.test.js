import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runSync, runReview, formatReport, formatReviewReport } from '../src/sync.js';
import { readLock, hashValue } from '../src/lock.js';
import { reviewBatch as geminiReview } from '../src/llm/gemini.js';
import { buildReviewPrompt } from '../src/llm/prompts.js';
import { tmpDir, write, readJson, read, makeConfig } from './helpers.js';

const fakeTranslate = async ({ items, targetLang }) => Object.fromEntries(items.map((i) => [i.id, `[${targetLang}] ${i.text}`]));

function setup(extra = {}) {
  const dir = tmpDir();
  const cfg = makeConfig(dir, { gitContext: false, languages: ['en', 'de'], ...extra });
  write(dir, 'locales/en.json', { a: 'Hello {{name}}', b: 'Save', c: 'Cancel' });
  return { dir, cfg };
}

test('review during sync applies a valid fix and rejects one that loses a placeholder', async () => {
  const { dir, cfg } = setup({ review: { enabled: true } });
  const reviewCalls = [];
  const reviewBatch = async (args) => {
    reviewCalls.push(args);
    args.onUsage({ input: 100, output: 10 });
    const out = {};
    for (const it of args.items) {
      if (it.source === 'Hello {{name}}') out[it.id] = { ok: false, issue: 'bad greeting', fixed: 'Hallo' }; // placeholder lost
      else if (it.source === 'Save') out[it.id] = { ok: false, issue: 'wrong word', fixed: 'Speichern' };
      else out[it.id] = { ok: true };
    }
    return out;
  };
  const report = await runSync(cfg, { translate: fakeTranslate, reviewBatch });
  const de = readJson(dir, 'locales/de.json');
  assert.equal(de.b, 'Speichern');
  assert.equal(de.a, '[de] Hello {{name}}'); // original kept
  assert.equal(de.c, '[de] Cancel');
  assert.deepEqual([report.review.reviewed, report.review.flagged, report.review.fixes.length, report.review.rejected.length], [3, 2, 1, 1]);
  assert.match(report.review.rejected[0].reason, /placeholders/);
  assert.equal(reviewCalls[0].items[0].source, 'Hello {{name}}');
  assert.ok(reviewCalls[0].items[0].translation);
  // lock holds the fixed value, so it is not a pending human edit
  assert.equal(readLock(cfg.lockPath).languages.de.b, hashValue('Speichern'));
  assert.equal((await runSync(cfg, { check: true })).pending, false);
  const lines = formatReport(report);
  assert.ok(lines.some((l) => l === 'de b: "[de] Save" -> "Speichern" (wrong word)'), lines.join('\n'));
  assert.ok(lines.some((l) => /^review: 3 reviewed, 2 flagged, 1 applied, 1 rejected$/.test(l)));
  assert.ok(lines.some((l) => /^review: 100 in \/ 10 out tokens/.test(l)));
});

test('--no-review style override disables review; glossary-violating fix is rejected', async () => {
  const { cfg } = setup({ review: { enabled: true }, glossary: { Save: 'Save' } });
  let called = false;
  const reviewBatch = async ({ items }) => {
    called = true;
    return Object.fromEntries(items.map((i) => [i.id, { ok: false, issue: 'x', fixed: 'Speichern' }]));
  };
  await runSync(cfg, { translate: fakeTranslate, reviewBatch, review: false });
  assert.equal(called, false);
  const { cfg: cfg2, dir } = setup({ glossary: { Save: 'Save' } });
  const r = await runSync(cfg2, { translate: async ({ items }) => Object.fromEntries(items.map((i) => [i.id, i.text])), reviewBatch, review: true });
  assert.ok(r.review.rejected.some((x) => /glossary/.test(x.reason)));
  assert.equal(readJson(dir, 'locales/de.json').b, 'Save');
});

async function synced(extra) {
  const s = setup(extra);
  await runSync(s.cfg, { translate: fakeTranslate });
  return s;
}

test('review subcommand applies fixes, updates the lock, restores whitespace', async () => {
  const { dir, cfg } = await synced();
  const reviewBatch = async ({ items }) =>
    Object.fromEntries(items.map((i) => [i.id, i.source === 'Save' ? { ok: false, issue: 'tone', fixed: ' Sichern ' } : { ok: true }]));
  const rr = await runReview(cfg, { reviewBatch });
  assert.equal(readJson(dir, 'locales/de.json').b, 'Sichern');
  assert.equal(readLock(cfg.lockPath).languages.de.b, hashValue('Sichern'));
  assert.equal(rr.review.fixes.length, 1);
  assert.equal(rr.review.reviewed, 3);
  assert.equal((await runSync(cfg, { check: true })).pending, false);
  const lines = formatReviewReport(rr);
  assert.ok(lines.some((l) => l === 'de b: "[de] Save" -> "Sichern" (tone)'));
});

test('review subcommand --dry-run writes nothing', async () => {
  const { dir, cfg } = await synced();
  const before = [read(dir, 'locales/de.json'), fs.readFileSync(cfg.lockPath, 'utf8')];
  const reviewBatch = async ({ items }) => Object.fromEntries(items.map((i) => [i.id, { ok: false, issue: 'x', fixed: 'Neu' }]));
  const rr = await runReview(cfg, { reviewBatch, dryRun: true });
  assert.equal(rr.review.fixes.length, 2);
  assert.equal(rr.review.rejected.length, 1); // 'Neu' drops {{name}}
  assert.deepEqual([read(dir, 'locales/de.json'), fs.readFileSync(cfg.lockPath, 'utf8')], before);
  assert.match(formatReviewReport(rr).at(-1), /^review: 3 reviewed, 3 flagged, 2 fixable \(not applied\), 1 rejected$/);
});

test('review subcommand refuses while sync is pending; --lang/--only filter', async () => {
  const { dir, cfg } = await synced({ languages: ['en', 'de', 'fr'] });
  const seen = [];
  const reviewBatch = async ({ items, targetLang }) => {
    seen.push([targetLang, items.map((i) => i.source)]);
    return Object.fromEntries(items.map((i) => [i.id, { ok: true }]));
  };
  await runReview(cfg, { reviewBatch, lang: 'fr', only: 'b' });
  assert.deepEqual(seen, [['fr', ['Save']]]);
  await assert.rejects(() => runReview(cfg, { reviewBatch, lang: 'en' }), /primary/);
  write(dir, 'locales/en.json', { ...readJson(dir, 'locales/en.json'), b: 'Store' });
  await assert.rejects(() => runReview(cfg, { reviewBatch }), /pending.*i18n-sync/s);
});

test('gemini reviewBatch sends the review prompt and reports usage', async () => {
  process.env.I18N_SYNC_TEST_KEY = 'k';
  const cfg = makeConfig(tmpDir(), { apiKeyEnv: 'I18N_SYNC_TEST_KEY', context: 'A todo app', tone: { de: 'formal (Sie)' }, glossary: { Todo: 'Todo' } });
  let body;
  let usage;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '```json\n{"0":{"ok":true}}\n```' }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } }) };
  };
  const out = await geminiReview({ items: [{ id: '0', source: 'Hi', translation: 'Hallo' }], sourceLang: 'en', targetLang: 'de', cfg, fetchImpl, onUsage: (u) => (usage = u) });
  assert.deepEqual(out, { 0: { ok: true } });
  assert.deepEqual(usage, { input: 7, output: 3 });
  const sys = body.systemInstruction.parts[0].text;
  assert.equal(sys, buildReviewPrompt({ sourceLang: 'en', targetLang: 'de', cfg }));
  assert.match(sys, /senior localization reviewer/);
  assert.match(sys, /A todo app/);
  assert.match(sys, /formal \(Sie\)/);
  assert.match(sys, /"Todo": never translate/);
});
