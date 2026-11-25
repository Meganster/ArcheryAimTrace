import { summarizeOfflineSeries } from '../telemetry/offline-aim.js?v=aim-pipeline-163';
const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = (n) => Number.isFinite(n) ? n.toFixed(3) : '—';
export function offlineMetricsText(analysis) {
  if (analysis?.status !== 'calculated') return `Relative analysis unavailable: ${analysis?.reasons?.join(', ') || 'not analyzed'}`;
  const m = analysis.result?.metrics || analysis.metrics;
  const p = analysis.parameters;
  const windowText = (key, title) => {
    const x = m[key];
    return x ? `${title}: σ X/Y ${number(x.xStdDeg)}° / ${number(x.yStdDeg)}° (${number(x.xStdCm)} / ${number(x.yStdCm)} cm); Δ X/Y ${number(x.deltaXDeg)}° / ${number(x.deltaYDeg)}°; cant σ ${number(x.cantStdDeg)}°` : `${title}: unavailable (incomplete window or projection)`;
  };
  return `Relative to mean pre-shot aim · ${p.distanceMeters} m · ${p.faceDiameterCm} cm face · reference ${p.referenceWindowMs.join('…')} ms. ` +
    [windowText('hold', 'Hold'), windowText('pre', 'Before detector'), windowText('post', 'Follow-through')].join(' | ') +
    ` | Detector sampling ≈ ${number((analysis.result?.quality || analysis.quality)?.samplePeriodUs / 1000)} ms; detector latency unknown. No drift removal or smoothing.`;
}
export function offlineSeriesHtml(shots) {
  if (!shots.some((s) => s.stored_upload)) return '';
  const summary = summarizeOfflineSeries(shots);
  const rows = summary.groups.map((g) => `<tr><td>${escape(g.parameters.distanceMeters)} m / ${escape(g.parameters.faceDiameterCm)} cm</td><td>${g.count}</td><td>${number(g.xStdDeg)} / ${number(g.yStdDeg)}</td><td>${number(g.xStdCm)} / ${number(g.yStdCm)}</td><td>${escape(g.parameters.referenceWindowMs.join('…'))} ms · v${g.version}</td></tr>`).join('');
  const excluded = summary.excluded.map((s) => `${escape(s.id.slice(0, 8))}: ${escape(s.reason)}`).join('; ');
  return `<div class="group-offline-summary" style="padding:12px"><strong>Offline relative aim</strong><p class="note">Mean per-shot hold standard deviation. Different analysis settings remain separate; these are not impact groups or Float Scores.</p>
    <table><thead><tr><th>Geometry</th><th>Usable</th><th>σ X/Y (°)</th><th>σ X/Y (cm)</th><th>Reference / algorithm</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="note">Excluded: ${summary.excluded.length}${excluded ? ' · ' + excluded : ''}</p></div>`;
}
