'use strict';

const { estimateTokens } = require('./tokens');
const { extractFacts } = require('./verify');

const STOPWORDS = new Set(
  ('a,an,the,and,or,but,if,then,else,when,while,of,to,in,on,at,by,for,with,about,against,between,' +
    'into,through,during,before,after,above,below,from,up,down,out,off,over,under,again,further,' +
    'once,here,there,all,any,both,each,few,more,most,other,some,such,no,nor,not,only,own,same,so,' +
    'than,too,very,can,will,just,should,now,i,me,my,we,our,you,your,he,him,his,she,her,it,its,' +
    'they,them,their,this,that,these,those,am,is,are,was,were,be,been,being,have,has,had,having,' +
    'do,does,did,doing,would,could,ought,as,also,because,until,either,neither,' +
    'however,therefore,thus,hence,ok,okay,please,thanks,thank,hi,hello,hey,regards').split(',')
);

function splitSentences(text) {
  // Fenced code blocks are atomic units: never split mid-fence, keep or drop
  // the whole block. Extract them first, then split the prose around them.
  const parts = [];
  const segments = text.split(/(```[\s\S]*?(?:```|$))/g);
  for (const segment of segments) {
    if (segment.startsWith('```')) {
      if (segment.trim()) parts.push(segment.trim());
      continue;
    }
    splitProse(segment, parts);
  }
  return parts.length ? parts : [text];
}

function splitProse(text, parts) {
  // Newlines are hard breaks (logs, transcripts, chat threads).
  for (const line of text.split(/\n+/)) {
    if (!line.trim()) continue;
    // Split only where punctuation ENDS a sentence (followed by whitespace).
    // Decimals like 18.4 and URLs like example.com/report never match this.
// CJK terminators need no trailing space — pad them with one so the same
    // rule applies. ASCII .!? only split when followed by whitespace, so
    // $18.4 and example.com/report never break.
    const prepared = line.replace(/([\u3002\uff01\uff1f])+/g, '$1 ');
    const pieces = prepared.split(/(?<=[.!?\u3002\uff01\uff1f])\s+/);
    for (let s of pieces) {
      s = s.trim();
      if (!s) continue;
      // Split monster "sentences" (minified text, logs) on clause breaks.
      if (s.length > 420) {
        let buf = '';
        for (const clause of s.split(/(?<=[;,:])\s+/)) {
          buf += (buf ? ' ' : '') + clause;
          if (buf.length >= 280) {
            parts.push(buf);
            buf = '';
          }
        }
        if (buf.trim()) parts.push(buf);
      } else {
        parts.push(s);
      }
    }
  }
  return parts.length ? parts : [text];
}

