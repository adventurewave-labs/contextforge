# Changelog

All notable changes to ContextForge. Format: Keep a Changelog; versioning: SemVer.

## [1.1.0] — 2026-11-26

### Added
- SQLite persistence via built-in `node:sqlite` (still zero npm dependencies): job metadata rows + lifetime counters survive restarts; `/api/stats` gains `storage` (`sqlite`|`memory`)
- Shareable result links: `POST /api/jobs/:id/share` → public-by-URL read-only `/r/:shareId` page (metrics, faithfulness score, missing facts, forged text); `DELETE /api/jobs/:id` hard-deletes and the link 404s
- UI share card with a public-by-URL warning, copy-link and delete buttons
- `/api/compress` now returns server-side `verify` and `shareable` (the UI no longer makes a second `/api/verify` call)

### Changed
- Node engine floor raised to ≥22.13 (`node:sqlite`); Dockerfile prepares a node-owned `/app/data`
- Originals are still never stored; forged text reaches disk only when shared

## [1.0.0] — 2026-10-12

### Added (initial release)
- Deterministic extractive compression engine: TF scoring, primacy/recency weighting, fact-priority fill, key-facts appendix guarantee
- Faithfulness verifier: severity-weighted scoring over numbers, dates, money, URLs, emails, names, quotes
- Optional LLM engine via OpenRouter (BYO key) with automatic extractive fallback
- Dark web UI: forge slider, before/after panels, faithfulness meter, missing-fact chips, savings calculator
- Savings catalog (live pricing snapshot 2026-10-12), sample loader, copy-to-clipboard
- Zero-dependency Node ≥18 server; Dockerfile; Railway config; MIT license

### Hardening loop (same day, 24-iteration campaign)
- Security headers (CSP, nosniff, frame-deny, referrer/permissions policies)
- Request IDs (echo inbound) + JSON access logging
- Graceful SIGTERM drain with connection idle-close and grace deadline
- Robust JSON body handling: consistent 400s, never a 500 on malformed input
- Enforced per-IP rate limiting (40/min default) with Retry-After + X-RateLimit headers
- HTTP integration suite (32 checks) chained into `npm test`
- GitHub Actions CI — *blocked: rig token lacks `workflow` scope; file preserved in loop artifacts*
- Transparent gzip for compressible responses ≥1KB
- Immutable year-long caching for versioned assets; no-cache HTML
- OpenAPI 3.0 description at `/api/openapi.json`
- Opt-in CORS via strict `CORS_ORIGINS` allowlist
- Enriched `/health`: version, node, uptime, heap/rss memory
- Branded 404 page; Allow header on 405; no path oracle on traversal
- Load benchmark: 303 req/s, p95 152.7ms (`docs/benchmark.md`)
- Verifier noise reduction: tech-acronym/word stop-lists, capped low-severity chips
- CJK-aware sentence splitting + token estimation; atomic code-fence handling
- LLM engine hardening: retry-once on transient errors, 45s timeout, failure taxonomy
- **Fix:** O(n²) regex backtracking on pathological inputs (megabyte walls hung extractFacts; now guard-railed, linear scans, timing regressions added)
- Dockerfile: OCI labels, corrected CMD (incident note: `node --init` invalid flag caused a ~3-min crash loop, fixed and verified)
- UI: OpenGraph/Twitter cards, noscript notice, aria-labels
- Ops runbook in README (deploy, env, monitoring, rollback, troubleshooting)
