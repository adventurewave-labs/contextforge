# Load smoke test — 2026-10-12

`node test/bench.js 1000 25` (spawned server, ~2.5KB contexts, extractive engine, RATE_LIMIT_MAX lifted):

| Metric | Result |
|---|---|
| Throughput | 303 req/s |
| Errors | 0 / 1000 |
| p50 | 72.8ms |
| p90 | 127.1ms |
| p95 | 152.7ms |
| p99 | 194.1ms |

Notes:
- Default production rate limit is 40 req/min/IP (`RATE_LIMIT_MAX` env, hard-capped 10k); the bench lifts it via env since all traffic is one localhost IP.
- With the default limiter active, excess requests correctly 429 (verified by the integration suite).
- Single process, single core — scale horizontally for more.
