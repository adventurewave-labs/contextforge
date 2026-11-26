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
const MAX_WRITE_BATCH = 32;
const WRITE_BATCH_DELAY_MS = 10;

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
  try {
    db.exec('PRAGMA busy_timeout = 2000; PRAGMA synchronous = FULL;');
    db.exec(SCHEMA);
    return db;
  } catch (error) {
    try { db.close(); } catch (_) { /* preserve the initialization error */ }
    throw error;
  }
}

function seedStore(db) {
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('started_at', new Date().toISOString());
  const seed = db.prepare('INSERT OR IGNORE INTO counters (key, value) VALUES (?, 0)');
  for (const k of COUNTERS) seed.run(k);
}

function prepareStatements(db) {
  return {
    insert: db.prepare(`INSERT INTO jobs (id, created_at, engine, model, method, original_tokens,
      compressed_tokens, ratio, compression, elapsed_ms, verify_score, facts_total, facts_kept,
      missing_count, est_savings_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    saveJob: db.prepare('SAVEPOINT record_job'),
    releaseJob: db.prepare('RELEASE record_job'),
    bump: db.prepare(`UPDATE counters SET value = value + CASE key
      WHEN 'jobs' THEN 1 WHEN 'tokens_in' THEN ? WHEN 'tokens_out' THEN ? ELSE 1 END
      WHERE key IN ('jobs', 'tokens_in', 'tokens_out', ?)`),
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

  seedStore(db);
  let q = prepareStatements(db);

  // jobId -> { compressed, missing, expires } | { tooLarge: true, expires }
  const pending = new Map();
  let sincePrune = 0;
  const queuedJobs = [];
  let flushTimer = null;
  let reopenRequired = false;
  let closed = false;

  function sweepPending() {
    const now = Date.now();
    for (const [id, p] of pending) if (p.expires <= now) pending.delete(id);
    while (pending.size > PENDING_MAX) pending.delete(pending.keys().next().value);
  }

  function writeJob(job, pruneDue) {
    const forged = Math.max(0, job.originalTokens - job.compressedTokens);
    const v = job.verify || null;
    if (job.jobId) {
      q.insert.run(job.jobId, job.createdAt || new Date().toISOString(), job.engine || job.method,
        job.model || null, job.method, job.originalTokens, job.compressedTokens,
        job.ratio ?? 0, job.compression ?? 0, job.elapsedMs ?? 0,
        v ? v.score : null, v ? v.factsTotal : null, v ? v.factsKept : null,
        v ? v.missing.length : null, +(forged / 1e6 * PRICE_PER_M).toFixed(6));
    }
    q.bump.run(job.originalTokens, job.compressedTokens, job.method === 'llm' ? 'llm' : 'extractive');
    if (pruneDue) q.pruneUnshared.run(MAX_UNSHARED_ROWS);

    if (!job.jobId || typeof job.compressed !== 'string') return null;
    return job.compressed.length > SHARE_MAX_CHARS
      ? { tooLarge: true }
      : { compressed: job.compressed, missing: v ? v.missing : [] };
  }

  function checkStore() {
    if (closed) throw new Error('The job store is closed');
    if (!reopenRequired) return;

    // Reopen the original backing store without the startup memory fallback.
    // Keep pending results that were published by earlier successful writes.
    if (storage === 'memory') {
      db.exec('ROLLBACK');
    } else {
      db?.close();
      db = null;
      db = openDb(file);
      q = prepareStatements(db);
    }
    reopenRequired = false;
  }

  function commitJobs(jobs) {
    checkStore();
    let nextSincePrune = sincePrune;
    const results = [];
    let committing = false;
    db.exec('BEGIN');
    try {
      for (const job of jobs) {
        q.saveJob.run();
        const pruneDue = nextSincePrune + 1 >= PRUNE_EVERY;
        let payload;
        try {
          payload = writeJob(job, pruneDue);
        } catch (error) {
          try {
            db.exec('ROLLBACK TO record_job; RELEASE record_job');
          } catch (_) {
            // SQLite may have already rolled back the entire transaction.
            throw error;
          }
          results.push({ error });
          continue;
        }
        q.releaseJob.run();
        results.push({ id: job.jobId, payload });
        nextSincePrune = pruneDue ? 0 : nextSincePrune + 1;
      }
      committing = true;
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch (rollbackError) {
        // Node 22.13 does not expose isTransaction. SQLite's ROLLBACK error
        // identifies the same already-ended transaction on that version.
        const stillInTransaction = db.isTransaction ?? !(rollbackError.errcode === 1 &&
          rollbackError.message === 'cannot rollback - no transaction is active');
        reopenRequired = stillInTransaction || (committing && storage === 'sqlite');
      }
      throw error;
    }

    sincePrune = nextSincePrune;
    for (const { id, payload } of results) {
      if (!payload) continue;
      pending.set(id, { ...payload, expires: Date.now() + PENDING_TTL_MS });
    }
    sweepPending();
    return results;
  }

  function flushJobWrites() {
    clearTimeout(flushTimer);
    flushTimer = null;
    const batch = queuedJobs.splice(0);
    if (!batch.length) return;

    let results;
    try {
      results = commitJobs(batch.map(({ job }) => job));
    } catch (error) {
      for (const { reject } of batch) reject(error);
      return;
    }
    batch.forEach(({ resolve, reject }, index) => {
      const { error } = results[index];
      if (error) reject(error);
      else resolve();
    });
  }

  function recordJob(job) {
    flushJobWrites();
    const [{ error }] = commitJobs([job]);
    if (error) throw error;
  }

  function recordJobAsync(job) {
    return new Promise((resolve, reject) => {
      checkStore();
      queuedJobs.push({ job, resolve, reject });
      if (queuedJobs.length === MAX_WRITE_BATCH) flushJobWrites();
      else if (flushTimer === null) flushTimer = setTimeout(flushJobWrites, WRITE_BATCH_DELAY_MS);
    });
  }

  // -> { shareId } | { error: 'not_found' | 'expired' | 'too_large' }
  // Read-check-write runs under one write lock (BEGIN IMMEDIATE), so another
  // process on the same file can't interleave; a failed prune rolls the share
  // back and the result stays pending, so no link exists that nobody was given.
  function shareJob(jobId) {
    checkStore();
    sweepPending();
    db.exec('BEGIN IMMEDIATE');
    let result;
    try {
      const row = q.byId.get(jobId);
      const p = pending.get(jobId);
      if (!row) result = { error: 'not_found' };
      else if (row.share_id) result = { shareId: row.share_id };
      else if (!p) result = { error: 'expired' };
      else if (p.tooLarge) result = { error: 'too_large' };
      else {
        const shareId = crypto.randomBytes(16).toString('base64url');
        q.share.run(shareId, new Date().toISOString(), p.compressed, JSON.stringify(p.missing), jobId);
        q.pruneShares.run(shareMax);
        result = { shareId, created: true };
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    if (result.created) {
      pending.delete(jobId);
      return { shareId: result.shareId };
    }
    return result;
  }

  function getShare(shareId) {
    checkStore();
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
    checkStore();
    pending.delete(jobId);
    return Number(q.del.run(jobId).changes) > 0;
  }

  function getStats() {
    checkStore();
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
    if (closed) return;
    flushJobWrites();
    closed = true;
    try { db?.close(); } catch (_) { /* shutdown must continue */ }
  }

  return { recordJob, recordJobAsync, shareJob, getShare, deleteJob, getStats, close, storage };
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
  recordJobAsync: (job) => store().recordJobAsync(job),
  shareJob: (id) => store().shareJob(id),
  getShare: (id) => store().getShare(id),
  deleteJob: (id) => store().deleteJob(id),
  getStats: () => store().getStats(),
  closeStore: () => { if (instance) { instance.close(); instance = null; } },
  SHARE_MAX_CHARS,
};
