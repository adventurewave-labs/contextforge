'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { compressContext } = require('./lib/compress');
const { verifyFaithfulness } = require('./lib/verify');
const { estimateTokens } = require('./lib/tokens');
const { catalog } = require('./lib/models');
const { recordJob, getStats } = require('./lib/store');

const PORT = process.env.PORT || 3000;
const MAX_BODY = 8 * 1024 * 1024; // 8MB
const MAX_CONTEXT_CHARS = 4_000_000; // ~1M tokens
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 40;

// --- tiny rate limiter (per-IP, in-memory) ---
const hits = new Map();
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, times] of hits) {
    const alive = times.filter((t) => t > cutoff);
    if (alive.length) hits.set(ip, alive);
    else hits.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

function rateLimited(ip) {
  const now = Date.now();
  const times = (hits.get(ip) || []).filter((t) => t > now - RATE_LIMIT_WINDOW_MS);
  times.push(now);
  hits.set(ip, times);
  return times.length > RATE_LIMIT_MAX;
}

// --- helpers ---
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function withSecurity(headers) {
  return { ...SECURITY_HEADERS, ...(headers || {}) };
}

// --- request IDs + structured access logging ---
const INBOUND_REQ_ID_RE = /^[A-Za-z0-9._~-]{8,64}$/;

function requestId(req) {
  // Echo well-formed client-provided IDs (trace correlation); else mint one.
  const inbound = req.headers['x-request-id'];
  if (typeof inbound === 'string' && INBOUND_REQ_ID_RE.test(inbound)) return inbound;
  return crypto.randomUUID();
}

function logAccess(reqId, req, res, pathname, startedAt) {
  const ms = Math.round((Number(process.hrtime.bigint() - startedAt) / 1e6) * 10) / 10;
  const entry = {
    ts: new Date().toISOString(),
    msg: 'access',
    reqId,
    method: req.method,
    path: pathname,
    status: res.statusCode,
    ms,
    bytes: Number(res.getHeader('content-length')) || 0,
  };
  console.log(JSON.stringify(entry));
}

function send(res, status, body, headers) {
  // Buffers (static files) must be written raw — never JSON.stringify'd.
  const isBuffer = Buffer.isBuffer(body);
  const data = isBuffer ? body : typeof body === 'string' ? body : JSON.stringify(body);
  const type = isBuffer
    ? 'application/octet-stream'
    : typeof body === 'string'
      ? 'text/html; charset=utf-8'
      : 'application/json; charset=utf-8';
  res.writeHead(status, withSecurity({
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(data),
    ...(headers || {}),
  }));
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  p = p.split('?')[0];
  const root = path.join(__dirname, '..', 'web');
  const resolved = path.join(root, path.normalize(p));
  if (!resolved.startsWith(root)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(resolved, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    send(res, 200, buf, {
      'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream',
      'Cache-Control': path.extname(resolved) === '.html' ? 'no-cache' : 'public, max-age=3600',
      // (cache-control polish lands in a later iteration)
    });
  });
}

// --- API handlers ---
async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) {
    const err = new Error('request body must be JSON');
    err.status = 400;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const err = new Error('JSON body must be an object');
      err.status = 400;
      throw err;
    }
    return parsed;
  } catch (e) {
    if (e && e.status) throw e;
    const err = new Error('invalid JSON body');
    err.status = 400;
    throw err;
  }
}

async function handleCompress(req, res) {
  const body = await readJson(req);
  const context = typeof body.context === 'string' ? body.context : '';
  if (!context.trim()) return send(res, 400, { error: 'context is required' });
  if (context.length > MAX_CONTEXT_CHARS) {
    return send(res, 413, { error: `context exceeds ${MAX_CONTEXT_CHARS} characters` });
  }
  const targetRatio = Math.min(1, Math.max(0.05, Number(body.targetRatio) || 0.3));
  const engine = body.engine === 'llm' ? 'llm' : 'extractive';
  const model = typeof body.model === 'string' ? body.model : undefined;
  const instructions = typeof body.instructions === 'string' ? body.instructions.slice(0, 2000) : undefined;

  const started = Date.now();
  const out = await compressContext({ context, targetRatio, engine, model, instructions });
  const elapsedMs = Date.now() - started;

  const originalTokens = estimateTokens(context);
  const compressedTokens = estimateTokens(out.compressed);
  const jobId = crypto.randomUUID();

  const job = {
    jobId,
    originalTokens,
    compressedTokens,
    ratio: +(compressedTokens / Math.max(1, originalTokens)).toFixed(4),
    compression: +(originalTokens / Math.max(1, compressedTokens)).toFixed(2),
    method: out.method,
    elapsedMs,
    fallbackReason: out.fallbackReason || null,
    createdAt: new Date().toISOString(),
  };
  recordJob(job);

  send(res, 200, { ...job, compressed: out.compressed });
}

async function handleVerify(req, res) {
  const body = await readJson(req);
  const { original, compressed } = body;
  if (typeof original !== 'string' || typeof compressed !== 'string') {
    return send(res, 400, { error: 'original and compressed strings are required' });
  }
  send(res, 200, verifyFaithfulness(original, compressed));
}

// --- router ---
const server = http.createServer(async (req, res) => {
  const reqId = requestId(req);
  const startedAt = process.hrtime.bigint();
  let pathname = req.url;
  res.setHeader('X-Request-ID', reqId);
  // 'close' fires for both completed and aborted responses.
  res.on('close', () => logAccess(reqId, req, res, pathname, startedAt));

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  pathname = url.pathname;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();

  try {
    if (url.pathname === '/health' || url.pathname === '/api/health') {
      return send(res, 200, { ok: true, uptime: process.uptime(), stats: getStats() });
    }
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/models' && req.method === 'GET') {
        return send(res, 200, catalog());
      }
      if (url.pathname === '/api/stats' && req.method === 'GET') {
        return send(res, 200, getStats());
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

      if (url.pathname === '/api/compress') return await handleCompress(req, res);
      if (url.pathname === '/api/verify') return await handleVerify(req, res);
      return send(res, 404, { error: 'not found' });
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    if (err && err.status) {
      try { send(res, err.status, { error: err.message }); } catch (_) {}
      return;
    }
    if (err.message === 'payload too large') {
      try { send(res, 413, { error: 'payload too large' }); } catch (_) {}
      return;
    }
    try { send(res, 500, { error: err.message || 'internal error' }); } catch (_) {}
  }
});

function start() {
  return new Promise((resolve) => {
    server.listen(PORT, () => {
      console.log(`ContextForge listening on :${PORT}`);
      resolve(server);
    });
  });
}

// --- graceful shutdown (Railway sends SIGTERM before killing the box) ---
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS) || 10_000;
let shuttingDown = false;

// Drains connections and resolves once the listener is closed (or grace
// expires). Never calls process.exit — that's the caller's call.
function shutdown(signal) {
  if (shuttingDown) return Promise.resolve();
  shuttingDown = true;
  console.log(JSON.stringify({
    ts: new Date().toISOString(), msg: 'shutdown', signal,
    note: `draining connections (${SHUTDOWN_GRACE_MS}ms grace)`,
  }));
  // Node 18.2+: idle keep-alives otherwise hold close() open for their timeout.
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  return new Promise((resolve) => {
    server.close(() => resolve());
    setTimeout(() => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      resolve();
    }, SHUTDOWN_GRACE_MS).unref();
  });
}

if (require.main === module) {
  start();
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      shutdown(sig).then(() => process.exit(0));
    });
  }
}

module.exports = { server, start, shutdown };
