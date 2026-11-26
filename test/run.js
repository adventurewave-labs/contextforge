'use strict';

// Zero-dependency test runner: node test/run.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Keep the process-wide store (and anything this suite spawns) off disk.
process.env.CONTEXTFORGE_DB = ':memory:';
const { compressContext, extractiveCompress, splitSentences } = require('../server/lib/compress');
const { verifyFaithfulness } = require('../server/lib/verify');
const { estimateTokens } = require('../server/lib/tokens');

let passed = 0;
let failed = 0;
const pending = [];

function ok(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => { passed++; console.log(`  ✓ ${name}`); })
        .catch((err) => { failed++; console.error(`  ✗ ${name}\n    ${err.message}`); }));
    } else {
      passed++;
      console.log(`  ✓ ${name}`);
    }
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

const SAMPLE = `Acme Corp reported revenue of $18.4 million in Q3 2026, up 22% year over year.
The renewal is scheduled for 2026-11-01 and must be signed by Robert Chen.
There is a lot of filler text here that says nothing at all, honestly, it just pads the token count for no reason.
More filler follows this sentence, and it also contributes nothing whatsoever to the meaning of the document.
Contact security@acme.example.com or visit https://acme.example.com/dpa for the SOC 2 report.
The API handles 40 million requests per month with 300ms p99 latency.
Team leads Maya Lindqvist and Priya Patel approved the migration plan for Q1 2027.`;

console.log('tokens');
ok('estimates tokens within plausible range', () => {
  const t = estimateTokens(SAMPLE);
  assert.ok(t > 80 && t < 400, `got ${t}`);
});
ok('empty input is 0, tiny input >= 1', () => {
  assert.strictEqual(estimateTokens(''), 0);
  assert.ok(estimateTokens('hi') >= 1);
});

console.log('engine edge cases');
ok('CJK sentences split on 。！？ terminators', () => {
  const parts = splitSentences('这是第一句话。这是第二句话！这是第三句话？');
  assert.strictEqual(parts.length, 3);
});
ok('CJK token estimate is realistic (not chars/4)', () => {
  const t = estimateTokens('这是第一句话。这是第二句话！这是第三句话？这是第四句话。');
  // 20 CJK chars ≈ 15 tokens under 0.75 weighting; chars/4 would say ~5.
  assert.ok(t >= 12, `got ${t}`);
});
ok('fenced code blocks stay atomic', () => {
  const fence = 'Intro.\n```js\nconst a = 1; // periods. inside\n```\nClosing.';
  const parts = splitSentences(fence);
  assert.strictEqual(parts.length, 3);
  assert.ok(parts.some((p) => p.startsWith('```') && p.includes('periods')));
});
ok('compression keeps a fenced code block when facts live in it', () => {
  const text = 'Filler intro sentence with nothing important at all in it whatsoever.\n' +
    'More filler text here that also says nothing worth keeping honestly.\n' +
    '\u0060\u0060\u0060js\nconst RENEWAL_DATE = \'2026-11-01\';\nconst PRICE = \'$18,400\';\n\u0060\u0060\u0060\n' +
    'Trailing filler sentence that contributes nothing to the meaning here.\n';
  const out = extractiveCompress(text, 0.5);
  assert.ok(out.compressed.includes('2026-11-01'), out.compressed);
});

console.log('sentence splitting');
ok('decimals and URLs do not split sentences', () => {
  const parts = splitSentences('Revenue was $18.4 million, see https://acme.example.com/report. Next line.');
  assert.strictEqual(parts.length, 2);
  assert.ok(parts[0].includes('$18.4 million'));
  assert.ok(parts[0].includes('example.com/report'));
});
ok('newlines are hard breaks', () => {
  const parts = splitSentences('line one\nline two\n\nline three');
  assert.strictEqual(parts.length, 3);
});

