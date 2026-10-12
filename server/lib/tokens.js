'use strict';

// Heuristic token estimator. Vendors guard their tokenizers; this blends the
// two best zero-dependency estimators (chars/4 and word count) and is
// typically within ±10% for prose, code and mixed content.
// CJK ideographs + kana tokenize at roughly 1-1.5 chars/token — the
// chars/4 heuristic badly undercounts them, so they're weighted separately.
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

function estimateTokens(text) {
  if (!text) return 0;
  const cjkMatches = text.match(CJK_RE) || [];
  const cjk = cjkMatches.length;
  const nonCjkChars = text.length - cjk;
  const words = (text.match(/[A-Za-z0-9\u00c0-\u024f\u0400-\u04ff\S]*[A-Za-z0-9\u00c0-\u024f\u0400-\u04ff][\S]*/g) || []).length;
  return Math.max(1, Math.round(cjk * 0.75 + (nonCjkChars / 4) * 0.55 + words * 0.9));
}

module.exports = { estimateTokens };
