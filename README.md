<p align="center">
  <img src="docs/assets/banner.svg" alt="ContextForge — Forge lean LLM contexts. Keep every fact.">
</p>

# ContextForge

**Prompt compression with a receipt.** ContextForge takes giant LLM prompts — support
threads, transcripts, RAG piles, repo dumps — forges them down to a fraction of the
size, and **proves nothing important was lost** before you ship them.

- ⚡ **3–20× smaller contexts** — deterministic extractive engine, free and offline
- 🛡️ **Faithfulness verification** — every number, date, URL, email and name is checked; anything dropped is flagged by severity
- 💸 **Savings ledger** — live per-call dollar savings computed against current model pricing; lifetime totals persist across restarts (SQLite)
- 🔗 **Shareable results** — publish a read-only, public-by-URL link to a forged context + its faithfulness report; delete revokes it
- 🤖 **Optional LLM engine** — bring your own OpenRouter key for LLM-grade compression; falls back to extractive automatically
- 📦 **Zero dependencies** — pure Node ≥22.13 (built-in `node:sqlite`), single container, one-command Railway deploy

---

## Why this exists

Two research findings and one market fact:

1. **Long contexts degrade quality, not just cost.** *Lost in the Middle*
   (Liu et al., TACL 2023) showed models reliably ignore information buried
   mid-context. *RULER* (Hsieh et al., COLM 2024) found only half of evaluated
   "long-context" models maintained satisfactory performance even at 32K tokens.
2. **20× compression is proven.** *LLMLingua* (Jiang et al., EMNLP 2023)
   demonstrated up to 20× prompt compression with little performance loss.
3. **The math is absurdly favorable.** At current pricing (~$5/M input for
   frontier models), compressing a 200K-token prompt 10× saves **$0.88 per call**.
   A $0.10/M compressor model doing that job costs ~$0.03. The free extractive
   engine costs nothing at all.

What was missing is a tool that makes compression **trustworthy** — not just
smaller, but *verified*. That's ContextForge.

📖 Full research notes: [`docs/research.md`](docs/research.md) ·
📋 Product requirements: [`docs/PRD.md`](docs/PRD.md)

---

## How it works

<p align="center">
  <img src="web/assets/workflow.svg" alt="ContextForge workflow: score, forge, verify">
</p>

| Stage | What happens |
|---|---|
| **1 · Score** | Your context is split into sentences and scored by information density, with primacy/recency weighting — a direct counter to the *Lost in the Middle* effect. |
| **2 · Forge** | Fact-dense sentences fill your token budget first, in original order. First and last sentences are always kept. |
| **3 · Verify** | Every checkable fact in the original is matched against the forged output. Missing facts are appended as a key-facts appendix (guarantee) and any remainder is flagged by severity. |

<p align="center">
  <img src="docs/assets/verify.svg" alt="Faithfulness verification: facts checked against compressed output">
</p>

---

## Quick start

```bash
git clone https://github.com/adventurewave-labs/contextforge.git
cd contextforge
npm start          # no npm install needed — zero dependencies
open http://localhost:3000
```

Optional — enable the LLM compression engine:

```bash
export OPENROUTER_API_KEY=sk-or-...   # any OpenRouter key
npm start
```

### Deploy to Railway

1. Push this repo to your GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**.
3. Done — `railway.json` configures the Dockerfile build and `/health` check.
   Optionally set `OPENROUTER_API_KEY` as a service variable.
4. For stats and share links to survive **deploys**, attach a volume to the
   service (any mount path — the store follows `RAILWAY_VOLUME_MOUNT_PATH`).
   Railway mounts volumes as root while the image runs as `node`, so also set
   `RAILWAY_RUN_UID=0`. Without a volume the container filesystem is replaced
   on every deploy and the ledger and links reset with it.

Or with the CLI:

```bash
railway init && railway up
```

---

## API

### `POST /api/compress`

```json
{
  "context": "<your giant prompt text>",
  "targetRatio": 0.3,
  "engine": "extractive",
  "instructions": "renewal dates, pricing, customer names",
  "model": "anthropic/claude-haiku-5.5"
}
```

```json
{
  "jobId": "b7f6…",
  "originalTokens": 612,
  "compressedTokens": 204,
  "ratio": 0.333,
  "compression": 3.0,
  "method": "extractive",
  "elapsedMs": 6,
  "fallbackReason": null,
  "compressed": "Acme Corp reported revenue of $18.4 million…",
  "verify": { "score": 93, "factsTotal": 14, "factsKept": 13, "missing": [] },
  "shareable": true
}
```

- `engine`: `"extractive"` (default, free) or `"llm"` (uses `OPENROUTER_API_KEY`;
  `model` defaults to `anthropic/claude-haiku-5.5`). Any LLM failure falls back to
  extractive automatically and says so in `fallbackReason`.
- `instructions`: free-text "must keep" hints — sentences matching ≥2 of your
  keywords get pinned.

### `POST /api/verify`

```json
{ "original": "<full text>", "compressed": "<forged text>" }
```

```json
{
  "score": 93,
  "factsTotal": 14,
  "factsKept": 13,
  "missing": [{ "value": "maya@acme.example.com", "kind": "email", "severity": "medium" }]
}
```

Score is severity-weighted: dropping a date or dollar figure hurts more than
dropping a passing mention of a name.

### `POST /api/jobs/:jobId/share` · `DELETE /api/jobs/:jobId` · `GET /r/:shareId`

`share` publishes the job's forged context, metrics and faithfulness report at
`/r/<shareId>` (read-only, no re-run) and returns `{ "shareId", "url", "public": true }`.
**Share pages are public to anyone holding the URL** (128-bit random id,
`noindex`, `no-store`). The `jobId` is the delete capability — it is returned
only to whoever ran the job and never appears on the share page.
`DELETE` hard-deletes the job row; its link 404s immediately.

