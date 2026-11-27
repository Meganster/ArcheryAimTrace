import { savedOfflineScore } from '../telemetry/offline-score.js?v=aim-pipeline-164';
import { offlineScoreReport, offlineIssueLabel } from './offline-score.js?v=aim-pipeline-164';
import { buildOfflineComparison, comparisonPoints, comparisonGroupMetrics, comparisonWindow } from '../telemetry/offline-comparison.js?v=aim-pipeline-164';
import { aimTraceLayout } from './aim-trace.js?v=aim-pipeline-164';
import { drawTargetFace } from './target-face.js?v=aim-pipeline-164';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n = (x) => Number.isFinite(x) ? x.toFixed(3) : '—';
const colors = ['#007fa3', '#c43e62', '#7d51aa', '#008767', '#b56600', '#4366c5'];
const label = (entry) => entry.orderLabel || `Shot ${entry.shot.device_shot_id ?? entry.shot.id.slice(0, 8)}`;

// All traces share a physical scale, including the optional fit of the whole set.
export function drawOfflineComparison(ctx, cohort, { width, height, phase = 'hold', mode = 'physical', focusId = null, colorForGroup = () => colors[0] }) {
  ctx.clearRect(0, 0, width, height);
  if (!cohort?.entries.length) return;
  const radius = Math.max(1, Math.min(width, height) * 0.39), cx = width / 2, cy = height / 2;
  const traces = cohort.entries.map((entry) => ({ entry, points: comparisonPoints(entry, phase) }));
  const extent = traces.reduce((max, {points}) => points.reduce((m, p) => Number.isFinite(p.aim?.xMeters) && Number.isFinite(p.aim?.yMeters)
    ? Math.max(m, Math.hypot(p.aim.xMeters, p.aim.yMeters)) : m, max), 0);
  const layouts = traces.map(({points}) => aimTraceLayout(points, { cx, cy, radius, mode, fitExtent: extent }));
  const geometry = layouts.find(Boolean);
  const p = cohort.parameters;
  drawTargetFace(ctx, { cx, cy, maxRadius: geometry?.faceRadiusPixels || radius,
    preset: {faceDiameterCm:122, label:`${p.distanceMeters} m`, faceLabel:`${p.faceDiameterCm} cm · ${mode === 'fit' ? 'shared fit' : 'physical 1×'}`} });
  let clipped = 0;
  ctx.save();ctx.beginPath();ctx.rect(0, 0, width, height);ctx.clip();
  for (let i = 0; i < traces.length; i++) {
    const {entry, points} = traces[i], layout = layouts[i];
    if (!layout) continue;
    ctx.strokeStyle = colorForGroup(entry.groupId);
    ctx.globalAlpha = focusId ? entry.shot.id === focusId ? 1 : 0.12 : 0.65;
    ctx.lineWidth = entry.shot.id === focusId ? 3 : 1.5;
    let previous = null;
    for (let j = 0; j < points.length; j++) {
      const point = layout.map(points[j]);
      const dt = points[j].aim?.samplePeriodUs;
      if (!point || points[j].gapBefore || (j && dt && points[j].tUs - points[j-1].tUs > dt * 1.5)) previous = null;
      if (!point) continue;
      if (point.x < 0 || point.x > width || point.y < 0 || point.y > height) clipped++;
      if (previous) {ctx.beginPath();ctx.moveTo(previous.x, previous.y);ctx.lineTo(point.x, point.y);ctx.stroke();}
      if (points[j].detectorEvent) {ctx.beginPath();ctx.arc(point.x,point.y,4,0,Math.PI*2);ctx.stroke();}
      previous = point;
    }
  }
  ctx.restore();
  ctx.fillStyle = '#617b73';ctx.font = '12px sans-serif';
  ctx.fillText('Each shot relative to its own mean pre-shot aim', 12, 53);
  ctx.fillText(clipped ? 'Some points outside view — choose Shared fit.' : 'Same scale for every trace · circles = DETECTOR', 12, height-12);
}

