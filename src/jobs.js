/**
 * Helpers shared by translation runs and cost estimates.
 */

/**
 * Group jobs by `source -> target` language pair.
 * @param {import('./diff.js').Job[]} jobs
 * @returns {Map<string, {source: string, target: string, entries: {job: import('./diff.js').Job, target: string}[]}>}
 */
export function groupJobs(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    for (const target of job.targets) {
      const g = `${job.source}->${target}`;
      if (!groups.has(g)) groups.set(g, { source: job.source, target, entries: [] });
      groups.get(g).entries.push({ job, target });
    }
  }
  return groups;
}

/** Build one translation request item for a job/target pair. */
export function buildItem(job, target, id, cfg, loaded) {
  const item = { id, text: job.sourceNew };
  const current = job.existing[target];
  if (current !== undefined && job.sourceOld !== undefined) {
    item.previousSource = job.sourceOld;
    item.currentTranslation = current;
  } else if (current !== undefined) {
    item.currentTranslation = current;
  }
  if (job.source !== cfg.primary && target !== cfg.primary) {
    const ref = loaded[cfg.primary].values.get(job.key);
    if (ref !== undefined) item.reference = ref;
  }
  return item;
}

/**
 * Config as seen by the review provider (model, key and effort come from `review`).
 * @param {import('./config.js').Config} cfg
 */
export function reviewConfig(cfg) {
  const r = cfg.review;
  return { ...cfg, provider: r.provider, model: r.model, apiKeyEnv: r.apiKeyEnv, effort: r.effort, thinkingLevel: r.thinkingLevel };
}
