# ContextForge — PRD

**Product:** ContextForge — prompt compression & faithfulness verification
**Repo:** `adventurewave-labs/contextforge`
**Author:** GLM (awl-dev agent), for Adventurewave Labs
**Status:** v1.0 — MVP shipped
**Date:** 2026-10-12

---

## 1. Problem

LLM practitioners routinely stuff giant contexts into prompts: support threads, repository
dumps, meeting transcripts, RAG retrieval piles. Two well-documented consequences:

1. **Cost scales linearly with input tokens.** At current frontier pricing
   ($1–$5 per million input tokens; live OpenRouter data, 2026-10), a team sending
   200K-token contexts 1,000×/day burns **$200–$1,000/day on input alone**.
2. **Quality degrades with length.** *Lost in the Middle* (Liu et al., TACL 2023)
   showed models reliably ignore information buried mid-context. *RULER*
   (Hsieh et al., COLM 2024) showed most "long-context" models degrade well
   before their advertised window — only half of evaluated models held up at 32K.

The industry's answer — *prompt compression* — is validated by research
(*LLMLingua*, Jiang et al., EMNLP 2023: up to **20× compression** with little
performance loss) but trapped in notebooks and Python research code. There is no
polished, self-hostable tool that lets a developer:

> paste a giant context, get a much smaller one back, **and see proof that
> nothing important was lost** — with a running dollar-savings ledger.

## 2. Product vision

**ContextForge is a forge for context:** raw oversized prompt in, dense
verified context out.

- Compress any context up to ~1M tokens (extractive engine, deterministic, free;
  optional LLM engine via any OpenRouter model).
- Verify faithfulness automatically: every number, date, URL, and proper noun in
  the original is checked against the compressed output; coverage is scored and
  missing facts are listed before you ship the prompt.
- Show the money: token deltas and dollar savings computed against the live
  pricing of 12 popular target models.

## 3. Users & personas

| Persona | Need |
|---|---|
| **Nadia, AI engineer** | Cut RAG prompt cost 5–10× without silently dropping facts |
| **Sam, support-ops lead** | Feed week-long ticket threads to a summarizer without hitting limits |
| **Rex, solo hacker** | Free local tool, no signup, no vendor lock-in |

## 4. Goals / Non-goals (v1)

**Goals**
- G1: Sub-second deterministic extractive compression of ≤1M-token inputs.
- G2: Faithfulness verification with explicit missing-facts list (no LLM required).
- G3: Optional LLM compression through user's own OpenRouter key; graceful
  fallback to extractive on any error.
- G4: Dollar-savings calculator from live model pricing (12-model catalog).
- G5: Single zero-dependency Node service; one Dockerfile; one-click Railway.
- G6: Polished dark web UI — paste, slide, compress, compare, verify, copy.

**Non-goals (v1)**
- User accounts / persistence (jobs are in-memory, stats ephemeral).
- Fine-tuned token-level compression (LLMLingua-class) — roadmap item.
- Streaming/async jobs; batch APIs.

## 5. User stories

1. As Nadia, I paste a 60K-token RAG blob, drag the ratio slider to 25%, hit
   **Forge**, and in under a second see the compressed context, the compression
   ratio, and a faithfulness score — with any dropped numbers flagged in red.
2. As Sam, I load the bundled sample ticket thread, compare before/after side
   by side, and copy the compressed prompt for my production pipeline.
3. As Rex, I set `OPENROUTER_API_KEY`, pick a cheap compressor model
   (e.g. `anthropic/claude-haiku-5.5` at $0.10/M input), and get LLM-grade
   compression; without a key everything still works extractively, free.
4. As any user, I open **Stats** and see cumulative tokens forged away and
   estimated dollars saved across models.

## 6. Functional requirements

| ID | Requirement |
|---|---|
| F1 | `POST /api/compress` — body: `{context, instructions?, targetRatio, engine, model?}` → `{jobId, originalTokens, compressedTokens, ratio, compressed, method, elapsedMs}` |
| F2 | Compression engines: `extractive` (default, offline) and `llm` (OpenRouter; auto-falls back to extractive on error) |
| F3 | `POST /api/verify` — body: `{original, compressed}` → `{score, factsTotal, factsKept, missing:[{value,kind,severity}]}` |
| F4 | Facts = numbers/units, dates, money, URLs, emails, proper nouns, quoted strings |
| F5 | `GET /api/models` — compressor catalog + 12 target models with live pricing |
| F6 | `GET /api/stats` — lifetime counters (jobs, tokens in/out, est. savings) |
| F7 | `GET /api/health` — Railway healthcheck |
| F8 | Web UI at `/` — input panel, ratio slider, engine/model pickers, sample loader, results with before/after cards, ratio ring, faithfulness meter, missing-facts list, savings calculator, copy button, stats bar |
| F9 | Input cap 4M characters; request cap 8MB; simple in-memory rate limit |

## 7. Success metrics

- Extractive compression ≥3× on typical prose at default 30% ratio.
- Faithfulness score ≥90 on the bundled sample at 30% ratio.
- p95 API latency <250ms for 100K-token inputs (extractive).
- Zero external runtime dependencies; container <200MB.

## 8. Architecture

Single Node ≥18 service, **zero npm dependencies**:

```
web/            static SPA (vanilla JS/CSS, no build step)
server/
  index.js      http server, router, static, rate limit
  lib/
    tokens.js       heuristic tokenizer (chars/4 + word blend)
    compress.js     extractive engine (TF scoring, position-aware) + LLM engine
    verify.js       fact extraction + faithfulness scoring
    models.js       model catalog w/ live pricing snapshot
    store.js        in-memory job log + lifetime stats
Dockerfile       node:24-alpine, non-root, dumb-init
railway.json     healthcheck /health, Dockerfile builder
```

Extractive engine details: sentence segmentation → stopword-filtered TF scoring →
primacy/recency position weighting (counters *Lost in the Middle*) → numeric
sentence boosting → greedy budget fill in original order.

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Extractive compression drops a fact | Faithfulness verifier surfaces every missing fact with severity; user adjusts ratio or instructions |
| LLM engine unavailable/slow | Auto-fallback to extractive; response always includes `method` |
| Token estimate drift vs vendor tokenizers | Heuristic labeled as estimate; ±10% typical |
| Abuse of public endpoint | Rate limit + size caps; self-host for real use |

## 10. Roadmap

- v1.1: SQLite job persistence, shareable result links
- v1.2: token-level LLMLingua-style compression behind the same API
- v1.3: API keys, team savings ledgers, CSV export
- v2.0: drop-in OpenAI-compatible proxy endpoint (`/v1/chat/completions`)
  that transparently forges context before forwarding
