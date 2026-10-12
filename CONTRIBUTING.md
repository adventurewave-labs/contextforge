# Contributing

Thanks for helping forge contexts. House rules:

## Setup

```bash
git clone https://github.com/adventurewave-labs/contextforge.git
cd contextforge
npm test   # no npm install — zero dependencies by design
```

## Ground rules

1. **Zero runtime npm dependencies.** Node stdlib only. If a change needs a package, it needs a very good reason and probably belongs behind an optional engine boundary (like the OpenRouter call).
2. **Tests gate everything.** `npm test` must pass (unit + HTTP integration + timing regressions). Add focused tests for new behavior. Never deploy on red.
3. **Conventional commits.** `feat(scope):`, `fix(scope):`, `docs:`, `feat(test):` …
4. **Match the style.** Plain Node, ESM-free CommonJS, no transpiler, no framework. The web UI is vanilla JS/CSS with no build step.
5. **Security posture is not negotiable.** Security headers apply centrally; new endpoints inherit rate limiting and JSON error shapes; CORS stays opt-in strict allowlist.
6. **Performance matters on hostile input.** Any regex on user input needs an anchor-character guard (see `server/lib/verify.js` and the O(n²) incident in the runbook). Timing regressions live in `test/run.js`.

## Pull requests

Small, described, tested. For engine changes, include before/after compression output on the bundled sample. For API changes, update `/api/openapi.json` and the README in the same PR.

## Deploying (maintainers)

See the operations runbook in the README. Briefly: push to main, then `railway up --ci --service contextforge`, then verify `/health` on the live URL.
