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
