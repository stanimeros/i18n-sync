import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Object} Config
 * @property {'json'|'arb'} format
 * @property {string} files
 * @property {string[]} languages
 * @property {string} primary
 * @property {string} lockFile
 * @property {string} provider
 * @property {string} model
 * @property {string} apiKeyEnv
 * @property {number} batchSize
 * @property {string} context
 * @property {Record<string, string | Record<string,string>>} glossary
 * @property {Record<string,string>} tone
 * @property {boolean} gitContext
 * @property {string} baseDir   Absolute directory of the config file.
 * @property {string} lockPath  Absolute path of the lock file.
 */

export const DEFAULT_CONFIG_NAME = 'i18n-sync.config.json';

const LANGUAGE_NAMES = {
  ar: 'Arabic', bg: 'Bulgarian', bn: 'Bengali', ca: 'Catalan', cs: 'Czech', da: 'Danish',
  de: 'German', el: 'Greek', en: 'English', es: 'Spanish', et: 'Estonian', fa: 'Persian',
  fi: 'Finnish', fr: 'French', he: 'Hebrew', hi: 'Hindi', hr: 'Croatian', hu: 'Hungarian',
  id: 'Indonesian', is: 'Icelandic', it: 'Italian', ja: 'Japanese', ko: 'Korean',
  lt: 'Lithuanian', lv: 'Latvian', ms: 'Malay', nb: 'Norwegian Bokmal', nl: 'Dutch',
  no: 'Norwegian', pl: 'Polish', pt: 'Portuguese', ro: 'Romanian', ru: 'Russian',
  sk: 'Slovak', sl: 'Slovenian', sq: 'Albanian', sr: 'Serbian', sv: 'Swedish', th: 'Thai',
  tr: 'Turkish', uk: 'Ukrainian', vi: 'Vietnamese', zh: 'Chinese',
  'pt-br': 'Brazilian Portuguese', 'pt-pt': 'European Portuguese',
  'zh-cn': 'Simplified Chinese', 'zh-tw': 'Traditional Chinese', 'zh-hk': 'Traditional Chinese (Hong Kong)',
  'en-us': 'American English', 'en-gb': 'British English', 'es-mx': 'Mexican Spanish',
  'fr-ca': 'Canadian French',
};

/**
 * English name of a language code, falling back to the code itself.
 * @param {string} code
 */
export function languageName(code) {
  const lower = String(code).toLowerCase().replace('_', '-');
  if (LANGUAGE_NAMES[lower]) return LANGUAGE_NAMES[lower];
  const base = lower.split('-')[0];
  if (LANGUAGE_NAMES[base]) return `${LANGUAGE_NAMES[base]} (${code})`;
  return code;
}

/**
 * Replace {lang} / {ns} in a file pattern.
 * @param {string} pattern
 * @param {{lang: string, ns?: string}} vars
 */
export function resolvePattern(pattern, { lang, ns }) {
  let out = pattern.replaceAll('{lang}', lang);
  if (ns !== undefined) out = out.replaceAll('{ns}', ns);
  return out;
}

/**
 * Minimal .env loader (KEY=VALUE). Never overrides existing environment variables.
 * @param {string} [dir]
 */
