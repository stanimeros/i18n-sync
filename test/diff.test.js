import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDiff } from '../src/diff.js';
import { maps, lockOf } from './helpers.js';

const config = { languages: ['en', 'el', 'de'], primary: 'en' };
const run = (values, lock, extra = {}) => computeDiff({ values: maps(values), lock, config, ...extra });

test('first run: in sync values produce nothing, lockOnly true', () => {
  const r = run({ en: { a: 'A' }, el: { a: 'Α' }, de: { a: 'a' } }, null);
  assert.deepEqual(r.jobs, []);
  assert.equal(r.lockOnly, true);
});

test('first run: missing keys filled from primary', () => {
  const r = run({ en: { a: 'A', b: 'B' }, el: { a: 'Α' }, de: {} }, null);
  assert.equal(r.jobs.length, 2);
  const a = r.jobs.find((j) => j.key === 'a');
  assert.deepEqual(a.targets, ['de']);
  assert.equal(a.source, 'en');
  assert.equal(a.mode, 'new');
  const b = r.jobs.find((j) => j.key === 'b');
  assert.deepEqual(b.targets, ['el', 'de']);
  assert.equal(r.lockOnly, false);
});

test('first run: source is first config language having key when primary lacks it', () => {
  const r = run({ en: {}, el: {}, de: { x: 'X' } }, null);
  assert.equal(r.jobs[0].source, 'de');
  assert.deepEqual(r.jobs[0].targets, ['en', 'el']);
  const r2 = run({ en: {}, el: { x: 'X' }, de: { x: 'Y' } }, null);
  assert.equal(r2.jobs[0].source, 'el');
  assert.deepEqual(r2.jobs[0].targets, ['en']);
});

test('in sync with lock: nothing to do, lockOnly false', () => {
  const v = { en: { a: 'A' }, el: { a: 'Α' }, de: { a: 'a' } };
  const r = run(v, lockOf(v));
  assert.deepEqual(r, { jobs: [], deletions: [], conflicts: [], lockOnly: false });
});

test('change in one non-primary language propagates to all others (update)', () => {
  const old = { en: { a: 'A' }, el: { a: 'Α' }, de: { a: 'a' } };
  const cur = { ...old, el: { a: 'Β' } };
  const r = run(cur, lockOf(old));
  assert.equal(r.jobs.length, 1);
  const j = r.jobs[0];
  assert.equal(j.source, 'el');
  assert.deepEqual(j.targets, ['en', 'de']);
  assert.equal(j.mode, 'update');
  assert.equal(j.sourceNew, 'Β');
  assert.deepEqual(j.existing, { en: 'A', de: 'a' });
  assert.equal(r.conflicts.length, 0);
});

test('change in primary', () => {
  const old = { en: { a: 'A' }, el: { a: 'Α' }, de: { a: 'a' } };
  const r = run({ ...old, en: { a: 'A2' } }, lockOf(old));
  assert.equal(r.jobs[0].source, 'en');
  assert.deepEqual(r.jobs[0].targets, ['el', 'de']);
});

test('new key added by human in one language: mode new', () => {
  const old = { en: { a: 'A' }, el: { a: 'Α' }, de: { a: 'a' } };
  const r = run({ ...old, el: { a: 'Α', n: 'Ν' } }, lockOf(old));
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].key, 'n');
  assert.equal(r.jobs[0].source, 'el');
  assert.equal(r.jobs[0].mode, 'new');
  assert.deepEqual(r.jobs[0].existing, {});
});

test('conflict: primary wins', () => {
  const old = { en: { a: 'A' }, el: { a: 'Α' }, de: { a: 'a' } };
  const r = run({ en: { a: 'A2' }, el: { a: 'Β' }, de: { a: 'a' } }, lockOf(old));
  assert.equal(r.jobs[0].source, 'en');
  assert.deepEqual(r.jobs[0].targets, ['el', 'de']);
  assert.deepEqual(r.conflicts, [{ key: 'a', langs: ['en', 'el'], winner: 'en' }]);
});

test('conflict without primary: first in config order wins', () => {
  const old = { en: { a: 'A' }, el: { a: 'Α' }, de: { a: 'a' } };
  const r = run({ en: { a: 'A' }, el: { a: 'Β' }, de: { a: 'x' } }, lockOf(old));
  assert.equal(r.jobs[0].source, 'el');
  assert.deepEqual(r.jobs[0].targets, ['en', 'de']);
  assert.deepEqual(r.conflicts, [{ key: 'a', langs: ['el', 'de'], winner: 'el' }]);
});

