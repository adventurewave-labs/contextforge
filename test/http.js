'use strict';

// HTTP integration suite — spawns the real server on an ephemeral port and
// exercises every endpoint including error paths and rate limiting.
// Run standalone (node test/http.js) or via test/run.js which asserts its exit code.

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3900 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      failed++;
      console.error(`  ✗ ${name}\n    ${err.message}`);
    });
}

async function req(method, p, body, headers) {
  const res = await fetch(BASE + p, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* html/text */ }
  return { res, text, json };
}

async function waitUp(child, out) {
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${out.slice(-400)}`);
    await new Promise((r) => setTimeout(r, 100));
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch (_) { /* not yet */ }
  }
  throw new Error('server did not come up within 6s');
}

async function main() {
  const out = '';
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), CORS_ORIGINS: 'https://app.example.com' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await waitUp(child, out);

    console.log('http · health & observability');
    await ok('GET /health returns 200 ok with stats', async () => {
      const { res, json } = await req('GET', '/health');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.ok, true);
      assert.ok(typeof json.uptime === 'number');
      assert.match(json.version || '', /^\d+\.\d+\.\d+$/);
      assert.match(json.node || '', /^v\d+/);
      assert.ok(json.memory && json.memory.heapUsedMb > 0);
      assert.ok(json.stats && typeof json.stats.jobs === 'number');
    });
    await ok('every response carries security headers', async () => {
      const { res } = await req('GET', '/health');
      assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/);
      assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
      assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
    });
    await ok('X-Request-ID is minted when absent', async () => {
      const { res } = await req('GET', '/health');
      assert.match(res.headers.get('x-request-id') || '', /^[0-9a-f-]{36}$/);
    });
    await ok('inbound X-Request-ID is echoed back', async () => {
      const { res } = await req('GET', '/health', undefined, { 'X-Request-ID': 'trace-1234-abcd' });
      assert.strictEqual(res.headers.get('x-request-id'), 'trace-1234-abcd');
    });

    console.log('http · static assets');
    await ok('GET / serves the app HTML', async () => {
      const { res, text } = await req('GET', '/');
      assert.strictEqual(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /text\/html/);
      assert.ok(text.trimStart().startsWith('<!doctype html>'));
      assert.ok(text.includes('ContextForge'));
    });
    await ok('styles and SVG assets serve with correct MIME', async () => {
      const css = await req('GET', '/style.css');
      assert.strictEqual(css.res.status, 200);
      assert.match(css.res.headers.get('content-type') || '', /text\/css/);
      const svg = await req('GET', '/logo.svg');
      assert.strictEqual(svg.res.status, 200);
      assert.match(svg.res.headers.get('content-type') || '', /image\/svg\+xml/);
    });
    await ok('path traversal is rejected', async () => {
      const { res } = await req('GET', '/%2e%2e/%2e%2e/etc/passwd');
      assert.ok(res.status === 403 || res.status === 404, `status ${res.status}`);
    });
    await ok('unknown static path returns 404 JSON', async () => {
      const { res, json } = await req('GET', '/nope.js');
      assert.strictEqual(res.status, 404);
      assert.strictEqual(json.error, 'not found');
    });

    console.log('http · CORS');
    await ok('preflight from allowed origin gets 204 + CORS headers', async () => {
      const res = await fetch(`${BASE}/api/compress`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://app.example.com', 'Access-Control-Request-Method': 'POST' },
      });
      assert.strictEqual(res.status, 204);
      assert.strictEqual(res.headers.get('access-control-allow-origin'), 'https://app.example.com');
      assert.match(res.headers.get('access-control-allow-methods') || '', /POST/);
    });
    await ok('allowed origin sees allow-origin on real responses', async () => {
      const res = await fetch(`${BASE}/api/stats`, { headers: { Origin: 'https://app.example.com' } });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('access-control-allow-origin'), 'https://app.example.com');
    });
    await ok('disallowed origin gets no CORS headers', async () => {
      const res = await fetch(`${BASE}/api/stats`, { headers: { Origin: 'https://evil.example' } });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('access-control-allow-origin'), null);
    });

    console.log('http · API discovery');
    await ok('GET /api/openapi.json describes every endpoint', async () => {
      const { res, json } = await req('GET', '/api/openapi.json');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.openapi, '3.0.3');
      for (const p of ['/api/compress', '/api/verify', '/api/models', '/api/stats', '/health']) {
        assert.ok(json.paths[p], `missing path ${p}`);
      }
      const body = json.paths['/api/compress'].post.requestBody.content['application/json'].schema;
      assert.ok(body.required.includes('context'));
    });

    console.log('http · static caching');
    await ok('HTML is served no-cache', async () => {
      const res = await fetch(`${BASE}/`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('cache-control'), 'no-cache');
    });
    await ok('versioned assets cache immutably for a year', async () => {
      const res = await fetch(`${BASE}/style.css?v=1.0.0`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    });

    console.log('http · compression');
    // fetch() auto-decompresses and strips Content-Encoding, so probe with
    // raw http.request to assert what's actually on the wire.
    const rawGet = (p, extraHeaders) => new Promise((resolve, reject) => {
      const r = require('http').get(`${BASE}${p}`, { headers: extraHeaders || {} }, (resp) => {
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }));
      });
      r.on('error', reject);
    });
    await ok('large HTML is gzipped when accepted and decodes cleanly', async () => {
      const { status, headers, body } = await rawGet('/', { 'Accept-Encoding': 'gzip' });
      assert.strictEqual(status, 200);
      assert.strictEqual(headers['content-encoding'], 'gzip');
      assert.match(headers.vary || '', /Accept-Encoding/);
      const html = require('zlib').gunzipSync(body).toString();
      assert.ok(html.includes('ContextForge'));
      assert.ok(body.length < Buffer.byteLength(html), 'gzip should shrink the page');
    });
    await ok('identity when client does not accept gzip', async () => {
      const { status, headers, body } = await rawGet('/', {});
      assert.strictEqual(status, 200);
      assert.strictEqual(headers['content-encoding'], undefined);
      assert.ok(body.toString().includes('ContextForge'));
    });

    console.log('http · API happy paths');
    await ok('GET /api/models returns catalog', async () => {
      const { res, json } = await req('GET', '/api/models');
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(json.compressors) && json.compressors.length >= 3);
      assert.ok(Array.isArray(json.targets) && json.targets.length >= 6);
    });
    await ok('POST /api/compress forges context and records the job', async () => {
      const before = (await req('GET', '/api/stats')).json.jobs;
      const { res, json } = await req('POST', '/api/compress', {
        context: 'Acme revenue was $18.4 million in Q3 2026, renewal on 2026-11-01, signed by Robert Chen. ' +
          'Filler sentence one contributes nothing at all to the meaning. Filler sentence two also contributes nothing. ' +
          'Contact maya@acme.example.com. The API handles 40 million requests per month.',
        targetRatio: 0.4,
        engine: 'extractive',
      });
      assert.strictEqual(res.status, 200);
      assert.ok(json.jobId);
      assert.strictEqual(json.method, 'extractive');
      assert.ok(json.compressedTokens < json.originalTokens);
      assert.ok(json.compressed.includes('$18.4 million'));
      const after = (await req('GET', '/api/stats')).json.jobs;
      assert.strictEqual(after, before + 1, `jobs ${before} -> ${after}`);
    });
    await ok('POST /api/verify scores faithfulness', async () => {
      const { res, json } = await req('POST', '/api/verify', {
        original: 'Renewal 2026-11-01 costs $18,400/month; contact maya@acme.example.com',
        compressed: 'Renewal 2026-11-01 costs $18,400/month.',
      });
      assert.strictEqual(res.status, 200);
      assert.ok(json.score >= 0 && json.score <= 100);
      assert.ok(json.missing.some((f) => f.kind === 'email'));
    });

    console.log('http · API error paths');
    await ok('missing context -> 400 with error JSON', async () => {
      const { res, json } = await req('POST', '/api/compress', { targetRatio: 0.3 });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(json.error, 'context is required');
    });
    await ok('malformed JSON -> 400, not 500', async () => {
      const { res, json } = await req('POST', '/api/compress', '{"context": "broken"');
      assert.strictEqual(res.status, 400);
      assert.ok(json.error);
    });
    await ok('empty body -> 400', async () => {
      const { res } = await req('POST', '/api/compress', '');
      assert.strictEqual(res.status, 400);
    });
    await ok('non-object JSON body -> 400', async () => {
      const { res } = await req('POST', '/api/compress', '[1,2,3]');
      assert.strictEqual(res.status, 400);
    });
    await ok('verify without fields -> 400', async () => {
      const { res } = await req('POST', '/api/verify', { original: 'x' });
      assert.strictEqual(res.status, 400);
    });
    await ok('GET on POST-only endpoint -> 405', async () => {
      const { res, json } = await req('GET', '/api/compress');
      assert.strictEqual(res.status, 405);
      assert.strictEqual(json.error, 'method not allowed');
    });
    await ok('unknown API path -> 404', async () => {
      const { res } = await req('POST', '/api/nope', {});
      assert.strictEqual(res.status, 404);
    });

    console.log('http · rate limiting (runs last: exhausts the window)');
    await ok('burst beyond limit gets 429 + Retry-After + headers', async () => {
      let got429 = null;
      for (let i = 0; i < 60 && !got429; i++) {
        const r = await fetch(`${BASE}/api/stats`);
        if (r.status === 429) { got429 = r; break; }
      }
      assert.ok(got429, 'never rate limited after 60 rapid requests');
      assert.ok(Number(got429.headers.get('retry-after')) >= 1, 'missing Retry-After');
      assert.strictEqual(got429.headers.get('x-ratelimit-remaining'), '0');
      const body = await got429.json();
      assert.match(body.error, /rate limit/i);
    });
  } finally {
    child.kill('SIGKILL');
  }

  console.log(`\nhttp integration: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('suite crashed:', err.message);
  process.exitCode = 1;
});