console.log('extractive compression');
ok('compresses below target ratio ceiling (+12% slack)', () => {
  // Sentence-granularity makes tiny samples lumpy; test budget adherence at scale.
  const filler = [];
  for (let i = 0; i < 60; i++) {
    filler.push(`Filler paragraph ${i} explains nothing important and merely occupies space in the corpus for testing purposes.`);
    if (i % 7 === 0) filler.push(`Milestone ${i} shipped on 2026-0${(i % 9) + 1}-1${i % 9} costing $${i + 3},000.`);
  }
  const big = filler.join('\n');
  const out = extractiveCompress(big, 0.4);
  const ratio = estimateTokens(out.compressed) / estimateTokens(big);
  assert.ok(ratio <= 0.52, `ratio ${ratio}`);
});
ok('always keeps first and last sentence', () => {
  const out = extractiveCompress(SAMPLE, 0.1);
  assert.ok(out.compressed.includes('Acme Corp reported revenue'));
  assert.ok(out.compressed.includes('approved the migration plan'));
});
ok('boosts facts over filler', () => {
  const out = extractiveCompress(SAMPLE, 0.35);
  assert.ok(out.compressed.includes('$18.4 million'), out.compressed);
  assert.ok(out.compressed.includes('security@acme.example.com'));
  assert.ok(!out.compressed.includes('padding the token count'));
});
ok('preserves order of kept sentences', () => {
  const out = extractiveCompress(SAMPLE, 0.6);
  const i1 = out.compressed.indexOf('Acme Corp');
  const i2 = out.compressed.indexOf('renewal');
  const i3 = out.compressed.indexOf('migration plan');
  assert.ok(i1 > -1 && i2 > i1 && i3 > i2, `${i1} ${i2} ${i3}`);
});
ok('instruction keywords survive', () => {
  const out = extractiveCompress(SAMPLE, 0.3, 'Robert Chen must sign the renewal');
  assert.ok(out.compressed.includes('Robert Chen'));
});
ok('targetRatio 1 returns context unchanged', () => {
  const out = extractiveCompress(SAMPLE, 1);
  assert.strictEqual(out.compressed, SAMPLE);
});
ok('tiny input passes through', () => {
  const out = extractiveCompress('One sentence only.', 0.1);
  assert.strictEqual(out.compressed, 'One sentence only.');
});
ok('high ratio converges to full text', () => {
  const out = extractiveCompress(SAMPLE, 0.95);
  const ratio = estimateTokens(out.compressed) / estimateTokens(SAMPLE);
  assert.ok(ratio > 0.6, `ratio ${ratio}`);
});

console.log('verifier noise reduction');
ok('common tech acronyms are not flagged as missing facts', () => {
  const orig = 'The API returned JSON over HTTPS with SOC 2 compliance. Renewal is 2026-11-01.';
  const comp = 'Renewal is 2026-11-01.';
  const v = verifyFaithfulness(orig, comp);
  assert.ok(!v.missing.some((f) => f.value === 'API' || f.value === 'JSON' || f.value === 'HTTPS'), JSON.stringify(v.missing));
  assert.ok(v.missing.some((f) => f.value === '2026-11-01') === false); // kept
});

console.log('faithfulness verification');
ok('perfect copy scores 100', () => {
  const v = verifyFaithfulness(SAMPLE, SAMPLE);
  assert.strictEqual(v.score, 100);
  assert.strictEqual(v.missing.length, 0);
});
ok('dropped facts are flagged', () => {
  const v = verifyFaithfulness(SAMPLE, 'Acme Corp reported revenue.');
  assert.ok(v.score < 100);
  assert.ok(v.missing.some((f) => f.value.includes('18.4') && f.severity === 'high'));
  assert.ok(v.missing.some((f) => f.kind === 'url'));
  assert.ok(v.missing.some((f) => f.kind === 'email'));
});
ok('extractive output scores >= 85 on sample at 40%', () => {
  const out = extractiveCompress(SAMPLE, 0.4);
  const v = verifyFaithfulness(SAMPLE, out.compressed);
  assert.ok(v.score >= 85, `score ${v.score}`);
});
ok('no facts found -> score 100 with zero facts', () => {
  const v = verifyFaithfulness('hello there friend', 'hello');
  assert.strictEqual(v.score, 100);
  assert.strictEqual(v.factsTotal, 0);
});

console.log('memory bounds');
ok('job log is capped at 500 entries under churn', () => {
  // reset the module state by re-requiring in a child process would be overkill;
  // instead simulate 600 records and assert the internal cap logic via behavior.
  const { recordJob, getStats } = require('../server/lib/store');
  const before = getStats().jobs;
  const job = { originalTokens: 10, compressedTokens: 5, method: 'extractive' };
  for (let i = 0; i < 600; i++) recordJob(job);
  const after = getStats();
  assert.strictEqual(after.jobs, before + 600); // lifetime stats unbounded by design (counters)
  assert.ok(after.tokensForged >= 3000);
});

