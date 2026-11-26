'use strict';

// Job persistence + lifetime stats on node:sqlite (built in, Node >=22.13 —
// keeps the zero-npm-dependency law).
//
// Privacy model:
// - Every job writes a metadata row (token counts, scores, method). Never the
//   original context — originals are the bulky, secret-bearing part.
// - Compressed text + the missing-facts list touch disk ONLY when the user
//   presses Share. Until then they sit in a small bounded in-memory map so the
//   share button can find them; restart/eviction just means "re-run to share".
// - Delete hard-deletes the row (link 404s). Lifetime counters live in their
//   own table so deletes never rewrite the savings ledger.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PRICE_PER_M = 5; // savings estimate vs the priciest common target (Claude Opus 4.6 @ $5/M input)
const SHARE_MAX_CHARS = 200_000; // ~50k tokens; bigger results aren't shareable
const PENDING_MAX = 100; // unshared results held in memory for the share button
const PENDING_TTL_MS = 60 * 60 * 1000;
const MAX_UNSHARED_ROWS = 10_000; // metadata rows kept for unshared jobs
const SHARE_MAX = Math.max(1, Number(process.env.SHARE_MAX) || 10_000); // oldest shares expire first
const PRUNE_EVERY = 100;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  engine TEXT NOT NULL,
  model TEXT,
  method TEXT NOT NULL,
  original_tokens INTEGER NOT NULL,
  compressed_tokens INTEGER NOT NULL,
  ratio REAL NOT NULL,
  compression REAL NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  verify_score INTEGER,
  facts_total INTEGER,
  facts_kept INTEGER,
  missing_count INTEGER,
  est_savings_usd REAL NOT NULL,
  share_id TEXT UNIQUE,
  shared_at TEXT,
  share_seq INTEGER UNIQUE, -- monotonic share order: pruning never ties on a timestamp
  compressed TEXT,
  missing_json TEXT
);
CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at);
CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const COUNTERS = ['jobs', 'tokens_in', 'tokens_out', 'extractive', 'llm'];

function defaultDbFile() {
  if (process.env.CONTEXTFORGE_DB) return process.env.CONTEXTFORGE_DB;
  // Railway injects this when a volume is attached to the service.
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'contextforge.db');
  }
  return path.join(__dirname, '..', '..', 'data', 'contextforge.db');
}

function openDb(file) {
  const { DatabaseSync } = require('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 2000;');
  db.exec(SCHEMA);
  return db;
}

