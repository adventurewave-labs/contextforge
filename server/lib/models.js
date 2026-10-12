'use strict';

// Live pricing snapshot from the OpenRouter catalog, 2026-10-12 (USD per 1M tokens).

const COMPRESSORS = [
  { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5', input: 0.1, output: 0.5, context: 1000000 },
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', input: 0.3, output: 2.5, context: 1048576 },
  { id: 'z-ai/glm-5.3', label: 'GLM 5.3', input: 0.08, output: 4.8, context: 1048576 },
  { id: 'meta-llama/llama-4-maverick', label: 'Llama 4 Maverick', input: 0.19, output: 0.65, context: 1048576 },
];

const TARGETS = [
  { id: 'anthropic/claude-opus-4.6', label: 'Claude Opus 4.6', input: 5.0, output: 25.0, context: 1000000 },
  { id: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol', input: 2.0, output: 10.0, context: 1050000 },
  { id: 'google/gemini-3-pro-preview', label: 'Gemini 3 Pro', input: 2.0, output: 12.0, context: 1048576 },
  { id: 'x-ai/grok-4', label: 'Grok 4', input: 3.0, output: 15.0, context: 256000 },
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', input: 0.3, output: 2.5, context: 1048576 },
  { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5', input: 0.1, output: 0.5, context: 1000000 },
  { id: 'z-ai/glm-5.3', label: 'GLM 5.3', input: 0.08, output: 4.8, context: 1048576 },
  { id: 'meta-llama/llama-4-maverick', label: 'Llama 4 Maverick', input: 0.19, output: 0.65, context: 1048576 },
];

function catalog() {
  return {
    snapshotDate: '2026-10-12',
    source: 'https://openrouter.ai/api/v1/models',
    compressors: COMPRESSORS,
    targets: TARGETS,
  };
}

module.exports = { catalog, COMPRESSORS, TARGETS };
