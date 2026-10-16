#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, loadDotEnv, STARTER_CONFIG, DEFAULT_CONFIG_NAME } from '../src/config.js';
import { runSync, formatPlan, formatReport } from '../src/sync.js';

const HELP = `i18n-sync - keep all locale files in sync with an LLM

Usage:
  i18n-sync [options]        Sync all languages
  i18n-sync init             Write a starter ${DEFAULT_CONFIG_NAME}

Options:
  --check            Make no changes or API calls; exit 1 if anything is pending
  --dry-run          Print the planned work; make no changes or API calls
  --only <prefix>    Only keys starting with <prefix>
  --force            Retranslate selected keys from the primary language
  --lang <code>      Only update this target language
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
      lang: { type: 'string' },
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
  if (command) throw new Error(`Unknown command "${command}". Try --help.`);

  loadDotEnv(process.cwd());
  const cfg = loadConfig(values.config);
  loadDotEnv(cfg.baseDir);

  const report = await runSync(cfg, {
    check: values.check,
    dryRun: values['dry-run'],
    only: values.only,
    force: values.force,
    lang: values.lang,
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
