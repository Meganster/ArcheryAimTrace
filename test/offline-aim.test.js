import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeOfflineTrace, withOfflineAnalysis, offlineShotSummary, summarizeOfflineSeries } from '../app/telemetry/offline-aim.js';
import { createAimReferenceFromDirection, captureAimPoint, aimDirection } from '../app/telemetry/aim-projection.js';
import { traceForReview } from '../app/protocol/trace.js';
import { suggestOfflineSeries } from '../app/telemetry/offline-series.js';
import { groupShotsByTime } from '../app/core/db.js';
import { aimTraceLayout, drawAimTrace } from '../app/ui/aim-trace.js';
import { offlineSeriesHtml, offlineMetricsText } from '../app/ui/offline-summary.js';

const wrap = (x) => ((x + 180) % 360 + 360) % 360 - 180;
function record({ yaw = 0, roll = 0, fn = () => ({}), start = -3000, end = 1500, dt = 20 } = {}) {
  const payload = [];
  for (let t = start; t <= end; t += dt) payload.push({ tUs: t * 1000, roll, pitch: 0, yaw,
    yawAvailable: true, accelAvailable: false, detectorEvent: t === 0, ...fn(t) });
  return { source: 'firmware', shot_id: 'a', raw: { bytes: [1, 2, 3] }, payload,
    timing: { version: 3, samplePeriodUs: dt * 1000, sampleRateSource: 'configured-odr',
      mountProfile: 2, releaseIndex: payload.findIndex((p) => p.detectorEvent), completeness: 'complete' } };
}
const close = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test('vector reference handles yaw wrap and constant headings, with right/up signs', () => {
  const shape = (t) => t < -300 ? 0.1 * Math.sin(t / 200) : (t + 300) / 1000;
  const calculate = (offset) => analyzeOfflineTrace(record({ fn: (t) => ({ yaw: wrap(offset - shape(t)), pitch: -shape(t) }) }));
  const first = calculate(0), acrossWrap = calculate(179.99);
  assert.equal(first.status, 'calculated'); assert.equal(acrossWrap.status, 'calculated');
  first.result.projected.forEach((p, i) => {
    close(p.aim.xMeters, acrossWrap.result.projected[i].aim.xMeters);
    close(p.aim.yMeters, acrossWrap.result.projected[i].aim.yMeters);
  });
  assert.ok(first.result.projected.at(-1).aim.xMeters > 0);
  assert.ok(first.result.projected.at(-1).aim.yMeters > 0);
  close(first.result.metrics.hold.xStdDeg, acrossWrap.result.metrics.hold.xStdDeg);
});

test('cant alone, including horizontal bow and roll wrap, cannot move pin', () => {
  for (const roll of [0, 90, 179.99]) {
    const analysis = analyzeOfflineTrace(record({ yaw: 125, fn: (t) => ({ roll: wrap(roll + t / 30) }) }));
    assert.equal(analysis.status, 'calculated');
    for (const p of analysis.result.projected) { close(p.aim.xMeters, 0); close(p.aim.yMeters, 0); }
    assert.ok(analysis.result.metrics.hold.cantStdDeg > 1);
  }
  const wrapped = analyzeOfflineTrace(record({ fn: (t) => ({ roll: t % 40 ? -179.9 : 179.9 }) }));
  assert.ok(wrapped.result.metrics.hold.cantStdDeg < 0.11);
});

test('slow yaw drift stays in original and projected data, no smoothing or detrending', () => {
  const source = record({ fn: (t) => ({ yaw: t * 0.000001 }) });
  const original = structuredClone(source), next = withOfflineAnalysis(source);
  assert.deepEqual(source, original); assert.deepEqual(next.payload, original.payload); assert.deepEqual(next.raw, original.raw);
  const result = next.analysis.result;
  close(result.metrics.pre.deltaXDeg, -0.0003, 1e-7);
  assert.equal(result.quality.driftRemoved, false); assert.equal(result.quality.smoothed, false);
  assert.ok(Math.abs(result.projected.at(-1).aim.xMeters - result.projected[0].aim.xMeters) > 0);
  assert.deepEqual(withOfflineAnalysis(next).analysis, next.analysis);
  const review = traceForReview(next);
  assert.ok(review.payload.every((p) => p.aim));
  assert.ok(next.payload.every((p) => !p.aim));
});

test('missing windows, gaps, unsupported mount, simulated and vertical aim fail explicitly', () => {
  const cases = [
    [record({ start: -1000 }), 'reference_window_incomplete'],
    [{ ...record(), timing: {} }, 'release_timing_missing'],
    [record({ fn: () => ({ pitch: 90 }) }), 'vertical_aim_no_horizon'],
  ];
  for (const [field, value, reason] of [['dataGap', true, 'data_gap'], ['simulated', true, 'simulated_event'],
    ['eventOutside', true, 'release_timing_missing'], ['mountProfile', 0, 'mount_not_verified']]) {
    const r = record(); r.timing[field] = value; cases.push([r, reason]);
  }
  const gap = record(); gap.payload.splice(100, 1); cases.push([gap, 'data_gap']);
  const noYaw = record(); noYaw.payload[30].yawAvailable = false; cases.push([noYaw, 'invalid_orientation']);
  const divergent = record({ fn: (t) => ({ yaw: t % 40 ? 0 : 180 }) }); cases.push([divergent, 'reference_directions_diverge']);
  for (const [r, reason] of cases) { const a = analyzeOfflineTrace(r); assert.equal(a.status, 'not_calculated'); assert.deepEqual(a.reasons, [reason]); }
  assert.equal(analyzeOfflineTrace(record(), { distanceMeters: Infinity }).reasons[0], 'invalid_parameters');
  const shortPost = analyzeOfflineTrace(record({ end: 0 }));
  assert.equal(shortPost.status, 'calculated'); assert.equal(shortPost.result.metrics.post, null);
  assert.equal(shortPost.result.exclusions.post, 'window_incomplete');
});

