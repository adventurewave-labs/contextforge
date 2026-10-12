'use strict';

// Zero-dependency test runner: node test/run.js

const assert = require('assert');
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

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
});
