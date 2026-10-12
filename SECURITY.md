# Security Policy

## Supported versions

The `main` branch (v1.x) receives security fixes.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Email: security@adventurewave-labs.example (or use GitHub's private vulnerability reporting on this repo).

Include: description, reproduction steps/input shapes, impact assessment. We aim to acknowledge within 48 hours and will coordinate disclosure timelines with reporters.

## Scope notes

- The service is stateless by design: no database, no stored prompts (memory-only counters/logs).
- All endpoints are rate-limited (40/min/IP default). Security headers (CSP, nosniff, frame-deny) apply to every response.
- CORS is disabled unless `CORS_ORIGINS` is explicitly set (strict allowlist).
- The LLM engine sends context to OpenRouter **only** when the operator configures `OPENROUTER_API_KEY` and a client explicitly selects `engine: "llm"`. Extractive mode (default) makes no outbound calls.
