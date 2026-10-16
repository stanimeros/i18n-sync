import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import { buildPrompt, buildReviewPrompt, parseJsonObject } from './prompts.js';

/**
 * Run `claude -p` once. The prompt replaces Claude Code's own system prompt (no tools, no session
 * file) and runs from the temp dir so no project instructions are loaded. Uses whatever account the
 * CLI is logged in with; the CLI reports the request's cost itself.
 * @param {{system: string, user: string, model: string, bin?: string}} args
 * @returns {Promise<any>} the CLI's JSON result object
 */
export function runClaude({ system, user, model, bin = 'claude' }) {
  const args = ['-p', '--output-format', 'json', '--model', model, '--system-prompt', system, '--tools', '', '--no-session-persistence'];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`Could not run the Claude CLI (${e.message}). Install Claude Code and log in: https://claude.com/claude-code`)));
    child.on('close', (code) => {
      let res;
      try {
        res = JSON.parse(out);
      } catch {
        return reject(new Error(`Claude CLI failed (exit ${code}): ${(err || out).trim().slice(0, 300)}`));
      }
      if (res.is_error) return reject(new Error(`Claude CLI error: ${String(res.result ?? res.subtype ?? 'unknown').slice(0, 300)}`));
      resolve(res);
    });
    child.stdin.end(user);
  });
}

/** Send one request and return the parsed JSON object. */
async function generate({ system, user, cfg, onUsage, run = runClaude }) {
  const res = await run({ system, user, model: cfg.model });
  if (onUsage) {
    const u = res.usage ?? {};
    onUsage({
      input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      output: u.output_tokens ?? 0,
      cost: typeof res.total_cost_usd === 'number' ? res.total_cost_usd : undefined,
    });
  }
  if (res.stop_reason === 'refusal') throw new Error('Claude refused the request');
  if (typeof res.result !== 'string' || !res.result.trim()) throw new Error('Claude CLI returned no content');
  return parseJsonObject(res.result, 'Claude CLI');
}

/** @param {{items: any[], sourceLang: string, targetLang: string, cfg: any, note?: string, onUsage?: Function, run?: Function}} args */
export async function translateBatch({ items, sourceLang, targetLang, cfg, note, ...rest }) {
  return generate({ system: buildPrompt({ sourceLang, targetLang, cfg, note }), user: JSON.stringify(items), cfg, ...rest });
}

/** @param {{items: any[], sourceLang: string, targetLang: string, cfg: any, onUsage?: Function, run?: Function}} args */
export async function reviewBatch({ items, sourceLang, targetLang, cfg, ...rest }) {
  return generate({ system: buildReviewPrompt({ sourceLang, targetLang, cfg }), user: JSON.stringify(items), cfg, ...rest });
}

export const provider = {
  name: 'claude-cli',
  assertReady() {
    try {
      execFileSync('claude', ['--version'], { stdio: 'ignore' });
    } catch {
      throw new Error('The claude-cli provider needs the Claude Code CLI on PATH (and a logged-in account): https://claude.com/claude-code');
    }
  },
  translateBatch,
  reviewBatch,
};