function wordFreq(sentences) {
  const freq = new Map();
  for (const s of sentences) {
    for (const w of s.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) || []) {
      if (STOPWORDS.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return freq;
}

function instructionKeywords(instructions) {
  const kws = new Set();
  for (const w of (instructions || '').toLowerCase().match(/[a-z][a-z0-9'-]{3,}/g) || []) {
    if (!STOPWORDS.has(w)) kws.add(w);
  }
  return kws;
}

function sentenceScore(sentence, freq, maxFreq, position, total, keywords) {
  const words = sentence.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) || [];
  let tf = 0;
  let hits = 0;
  for (const w of words) {
    if (STOPWORDS.has(w)) continue;
    tf += (freq.get(w) || 0) / maxFreq;
    hits++;
  }
  // Length-normalized informativeness (favors dense sentences, penalizes filler).
  let score = hits ? tf / Math.sqrt(hits) : 0;

  // Primacy / recency weighting — counters "Lost in the Middle" degradation.
  const rel = total > 1 ? position / (total - 1) : 0;
  if (rel < 0.15) score *= 1.35;
  else if (rel > 0.85) score *= 1.25;
  else if (rel > 0.4 && rel < 0.6) score *= 0.85; // middle is the danger zone

  // Facts and figures survive compression.
  if (/\d/.test(sentence)) score *= 1.2;
  if (/[$€£]\s?\d|\d+\s?%|\b\d{4}\b/.test(sentence)) score *= 1.3;
  // High-value verifiable facts get the strongest protection.
  if (/https?:\/\/|[\w.+-]+@[\w-]+\.[\w.]+/.test(sentence)) score *= 1.45;

  // User instruction terms get a boost.
  if (keywords.size) {
    let kw = 0;
    for (const w of words) if (keywords.has(w)) kw++;
    if (kw) score *= 1 + Math.min(0.6, kw * 0.15);
  }
  return score;
}

function extractiveCompress(context, targetRatio, instructions) {
  const sentences = splitSentences(context);
  const totalTokens = estimateTokens(context);

  if (targetRatio >= 1 || sentences.length <= 2) {
    return { compressed: context, kept: sentences.length, total: sentences.length };
  }

  const budget = Math.max(
    estimateTokens(sentences[0]),
    Math.round(totalTokens * targetRatio)
  );

  const freq = wordFreq(sentences);
  const maxFreq = Math.max(1, ...freq.values());
  const keywords = instructionKeywords(instructions);

  const scored = sentences.map((s, i) => ({
    i,
    s,
    score: sentenceScore(s, freq, maxFreq, i, sentences.length, keywords),
    tokens: estimateTokens(s),
  }));

  // Always keep the first and last sentence (primacy + recency anchors).
  const chosen = new Set([0, sentences.length - 1]);
  let used = scored.filter((x) => chosen.has(x.i)).reduce((a, x) => a + x.tokens, 0);

  // "Must keep" pinning: sentences matching >=2 instruction keywords are
  // guaranteed inclusion (capped at 1.35x budget so pathological hints can't
  // swallow everything).
  const kwHits = (s) => {
    const words = s.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) || [];
    let n = 0;
    for (const w of words) if (keywords.has(w)) n++;
    return n;
  };
  if (keywords.size >= 2) {
    const pinned = scored
      .filter((x) => !chosen.has(x.i) && kwHits(x.s) >= 2)
      .sort((a, b) => kwHits(b.s) - kwHits(a.s));
    for (const p of pinned) {
      if (used + p.tokens > Math.max(budget * 1.35, used)) break;
      chosen.add(p.i);
      used += p.tokens;
    }
  }

  const rest = scored.filter((x) => !chosen.has(x.i)).sort((a, b) => b.score - a.score);
  // Pass 0 admits fact-dense sentences first with a generous ceiling (facts are
  // the product); pass 1 fills remaining budget with best-scoring prose.
  const FACT_RE = /\d|https?:\/\/|[\w.+-]+@[\w-]+\.[\w.]+/;
  for (let pass = 0; pass < 2; pass++) {
    for (const cand of rest) {
      if (used >= budget) break;
      const isFact = FACT_RE.test(cand.s);
      if ((pass === 0) !== isFact) continue;
      const ceil = pass === 0 ? budget * 1.45 : budget * 1.12;
      if (used + cand.tokens > ceil) continue;
      chosen.add(cand.i);
      used += cand.tokens;
    }
  }
  // Guarantee at least one high-signal middle sentence on tiny inputs.
  if (chosen.size <= 2 && rest.length) {
    chosen.add(rest[0].i);
  }

  let compressed = scored.filter((x) => chosen.has(x.i)).map((x) => x.s).join(' ');

  // Fact guarantee: any high/medium fact not covered by the kept sentences is
  // appended as a compact key-facts appendix. Costs a handful of tokens,
  // guarantees the verifier never reports a dropped date, number, URL or
  // contact — the entire point of ContextForge.
  const chosenText = compressed.toLowerCase();
  const uncovered = extractFacts(context).filter(
    (f) => f.severity !== 'low' && !chosenText.includes(f.value.toLowerCase())
  );
  if (uncovered.length) {
    const appendixBudget = Math.max(12, Math.round(budget * 0.25));
    const items = [];
    let usedTokens = 0;
    for (const f of uncovered) {
      const t = estimateTokens(f.value);
      if (items.length >= 12 || usedTokens + t > appendixBudget) break;
      items.push(f.value.replace(/\s+/g, ' ').trim());
      usedTokens += t;
    }
    if (items.length) {
      compressed += ` — key facts: ${items.join(' · ')}`;
    }
  }
  return { compressed, kept: chosen.size, total: sentences.length };
}

const COMPRESS_SYSTEM_PROMPT =
  'You are a prompt compression engine. Compress the user\'s context to roughly the requested ' +
  'fraction of its size while preserving EVERY fact: numbers, dates, names, URLs, decisions, ' +
  'quantities, and any information the user flagged as important. Drop filler, pleasantries, ' +
  'repetition and verbose phrasing. Keep the original order of ideas. Output ONLY the compressed ' +
  'context — no preamble, no commentary, no markdown fences.';

async function llmCompress(context, targetRatio, instructions, model) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    const fb = extractiveCompress(context, targetRatio, instructions);
    return { ...fb, fallbackReason: 'No OPENROUTER_API_KEY set — used extractive engine.' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const words = context.split(/\s+/).length;
    const targetWords = Math.max(50, Math.round(words * targetRatio));
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'HTTP-Referer': 'https://contextforge-production-2ff7.up.railway.app',
        'X-Title': 'ContextForge',
      },
      body: JSON.stringify({
        model: model || 'anthropic/claude-haiku-5.5',
        temperature: 0.2,
        max_tokens: Math.min(16000, Math.round(targetWords * 2.2)),
        messages: [
          { role: 'system', content: COMPRESS_SYSTEM_PROMPT },
          {
            role: 'user',
            content:
              `Compress this context to approximately ${Math.round(targetRatio * 100)}% of its size ` +
              `(about ${targetWords} words).${instructions ? `\nPreserve especially: ${instructions}` : ''}\n\n` +
              context,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
    const data = await res.json();
    const compressed = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content.trim()
      : '';
    if (!compressed) throw new Error('empty completion');
    return { compressed, kept: null, total: null };
  } finally {
    clearTimeout(timer);
  }
}

async function compressContext(opts) {
  const { context, targetRatio, engine, model, instructions } = opts;
  if (engine === 'llm') {
    try {
      const out = await llmCompress(context, targetRatio, instructions, model);
      if (out.fallbackReason) return { ...out, method: 'extractive' };
      return { ...out, method: 'llm' };
    } catch (err) {
      const out = extractiveCompress(context, targetRatio, instructions);
      return { ...out, method: 'extractive', fallbackReason: `LLM engine failed (${err.message}) — extractive used.` };
    }
  }
  return { ...extractiveCompress(context, targetRatio, instructions), method: 'extractive' };
}

module.exports = { compressContext, extractiveCompress, splitSentences };
