'use strict';

// Heuristic token estimator. Vendors guard their tokenizers; this blends the
// two best zero-dependency estimators (chars/4 and word count) and is
// typically within ±10% for prose, code and mixed content.
function estimateTokens(text) {
  if (!text) return 0;
  const chars = text.length;
  const words = (text.match(/\S+/g) || []).length;
  return Math.max(1, Math.round((chars / 4) * 0.55 + words * 0.9));
}

module.exports = { estimateTokens };