test('known movement produces quantitative metrics and scales centimetres with distance', () => {
  const source = record({ fn: (t) => ({ yaw: t / 1000, pitch: t / 2000 }) });
  const a = analyzeOfflineTrace(source, { distanceMeters: 18 }), b = analyzeOfflineTrace(source, { distanceMeters: 36 });
  close(a.result.metrics.pre.deltaXDeg, -0.3, 0.00005);
  close(a.result.metrics.pre.deltaYDeg, -0.15, 0.0002);
  close(a.result.metrics.hold.xStdDeg, b.result.metrics.hold.xStdDeg);
  close(a.result.metrics.hold.xStdCm * 2, b.result.metrics.hold.xStdCm);
  assert.equal(a.result.metrics.hold.count, 61);
  assert.equal(a.result.quality.detectorLatencyUs, null);
});

test('browser ray projection and offline quantized Euler path agree under the same reference', () => {
  const source = record({ fn: (t) => ({ yaw: 50 + Math.sin(t / 200) * 0.4, pitch: Math.cos(t / 100) * 0.2, roll: 90 }) });
  const quantized = structuredClone(source);
  quantized.payload.forEach((p) => { for (const key of ['yaw', 'pitch', 'roll']) p[key] = Math.round(p[key] * 100) / 100; });
  const offline = analyzeOfflineTrace(quantized);
  const ref = offline.result.reference;
  let maxCm = 0;
  source.payload.forEach((p, i) => {
    const live = captureAimPoint(p, ref), saved = offline.result.projected[i].aim;
    maxCm = Math.max(maxCm, Math.hypot(live.xMeters - saved.xMeters, live.yMeters - saved.yMeters) * 100);
  });
  assert.ok(maxCm < 0.23, `quantization error ${maxCm} cm exceeds 0.01° encoding bound`);
  const direction = aimDirection(source.payload[0]);
  assert.ok(createAimReferenceFromDirection(direction, { distanceMeters: 18, faceDiameterCm: 40 }));
});

test('series summaries split analysis settings and expose exclusions without Float Scores', () => {
  const make = (id, distanceMeters) => ({ id, stored_upload: true, ...offlineShotSummary(analyzeOfflineTrace(record(), { distanceMeters })) });
  const shots = [make('a', 18), make('b', 18), make('c', 30), { id: 'd', stored_upload: true }];
  assert.equal(shots[0].shot_score, null);
  assert.equal(shots[0].release_quality, null);
  const summary = summarizeOfflineSeries(shots);
  assert.deepEqual(summary.groups.map((g) => g.count), [2, 1]); assert.equal(summary.excluded.length, 1);
  const html = offlineSeriesHtml(shots); assert.match(html, /Excluded: 1/); assert.match(html, /σ X\/Y/);
  assert.match(offlineMetricsText(shots[0].offline_analysis), /detector latency unknown/);
});

test('suggested series respect boot, batch, event gaps; legacy can be grouped manually', () => {
  const make = (id, us, boot = 1, batch = 'b') => ({ id, stored_upload: true, device_id: 'd',
    import_batch_id: batch, device_boot_id: boot, device_event_uptime_us: us,
    device_time_source: 'device-processing-uptime', imported_at: '2026-10-21T12:00:00Z' });
  const shots = [make('a', 1e6), make('b', 50e6), make('c', 400e6), make('d', 2e6, 2), make('e', 3e6, 1, 'other'), { id: 'legacy' }];
  const suggestions = suggestOfflineSeries(shots);
  assert.deepEqual(suggestions.groups.map((g) => g.map((s) => s.id)), [['a', 'b'], ['c'], ['d'], ['e']]);
  assert.deepEqual(suggestions.excluded, ['legacy']);
  const groups = groupShotsByTime(shots.slice(0, 3).map((s) => ({ ...s, offline_series_id: 'series', offline_series_name: 'Test' })));
  assert.equal(groups.length, 1); assert.equal(groups[0].name, 'Test'); assert.equal(groups[0].shots[0].id, 'c');
});

test('review uses fixed physical scale, normalized shape warning and compatible comparisons', () => {
  const a = analyzeOfflineTrace(record({ fn: (t) => ({ yaw: t / 1000 }) })).result.projected;
  const b = analyzeOfflineTrace(record({ fn: (t) => ({ yaw: 2 * t / 1000 }) })).result.projected;
  const options = { cx: 400, cy: 300, radius: 200, mode: 'physical' };
  const la = aimTraceLayout(a, options), lb = aimTraceLayout(b, options);
  close(la.faceRadiusPixels, lb.faceRadiusPixels);
  assert.ok(Math.abs(lb.map(b.at(-1)).x - 400) > Math.abs(la.map(a.at(-1)).x - 400));
  const labels = [];
  const ctx = new Proxy({ measureText: () => ({ width: 100 }), fillText: (x) => labels.push(x) }, { get: (o, k) => k in o ? o[k] : () => {} });
  drawAimTrace(ctx, a, { ...options, mode: 'normalized', releaseIndex: 150 });
  assert.ok(labels.some((s) => s.includes('Relative to mean pre-shot aim')));
  assert.ok(labels.some((s) => s.includes('Normalized shape only')));
});