function createStore({ file = defaultDbFile(), shareMax = SHARE_MAX } = {}) {
  let db;
  let storage = 'sqlite';
  try {
    db = openDb(file);
  } catch (err) {
    // Never silent: log loudly and report storage:'memory' in /api/stats.
    console.error(JSON.stringify({
      ts: new Date().toISOString(), msg: 'store', level: 'warn',
      note: `cannot open SQLite at ${file} (${err.message}); falling back to in-memory — stats and shares will not survive a restart`,
    }));
    db = openDb(':memory:');
    storage = 'memory';
  }
  if (file === ':memory:') storage = 'memory';

  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('started_at', new Date().toISOString());
  const seed = db.prepare('INSERT OR IGNORE INTO counters (key, value) VALUES (?, 0)');
  for (const k of COUNTERS) seed.run(k);

  const q = {
    insert: db.prepare(`INSERT INTO jobs (id, created_at, engine, model, method, original_tokens,
      compressed_tokens, ratio, compression, elapsed_ms, verify_score, facts_total, facts_kept,
      missing_count, est_savings_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    bump: db.prepare('UPDATE counters SET value = value + ? WHERE key = ?'),
    counters: db.prepare('SELECT key, value FROM counters'),
    startedAt: db.prepare("SELECT value FROM meta WHERE key = 'started_at'"),
    byId: db.prepare('SELECT id, share_id FROM jobs WHERE id = ?'),
    share: db.prepare(`UPDATE jobs SET share_id = ?, shared_at = ?, compressed = ?, missing_json = ?,
      share_seq = (SELECT COALESCE(MAX(share_seq), 0) + 1 FROM jobs) WHERE id = ? AND share_id IS NULL`),
    byShare: db.prepare('SELECT * FROM jobs WHERE share_id = ?'),
    del: db.prepare('DELETE FROM jobs WHERE id = ?'),
    pruneUnshared: db.prepare(`DELETE FROM jobs WHERE share_id IS NULL AND id NOT IN
      (SELECT id FROM jobs WHERE share_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?)`),
    pruneShares: db.prepare(`DELETE FROM jobs WHERE share_id IS NOT NULL AND id NOT IN
      (SELECT id FROM jobs WHERE share_id IS NOT NULL ORDER BY share_seq DESC LIMIT ?)`),
  };

  // jobId -> { compressed, missing, expires } | { tooLarge: true, expires }
  const pending = new Map();
  let sincePrune = 0;

  function sweepPending() {
    const now = Date.now();
    for (const [id, p] of pending) if (p.expires <= now) pending.delete(id);
    while (pending.size > PENDING_MAX) pending.delete(pending.keys().next().value);
  }

  function recordJob(job) {
    const forged = Math.max(0, job.originalTokens - job.compressedTokens);
    const v = job.verify || null;
    db.exec('BEGIN');
    try {
      if (job.jobId) {
        q.insert.run(job.jobId, job.createdAt || new Date().toISOString(), job.engine || job.method,
          job.model || null, job.method, job.originalTokens, job.compressedTokens,
          job.ratio ?? 0, job.compression ?? 0, job.elapsedMs ?? 0,
          v ? v.score : null, v ? v.factsTotal : null, v ? v.factsKept : null,
          v ? v.missing.length : null, +(forged / 1e6 * PRICE_PER_M).toFixed(6));
      }
      q.bump.run(1, 'jobs');
      q.bump.run(job.originalTokens, 'tokens_in');
      q.bump.run(job.compressedTokens, 'tokens_out');
      q.bump.run(1, job.method === 'llm' ? 'llm' : 'extractive');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    if (job.jobId && typeof job.compressed === 'string') {
      pending.set(job.jobId, job.compressed.length > SHARE_MAX_CHARS
        ? { tooLarge: true, expires: Date.now() + PENDING_TTL_MS }
        : { compressed: job.compressed, missing: v ? v.missing : [], expires: Date.now() + PENDING_TTL_MS });
      sweepPending();
    }
    if (++sincePrune >= PRUNE_EVERY) {
      sincePrune = 0;
      q.pruneUnshared.run(MAX_UNSHARED_ROWS);
    }
  }

  // -> { shareId } | { error: 'not_found' | 'expired' | 'too_large' }
  function shareJob(jobId) {
    const row = q.byId.get(jobId);
    if (!row) return { error: 'not_found' };
    if (row.share_id) return { shareId: row.share_id };
    sweepPending();
    const p = pending.get(jobId);
    if (!p) return { error: 'expired' };
    if (p.tooLarge) return { error: 'too_large' };
    const shareId = crypto.randomBytes(16).toString('base64url');
    q.share.run(shareId, new Date().toISOString(), p.compressed, JSON.stringify(p.missing), jobId);
    pending.delete(jobId);
    q.pruneShares.run(shareMax);
    return { shareId };
  }

  function getShare(shareId) {
    const r = q.byShare.get(shareId);
    if (!r) return null;
    return {
      createdAt: r.created_at,
      sharedAt: r.shared_at,
      method: r.method,
      originalTokens: r.original_tokens,
      compressedTokens: r.compressed_tokens,
      ratio: r.ratio,
      compression: r.compression,
      elapsedMs: r.elapsed_ms,
      compressed: r.compressed,
      verify: r.verify_score == null ? null : {
        score: r.verify_score,
        factsTotal: r.facts_total,
        factsKept: r.facts_kept,
        missing: JSON.parse(r.missing_json || '[]'),
      },
    };
  }

  function deleteJob(jobId) {
    pending.delete(jobId);
    return Number(q.del.run(jobId).changes) > 0;
  }

  function getStats() {
    const c = Object.fromEntries(q.counters.all().map((r) => [r.key, Number(r.value)]));
    const forged = Math.max(0, c.tokens_in - c.tokens_out);
    return {
      jobs: c.jobs,
      tokensIn: c.tokens_in,
      tokensOut: c.tokens_out,
      byMethod: { extractive: c.extractive, llm: c.llm },
      startedAt: q.startedAt.get().value,
      storage,
      tokensForged: forged,
      estSavingsUsd: +(forged / 1e6 * PRICE_PER_M).toFixed(4),
    };
  }

  function close() {
    try { db.close(); } catch (_) { /* already closed */ }
  }

  return { recordJob, shareJob, getShare, deleteJob, getStats, close, storage };
}

// Process-wide store, opened lazily so tests can set CONTEXTFORGE_DB first.
let instance = null;
function store() {
  if (!instance) instance = createStore();
  return instance;
}

module.exports = {
  createStore,
  recordJob: (job) => store().recordJob(job),
  shareJob: (id) => store().shareJob(id),
  getShare: (id) => store().getShare(id),
  deleteJob: (id) => store().deleteJob(id),
  getStats: () => store().getStats(),
  closeStore: () => { if (instance) { instance.close(); instance = null; } },
  SHARE_MAX_CHARS,
};
