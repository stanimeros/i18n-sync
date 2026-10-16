/**
 * Token usage, pricing and cost formatting.
 * Prices are USD per 1M tokens and may be overridden or extended with the "pricing" config key.
 */

/**
 * Standard-tier prices as of 2026-10. Gemini 3.6 Flash and 3.8 Flash prices double on 2027-01-01;
 * override with the "pricing" config key when prices change.
 * @type {Record<string, {input: number, output: number}>}
 */
export const PRICES = {
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'gemini-3.6-flash': { input: 0.75, output: 3.75 },
  'gemini-3.8-flash': { input: 0.75, output: 3.75 },
  'gemini-3.1-pro-preview': { input: 2, output: 12 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/**
 * Cost in USD, or null when the model has no known price.
 * @param {string} model
 * @param {{input: number, output: number}} usage
 * @param {{pricing?: Record<string, {input: number, output: number}>}} [cfg]
 * @returns {number | null}
 */
export function cost(model, usage, cfg) {
  const p = cfg?.pricing?.[model] ?? PRICES[model];
  if (!p) return null;
  return (usage.input * p.input + usage.output * p.output) / 1e6;
}

/** Accumulates usage reported by providers through `onUsage`. */
export function createUsage() {
  // `reportedCost`: some providers (the Claude CLI) report the exact cost; it then wins over the price table.
  const u = { input: 0, output: 0, calls: 0, reportedCost: /** @type {number|null} */ (null) };
  return {
    totals: u,
    /** @type {(usage: {input?: number, output?: number, cost?: number}) => void} */
    add(usage) {
      u.input += Number(usage?.input) || 0;
      u.output += Number(usage?.output) || 0;
      if (typeof usage?.cost === 'number') u.reportedCost = (u.reportedCost ?? 0) + usage.cost;
      u.calls++;
    },
  };
}

/**
 * Combine per-phase usage into a summary with costs.
 * @param {Record<string, {model: string, input: number, output: number} | undefined>} phases
 * @param {{pricing?: any}} cfg
 */
export function summarizeUsage(phases, cfg) {
  const out = { phases: {}, total: { input: 0, output: 0, cost: /** @type {number|null} */ (0) } };
  for (const [name, p] of Object.entries(phases)) {
    if (!p || p.input + p.output === 0) continue;
    const c = typeof p.reportedCost === 'number' ? p.reportedCost : cost(p.model, p, cfg);
    out.phases[name] = { model: p.model, input: p.input, output: p.output, cost: c };
    out.total.input += p.input;
    out.total.output += p.output;
    out.total.cost = out.total.cost === null || c === null ? null : out.total.cost + c;
  }
  return out;
}

const n = (x) => Math.round(x).toLocaleString('en-US');
const usd = (x, digits) => `$${x.toFixed(digits)}`;

/**
 * Report lines for a usage summary (actual or estimated).
 * @param {ReturnType<typeof summarizeUsage>} summary
 * @param {{estimate?: boolean}} [opts]
 */
export function formatUsage(summary, { estimate = false } = {}) {
  const names = Object.keys(summary.phases);
  if (!names.length) return [];
  const ap = estimate ? '~' : '';
  const money = (c) => (estimate ? `~${usd(c, c >= 0.01 ? 2 : 4)}` : usd(c, 4));
  const lines = [];
  for (const name of names) {
    const p = summary.phases[name];
    const tail = p.cost === null
      ? `cost unknown (no pricing for ${p.model}; set "pricing" in config)`
      : money(p.cost);
    lines.push(`${name}: ${ap}${n(p.input)} in / ${ap}${n(p.output)} out tokens, ${tail} (${p.model})`);
  }
  const t = summary.total;
  if (estimate) {
    lines.push(t.cost === null ? 'estimated cost: unknown (missing pricing, see above)' : `estimated cost: ${money(t.cost)} (estimate only; actual usage varies)`);
  } else {
    lines.push(`total: ${n(t.input)} in / ${n(t.output)} out tokens, ${t.cost === null ? 'cost unknown' : money(t.cost)}`);
  }
  return lines;
}