export function loadDotEnv(dir = process.cwd()) {
  const file = path.join(dir, '.env');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      val = val.replace(/\s+#.*$/, '');
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

/**
 * Validate and normalize a raw config object.
 * @param {any} raw
 * @param {string} baseDir
 * @returns {Config}
 */
export function normalizeConfig(raw, baseDir) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Config must be a JSON object.');
  }
  const format = raw.format ?? 'json';
  if (!['json', 'arb'].includes(format)) errors.push(`"format" must be "json" or "arb" (got ${JSON.stringify(format)}).`);

  const files = raw.files;
  if (typeof files !== 'string' || !files) errors.push('"files" is required and must be a string pattern, e.g. "locales/{lang}.json".');
  else {
    if (!files.includes('{lang}')) errors.push('"files" must contain the {lang} placeholder.');
    if ((files.match(/\{ns\}/g) || []).length > 1) errors.push('"files" may contain {ns} at most once.');
    if (format === 'arb' && files.includes('{ns}')) errors.push('{ns} is not supported with the "arb" format.');
  }

  const languages = raw.languages;
  if (!Array.isArray(languages) || languages.length < 1 || languages.some((l) => typeof l !== 'string' || !l.trim())) {
    errors.push('"languages" must be a non-empty array of language codes.');
  } else if (new Set(languages).size !== languages.length) {
    errors.push('"languages" contains duplicates.');
  }

  const primary = raw.primary ?? (Array.isArray(languages) ? languages[0] : undefined);
  if (Array.isArray(languages) && !languages.includes(primary)) {
    errors.push(`"primary" (${JSON.stringify(primary)}) must be one of "languages".`);
  }

  const batchSize = raw.batchSize ?? 40;
  if (!Number.isInteger(batchSize) || batchSize < 1) errors.push('"batchSize" must be a positive integer.');

  const provider = raw.provider ?? 'gemini';
  if (provider !== 'gemini') errors.push(`Unsupported "provider": ${JSON.stringify(provider)} (only "gemini" is available).`);

  for (const field of ['context', 'model', 'apiKeyEnv', 'lockFile']) {
    if (raw[field] !== undefined && typeof raw[field] !== 'string') errors.push(`"${field}" must be a string.`);
  }
  const glossary = raw.glossary ?? {};
  if (typeof glossary !== 'object' || Array.isArray(glossary) || glossary === null) {
    errors.push('"glossary" must be an object.');
  } else {
    for (const [term, v] of Object.entries(glossary)) {
      const ok = typeof v === 'string' || (v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string'));
      if (!ok) errors.push(`"glossary.${term}" must be a string or an object of language -> string.`);
    }
  }
  const tone = raw.tone ?? {};
  if (typeof tone !== 'object' || Array.isArray(tone) || tone === null || Object.values(tone).some((v) => typeof v !== 'string')) {
    errors.push('"tone" must be an object of language -> string.');
  }
  if (raw.gitContext !== undefined && typeof raw.gitContext !== 'boolean') errors.push('"gitContext" must be a boolean.');

  if (errors.length) throw new Error(`Invalid config:\n  - ${errors.join('\n  - ')}`);

  const lockFile = raw.lockFile ?? 'i18n.lock.json';
  return {
    format,
    files,
    languages: [...languages],
    primary,
    lockFile,
    provider,
    model: raw.model ?? 'gemini-2.5-flash',
    apiKeyEnv: raw.apiKeyEnv ?? 'GEMINI_API_KEY',
    batchSize,
    context: raw.context ?? '',
    glossary,
    tone,
    gitContext: raw.gitContext ?? true,
    baseDir,
    lockPath: path.resolve(baseDir, lockFile),
  };
}

/**
 * Load a config file from disk.
 * @param {string} [configPath]
 * @returns {Config}
 */
export function loadConfig(configPath) {
  const abs = path.resolve(configPath || DEFAULT_CONFIG_NAME);
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    throw new Error(`Config file not found: ${abs}\nRun "i18n-sync init" to create one.`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Config file is not valid JSON (${abs}): ${e.message}`);
  }
  return normalizeConfig(raw, path.dirname(abs));
}

/** Starter config written by `init`. */
export const STARTER_CONFIG = {
  format: 'json',
  files: 'src/locales/{lang}.json',
  languages: ['en', 'el'],
  primary: 'en',
  lockFile: 'i18n.lock.json',
  provider: 'gemini',
  model: 'gemini-2.5-flash',
  apiKeyEnv: 'GEMINI_API_KEY',
  batchSize: 40,
  context: 'Describe your product and its audience here so translations match your voice.',
  glossary: {},
  tone: {},
  gitContext: true,
};
