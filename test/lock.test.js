import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hashValue, readLock, writeLock, buildLock, serializeLock } from '../src/lock.js';
import { tmpDir } from './helpers.js';

test('hash is 16 hex chars and exact', () => {
  assert.match(hashValue('x'), /^[0-9a-f]{16}$/);
  assert.notEqual(hashValue('x'), hashValue('x '));
});

test('round trip with sorted keys', () => {
  const f = path.join(tmpDir(), 'sub', 'lock.json');
  assert.equal(readLock(f), null);
  const lock = buildLock({ el: new Map([['b', '2'], ['a', '1']]), en: new Map() }, ['en', 'el']);
  assert.equal(writeLock(f, lock), true);
  assert.equal(writeLock(f, lock), false);
  const back = readLock(f);
  assert.deepEqual(back, lock);
  const text = serializeLock(lock);
  assert.ok(text.indexOf('"a"') < text.indexOf('"b"'));
  assert.ok(text.indexOf('"el"') < text.indexOf('"en"'));
  assert.ok(text.endsWith('\n'));
});
