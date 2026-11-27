import { offlineComparisonKey } from './offline-aim.js?v=aim-pipeline-164';

export function buildOfflineComparison(entries) {
  const cohorts = new Map(), excluded = [], seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.shot.id)) continue;
    seen.add(entry.shot.id);
    const analysis = entry.trace?.analysis;
    const key = offlineComparisonKey(analysis);
    const points = analysis?.result?.projected;
    if (!key || !points?.length || !analysis.result.metrics?.hold) {
      excluded.push({ ...entry, reason: !entry.trace ? 'Trace not saved' :
        entry.trace.source !== 'firmware' ? 'Connected recording — open individual review' :
        analysis?.reasons?.join(', ') || 'Not analyzed — choose Analyze this set' });
      continue;
    }
    if (!cohorts.has(key)) cohorts.set(key, { key, parameters: analysis.parameters, version: analysis.version, entries: [] });
    cohorts.get(key).entries.push({ ...entry, analysis, points });
  }
  return { total: seen.size, cohorts: [...cohorts.values()], excluded };
}

export function comparisonWindow(parameters, phase) {
  return phase === 'hold' ? parameters.referenceWindowMs : phase === 'pre' ? parameters.preWindowMs :
    phase === 'post' ? parameters.postWindowMs : null;
}
export function comparisonPoints(entry, phase) {
  const window = comparisonWindow(entry.analysis.parameters, phase);
  // Do not show a partial window as though it were a complete comparable phase.
  if (phase !== 'full' && !entry.analysis.result.metrics[phase]) return [];
  return window ? entry.points.filter((p) => p.tUs >= window[0] * 1000 && p.tUs <= window[1] * 1000) : entry.points;
}
export function comparisonGroupMetrics(cohort, phase = 'hold') {
  const groups = new Map();
  for (const entry of cohort.entries) {
    const key = entry.groupId;
    if (!groups.has(key)) groups.set(key, { id: key, name: entry.groupName, total: 0, usable: 0, values: [] });
    const group = groups.get(key); group.total++;
    const metrics = entry.analysis.result.metrics[phase === 'full' ? 'hold' : phase];
    if (metrics) { group.usable++; group.values.push(metrics); }
  }
  return [...groups.values()].map(({ values, ...group }) => ({ ...group,
    metrics: Object.fromEntries(['xStdDeg', 'yStdDeg', 'xStdCm', 'yStdCm', 'cantStdDeg', 'deltaXDeg', 'deltaYDeg', 'pathCm']
      .map((key) => [key, values.length ? values.reduce((s, m) => s + m[key], 0) / values.length : null])) }));
}
