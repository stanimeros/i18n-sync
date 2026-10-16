import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { runSync } from '../src/sync.js';
import { tmpDir, write, makeConfig } from './helpers.js';

const git = (dir, ...args) =>
  execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

function fake(calls) {
  return async (args) => {
    calls.push(args);
    return Object.fromEntries(args.items.map((i) => [i.id, `[${args.targetLang}] ${i.text}`]));
  };
}

async function syncedRepo() {
  const dir = tmpDir();
  git(dir, 'init', '-q');
  const cfg = makeConfig(dir, { gitContext: true });
  write(dir, 'locales/en.json', { title: 'Hello' });
  write(dir, 'locales/el.json', { title: 'Γεια' });
  write(dir, 'locales/de.json', { title: 'Hallo' });
  await runSync(cfg, { translate: fake([]) });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'initial sync');
  return { dir, cfg };
}

test('git baseline: uncommitted edit sends previousSource', async () => {
  const { dir, cfg } = await syncedRepo();
  write(dir, 'locales/el.json', { title: 'Γεια σου' });
  const calls = [];
  await runSync(cfg, { translate: fake(calls) });
  const item = calls.find((c) => c.targetLang === 'en').items[0];
  assert.equal(item.previousSource, 'Γεια');
  assert.equal(item.currentTranslation, 'Hello');
});

test('git baseline: committed edits still find the synced text and use commit subjects as note', async () => {
  const { dir, cfg } = await syncedRepo();
  write(dir, 'locales/el.json', { title: 'Γεια σας' });
  git(dir, 'commit', '-qam', 'more formal greeting');
  write(dir, 'locales/el.json', { title: 'Γεια σας!' });
  git(dir, 'commit', '-qam', 'add exclamation');
  const calls = [];
  await runSync(cfg, { translate: fake(calls) });
  const call = calls.find((c) => c.targetLang === 'de');
  assert.equal(call.items[0].previousSource, 'Γεια');
  assert.equal(call.items[0].text, 'Γεια σας!');
  assert.equal(call.note, 'add exclamation; more formal greeting');
});