Share errors: `404` unknown job · `410` result no longer held (unshared results
are kept in memory only, max 100 for 1h — restart or expiry means re-run) ·
`413` result over 200,000 characters.

### `GET /api/models` · `GET /api/stats` · `GET /health`

Model catalog with live pricing snapshot · lifetime forge stats
(`storage: "sqlite"` when persisted, `"memory"` when the database could not be
opened — logged at boot) · healthcheck.

---

## The UI

Paste (or **Load sample**), drag the target-size slider, hit **Forge context**:

- Before/after panels with token counts and compression ratio
- Faithfulness meter with missing-fact chips, colored by severity
- Per-call savings table across six popular models
- Copy button, engine/model pickers, "must keep" hint field

Everything runs server-side; no accounts, no tracking, no external calls
unless you enable the LLM engine.

---

## Design decisions

- **Zero npm dependencies.** The whole server is Node stdlib. Smaller attack
  surface, instant cold starts, nothing to audit.
- **Verification is deterministic.** The faithfulness check doesn't ask an LLM
  whether it did a good job — it extracts checkable facts and checks them.
- **Compression guarantees facts.** High/medium-severity facts not covered by
  selected sentences are appended as a compact key-facts appendix rather than
  silently dropped.
- **Sentence granularity, order preserved.** Forged context stays readable and
  stays in narrative order — models handle ordered, coherent context better
  than shuffled fragments.
- **Originals are never stored.** Every job writes an anonymous metadata row
  (token counts, scores, engine) and bumps lifetime counters in SQLite. The
  forged text and missing-fact list reach disk only when you press **Share**;
  until then they sit in a small bounded in-memory map. Deleting a job
  hard-deletes its row without rewinding the lifetime ledger.

---

## Tests

```bash
npm test    # 34 unit tests + 40 HTTP integration checks, zero dependencies
```

---

## Roadmap

- [x] SQLite persistence + shareable result links (v1.1)
- [ ] Token-level LLMLingua-style compression behind the same API
- [ ] Team savings ledgers + CSV export
- [ ] Drop-in OpenAI-compatible proxy that forges context transparently

## License

MIT © Adventurewave Labs

## Credits

Research grounding: *Lost in the Middle* (Liu et al., TACL 2023) · *RULER*
(Hsieh et al., COLM 2024) · *LLMLingua* (Jiang et al., EMNLP 2023). Pricing
snapshot from the OpenRouter catalog (2026-10-12).

---

## Operations runbook

### Deploy

- **Via CLI (used by the hardening loop):** `railway up --ci --service contextforge` from the repo root. Build is the Dockerfile; health gate is `/health` (`railway.json`).
- **Via Railway UI:** the service auto-deploys from connected repo pushes once linked; otherwise use "Deploy latest".
- Zero npm dependencies means no `npm install`, no lockfile drift, and ~30s cold builds.

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port (Railway injects this) |
| `OPENROUTER_API_KEY` | – | Enables the LLM compression engine; absent = extractive only, LLM requests fall back with `fallbackReason` |
| `RATE_LIMIT_MAX` | `40` | Requests/min/IP (hard-capped at 10,000) |
| `CORS_ORIGINS` | – | Comma-separated strict allowlist, e.g. `https://app.example.com`; unset = no CORS headers |
| `SHUTDOWN_GRACE_MS` | `10000` | SIGTERM drain window before forced close |
| `CONTEXTFORGE_DB` | `$RAILWAY_VOLUME_MOUNT_PATH/contextforge.db`, else `./data/contextforge.db` | SQLite file for stats + shares; `:memory:` for ephemeral |
| `SHARE_MAX` | `10000` | Max live share links; beyond it the oldest expire first |

### Health & monitoring

- `GET /health` → `ok`, `version`, `node`, `uptime`, `memory.{heapUsedMb,rssMb}`, lifetime `stats`. Wire this to your uptime checker.
- Logs are JSON lines: access entries carry `reqId`, `method`, `path`, `status`, `ms`, `bytes`; shutdown logs `{"msg":"shutdown"}`. `X-Request-ID` is echoed from inbound headers when well-formed for trace correlation.
- Load reference (single replica, local): 303 req/s, p95 152.7ms — see `docs/benchmark.md`.

### Rollback

1. `railway rollback` in the project dashboard (pick the previous healthy deployment), **or**
2. `git revert <sha> && git push && railway up --ci --service contextforge` for a code-level revert that keeps history forward-moving.

Verify after any rollback: `curl -s https://<host>/health | jq .ok` must be `true`.

### Troubleshooting

| Symptom | First checks |
|---|---|
| 502 at the domain | `railway logs --service contextforge` — crash loop usually means a bad CMD/entrypoint (see `ac0b100` incident note: never pass `--init` to node) |
| 429s in production | Intended rate limiting; raise `RATE_LIMIT_MAX` if behind a gateway that proxies many users through one IP |
| LLM engine always `extractive` | `OPENROUTER_API_KEY` not set on the service; check `fallbackReason` in the compress response |
| Slow giant inputs | Pathological walls of repeated characters were fixed (guard-railed fact extraction); if a new shape stalls, capture the input shape and file an issue |

### Incident notes (loop history)

- **04:50Z, iter 19:** Dockerfile used `node --init` (invalid flag — `--init` belongs to `docker run`). Container crash-looped; caught within ~3 min via `/health` 502 + logs, fixed in `ac0b100`, verified recovered. Lesson recorded here so it never repeats.
