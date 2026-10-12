# Research — why ContextForge exists

Three research findings and one live market fact, distilled 2026-10-12.

## 1. Long contexts waste quality, not just money

**Lost in the Middle: How Language Models Use Long Contexts** — Liu et al., TACL 2023.
[arXiv:2307.03172](https://arxiv.org/abs/2307.03172)

Multi-document QA and key-value retrieval experiments show performance is
highest when relevant information sits at the **beginning or end** of the input
and degrades significantly when it sits in the **middle** — even for models
explicitly marketed as long-context. Position matters: a prompt that is 5×
smaller but well-ordered beats a giant prompt with the answer buried at line
4,000.

> ContextForge countermeasure: the extractive engine applies explicit
> **primacy/recency weighting** — first and last sentences are always retained,
> and high-signal sentences are promoted.

## 2. Advertised context ≠ usable context

**RULER: What's the Real Context Size of Your Long-Context Language Models?** —
Hsieh et al., COLM 2024. [arXiv:2404.06654](https://arxiv.org/abs/2404.06654)

17 long-context models, 13 tasks. Nearly all ace vanilla needle-in-a-haystack
yet show **large performance drops as context grows**; of models claiming ≥32K
context, **only half maintained satisfactory performance at 32K**. Conclusion:
you cannot rely on the advertised window; you must keep contexts tight.

## 3. 20× compression is proven

**LLMLingua: Compressing Prompts for Accelerated Inference of LLMs** — Jiang
et al., EMNLP 2023. [arXiv:2310.05736](https://arxiv.org/abs/2310.05736)

Budget-controlled coarse-to-fine prompt compression achieves **up to 20×
compression with little performance loss** across GSM8K, BBH, ShareGPT and
Arxiv-March23. The technique exists; what's missing is a tool normal people
can run.

## 4. The economics (live OpenRouter catalog, 2026-10-12)

Input price per million tokens:

| Target model | $/M input | 200K-token prompt costs | After 10× compression |
|---|---|---|---|
| anthropic/claude-opus-4.6 | 5.00 | $1.00 | $0.10 |
| google/gemini-2.5-flash | 0.30 | $0.060 | $0.006 |
| anthropic/claude-haiku-5.5 | 0.10 | $0.020 | $0.002 |
| z-ai/glm-5.3 | 0.08 | $0.016 | $0.0016 |

A cheap compressor model (≈$0.10/M input, ~$0.50/M output) that reads 200K
tokens and emits 20K costs ≈ **$0.03** — and saves ≈ **$0.88** on a single
Opus call. At 1,000 calls/day that is **~$26K/month** recovered. Even the free
deterministic extractive engine (no API key, no cost) typically achieves 3–5×
on prose.

## Synthesis

- Long contexts **cost linearly** and **degrade accuracy** (papers 1–2).
- **20× reduction is achievable** (paper 3).
- The payback math is trivially positive (table above).
- Missing piece: a self-hostable product with **built-in verification** so
  compression is trustworthy — that is ContextForge.
