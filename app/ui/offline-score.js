import { savedOfflineScore, offlineScoreKey } from '../telemetry/offline-score.js?v=aim-pipeline-163';
import { sessionOrder } from '../core/session-order.js?v=aim-pipeline-163';
const esc = x => String(x ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = x => Number.isFinite(x) ? x.toFixed(1) : '—';
export function offlineIssueLabel(s) {
  return !s ? 'Analyze shot to calculate' : s.issue?.label || (s.status === 'complete' ? 'No major issue detected' : 'Incomplete assessment');
}
export function offlineScoreReport(analysis, peer = null, {windowButtons = false} = {}) {
  const s = savedOfflineScore(analysis);
  if (!s) return '<section class="offline-score-report"><strong>Offline Motion Score · not calculated</strong><p>Choose Analyze shot or Analyze group to calculate the current score. Legacy traces without usable timing cannot be scored.</p></section>';
  const cards = ['hold','pre','cant'].map(key=>{
    const c=s.components[key];
    return `<div class="offline-score-component"><span>${esc(c?.label || ({hold:'Hold stability',pre:'Before-detector control',cant:'Cant consistency'}[key]))}</span><strong>${c ? `${c.score}/100` : 'Unavailable'}</strong>
      ${c ? '' : '<small>Not enough data</small>'}</div>`;
  }).join('');
  return `<section class="offline-score-report" aria-label="Offline shot score and main issue">
    <div class="offline-score-heading"><strong>Offline Motion Score</strong><b>${s.total == null ? 'Incomplete' : `${s.total}/100`}</b></div>
    <p class="note">Movement score · higher is steadier. Not target points.</p>
    <div class="offline-score-components">${cards}</div>
    <div class="offline-main-issue"><strong>Main issue${s.issue?.tentative ? ' (partial assessment)' : ''}: ${esc(offlineIssueLabel(s))}</strong>
    ${s.issue ? `${windowButtons ? '<button type="button" data-score-window>Show issue window</button>' : ''}` : ''}</div>
    <p>${peer ? `Other comparable shots in this group: ${peer.count} · average ${num(peer.mean)}/100 · this shot ${peer.difference >= 0 ? '+' : ''}${num(peer.difference)} points.` : 'Analyze another shot in this group to compare results.'}</p>
    ${s.reasons.length ? '<p class="note">Not enough data for an overall score.</p>' : ''}
    <details class="score-measurements"><summary>Measurements</summary>
      ${Object.values(s.components).map(c=>`<p><strong>${esc(c.label)}:</strong> ${esc(c.evidence)} · ${esc(c.windowMs.join('…'))} ms</p>`).join('')}
      <p>${esc(s.post?.description || 'After-shot movement unavailable.')}</p>
    </details>
  </section>`;
}
export function offlineSessionScoresHtml(shots, firstDeviceShot = null) {
  if (!shots.some(s=>s.stored_upload)) return '';
  const order=sessionOrder(shots,firstDeviceShot), sets=new Map();
  for (const entry of order.entries) {
    const a=entry.shot.offline_analysis, key=offlineScoreKey(a);
    if (!key) continue;
    if (!sets.has(key)) sets.set(key,[]);
    sets.get(key).push({...entry,score:a.score,analysis:a});
  }
  if (!sets.size) return '<div class="session-review offline-score-session"><strong>Offline Motion Score Trend</strong><p class="note">Analyze group to calculate scores and recurring issues. Complete hold and before-detector windows are required.</p></div>';
  const scored=[...sets.values()].reduce((n,rows)=>n+rows.length,0);
  return [...sets.values()].map((rows,index)=>{
    const mean=rows.reduce((n,r)=>n+r.score.total,0)/rows.length;
    const best=rows.reduce((a,b)=>a.score.total>=b.score.total?a:b), worst=rows.reduce((a,b)=>a.score.total<=b.score.total?a:b);
    const issues=new Map();
    for (const {score} of rows) if(score.issue) issues.set(score.issue.label,(issues.get(score.issue.label)||0)+1);
    const issueRows=[...issues].sort((a,b)=>b[1]-a[1]);
    const start=order.entries[0].number, end=order.entries.at(-1).number;
    const dots=rows.map(r=>({...r,x:end===start?160:24+272*(r.number-start)/(end-start),y:76-r.score.total*0.6}));
    const path=dots.map((p,i)=>`${i&&p.number===dots[i-1].number+1?'L':'M'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
    const p=rows[0].analysis.parameters;
    return `<section class="session-review offline-score-session"><div class="session-review-head"><span>Offline Motion Score${sets.size>1?` · settings ${index+1}`:''}</span><strong>${num(mean)}/100 average</strong></div>
      <p class="note">${rows.length} scored · ${shots.length-scored} not scored · ${esc(p.distanceMeters)} m / ${esc(p.faceDiameterCm)} cm${sets.size>1?' · Different analysis settings are kept separate.':''}</p>
      <div class="group-analysis-actions"><button type="button" data-review-shot-id="${esc(best.shot.id)}">Best: ${esc(best.label)} · ${best.score.total}</button><button type="button" data-review-shot-id="${esc(worst.shot.id)}">Lowest: ${esc(worst.label)} · ${worst.score.total}</button></div>
      <strong>Recurring issues</strong><p>${issueRows.length?issueRows.map(([name,count])=>`${esc(name)}: ${count}/${rows.length}`).join(' · '):'No major issue detected'}</p>
      <div class="session-float-plot"><div class="session-float-plot-head"><span>Offline Motion Score Trend</span><strong>${rows.at(-1).score.total} latest</strong></div>
      <svg viewBox="0 0 320 100" role="img" aria-label="Offline motion scores from earliest to latest">
        <line x1="24" y1="76" x2="296" y2="76" class="session-float-grid"/><text x="2" y="20" font-size="9" fill="currentColor">100</text><text x="4" y="76" font-size="9" fill="currentColor">0</text>
        <path d="${path}" class="session-float-line"/>
        ${dots.map(d=>`<circle cx="${d.x.toFixed(2)}" cy="${d.y.toFixed(2)}" r="3.5" class="session-float-dot"><title>${esc(d.label)}: ${d.score.total}/100 · ${esc(offlineIssueLabel(d.score))}</title></circle>`).join('')}
        <text x="24" y="96" fill="currentColor" font-size="9">#${start}</text><text x="296" y="96" text-anchor="end" fill="currentColor" font-size="9">#${end}</text>
      </svg><p class="note">${order.confirmed?'Session number':order.continuous?'Device number':'Record order; capture order uncertain'} → earliest to latest.</p></div></section>`;
  }).join('');
}