test('missing in some languages, not changed: fill only missing from primary', () => {
  const old = { en: { a: 'A' }, el: { a: 'Α' }, de: { a: 'a' } };
  const r = run({ en: { a: 'A' }, el: {}, de: { a: 'a' } }, lockOf(old));
  // deleted from a non-primary language: refill
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].source, 'en');
  assert.deepEqual(r.jobs[0].targets, ['el']);
  assert.equal(r.jobs[0].mode, 'new');
  assert.equal(r.deletions.length, 0);
});

test('deleted from primary propagates to all languages', () => {
  const old = { en: { a: 'A', b: 'B' }, el: { a: 'Α', b: 'Β' }, de: { a: 'a', b: 'b' } };
  const r = run({ en: { a: 'A' }, el: { a: 'Α', b: 'Β' }, de: { a: 'a', b: 'b' } }, lockOf(old));
  assert.deepEqual(r.deletions, [{ key: 'b', langs: ['el', 'de'] }]);
  assert.equal(r.jobs.length, 0);
});

test('deleted from primary wins even if another language edited the key', () => {
  const old = { en: { a: 'A' }, el: { a: 'Α' }, de: { a: 'a' } };
  const r = run({ en: {}, el: { a: 'Z' }, de: { a: 'a' } }, lockOf(old));
  assert.equal(r.jobs.length, 0);
  assert.deepEqual(r.deletions, [{ key: 'a', langs: ['el', 'de'] }]);
});

test('new language in config: all keys filled', () => {
  const old = { en: { a: 'A', b: 'B' }, el: { a: 'Α', b: 'Β' } };
  const lock = lockOf(old);
  const r = run({ en: old.en, el: old.el, de: {} }, lock);
  assert.equal(r.jobs.length, 2);
  for (const j of r.jobs) {
    assert.deepEqual(j.targets, ['de']);
    assert.equal(j.source, 'en');
  }
});

test('new language with an existing file is considered in sync (untracked)', () => {
  const old = { en: { a: 'A' }, el: { a: 'Α' } };
  const r = run({ ...old, de: { a: 'x' } }, lockOf(old));
  assert.deepEqual(r.jobs, []);
  assert.equal(r.lockOnly, true);
});

test('--only restricts by prefix', () => {
  const v = { en: { 'a.x': 'X', 'b.y': 'Y' }, el: {}, de: {} };
  const r = run(v, null, { only: 'a.' });
  assert.deepEqual(r.jobs.map((j) => j.key), ['a.x']);
});

test('--force retranslates everything from primary', () => {
  const v = { en: { a: 'A' }, el: { a: 'Α' }, de: { a: 'a' } };
  const r = run(v, lockOf(v), { force: true });
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].source, 'en');
  assert.deepEqual(r.jobs[0].targets, ['el', 'de']);
  assert.equal(r.jobs[0].mode, 'update');
  const r2 = run(v, lockOf(v), { force: true, only: 'zzz' });
  assert.equal(r2.jobs.length, 0);
});

test('--force ignores edits in other languages (primary wins, no conflict)', () => {
  const old = { en: { a: 'A' }, el: { a: 'Α' }, de: { a: 'a' } };
  const r = run({ ...old, el: { a: 'edited' } }, lockOf(old), { force: true });
  assert.equal(r.jobs[0].source, 'en');
  assert.equal(r.conflicts.length, 0);
});

test('--lang restricts targets', () => {
  const v = { en: { a: 'A' }, el: {}, de: {} };
  const r = run(v, null, { lang: 'de' });
  assert.deepEqual(r.jobs[0].targets, ['de']);
});

test('lockOnly when lock is stale but nothing pending', () => {
  const old = { en: { a: 'A' }, el: { a: 'Α' }, de: { a: 'a' } };
  const lock = lockOf(old);
  delete lock.languages.de.a;
  const r = run({ en: { a: 'A' }, el: { a: 'Α' }, de: { a: 'a' } }, lock);
  // absent from lock for de but present elsewhere: treated as human-added in de
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].source, 'de');
});

// --- arrays ---------------------------------------------------------------
const arr = (o) => Object.fromEntries(Object.entries(o).map(([l, a]) => [l, new Map(Object.entries(a))]));

