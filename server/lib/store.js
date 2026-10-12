'use strict';

// In-memory job log + lifetime stats. Ephemeral by design (see PRD non-goals).

const MAX_JOBS = 500;

const state = {
  jobs: [],
  stats: {
    jobs: 0,
    tokensIn: 0,
    tokensOut: 0,
    byMethod: { extractive: 0, llm: 0 },
    startedAt: new Date().toISOString(),
  },
};

function recordJob(job) {
  state.jobs.unshift(job);
  if (state.jobs.length > MAX_JOBS) state.jobs.length = MAX_JOBS;
  state.stats.jobs++;
  state.stats.tokensIn += job.originalTokens;
  state.stats.tokensOut += job.compressedTokens;
  if (job.method === 'llm') state.stats.byMethod.llm++;
  else state.stats.byMethod.extractive++;
}

function getStats() {
  const { jobs, tokensIn, tokensOut } = state.stats;
  const forged = Math.max(0, tokensIn - tokensOut);
  // Savings estimate against the priciest common target (Claude Opus 4.6 @ $5/M input).
  const estSavingsUsd = +(forged / 1e6 * 5).toFixed(4);
  return { ...state.stats, tokensForged: forged, estSavingsUsd };
}

module.exports = { recordJob, getStats };
