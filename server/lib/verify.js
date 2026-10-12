'use strict';

// Faithfulness verification: extract checkable facts from the original context
// and confirm each survived compression. Deterministic, no LLM required.

const MAX_FACTS = 400;

const ACRONYM_STOP = new Set([
  'OK', 'YES', 'NO', 'HI', 'HEY', 'THANKS', 'TODO', 'FYI', 'ASAP', 'RE', 'FW', 'GMT', 'UTC', 'PM', 'AM',
  // Common tech/business vocabulary — not distinguishing facts.
  'API', 'HTTP', 'HTTPS', 'JSON', 'XML', 'URL', 'URI', 'HTML', 'CSS', 'SQL', 'OSS',
  'SSO', 'SLA', 'SOC', 'GDPR', 'HIPAA', 'PDF', 'CSV', 'LLM', 'AI', 'ML', 'QA', 'UX', 'UI',
  'IT', 'HR', 'PR', 'CEO', 'CFO', 'CTO', 'COO', 'VP', 'USA', 'EU', 'UK', 'SaaS', 'B2B',
  'KPI', 'OKR', 'ETA', 'ID', 'UUID', 'CI', 'CD',
]);

function norm(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function pushFacts(set, matches, kind, severity) {
  for (const m of matches) {
    const value = (typeof m === 'string' ? m : m[0]).trim();
    if (!value) continue;
    const key = `${kind}:${norm(value)}`;
    if (!set.has(key)) set.set(key, { value, kind, severity });
  }
}

function extractFacts(text) {
  const facts = new Map();
  const t = text || '';

  pushFacts(facts, t.match(/https?:\/\/[^\s)>\]"']+/gi) || [], 'url', 'high');
  pushFacts(facts, t.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || [], 'email', 'medium');
  pushFacts(facts, t.match(/[$€£]\s?\d[\d,]*(?:\.\d+)?/g) || [], 'money', 'high');
  pushFacts(facts, t.match(/\b\d[\d,]*(?:\.\d+)?\s?%/g) || [], 'percent', 'high');
  pushFacts(
    facts,
    t.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?\b/gi) || [],
    'date',
    'high'
  );
  pushFacts(facts, t.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [], 'date', 'high');
  pushFacts(facts, t.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g) || [], 'date', 'high');
  pushFacts(
    facts,
    t.match(/\b\d[\d,]*(?:\.\d+)?\s?(?:million|billion|bn|thousand|k|x)\b/gi) || [],
    'quantity',
    'high'
  );
  // Numbers with units (keep after money/percent so those win dedupe by kind)
  pushFacts(
    facts,
    t.match(/\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|days?|hours?|hrs?|minutes?|mins?|seconds?|ms|tokens?|users?|requests?|customers?|GB|MB|TB|KB)\b/gi) || [],
    'number',
    'high'
  );
  pushFacts(facts, t.match(/"([^"\n]{3,60})"/g) || [], 'quoted', 'medium');
  const STARTERS = new Set(['The', 'This', 'That', 'There', 'Then', 'And', 'But', 'For', 'With', 'More', 'Team', 'Contact', 'Please', 'Thanks', 'When', 'While', 'Until', 'Because', 'Our', 'Your', 'Their', 'What', 'Where', 'How', 'Why', 'Also', 'Next', 'First', 'Last', 'Perfect', 'Great']);
  const nameMatches = [];
  for (const m of t.match(/\b[A-Z][a-zA-Z&.]{1,}(?:[ \t]+[A-Z][a-zA-Z&.]{1,}){1,3}\b/g) || []) {
    const first = m.split(/[ \t]/)[0];
    if (!STARTERS.has(first)) nameMatches.push(m);
  }
  pushFacts(facts, nameMatches, 'name', 'low');
  const UPPER_STOP = new Set([...ACRONYM_STOP, 'THE', 'AND', 'FOR', 'NOT', 'ALL', 'BUT', 'CAN', 'GET', 'NEW', 'NOW', 'ONE', 'TWO', 'WHO', 'WHY', 'HOW', 'ANY', 'DAY', 'WAY', 'USE', 'US', 'IE', 'EG']);
  pushFacts(
    facts,
    (t.match(/\b[A-Z]{2,7}\b/g) || []).filter((a) => !UPPER_STOP.has(a)),
    'acronym',
    'low'
  );

  const all = [...facts.values()];
  // Bias the cap toward high-severity facts.
  all.sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 };
    return rank[a.severity] - rank[b.severity];
  });
  return all.slice(0, MAX_FACTS);
}

function verifyFaithfulness(original, compressed) {
  const facts = extractFacts(original);
  if (!facts.length) {
    return { score: 100, factsTotal: 0, factsKept: 0, missing: [] };
  }
  const WEIGHT = { high: 3, medium: 2, low: 1 };
  const haystack = norm(compressed);
  const missing = [];
  let weightKept = 0;
  let weightTotal = 0;
  let keptCount = 0;
  for (const f of facts) {
    weightTotal += WEIGHT[f.severity];
    if (haystack.includes(norm(f.value))) {
      weightKept += WEIGHT[f.severity];
      keptCount++;
    } else {
      missing.push(f);
    }
  }
  const score = Math.round((weightKept / Math.max(1, weightTotal)) * 100);
  const kept = keptCount;
  missing.sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 };
    return rank[a.severity] - rank[b.severity] || a.kind.localeCompare(b.kind);
  });
  // All high/medium missing facts are reported; low-severity chips are capped
  // so passing name mentions don't flood the UI.
  const highMed = missing.filter((f) => f.severity !== 'low');
  const low = missing.filter((f) => f.severity === 'low').slice(0, 20);
  return {
    score,
    factsTotal: facts.length,
    factsKept: kept,
    missing: [...highMed.slice(0, 40), ...low],
  };
}

module.exports = { verifyFaithfulness, extractFacts };
