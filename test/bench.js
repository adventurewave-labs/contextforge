#!/usr/bin/env node
'use strict';

// Local load smoke test: hammers a spawned server with real requests and
// reports latency percentiles + throughput. Zero dependencies.
// Usage: node test/bench.js [requests=1000] [concurrency=25]

const { spawn } = require('child_process');
const path = require('path');

const REQUESTS = Number(process.argv[2]) || 1000;
const CONCURRENCY = Number(process.argv[3]) || 25;
const PORT = 4200 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;

const CONTEXT = [
  'Acme Corp reported revenue of $18.4 million in Q3 2026, up 22% year over year.',
  'The renewal is scheduled for 2026-11-01 and must be signed by Robert Chen.',
  'Filler sentence that contributes nothing to the meaning of the document at all.',
  'More filler text here which also says nothing worth keeping, honestly.',
  'Contact security@acme.example.com or visit https://acme.example.com/dpa.',
  'The API handles 40 million requests per month with 300ms p99 latency.',
  'Team leads Maya Lindqvist and Priya Patel approved the migration plan.',
  'Budget owner Robert Chen needs the final quote by 2026-10-15 for the cycle.',
].join('\n').repeat(12); // ~2.5KB context per request

function percentile(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

async function main() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), RATE_LIMIT_MAX: '10000' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  // Wait for readiness.
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { const r = await fetch(`${BASE}/health`); if (r.ok) break; } catch (_) {}
  }

  const latencies = [];
  let errors = 0;
  let done = 0;
  const started = process.hrtime.bigint();

  async function worker() {
    while (done < REQUESTS) {
      done++;
      const t0 = process.hrtime.bigint();
      try {
        const res = await fetch(`${BASE}/api/compress`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context: CONTEXT, targetRatio: 0.3, engine: 'extractive' }),
        });
        await res.arrayBuffer();
        if (!res.ok) errors++;
      } catch (_) {
        errors++;
      }
      latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const totalMs = Number(process.hrtime.bigint() - started) / 1e6;
  const sorted = latencies.sort((a, b) => a - b);

  console.log(`requests: ${REQUESTS} @ concurrency ${CONCURRENCY}`);
  console.log(`throughput: ${(REQUESTS / (totalMs / 1000)).toFixed(0)} req/s`);
  console.log(`errors: ${errors}`);
  for (const p of [50, 90, 95, 99]) {
    console.log(`p${p}: ${percentile(sorted, p).toFixed(1)}ms`);
  }

  child.kill('SIGKILL');
  if (errors > REQUESTS * 0.01) process.exitCode = 1; // >1% errors = fail
}

main().catch((err) => { console.error('bench crashed:', err.message); process.exit(1); });
