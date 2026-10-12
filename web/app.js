'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => n.toLocaleString('en-US');

// Embedded fallback catalog (server also exposes /api/health; catalog is static enough for UI)
const TARGETS = [
  ['Claude Opus 4.6', 5.0],
  ['GPT-6.1 Sol', 2.0],
  ['Grok 4', 3.0],
  ['Gemini 2.5 Flash', 0.3],
  ['Claude Haiku 5.5', 0.1],
  ['GLM 5.3', 0.08],
];
const COMPRESSORS = ['anthropic/claude-haiku-5.5', 'google/gemini-2.5-flash', 'z-ai/glm-5.3', 'meta-llama/llama-4-maverick'];

const SAMPLE = `Support thread #48211 — Acme Corp (Enterprise plan, 2,400 seats)

[Mon 2026-09-14, 09:02] Hi team, we're evaluating an upgrade to the Ultra tier before our renewal on 2026-11-01. Our current spend is $18,400/month. What would Ultra cost us?

[Mon 2026-09-14, 09:31] Agent (Dana): Thanks Maya! Great to hear. Ultra for 2,400 seats is $7.50/seat/month → $18,000/month, plus the $2,000/month compliance add-on you flagged. So $20,000/month total, but with the 15% annual discount that's $17,000/month billed yearly ($204,000/year). Your renewal date stays 2026-11-01.

[Mon 2026-09-14, 10:15] Maya: Interesting. And what about the API limits? We currently average 40M requests/month with peaks around 90M.

[Mon 2026-09-14, 10:40] Dana: Ultra raises the limit from 50M to 250M requests/month and increases the per-burst cap to 25,000 requests. Latency SLO stays at 300ms p99; support SLA improves from 24h to 1h response.

[Mon 2026-09-14, 11:02] Maya: One more thing — GDPR. We were audited in March 2026 and need EU data residency.

[Mon 2026-09-14, 11:20] Dana: Ultra includes EU residency (Frankfurt and Dublin regions) at no extra charge, and the DPA at https://acme.example.com/dpa covers it. Your CISO can email security@acme.example.com for the SOC 2 report.

[Mon 2026-09-14, 11:45] Maya: Perfect. Please also note: our CFO (Robert Chen) needs the final quote by 2026-10-15 for the budget cycle, and we must keep the legacy SSO integration (SAML 1.1) through Q1 2027.

[Mon 2026-09-14, 12:10] Dana: Noted — quote by October 15, SAML 1.1 through Q1 2027. I'll loop in our solutions engineer, Priya Patel, for the SSO migration plan.

Thanks!
Maya Lindqvist, Head of Platform Engineering, Acme Corp
maya@acme.example.com | +1 (555) 010-2288`;

function ratioColor(score) {
  if (score >= 90) return '#4ade80';
  if (score >= 70) return '#fbbf24';
  return '#f87171';
}

function renderSavings(originalTokens, compressedTokens) {
  const rows = $('savingsRows');
  const delta = Math.max(0, originalTokens - compressedTokens);
  rows.innerHTML = TARGETS.map(([name, perM]) => {
    const was = originalTokens / 1e6 * perM;
    const now = compressedTokens / 1e6 * perM;
    const save = delta / 1e6 * perM;
    return `<div class="srow"><span>${name}</span><span class="was">$${was.toFixed(3)} → $${now.toFixed(3)}</span><span class="amt">−$${save.toFixed(3)}</span></div>`;
  }).join('');
}

function renderMissing(missing) {
  const box = $('missing');
  if (!missing || !missing.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  $('missingList').innerHTML = missing.map((f) =>
    `<li class="${f.severity === 'high' ? '' : f.severity === 'medium' ? 'med' : 'low'}">${esc(f.value)}<em>${f.kind}</em></li>`
  ).join('');
}

async function forge() {
  const context = $('input').value;
  if (!context.trim()) { $('input').focus(); return; }
  const btn = $('forge');
  btn.disabled = true; btn.textContent = 'Forging…';

  const payload = {
    context,
    targetRatio: Number($('ratio').value) / 100,
    engine: $('engine').value,
    instructions: $('instructions').value || undefined,
  };
  if (payload.engine === 'llm') payload.model = $('model').value;

  try {
    const res = await fetch('/api/compress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error((await res.json()).error || res.status);
    const data = await res.json();

    $('output').value = data.compressed;
    $('copy').disabled = false;
    $('inMeta').textContent = `· ${fmt(data.originalTokens)} tokens`;
    $('outMeta').textContent =
      `· ${fmt(data.compressedTokens)} tokens (${data.compression}x) in ${data.elapsedMs}ms · ${data.method}`;
    $('mRatio').textContent = `${data.compression}x`;
    $('mTokens').textContent = `${fmt(data.originalTokens)} → ${fmt(data.compressedTokens)}`;
    $('mTime').textContent = `${data.elapsedMs}ms`;
    $('mMethod').textContent = data.method === 'llm' ? 'LLM' : 'extractive';
    if (data.fallbackReason) $('outMeta').textContent += ` · ${data.fallbackReason}`;

    // Verify faithfulness
    const vres = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ original: context, compressed: data.compressed }),
    });
    const v = await vres.json();
    $('score').textContent = `${v.score}`;
    $('score').style.color = ratioColor(v.score);
    $('scoreBar').style.width = `${v.score}%`;
    $('scoreBar').style.background = ratioColor(v.score);
    $('verifyMeta').textContent =
      `${v.factsKept} of ${v.factsTotal} facts kept · numbers, dates, URLs, emails and names checked`;

    renderMissing(v.missing);
    renderSavings(data.originalTokens, data.compressedTokens);
    $('results').classList.remove('hidden');
    $('results').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    refreshStats();
  } catch (err) {
    alert('Forge failed: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = '⚒ Forge context';
  }
}

async function refreshStats() {
  try {
    const res = await fetch('/api/stats');
    const s = await res.json();
    $('stats').textContent =
      `${fmt(s.jobs)} contexts forged · ${fmt(s.tokensForged)} tokens burned away · est. $${s.estSavingsUsd.toFixed(2)} saved (vs $5/M input) · since ${new Date(s.startedAt).toLocaleString()}`;
  } catch { /* ignore */ }
}

function bind() {
  $('ratio').addEventListener('input', () => ($('ratioOut').textContent = $('ratio').value + '%'));
  $('engine').addEventListener('change', () => {
    const isLlm = $('engine').value === 'llm';
    $('model').classList.toggle('hidden', !isLlm);
    if (isLlm && !$('model').options.length) {
      $('model').innerHTML = COMPRESSORS.map((m) => `<option>${m}</option>`).join('');
    }
  });
  $('forge').addEventListener('click', forge);
  $('sample').addEventListener('click', () => {
    $('input').value = SAMPLE;
    $('inMeta').textContent = '· sample loaded';
  });
  $('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('output').value);
      $('copy').textContent = 'Copied ✓';
      setTimeout(() => ($('copy').textContent = 'Copy forged context'), 1500);
    } catch { /* clipboard unavailable */ }
  });
  refreshStats();
}

document.addEventListener('DOMContentLoaded', bind);