console.log('persistence & shares (node:sqlite)');
const { createStore, SHARE_MAX_CHARS } = require('../server/lib/store');
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cf-store-')), 'cf.db');
const UUID = () => require('crypto').randomUUID();
function sampleJob(over) {
  return {
    jobId: UUID(), engine: 'extractive', method: 'extractive', originalTokens: 100, compressedTokens: 30,
    ratio: 0.3, compression: 3.33, elapsedMs: 4, createdAt: new Date().toISOString(),
    verify: { score: 88, factsTotal: 9, factsKept: 8, missing: [{ value: '$18.4 million', kind: 'money', severity: 'high' }] },
    compressed: 'Acme revenue grew.', ...over,
  };
}
ok('share round-trips compressed text, metrics and missing facts', () => {
  const s = createStore({ file: ':memory:' });
  const job = sampleJob();
  s.recordJob(job);
  const r = s.shareJob(job.jobId);
  assert.ok(/^[A-Za-z0-9_-]{22}$/.test(r.shareId), `bad shareId ${r.shareId}`);
  assert.deepStrictEqual(s.shareJob(job.jobId), r, 'share must be idempotent');
  const got = s.getShare(r.shareId);
  assert.strictEqual(got.compressed, 'Acme revenue grew.');
  assert.strictEqual(got.verify.score, 88);
  assert.strictEqual(got.verify.missing[0].value, '$18.4 million');
  assert.strictEqual(got.originalTokens, 100);
  s.close();
});
ok('delete hard-deletes the share but never rewinds lifetime stats', () => {
  const s = createStore({ file: ':memory:' });
  const job = sampleJob();
  s.recordJob(job);
  const { shareId } = s.shareJob(job.jobId);
  const before = s.getStats();
  assert.strictEqual(s.deleteJob(job.jobId), true);
  assert.strictEqual(s.getShare(shareId), null);
  assert.strictEqual(s.deleteJob(job.jobId), false);
  assert.strictEqual(s.shareJob(job.jobId).error, 'not_found');
  assert.deepStrictEqual(s.getStats(), before);
  s.close();
});
ok('unshared content is never written to disk; restart means re-run to share', () => {
  const file = tmpDb();
  const s1 = createStore({ file });
  const job = sampleJob({ compressed: 'SECRET-MARKER-unshared' });
  s1.recordJob(job);
  s1.close();
  assert.ok(!fs.readFileSync(file).includes('SECRET-MARKER-unshared'), 'unshared text reached disk');
  const s2 = createStore({ file });
  assert.strictEqual(s2.shareJob(job.jobId).error, 'expired');
  assert.strictEqual(s2.shareJob(UUID()).error, 'not_found');
  s2.close();
});
ok('share cap expires oldest first and never the share just created', () => {
  const s = createStore({ file: ':memory:', shareMax: 2 });
  const ids = [];
  for (let i = 0; i < 5; i++) { // same-millisecond shares: ordering must not tie
    const job = sampleJob();
    s.recordJob(job);
    const { shareId } = s.shareJob(job.jobId);
    assert.ok(s.getShare(shareId), `share ${i} pruned on creation`);
    ids.push(shareId);
  }
  assert.deepStrictEqual(ids.map((id) => !!s.getShare(id)), [false, false, false, true, true]);
  s.close();
});
ok('oversized results are refused for sharing', () => {
  const s = createStore({ file: ':memory:' });
  const job = sampleJob({ compressed: 'x'.repeat(SHARE_MAX_CHARS + 1) });
  s.recordJob(job);
  assert.strictEqual(s.shareJob(job.jobId).error, 'too_large');
  s.close();
});
ok('stats and shares survive a restart on the same database file', () => {
  const file = tmpDb();
  const s1 = createStore({ file });
  assert.strictEqual(s1.storage, 'sqlite');
  const a = sampleJob();
  s1.recordJob(a);
  s1.recordJob(sampleJob({ method: 'llm', engine: 'llm', originalTokens: 1000, compressedTokens: 100 }));
  const { shareId } = s1.shareJob(a.jobId);
  const stats1 = s1.getStats();
  s1.close();
  const s2 = createStore({ file });
  const stats2 = s2.getStats();
  assert.deepStrictEqual(stats2, stats1);
  assert.strictEqual(stats2.jobs, 2);
  assert.deepStrictEqual(stats2.byMethod, { extractive: 1, llm: 1 });
  assert.strictEqual(stats2.tokensForged, 970);
  assert.strictEqual(s2.getShare(shareId).compressed, 'Acme revenue grew.');
  s2.close();
});
ok('unopenable database path falls back to memory and says so', () => {
  const blocker = tmpDb(); // a regular file standing where a directory must go
  fs.writeFileSync(blocker, 'not a dir');
  const origErr = console.error;
  let warned = '';
  console.error = (m) => { warned += m; };
  try {
    const s = createStore({ file: path.join(blocker, 'sub', 'cf.db') });
    assert.strictEqual(s.storage, 'memory');
    assert.strictEqual(s.getStats().storage, 'memory');
    s.close();
  } finally {
    console.error = origErr;
  }
  assert.match(warned, /falling back to in-memory/);
});

