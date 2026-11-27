import { computeOfflineScore } from './offline-score.js?v=aim-pipeline-164';
// Pure, reproducible analysis of bow-aligned, timed device traces.
// Raw payload/bytes are never overwritten. Detector time is not arrow departure time.
import { aimDirection, createAimReferenceFromDirection, captureAimPoint, aimAngles } from './aim-projection.js?v=aim-pipeline-164';
import { unscoredFields } from '../core/shot-record.js?v=aim-pipeline-164';
export const OFFLINE_AIM_VERSION = 1;
export const DEFAULT_OFFLINE_PARAMETERS = Object.freeze({
  referenceWindowMs: [-1500, -300], preWindowMs: [-300, 0], postWindowMs: [100, 1000],
  distanceMeters: 18, faceDiameterCm: 40, horizontalSign: 1, verticalSign: 1,
});
const rad = Math.PI / 180;
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
const wrap = (x) => ((x + 180) % 360 + 360) % 360 - 180;
const windowValid = (w) => Array.isArray(w) && w.length === 2 && w.every(Number.isFinite) && w[0] < w[1];
export function offlineParameters(options = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_OFFLINE_PARAMETERS).map(([key, value]) =>
    [key, structuredClone(options[key] ?? value)]));
}
export function offlineComparisonKey(analysis) {
  return analysis?.status === 'calculated' ? JSON.stringify([analysis.version, analysis.parameters]) : null;
}
function windowPoints(points, window, dt) {
  const selected = points.filter((p) => p.tUs >= window[0] * 1000 && p.tUs <= window[1] * 1000);
  if (selected.length < 3 || selected[0].tUs > window[0] * 1000 + dt * 1.1 ||
      selected.at(-1).tUs < window[1] * 1000 - dt * 1.1) return null;
  return selected;
}
function movement(points) {
  const angles = points.map(aimAngles);
  if (angles.some((a) => !a)) return null;
  const xs = angles.map((a) => a.horizontal), ys = angles.map((a) => a.vertical);
  const xCm = points.map((p) => p.aim.xMeters * 100), yCm = points.map((p) => p.aim.yMeters * 100);
  let pathDeg = 0, pathCm = 0;
  for (let i = 1; i < points.length; i++) {
    pathDeg += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    pathCm += Math.hypot(xCm[i] - xCm[i - 1], yCm[i] - yCm[i - 1]);
  }
  const cantMean = Math.atan2(mean(points.map((p) => Math.sin(p.roll * rad))),
    mean(points.map((p) => Math.cos(p.roll * rad)))) / rad;
  const cantOffsets = points.map((p) => wrap(p.roll - cantMean));
  return { count: points.length, startMs: points[0].tUs / 1000, endMs: points.at(-1).tUs / 1000,
    xStdDeg: sd(xs), yStdDeg: sd(ys), xStdCm: sd(xCm), yStdCm: sd(yCm),
    xRangeDeg: Math.max(...xs) - Math.min(...xs), yRangeDeg: Math.max(...ys) - Math.min(...ys),
    xMeanCm: mean(xCm), yMeanCm: mean(yCm),
    deltaXDeg: xs.at(-1) - xs[0], deltaYDeg: ys.at(-1) - ys[0],
    deltaXCm: xCm.at(-1) - xCm[0], deltaYCm: yCm.at(-1) - yCm[0],
    pathDeg, pathCm, cantMeanDeg: cantMean, cantStdDeg: sd(cantOffsets) };
}
export function analyzeOfflineTrace(record, options = {}) {
  const parameters = offlineParameters(options);
  const base = { version: OFFLINE_AIM_VERSION, kind: 'per-shot-relative', parameters,
    status: 'not_calculated', reasons: [], result: null };
  const fail = (reason) => ({ ...base, reasons: [reason] });
  const timing = record?.timing, points = record?.payload;
  if (record?.source !== 'firmware') return fail('not_firmware_trace');
  if (timing?.version !== 3 || timing.releaseIndex == null || timing.eventOutside) return fail('release_timing_missing');
  if (timing.mountProfile !== 2) return fail('mount_not_verified');
  if (timing.dataGap) return fail('data_gap');
  if (timing.simulated) return fail('simulated_event');
  if (![parameters.referenceWindowMs, parameters.preWindowMs, parameters.postWindowMs].every(windowValid) ||
      parameters.referenceWindowMs[1] >= 0 || parameters.preWindowMs[1] > 0 || parameters.postWindowMs[0] < 0 ||
      !(parameters.distanceMeters > 0 && parameters.distanceMeters <= 1000) ||
      !(parameters.faceDiameterCm > 0 && parameters.faceDiameterCm <= 1000) ||
      ![parameters.distanceMeters, parameters.faceDiameterCm].every(Number.isFinite) ||
      ![parameters.horizontalSign, parameters.verticalSign].every((n) => n === 1 || n === -1)) return fail('invalid_parameters');
  const dt = timing.samplePeriodUs;
  if (!Array.isArray(points) || !points.length || !Number.isFinite(dt) || dt <= 0) return fail('invalid_samples');
  for (let i = 0; i < points.length; i++) {
    if (!Number.isFinite(points[i].tUs) || !aimDirection(points[i])) return fail('invalid_orientation');
    if (i && Math.abs(points[i].tUs - points[i - 1].tUs - dt) > Math.max(1, dt * 0.01)) return fail('data_gap');
  }
  const referencePoints = windowPoints(points, parameters.referenceWindowMs, dt);
  if (!referencePoints) return fail('reference_window_incomplete');
  const rays = referencePoints.map((p) => aimDirection(p));
  const direction = [0, 1, 2].map((axis) => mean(rays.map((v) => v[axis])));
  // A nearly cancelling directional mean has no usable aiming centre.
  if (Math.hypot(...direction) < 0.95) return fail('reference_directions_diverge');
  if (Math.hypot(direction[0], direction[1]) < 0.01) return fail('vertical_aim_no_horizon');
  const reference = createAimReferenceFromDirection(direction, parameters);
  if (!reference) return fail('reference_invalid');
  reference.id = `offline-${record.shot_id}-v${OFFLINE_AIM_VERSION}-${JSON.stringify(parameters)}`;
  const projected = points.map((p) => {
    const aim = captureAimPoint(p, reference);
    return { ...p, aim: { ...aim, referenceType: 'per-shot-relative',
      referenceWindowMs: parameters.referenceWindowMs, samplePeriodUs: dt, analysisVersion: OFFLINE_AIM_VERSION,
      comparisonKey: JSON.stringify([OFFLINE_AIM_VERSION, parameters]) } };
  });
  const metrics = {}, exclusions = {};
  for (const [key, window] of [['hold', parameters.referenceWindowMs], ['pre', parameters.preWindowMs], ['post', parameters.postWindowMs]]) {
    const selected = windowPoints(projected, window, dt);
    metrics[key] = selected ? movement(selected) : null;
    if (!metrics[key]) exclusions[key] = selected ? 'projection_outside_plane' : 'window_incomplete';
  }
  if (!metrics.hold) return fail('reference_projection_invalid');
  const analysis = { ...base, status: 'calculated', result: { reference, projected, metrics, exclusions,
    quality: { completeness: timing.completeness, samplePeriodUs: dt, sampleRateSource: timing.sampleRateSource,
      eventTimeSource: 'detector-event', detectorLatencyUs: null, projectedCount: projected.filter((p) => aimAngles(p)).length,
      totalCount: points.length, driftRemoved: false, smoothed: false } } };
  return { ...analysis, score: computeOfflineScore(analysis) };
}
export function withOfflineAnalysis(record, parameters) {
  if (record?.source !== 'firmware') return record;
  return { ...record, analysis: analyzeOfflineTrace(record, parameters) };
}
export function offlineShotSummary(analysis) {
  return { ...unscoredFields(), offline_analysis: { version: analysis.version, kind: analysis.kind, status: analysis.status,
    parameters: analysis.parameters, reasons: analysis.reasons, score: analysis.score ?? null, metrics: analysis.result?.metrics ?? null,
    exclusions: analysis.result?.exclusions ?? null, quality: analysis.result?.quality ?? null },
    analysis_status: analysis.status, analysis_reason: analysis.reasons.join(', ') || null };
}
export function summarizeOfflineSeries(shots) {
  const buckets = new Map(), excluded = [];
  for (const shot of shots) {
    const a = shot.offline_analysis, key = offlineComparisonKey(a);
    if (!key || !a.metrics?.hold) { excluded.push({ id: shot.id, reason: a?.reasons?.join(', ') || 'analysis_unavailable' }); continue; }
    if (!buckets.has(key)) buckets.set(key, { parameters: a.parameters, version: a.version, shots: [] });
    buckets.get(key).shots.push(shot);
  }
  return { excluded, groups: [...buckets.values()].map((g) => ({ ...g,
    count: g.shots.length,
    xStdDeg: mean(g.shots.map((s) => s.offline_analysis.metrics.hold.xStdDeg)),
    yStdDeg: mean(g.shots.map((s) => s.offline_analysis.metrics.hold.yStdDeg)),
    xStdCm: mean(g.shots.map((s) => s.offline_analysis.metrics.hold.xStdCm)),
    yStdCm: mean(g.shots.map((s) => s.offline_analysis.metrics.hold.yStdCm)),
  })) };
}
