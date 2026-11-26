'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const { compressContext } = require('./lib/compress');
const { verifyFaithfulness } = require('./lib/verify');
const { estimateTokens } = require('./lib/tokens');
const { catalog } = require('./lib/models');
const { SHARE_MAX_CHARS } = require('./lib/store');
const { createJobStoreClient } = require('./lib/job-store-worker');
const jobStore = createJobStoreClient();
const pkg = require('../package.json');

const PORT = process.env.PORT || 3000;
const MAX_BODY = 8 * 1024 * 1024; // 8MB
const MAX_CONTEXT_CHARS = 4_000_000; // ~1M tokens
const RATE_LIMIT_WINDOW_MS = 60_000;
// Tunable per-IP rate limit (requests/min). Default 40; deployments behind
// auth or internal gateways may raise it. Hard-capped at 10k.
const RATE_LIMIT_MAX = Math.min(10000, Math.max(1, Number(process.env.RATE_LIMIT_MAX) || 40));

// --- CORS (disabled by default; opt in via CORS_ORIGINS, comma-separated) ---
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !CORS_ORIGINS.length || !CORS_ORIGINS.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Request-ID',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

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

function checkRate(ip) {
  const now = Date.now();
  const times = (hits.get(ip) || []).filter((t) => t > now - RATE_LIMIT_WINDOW_MS);
  const limited = times.length >= RATE_LIMIT_MAX;
  if (!limited) times.push(now);
  if (times.length) hits.set(ip, times);
  else hits.delete(ip);
  const oldest = times.length ? times[0] : now;
  const resetMs = Math.max(0, oldest + RATE_LIMIT_WINDOW_MS - now);
  return { limited, remaining: Math.max(0, RATE_LIMIT_MAX - times.length), resetMs };
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

const COMPRESSIBLE_TYPE = /^(text\/|application\/json|image\/svg\+xml)/;
const MIN_COMPRESS_BYTES = 1024;

function send(res, status, body, headers) {
  // Buffers (static files) must be written raw — never JSON.stringify'd.
  const isBuffer = Buffer.isBuffer(body);
  let data = isBuffer ? body : typeof body === 'string' ? body : JSON.stringify(body);
  if (!Buffer.isBuffer(data)) data = Buffer.from(data);
  const type = isBuffer
    ? 'application/octet-stream'
    : typeof body === 'string'
      ? 'text/html; charset=utf-8'
      : 'application/json; charset=utf-8';
  const outHeaders = withSecurity({ 'Content-Type': type, ...(headers || {}) });

  // Transparent gzip for compressible responses >=1KB when the client accepts it.
  // res.req is Node's reference to the incoming request; no signature churn.
  const acceptEnc = res.req ? String(res.req.headers['accept-encoding'] || '') : '';
  if (/\bgzip\b/.test(acceptEnc) && data.length >= MIN_COMPRESS_BYTES &&
      COMPRESSIBLE_TYPE.test(outHeaders['Content-Type'] || '')) {
    const gz = zlib.gzipSync(data, { level: 6 });
    if (gz.length < data.length) {
      data = gz;
      outHeaders['Content-Encoding'] = 'gzip';
      outHeaders['Vary'] = 'Accept-Encoding';
    }
  }

  outHeaders['Content-Length'] = data.length;
  res.writeHead(status, outHeaders);
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

function notFoundPage(res, headers) {
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>404 · ContextForge</title>' +
    '<style>body{background:#0b0e14;color:#dbe4f0;font:16px/1.6 system-ui,sans-serif;' +
    'display:grid;place-items:center;height:100vh;margin:0;text-align:center}' +
    'a{color:#ffb347}</style></head><body><div>' +
    '<h1 style="font-size:56px;margin:0">404</h1>' +
    '<p>Nothing forged here.</p>' +
    '<p><a href="/">← back to the forge</a></p></div></body></html>';
  send(res, 404, html, headers);
}

function serveStatic(req, res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  p = p.split('?')[0];
  const root = path.join(__dirname, '..', 'web');
  const resolved = path.join(root, path.normalize(p));
  if (!resolved.startsWith(root)) return notFoundPage(res);
  fs.readFile(resolved, (err, buf) => {
    if (err) return notFoundPage(res);
    const ext = path.extname(resolved);
    // Versioned assets (?v=) are content-addressed by the HTML that references
    // them, so they can be cached immutably for a year. HTML stays no-cache so
    // deploys are picked up instantly.
    const versioned = /[?&]v=[^&]+/.test(req.url || '');
    const cache = ext === '.html' || ext === '.json'
      ? 'no-cache'
      : versioned
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=86400';
    send(res, 200, buf, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cache,
    });
  });
}

// --- OpenAPI description (kept adjacent to the routes it describes) ---
function openapi() {
  const errResp = { '400': { description: 'Malformed or invalid request body' }, '429': { description: 'Rate limited' } };
  return {
    openapi: '3.0.3',
    info: {
      title: 'ContextForge',
      version: pkg.version,
      description: 'Prompt compression with faithfulness verification.',
      license: { name: 'MIT', url: 'https://github.com/adventurewave-labs/contextforge/blob/main/LICENSE' },
    },
    servers: [{ url: '/' }],
    paths: {
      '/health': { get: { summary: 'Health + stats', responses: { '200': { description: 'ok' } } } },
      '/api/models': { get: { summary: 'Model catalog with pricing snapshot', responses: { '200': { description: 'catalog' } } } },
      '/api/stats': { get: { summary: 'Lifetime forge stats (persisted in SQLite; storage field reports sqlite|memory)', responses: { '200': { description: 'stats' } } } },
      '/api/jobs/{jobId}/share': {
        post: {
          summary: 'Publish a job result at a public-by-URL /r/{shareId} page',
          parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: '{ shareId, url, public }' },
            '404': { description: 'Unknown job' },
            '410': { description: 'Result no longer held in memory (restart or expiry); re-run to share' },
            '413': { description: 'Result too large to share' },
          },
        },
      },
      '/api/jobs/{jobId}': {
        delete: {
          summary: 'Hard-delete a job and its share (the /r link 404s afterwards)',
          parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: '{ deleted: true }' }, '404': { description: 'Unknown job' } },
        },
      },
      '/api/openapi.json': { get: { summary: 'This document', responses: { '200': { description: 'OpenAPI spec' } } } },
      '/api/compress': {
        post: {
          summary: 'Compress a context',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['context'],
                  properties: {
                    context: { type: 'string', description: 'Raw context text (<=4M chars)' },
                    targetRatio: { type: 'number', minimum: 0.05, maximum: 1, default: 0.3 },
                    engine: { type: 'string', enum: ['extractive', 'llm'], default: 'extractive' },
                    model: { type: 'string', description: 'OpenRouter model id when engine=llm' },
                    instructions: { type: 'string', description: 'Must-keep hints (<=2000 chars)' },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'Forged context + metrics' }, ...errResp },
        },
      },
      '/api/verify': {
        post: {
          summary: 'Verify faithfulness of a compression',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['original', 'compressed'],
                  properties: {
                    original: { type: 'string' },
                    compressed: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'Severity-weighted score + missing facts' }, ...errResp },
        },
      },
    },
  };
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
  // Verified server-side so a shared result's score can't be forged by the client.
  const verify = verifyFaithfulness(context, out.compressed);

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
  await jobStore.request('recordJobAsync', { ...job, engine, model: engine === 'llm' ? model || null : null, verify, compressed: out.compressed });

  send(res, 200, { ...job, compressed: out.compressed, verify, shareable: out.compressed.length <= SHARE_MAX_CHARS });
}