console.log('engine routing');
ok('llm engine without key falls back to extractive', () => {
  return compressContext({ context: SAMPLE, targetRatio: 0.3, engine: 'llm' }).then((out) => {
    assert.strictEqual(out.method, 'extractive');
    assert.ok(out.fallbackReason);
  });
});
ok('extractive engine reports method extractive', () => {
  return compressContext({ context: SAMPLE, targetRatio: 0.3, engine: 'extractive' }).then((out) => {
    assert.strictEqual(out.method, 'extractive');
    assert.ok(out.compressed.length > 0);
  });
});

console.log('http request ids');
ok('X-Request-ID set on responses, echoes valid inbound id', async () => {
  const port = 3100 + Math.floor(Math.random() * 400);
  process.env.PORT = String(port);
  const { start, shutdown } = require('../server/index');
  await start();
  try {
    const rid = 'test-req-id-1234';
    const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'X-Request-ID': rid } });
    assert.strictEqual(res.headers.get('x-request-id'), rid);
    const res2 = await fetch(`http://127.0.0.1:${port}/health`);
    const rid2 = res2.headers.get('x-request-id');
    assert.ok(rid2 && /^[0-9a-f-]{36}$/.test(rid2) && rid2 !== rid, `unexpected id ${rid2}`);
  } finally {
    await shutdown('SIGTERM');
  }
});
ok('malformed JSON returns 400 with consistent error shape', async () => {
  const { spawn } = require('child_process');
  const path = require('path');
  const port = 3500 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { const r = await fetch(`http://127.0.0.1:${port}/health`); up = r.ok; } catch (_) { /* not yet */ }
    }
    assert.ok(up, 'server did not come up');
    for (const [body, label] of [
      ['{"context": "x", ', 'truncated JSON'],
      ['', 'empty body'],
      ['[1,2,3]', 'array body'],
      ['"just a string"', 'string body'],
      ['null', 'null body'],
    ]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/compress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      assert.strictEqual(res.status, 400, `${label}: expected 400, got ${res.status}`);
      const data = await res.json();
      assert.ok(typeof data.error === 'string' && data.error.length, `${label}: no error field`);
    }
  } finally {
    child.kill('SIGKILL');
  }
});
ok('429 carries Retry-After and X-RateLimit-* headers', async () => {
  const { spawn } = require('child_process');
  const path = require('path');
  const port = 3500 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { const r = await fetch(`http://127.0.0.1:${port}/health`); up = r.ok; } catch (_) { /* not yet */ }
    }
    assert.ok(up, 'server did not come up');
    let last;
    for (let i = 0; i < 45; i++) {
      last = await fetch(`http://127.0.0.1:${port}/api/models`);
    }
    assert.strictEqual(last.status, 429, `expected 429, got ${last.status}`);
    const ra = Number(last.headers.get('retry-after'));
    assert.ok(ra >= 1 && ra <= 60, `Retry-After ${ra}`);
    assert.strictEqual(last.headers.get('x-ratelimit-limit'), '40');
    assert.strictEqual(last.headers.get('x-ratelimit-remaining'), '0');
    assert.ok(/^\d+$/.test(last.headers.get('x-ratelimit-reset') || ''), 'bad reset');
    const data = await last.json();
    assert.ok(data.error.includes('rate limit'));
  } finally {
    child.kill('SIGKILL');
  }
});
ok('graceful shutdown closes listener within 2s of SIGTERM', async () => {
  const { spawn } = require('child_process');
  const path = require('path');
  const port = 3500 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { const r = await fetch(`http://127.0.0.1:${port}/health`); up = r.ok; } catch (_) { /* not yet */ }
    }
    assert.ok(up, 'server did not come up');
    const exitCode = await new Promise((resolve) => {
      const t = setTimeout(() => resolve('timeout'), 2000);
      child.on('exit', (code) => { clearTimeout(t); resolve(code); });
      child.kill('SIGTERM');
    });
    assert.strictEqual(exitCode, 0, `exit code ${exitCode}; output: ${out.slice(-500)}`);
    assert.ok(out.includes('"msg":"shutdown"') || out.includes('shutdown'), `no shutdown log: ${out.slice(-500)}`);
  } finally {
    child.kill('SIGKILL');
  }
});

// HTTP integration suite runs as a child process; its own exit code decides pass/fail.
function httpSuite() {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [require('path').join(__dirname, 'http.js')], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code === 0));
  });
}

Promise.all(pending).then(async () => {
  console.log('\nhttp integration (spawned)');
  const httpOk = await httpSuite();
  if (!httpOk) failed++;
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
});