test('arrays: middle element missing in target -> whole array retranslated, no misaligned per-key jobs', () => {
  const en = { 'rows.0': 'A', 'rows.1': 'B', 'rows.2': 'C', t: 'T' };
  const el = { 'rows.0': 'Α', 'rows.1': 'Γ', t: 'Τ' };
  const r = run({ en, el, de: { ...en } }, null, { arrays: arr({ en: { rows: 3 }, el: { rows: 2 }, de: { rows: 3 } }) });
  const rows = r.jobs.filter((j) => j.key.startsWith('rows.'));
  assert.deepEqual(rows.map((j) => [j.key, j.source, j.targets, j.mode]), [
    ['rows.0', 'en', ['el'], 'new'],
    ['rows.1', 'en', ['el'], 'new'],
    ['rows.2', 'en', ['el'], 'new'],
  ]);
  assert.ok(rows.every((j) => Object.keys(j.existing).length === 0));
  assert.deepEqual(r.deletions, []);
});

test('arrays: element added in Greek -> Greek is the source for the whole array', () => {
  const synced = { en: { 'l.0': 'A' }, el: { 'l.0': 'Α' }, de: { 'l.0': 'a' } };
  const lock = lockOf(synced);
  const r = run({ en: { 'l.0': 'A' }, el: { 'l.0': 'Α', 'l.1': 'Β' }, de: { 'l.0': 'a' } }, lock, {
    arrays: arr({ en: { l: 1 }, el: { l: 2 }, de: { l: 1 } }),
  });
  assert.deepEqual(r.jobs.map((j) => [j.key, j.source, j.targets]), [
    ['l.0', 'el', ['en']], ['l.1', 'el', ['en']], ['l.0', 'el', ['de']], ['l.1', 'el', ['de']],
  ]);
});

test('arrays: element removed from primary -> surplus deleted in targets', () => {
  const synced = { en: { 'l.0': 'A', 'l.1': 'B' }, el: { 'l.0': 'Α', 'l.1': 'Β' }, de: { 'l.0': 'a', 'l.1': 'b' } };
  const r = run({ en: { 'l.0': 'B' }, el: synced.el, de: synced.de }, lockOf(synced), {
    arrays: arr({ en: { l: 1 }, el: { l: 2 }, de: { l: 2 } }),
  });
  assert.deepEqual(r.deletions.map((d) => [d.key, d.langs]).sort(), [['l.1', ['de']], ['l.1', ['el']]]);
  assert.deepEqual(r.jobs.map((j) => [j.key, j.targets]), [['l.0', ['el']], ['l.0', ['de']]]);
});

test('arrays: equal lengths fall back to per-key rules', () => {
  const r = run({ en: { 'l.0': 'A', 'l.1': 'B' }, el: { 'l.0': 'Α' }, de: {} }, null, {
    arrays: arr({ en: { l: 2 }, el: { l: 1 } }),
  });
  // el misaligned (1 vs 2) -> full retranslate; de has no array -> normal missing-key fill
  const el = r.jobs.filter((j) => j.targets.includes('el')).map((j) => j.key);
  assert.deepEqual(el, ['l.0', 'l.1']);
  const de = r.jobs.filter((j) => j.targets.includes('de')).map((j) => j.key);
  assert.deepEqual(de, ['l.0', 'l.1']);
});

test('arrays: element removed only in Greek -> refilled from primary, not propagated', () => {
  const synced = { en: { 'l.0': 'A', 'l.1': 'B' }, el: { 'l.0': 'Α', 'l.1': 'Β' }, de: { 'l.0': 'a', 'l.1': 'b' } };
  const r = run({ en: synced.en, el: { 'l.0': 'Α' }, de: synced.de }, lockOf(synced), {
    arrays: arr({ en: { l: 2 }, el: { l: 1 }, de: { l: 2 } }),
  });
  assert.deepEqual(r.deletions, []);
  assert.deepEqual(r.jobs.map((j) => [j.key, j.source, j.targets]), [['l.0', 'en', ['el']], ['l.1', 'en', ['el']]]);
});

test('key added to several languages at once is not a conflict; only missing languages are filled', () => {
  const lock = lockOf({ en: { a: 'A' }, el: { a: 'Α' }, de: { a: 'a' } });
  const r = run({ en: { a: 'A', n: 'New' }, el: { a: 'Α', n: 'Νέο' }, de: { a: 'a' } }, lock);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.jobs.map((j) => [j.key, j.source, j.targets]), [['n', 'en', ['de']]]);
});

test('key added only in Greek still propagates from Greek', () => {
  const lock = lockOf({ en: { a: 'A' }, el: { a: 'Α' }, de: { a: 'a' } });
  const r = run({ en: { a: 'A' }, el: { a: 'Α', n: 'Νέο' }, de: { a: 'a' } }, lock);
  assert.deepEqual(r.jobs.map((j) => [j.key, j.source, j.targets]), [['n', 'el', ['en', 'de']]]);
});