const SHARE_ERRORS = {
  not_found: [404, 'job not found'],
  expired: [410, 'result no longer held in memory — re-run the job to share it'],
  too_large: [413, `result exceeds ${SHARE_MAX_CHARS} characters and cannot be shared`],
};

async function handleShare(res, jobId) {
  const r = await jobStore.request('shareJob', jobId);
  if (r.error) {
    const [status, error] = SHARE_ERRORS[r.error];
    return send(res, status, { error });
  }
  send(res, 200, { shareId: r.shareId, url: `/r/${r.shareId}`, public: true });
}

async function handleDelete(res, jobId) {
  if (!(await jobStore.request('deleteJob', jobId))) return send(res, 404, { error: 'job not found' });
  send(res, 200, { deleted: true });
}

// --- shared result page (read-only, server-rendered: CSP allows no inline script/style) ---
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => Number(n).toLocaleString('en-US');

function scoreClass(score) {
  if (score >= 90) return 'good';
  if (score >= 70) return 'warn';
  return 'bad';
}

async function renderShare(res, shareId) {
  const r = await jobStore.request('getShare', shareId);
  // no-store: a deleted share must not linger in caches; noindex: public-by-URL is not public-by-search.
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' };
  if (!r) return notFoundPage(res, headers);
  const v = r.verify;
  const missing = v && v.missing.length
    ? '<div class="missing"><h3>Missing facts</h3><ul>' + v.missing.map((f) =>
      `<li class="${f.severity === 'high' ? '' : f.severity === 'medium' ? 'med' : 'low'}">${escHtml(f.value)}<em>${escHtml(f.kind)}</em></li>`).join('') +
      '</ul></div>'
    : '';
  const verifyCard = v
    ? `<div class="card verify"><h2>Faithfulness <span class="score ${scoreClass(v.score)}">${v.score}</span></h2>` +
      `<progress class="score-meter ${scoreClass(v.score)}" max="100" value="${v.score}">${v.score}%</progress>` +
      `<p class="hint">${fmtNum(v.factsKept)} of ${fmtNum(v.factsTotal)} facts kept · numbers, dates, URLs, emails and names checked</p>${missing}</div>`
    : '';
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow">' +
    '<title>Shared forge result · ContextForge</title>' +
    `<link rel="icon" href="/favicon.svg?v=${pkg.version}" type="image/svg+xml">` +
    `<link rel="stylesheet" href="/style.css?v=${pkg.version}"></head><body>` +
    `<header><img src="/logo.svg?v=${pkg.version}" alt="ContextForge logo" class="logo">` +
    '<div><h1>ContextForge</h1><p class="tagline">Shared forge result · read-only</p></div>' +
    '<nav><a href="/">Forge your own</a></nav></header><main>' +
    '<p class="hint share-note">This page is publicly reachable by anyone with the URL. The original context was never stored.</p>' +
    '<div class="metrics">' +
    `<div class="metric card"><span>${r.compression}x</span><label>compression</label></div>` +
    `<div class="metric card"><span>${fmtNum(r.originalTokens)} → ${fmtNum(r.compressedTokens)}</span><label>tokens</label></div>` +
    `<div class="metric card"><span>${fmtNum(r.elapsedMs)}ms</span><label>latency</label></div>` +
    `<div class="metric card"><span>${r.method === 'llm' ? 'LLM' : 'extractive'}</span><label>engine</label></div>` +
    '</div>' + verifyCard +
    `<div class="card pane"><h2>Forged context <span class="hint">· forged ${escHtml(r.createdAt)}</span></h2>` +
    `<textarea readonly spellcheck="false" aria-label="Forged compressed context">${escHtml(r.compressed)}</textarea></div>` +
    '</main></body></html>';
  send(res, 200, html, headers);
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
      const mem = process.memoryUsage();
      return send(res, 200, {
        ok: true,
        version: pkg.version,
        node: process.version,
        uptime: Math.round(process.uptime()),
        memory: { heapUsedMb: +(mem.heapUsed / 1048576).toFixed(1), rssMb: +(mem.rss / 1048576).toFixed(1) },
        stats: await jobStore.request('getStats'),
      });
    }
    if (url.pathname.startsWith('/api/')) {
      const cors = corsHeaders(req);
      for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
      // Preflight never touches rate limits or handlers.
      if (req.method === 'OPTIONS') return send(res, 204, '');
      const rl = checkRate(ip);
      res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_MAX));
      res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil((Date.now() + rl.resetMs) / 1000)));
      if (rl.limited) {
        return send(res, 429, { error: 'rate limit exceeded, retry later' }, {
          'Retry-After': String(Math.max(1, Math.ceil(rl.resetMs / 1000))),
        });
      }
      if (url.pathname === '/api/models' && req.method === 'GET') {
        return send(res, 200, catalog());
      }
      if (url.pathname === '/api/openapi.json' && req.method === 'GET') {
        return send(res, 200, openapi());
      }
      if (url.pathname === '/api/stats' && req.method === 'GET') {
        return send(res, 200, await jobStore.request('getStats'));
      }
      const jobRoute = /^\/api\/jobs\/([0-9a-f-]{36})(\/share)?$/.exec(url.pathname);
      if (jobRoute) {
        if (jobRoute[2] && req.method === 'POST') return await handleShare(res, jobRoute[1]);
        if (!jobRoute[2] && req.method === 'DELETE') return await handleDelete(res, jobRoute[1]);
        return send(res, 405, { error: 'method not allowed' });
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

      if (url.pathname === '/api/compress') return await handleCompress(req, res);
      if (url.pathname === '/api/verify') return await handleVerify(req, res);
      return send(res, 404, { error: 'not found' });
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET, HEAD');
      return send(res, 405, '<!doctype html><p>method not allowed</p>');
    }
    const shareRoute = /^\/r\/([A-Za-z0-9_-]{22})$/.exec(url.pathname);
    if (shareRoute) return await renderShare(res, shareRoute[1]);
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

async function start() {
  await jobStore.request('getStats'); // open the store at boot so a storage fallback is logged before traffic
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
  }).then(() => jobStore.close());
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