export function createOfflineComparisonPanel({ root, onReview, onAnalyze, onPair }) {
  let model = null, title = '', entries = [], cohortIndex = 0, phase = 'hold', mode = 'physical', focusId = null;
  const groupColors = new Map();
  const color = (id) => groupColors.get(id) || colors[0];
  function paint() {
    const canvas = root.querySelector('canvas');
    if (!canvas || root.hidden) return;
    const rect = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width*dpr));canvas.height = Math.max(1, Math.round(rect.height*dpr));
    const ctx = canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);
    drawOfflineComparison(ctx, model.cohorts[cohortIndex], {width:rect.width,height:rect.height,phase,mode,focusId,colorForGroup:color});
  }
  const observer = new ResizeObserver(paint); observer.observe(root);
  function render() {
    const individualShotsOpen = root.querySelector('.comparison-individual-shots')?.open ?? false;
    const cohort = model.cohorts[cohortIndex];
    const tablePhase = phase === 'full' ? 'hold' : phase;
    const groups = cohort ? comparisonGroupMetrics(cohort, phase) : [];
    const options = model.cohorts.map((c, i) => `<option value="${i}"${i===cohortIndex?' selected':''}>${c.parameters.distanceMeters} m / ${c.parameters.faceDiameterCm} cm · ${c.entries.length} shots · v${c.version} · reference ${c.parameters.referenceWindowMs.join('…')} ms</option>`).join('');
    const row = (entry) => {
      const m = entry.analysis.result.metrics[tablePhase];
      const motionScore = savedOfflineScore(entry.analysis);
      return `<tr class="${entry.shot.id===focusId?'comparison-focused':''}"><td><button type="button" data-focus="${esc(entry.shot.id)}" aria-pressed="${entry.shot.id===focusId}">${esc(label(entry))}</button></td><td>${esc(entry.groupName)}</td>
        <td>${motionScore?.total ?? '—'} / 100<br><small>${esc(offlineIssueLabel(motionScore))}</small></td>
        <td>${m ? '' : 'Window unavailable · '}<button type="button" data-review="${esc(entry.shot.id)}">Review</button> <button type="button" data-analyze="${esc(entry.shot.id)}">Analyze shot</button></td></tr>`;
    };
    const focused = cohort?.entries.find(e=>e.shot.id===focusId);
    root.hidden = false;
    root.innerHTML = `<div class="comparison-heading"><div><h3>${esc(title)}</h3><p class="note">${model.total} selected · ${model.total-model.excluded.length} analyzed · ${model.excluded.length} excluded. ${model.cohorts.length > 1 ? 'Different settings are shown in separate sets.' : ''}</p></div><button type="button" data-close>Close comparison</button></div>
      <div class="comparison-controls"><button type="button" data-analyze-all>Analyze this set</button><span class="note">Uses your analysis settings.</span>
      ${entries.length===2?'<button type="button" data-pair>Open pair in review</button>':''}</div>
      ${cohort ? `<div class="comparison-controls"><label>Compatible set<select data-cohort>${options}</select></label><label>Window<select data-phase><option value="hold">Hold</option><option value="pre">Before detector</option><option value="post">Follow-through</option><option value="full">Full trace</option></select></label><label>Scale<select data-scale><option value="physical">Physical 1×</option><option value="fit">Shared fit</option></select></label><button type="button" data-clear-focus>Show all equally</button></div>
      <p class="note">Window: ${comparisonWindow(cohort.parameters,phase)?.join('…') ?? 'full recorded trace'} ms. ${phase==='full'?'Tables show hold metrics.':''} Click a shot in the table to highlight its trace.</p>
      <div class="comparison-legend">${groups.map(g=>`<span><i style="background:${color(g.id)}"></i>${esc(g.name)} · ${g.usable}/${g.total} usable in window</span>`).join('')}</div>
      <canvas class="offline-comparison-canvas" aria-label="Selected shot trajectories at a shared physical scale"></canvas>
      ${focused ? offlineScoreReport(focused.analysis, focused.peer, {windowButtons:true}) : '<p class="note">Select a shot in the table to see its score breakdown, main issue and group comparison.</p>'}
      <details class="comparison-measurements"><summary>Group measurements</summary><div class="comparison-table-wrap"><table><thead><tr><th>Group</th><th>Usable</th><th>σ X/Y (°)</th><th>σ X/Y (cm)</th><th>Cant σ (°)</th><th>Δ X/Y (°)</th></tr></thead><tbody>${groups.map(g=>`<tr><td>${esc(g.name)}</td><td>${g.usable}/${g.total}</td><td>${n(g.metrics.xStdDeg)} / ${n(g.metrics.yStdDeg)}</td><td>${n(g.metrics.xStdCm)} / ${n(g.metrics.yStdCm)}</td><td>${n(g.metrics.cantStdDeg)}</td><td>${n(g.metrics.deltaXDeg)} / ${n(g.metrics.deltaYDeg)}</td></tr>`).join('')}</tbody></table></div>
      </details><details class="comparison-measurements comparison-individual-shots"${individualShotsOpen ? ' open' : ''}><summary>Individual shots</summary><div class="comparison-table-wrap"><table><thead><tr><th>Shot / highlight</th><th>Group</th><th>Score / main issue</th><th>Actions</th></tr></thead><tbody>${cohort.entries.map(row).join('')}</tbody></table></div></details>` : '<p>No comparable trajectories yet. Analyze this set, then check any excluded records below.</p>'}
      ${model.excluded.length ? `<details open><summary>Excluded records (${model.excluded.length})</summary><ul>${model.excluded.map(e=>`<li>${esc(label(e))} · ${esc(e.groupName)} — ${esc(e.reason)} <button type="button" data-review="${esc(e.shot.id)}">Review</button></li>`).join('')}</ul></details>`:''}
      <p class="note">Scores describe bow movement, not arrow impact.</p>`;
    root.querySelector('[data-score-window]')?.addEventListener('click', () => {
      phase = savedOfflineScore(focused.analysis)?.issue?.key === 'pre' ? 'pre' : 'hold';
      render();
      root.querySelector('canvas')?.scrollIntoView({block:'start',behavior:'smooth'});
    });
    root.querySelector('[data-close]').onclick = () => {root.hidden=true;};
    root.querySelector('[data-analyze-all]').onclick = (e) => onAnalyze(entries.map(e=>e.shot.id), e.currentTarget, title);
    root.querySelector('[data-pair]')?.addEventListener('click', () => onPair(entries.map(e=>e.shot.id)));
    root.querySelectorAll('[data-review]').forEach(b=>b.onclick=()=>onReview(b.dataset.review));
    root.querySelectorAll('[data-analyze]').forEach(b=>b.onclick=()=>onAnalyze([b.dataset.analyze], b, title, entries.map(e=>e.shot.id)));
    root.querySelectorAll('[data-focus]').forEach(b=>b.onclick=()=>{focusId=focusId===b.dataset.focus?null:b.dataset.focus;render();});
    root.querySelector('[data-clear-focus]')?.addEventListener('click',()=>{focusId=null;render();});
    const bind = (selector, value, action) => {const input=root.querySelector(selector);if(input){input.value=value;input.onchange=()=>{action(input.value);render();};}};
    bind('[data-cohort]', String(cohortIndex), value=>{cohortIndex=Number(value);focusId=null;});
    bind('[data-phase]', phase, value=>{phase=value;});bind('[data-scale]', mode, value=>{mode=value;});
    requestAnimationFrame(paint);
  }
  return {
    scope: () => root.hidden ? null : { ids: entries.map(e=>e.shot.id), title },
    show(next, name, {scroll=true}={}) {
      entries=next;title=name;model=buildOfflineComparison(entries);cohortIndex=0;focusId=entries.length===1?entries[0].shot.id:null;
      groupColors.clear();for(const e of entries) if(!groupColors.has(e.groupId)) groupColors.set(e.groupId,colors[groupColors.size%colors.length]);
      render();if(scroll)root.scrollIntoView({block:'start',behavior:'smooth'});
    },
  };
}
