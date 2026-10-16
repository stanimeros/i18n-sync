#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import readline from 'node:readline/promises';
import { loadConfig, loadDotEnv, withReviewProvider, STARTER_CONFIG, DEFAULT_CONFIG_NAME } from '../src/config.js';
import { runSync, runReview, runAccept, formatPlan, formatReport, formatEstimate, formatReviewReport } from '../src/sync.js';

const HELP = `i18n-sync - keep all locale files in sync with an LLM

Usage:
  i18n-sync [options]        Sync all languages
  i18n-sync review [options] Review ALL existing translations against the primary language
  i18n-sync accept [options] Mark current values as in sync without translating (after a hand fix
                             in one language that should not propagate); use --lang / --only
  i18n-sync init             Write a starter ${DEFAULT_CONFIG_NAME}

Options:
  --check            Make no changes or API calls; exit 1 if anything is pending (prints a cost estimate)
  --dry-run          Print the planned work and a cost estimate; make no changes or API calls
                     (with "review": print proposed fixes without applying them)
  --only <prefix>    Only keys starting with <prefix>
  --force            Retranslate selected keys from the primary language
  --lang <code>      Only update this target language
  --review           Review newly translated strings with the review model before writing
  --no-review        Disable review even if "review.enabled" is true
  --review-with <p>  Review with this provider for this run: gemini (gemini-3.6-flash) or
                     claude-cli (your logged-in Claude Code, claude-opus-5-5); implies --review
  -y, --yes          Don't ask before spending more than "confirmAbove" (default $1)
  --config <path>    Config file (default: ./${DEFAULT_CONFIG_NAME})
  -h, --help         Show this help
  -v, --version      Show version
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      check: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      only: { type: 'string' },
      force: { type: 'boolean' },
      review: { type: 'boolean' },
      'no-review': { type: 'boolean' },
      lang: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      'review-with': { type: 'string' },
      config: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.help) return void console.log(HELP);
  if (values.version) {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return void console.log(pkg.version);
  }

  const command = positionals[0];
  if (command === 'init') {
    const target = path.resolve(values.config || DEFAULT_CONFIG_NAME);
    if (fs.existsSync(target)) throw new Error(`${target} already exists.`);
    fs.writeFileSync(target, JSON.stringify(STARTER_CONFIG, null, 2) + '\n');
    console.log(`Created ${target}\nEdit it, set your API key (GEMINI_API_KEY), then run: i18n-sync`);
    return;
  }

  if (values.review && values['no-review']) throw new Error('Use either --review or --no-review, not both.');
  if (command && command !== 'review' && command !== 'accept') throw new Error(`Unknown command "${command}". Try --help.`);

  loadDotEnv(process.cwd());
  let cfg = loadConfig(values.config);
  loadDotEnv(cfg.baseDir);
  if (values['review-with']) {
    if (values['no-review']) throw new Error('Use either --review-with or --no-review, not both.');
    cfg = withReviewProvider(cfg, values['review-with']);
  }

  /** Ask before spending more than cfg.confirmAbove. */
  const confirm = async (usd) => {
    if (values.yes) return true;
    const msg = `Estimated cost ~$${usd.toFixed(2)} is above $${cfg.confirmAbove}.`;
    if (!process.stdin.isTTY) throw new Error(`${msg} Re-run with --yes to proceed.`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`${msg} Continue? [y/N] `);
    rl.close();
    return /^y(es)?$/i.test(answer.trim());
  };

  if (command === 'accept') {
    const { accepted } = runAccept(cfg, { lang: values.lang, only: values.only });
    for (const a of accepted) console.log(`accepted ${a.lang} ${a.key}`);
    console.log(accepted.length ? `${accepted.length} value(s) marked as in sync.` : 'Nothing to accept.');
    return;
  }

  if (command === 'review') {
    const rr = await runReview(cfg, { lang: values.lang, only: values.only, dryRun: values['dry-run'], confirm, log: (m) => console.log(m) });
    for (const l of formatReviewReport(rr)) console.log(l);
    if (rr.review.errors.length) process.exitCode = 1;
    return;
  }

  const report = await runSync(cfg, {
    check: values.check,
    dryRun: values['dry-run'],
    only: values.only,
    force: values.force,
    lang: values.lang,
    review: values.review ? true : values['no-review'] ? false : undefined,
    confirm,
    log: (m) => console.log(m),
  });

  if (values.check || values['dry-run']) {
    const lines = formatPlan(report.plan);
    if (!report.pending) {
      console.log('Everything in sync.');
      return;
    }
    console.log(values.check ? 'Pending changes:' : 'Planned changes (dry run):');
    for (const l of lines) console.log(`  ${l}`);
    for (const l of formatEstimate(report)) console.log(l);
    if (values.check) process.exitCode = 1;
    return;
  }

  for (const l of formatReport(report)) console.log(l);
  if (report.failures.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(2);
});
