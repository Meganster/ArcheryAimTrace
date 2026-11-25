// A transparent engineering heuristic, not an impact score or validated skill grade.
// Version includes thresholds, weights, issue selection and required windows.
export const OFFLINE_SCORE_VERSION = 'offline-motion-v1';
export const OFFLINE_SCORE_RULES = Object.freeze({ hold: { scale: 0.15, weight: 0.5 },
  pre: { scale: 0.30, weight: 0.35 }, cant: { scale: 0.50, weight: 0.15 } });
const valid = x => Number.isFinite(x) && x >= 0;
const format = x => x.toFixed(3);
const score = (x, scale) => 100 / (1 + (x / scale) ** 2);
function direction(x, y) {
  const horizontal = x >= 0 ? 'right' : 'left', vertical = y >= 0 ? 'up' : 'down';
  return Math.abs(x) > Math.abs(y) * 1.5 ? horizontal : Math.abs(y) > Math.abs(x) * 1.5 ? vertical : `${vertical} and ${horizontal}`;
}
export function computeOfflineScore(analysis) {
  const result = { version: OFFLINE_SCORE_VERSION, status: 'unavailable', total: null,
    components: {}, issue: null, reasons: [], post: null };
  if (analysis?.status !== 'calculated') return { ...result, reasons: analysis?.reasons?.length ? [...analysis.reasons] : ['analysis_not_calculated'] };
  const m = analysis.result?.metrics || analysis.metrics, p = analysis.parameters;
  if (!m || !p) return { ...result, reasons: ['metrics_missing'] };
  const add = (key, label, value, windowMs, evidence, issueLabel) => {
    const rule = OFFLINE_SCORE_RULES[key];
    const rawScore = score(value, rule.scale);
    result.components[key] = { label, valueDeg: value, score: Math.round(rawScore),
      weightedLoss: (100 - rawScore) * rule.weight, weight: rule.weight, scaleDeg: rule.scale,
      windowMs: [...windowMs], evidence, issueLabel };
  };
  if (valid(m.hold?.xStdDeg) && valid(m.hold?.yStdDeg) && Array.isArray(p.referenceWindowMs)) {
    const {xStdDeg:x,yStdDeg:y} = m.hold;
    const axis = x > y * 1.5 ? 'Horizontal' : y > x * 1.5 ? 'Vertical' : 'Horizontal and vertical';
    add('hold', 'Hold stability', Math.hypot(x,y), p.referenceWindowMs,
      `Hold σ X/Y ${format(x)}° / ${format(y)}°`, `${axis} hold movement`);
  } else result.reasons.push('hold_window_unavailable');
  if (valid(m.pre?.xStdDeg) && valid(m.pre?.yStdDeg) && Number.isFinite(m.pre?.deltaXDeg) &&
      Number.isFinite(m.pre?.deltaYDeg) && Array.isArray(p.preWindowMs)) {
    const {xStdDeg:x,yStdDeg:y,deltaXDeg:dx,deltaYDeg:dy} = m.pre;
    const travel = Math.hypot(dx,dy), spread = 2*Math.hypot(x,y);
    add('pre', 'Before-detector control', Math.max(travel,spread), p.preWindowMs,
      `Before detector: Δ X/Y ${format(dx)}° / ${format(dy)}°; 2σ ${format(spread)}°`,
      travel >= spread ? `Aim moves ${direction(dx,dy)} before detector` : 'Aim oscillates before detector');
  } else result.reasons.push('pre_window_unavailable');
  if (valid(m.hold?.cantStdDeg) && Array.isArray(p.referenceWindowMs)) {
    add('cant', 'Cant consistency', m.hold.cantStdDeg, p.referenceWindowMs,
      `Hold cant σ ${format(m.hold.cantStdDeg)}°; absolute mounting angle is not penalized`, 'Cant changes during hold');
  } else result.reasons.push('cant_window_unavailable');
  if (Number.isFinite(m.post?.deltaXDeg) && Number.isFinite(m.post?.deltaYDeg)) {
    result.post = { deltaXDeg: m.post.deltaXDeg, deltaYDeg: m.post.deltaYDeg,
      windowMs: [...p.postWindowMs], description: `After detector: Δ X/Y ${format(m.post.deltaXDeg)}° / ${format(m.post.deltaYDeg)}°. Descriptive only; natural bow rotation is not penalized.` };
  }
  const components = Object.entries(result.components);
  if (components.length === 3) {
    result.status = 'complete';
    result.total = Math.round(100-components.reduce((sum,[,c]) => sum+c.weightedLoss,0));
  } else if (components.length) result.status = 'partial';
  // Never force an issue on a stable trace. Rank meaningful components by their
  // contribution to lost points rather than blaming a physical technique.
  const candidates = components.filter(([,c]) => c.score < 70).sort((a,b) => b[1].weightedLoss-a[1].weightedLoss);
  if (candidates.length) {
    const [key,c] = candidates[0];
    result.issue = { key, label:c.issueLabel, evidence:c.evidence, windowMs:c.windowMs,
      weightedLoss: Number(c.weightedLoss.toFixed(1)), tentative:result.status !== 'complete' };
  }
  return result;
}
export function savedOfflineScore(analysis) {
  const s = analysis?.score;
  return analysis?.status === 'calculated' && s?.version === OFFLINE_SCORE_VERSION ? s : null;
}
export function offlineScoreKey(analysis) {
  const s = savedOfflineScore(analysis);
  return s?.status === 'complete' && Number.isFinite(s.total)
    ? JSON.stringify([s.version,analysis.version,analysis.parameters]) : null;
}
export function offlinePeerComparison(analysis, peers) {
  const key = offlineScoreKey(analysis);
  if (!key) return null;
  const values = peers.filter(a => offlineScoreKey(a) === key).map(a => a.score.total);
  if (!values.length) return null;
  const mean = values.reduce((a,b)=>a+b,0)/values.length;
  return { count:values.length, mean, difference:analysis.score.total-mean };
}
