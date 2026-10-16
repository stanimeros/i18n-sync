import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Run git; return trimmed-free stdout or null on any failure.
 * @param {string[]} args @param {string} cwd
 */
function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** Repository root for `dir`, or null. @param {string} dir */
export function repoRoot(dir) {
  const out = git(['rev-parse', '--show-toplevel'], dir);
  return out ? out.trim() : null;
}

/** Path of `absFile` relative to its repo root (posix), or null. @param {string} absFile */
function relInRepo(absFile) {
  const dir = fs.realpathSync(path.dirname(absFile)); // git reports the real path (e.g. macOS /var -> /private/var)
  const root = repoRoot(dir);
  if (!root) return null;
  return { root, rel: path.relative(root, path.join(dir, path.basename(absFile))).split(path.sep).join('/') };
}

/**
 * Commits touching a file, newest first: [{rev, subject}]. Empty on any failure. Never throws.
 * @param {string} absFile @param {number} [limit]
 */
export function fileHistory(absFile, limit = 50) {
  try {
    const r = relInRepo(absFile);
    if (!r) return [];
    const out = git(['log', `-${limit}`, '--format=%H%x00%s', '--', r.rel], r.root);
    if (!out) return [];
    return out.split('\n').filter(Boolean).map((line) => {
      const [rev, subject] = line.split('\0');
      return { rev, subject };
    });
  } catch {
    return [];
  }
}

/**
 * Content of a file at a revision, or null. Never throws.
 * @param {string} absFile @param {string} rev
 */
export function fileAt(absFile, rev) {
  try {
    const r = relInRepo(absFile);
    if (!r) return null;
    return git(['show', `${rev}:${r.rel}`], r.root);
  } catch {
    return null;
  }
}
