import { savedOfflineScore, offlinePeerComparison } from '../telemetry/offline-score.js?v=aim-pipeline-164';
import { offlineScoreReport, offlineSessionScoresHtml, offlineIssueLabel } from './offline-score.js?v=aim-pipeline-164';
import { sessionOrder } from '../core/session-order.js?v=aim-pipeline-164';
import { sessionTimelineHtml } from './session-timeline.js?v=aim-pipeline-164';
// Shot history, review, recent shots, and deletion UI module.

import { getAll, get, put, remove, deleteShotRecords, groupShotsByTime, SESSION_GAP_MS } from "../core/db.js?v=aim-pipeline-164";
import { coachForScore } from "../telemetry/telemetry.js?v=aim-pipeline-164";
import { resolveReviewMicSeries, traceForReview } from "../protocol/trace.js?v=aim-pipeline-164";
import { drawEmptyTargetPreview, drawTraceTargetPreview, watchTracePreviewResize } from "./trace-preview.js?v=aim-pipeline-164";
import { buildSessionFloatPlot, buildSessionReview } from "./session-review.js?v=aim-pipeline-164";
import { targetViewSummary } from "./target-face.js?v=aim-pipeline-164";

import { withOfflineAnalysis, offlineShotSummary, offlineParameters } from '../telemetry/offline-aim.js?v=aim-pipeline-164';
import { suggestOfflineSeries } from '../telemetry/offline-series.js?v=aim-pipeline-164';
import { offlineMetricsText } from './offline-summary.js?v=aim-pipeline-164';

import { createOfflineComparisonPanel } from './offline-comparison.js?v=aim-pipeline-164';

import { shotForDisplay, shotFloatScore, shotTimeLabel } from "../core/shot-record.js?v=aim-pipeline-164";

const displayScore = (shot) => shotFloatScore(shot) == null ? "Not calculated" : Math.round(shotFloatScore(shot));

export function initHistory({ bus, store, state, el, syncAdapter, selectViewTab, saveSettingsToCache }) {
  const selection = new Set();
  const groupExpanded = new Map();
  const groupSort = new Map();
  const expandedAnalysis = new Set(), expandedMore = new Set();
  const sortModes = ['shot-order', 'score-desc', 'score-asc'];
  try {
    const saved = JSON.parse(localStorage.getItem('openfloat_history_sort') || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [id, mode] of Object.entries(saved)) if (sortModes.includes(mode)) groupSort.set(id, mode);
    }
  } catch { /* Sorting still works when browser storage is unavailable. */ }
  const shotOrderLabels = new Map();
  const chartPanel = el.traceCanvas.closest('.chart-panel');
  const chartHome = document.createComment('Live chart location');
  chartPanel.before(chartHome);
  let inlineReviewId = null, reviewRequest = 0;
  const historyVisible = () => !!el.historyList.closest('.tab-view')?.classList.contains('active-view');
  function restoreChart(clear = true) {
    const host = chartPanel.closest('.inline-shot-review');
    if (host) {
      const card = host.closest('.history-item');
      card?.classList.remove('has-inline-review');
      const button = card?.querySelector('[data-shot-review]');
      if (button) { button.textContent = 'Review'; button.setAttribute('aria-expanded', 'false'); button.removeAttribute('aria-controls'); }
      chartHome.after(chartPanel);
      host.remove();
    }
    if (clear) inlineReviewId = null;
    el.exitReviewBtn.textContent = 'Exit Review';
  }
  function mountInlineReview(scroll = false) {
    if (!inlineReviewId || !historyVisible() || !store.get().reviewMode) return false;
    const card = [...el.historyList.querySelectorAll('.history-item')].find(node => node.dataset.shotId === inlineReviewId);
    if (!card) return false;
    if (chartPanel.closest('.history-item') !== card) {
      restoreChart(false);
      const host = document.createElement('section');
      host.className = 'inline-shot-review';
      host.setAttribute('aria-label', `Trace review for ${shotOrderLabels.get(inlineReviewId) || 'selected shot'}`);
      host.id = 'inlineShotReview';
      card.classList.add('has-inline-review');
      card.appendChild(host); host.appendChild(chartPanel);
    }
    const group = card.closest('.session-group');
    group.classList.remove('collapsed'); groupExpanded.set(group.dataset.groupId, true);
    const button = card.querySelector('[data-shot-review]');
    button.textContent = 'Close review'; button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-controls', 'inlineShotReview');
    el.exitReviewBtn.textContent = 'Close review';
    if (scroll) requestAnimationFrame(() => chartPanel.scrollIntoView({block:'start',behavior:'smooth'}));
    return true;
  }
  store.subscribe(current => {
    if (!current.reviewMode && inlineReviewId) restoreChart();
  });
  bus.on('view-changed', target => {
    reviewRequest++;
    if (target !== 'tabHistory' && inlineReviewId) el.exitReviewBtn.click();
  });
  let busy = false, historyLoadGeneration = 0, selectionMode = false;
  const comparison = createOfflineComparisonPanel({ root: el.offlineComparisonPanel,
    onReview: async (id) => { const shot = await get('shots', id); if (shot) await reviewShotTrace(shot); },
    onAnalyze: (ids, button, title, scope = ids) => performOfflineAction(button, () => analyzeIds(ids), { compareIds: scope, title }),
    onPair: async (ids) => {
      const shot = await get('shots', ids[0]);
      if (shot) { await reviewShotTrace(shot); await loadReviewCompareShot(ids[1]);
        if (el.reviewCompareSelect) el.reviewCompareSelect.value = store.get().compareShotId || ''; }
    },
  });
  async function openComparison(ids, title = 'Selected shots across groups', scroll = true) {
    const shots = (await getAll('shots')).map(shotForDisplay), groups = groupShotsByTime(shots);
    const overrides = new Map((await getAll('session_overrides')).map(o => [o.id, o]));
    const membership = new Map();
    for (const group of groups) {
      const name = overrides.get(group.anchorId)?.name || group.name ||
        (group.timeKind === 'imported' ? `Import ${new Date(group.startTime).toLocaleString()}` : defaultSessionName(group.startTime));
      for (const e of sessionOrder(group.shots, overrides.get(group.anchorId)?.first_device_shot).entries)
        membership.set(e.shot.id, { groupId: group.anchorId, groupName: name, orderLabel: e.label,
          peer: offlinePeerComparison(e.shot.offline_analysis, group.shots.filter(s=>s.id!==e.shot.id).map(s=>s.offline_analysis)) });
    }
    const byId = new Map(shots.map(s => [s.id, s]));
    const selected = [...new Set(ids)].map(id => byId.get(id)).filter(Boolean);
    const entries = await Promise.all(selected.map(async shot => ({ shot,
      trace: await get('shot_traces', shot.id), ...membership.get(shot.id) })));
    comparison.show(entries, title, {scroll});
  }
  const parameters = offlineParameters(store.get().offlineAnalysisParameters);
  if (el.offlineDistance) el.offlineDistance.value = parameters.distanceMeters;
  if (el.offlineFace) el.offlineFace.value = parameters.faceDiameterCm;
  function readAnalysisParameters() {
    const distanceMeters = Number(el.offlineDistance?.value), faceDiameterCm = Number(el.offlineFace?.value);
    if (![distanceMeters, faceDiameterCm].every((x) => Number.isFinite(x) && x >= 1 && x <= 1000)) {
      throw new Error('Distance and diameter must be between 1 and 1000.');
    }
    const next = offlineParameters({ distanceMeters, faceDiameterCm });
    store.set({ offlineAnalysisParameters: next });
    saveSettingsToCache?.();
    return next;
  }
  for (const input of [el.offlineDistance, el.offlineFace]) input?.addEventListener('change', () => {
    try { readAnalysisParameters(); el.offlineStatus.textContent = 'Settings saved for new imports. Select existing shots and choose Analyze selected to recalculate.'; }
    catch (e) { el.offlineStatus.textContent = e.message; }
  });
  function selectedIds() {
    return [...selection];
  }
  async function saveRecord(table, record) {
    await put(table, record);
    await put('sync_queue', { table, action: 'UPDATE', targetId: record.id || record.shot_id, payload: record, status: 'pending' });
  }
  function setAnalysisBusy(value) {
    busy = value;
    el.offlineStatus.setAttribute('aria-busy', String(value));
    document.querySelectorAll('#offlineAnalyzeBtn, #offlineGroupBtn, #offlineSuggestBtn, #offlineCompareBtn, [data-group-analyze], [data-shot-analyze], [data-analyze-all], [data-analyze]')
      .forEach(button => { button.disabled = value; });
  }
  async function performOfflineAction(button, action, { compareIds = null, title } = {}) {
    if (busy) { el.offlineStatus.textContent = 'Please wait for the current analysis to finish.'; return; }
    setAnalysisBusy(true); button.disabled = true;
    try {
      await action(); syncAdapter?.triggerSync(); await loadShotHistoryList();
      await loadRecentShotsList();
      if (compareIds) await openComparison(compareIds, title);
      else { const scope = comparison.scope(); if (scope) await openComparison(scope.ids, scope.title, false); }
    } catch (e) { el.offlineStatus.textContent = `Could not finish: ${e.message}. Saved originals are retained.`; }
    finally { setAnalysisBusy(false); button.disabled = false; }
  }
  async function analyzeIds(ids) {
    const options = readAnalysisParameters();
    if (!ids.length) throw new Error('Select shots or use Analyze group');
    let calculated = 0, excluded = 0;
    for (const id of ids) {
      el.offlineStatus.textContent = `Analyzing ${calculated + excluded + 1} / ${ids.length}…`;
      const trace = await get('shot_traces', id), shot = await get('shots', id);
      if (!shot || trace?.source !== 'firmware') { excluded++; continue; }
      const next = withOfflineAnalysis(trace, options);
      await saveRecord('shot_traces', next);
      await saveRecord('shots', { ...shot, ...offlineShotSummary(next.analysis) });
      if (next.analysis.status === 'calculated') calculated++; else excluded++;
      if (store.get().reviewShotId === id) await reviewShotTrace(await get('shots', id));
    }
    el.offlineStatus.textContent = `Saved analysis: ${calculated} usable, ${excluded} excluded. Selection retained; original records unchanged.`;
  }
  el.offlineAnalyzeBtn?.addEventListener('click', () => {
    const ids = selectedIds();
    performOfflineAction(el.offlineAnalyzeBtn, () => analyzeIds(ids), {compareIds: ids});
  });
  el.offlineCompareBtn?.addEventListener('click', async () => {
    if (!selection.size) { el.offlineStatus.textContent = 'Select shots from one or more groups first.'; return; }
    try { await openComparison(selectedIds()); } catch (e) { el.offlineStatus.textContent = e.message; }
  });
  el.offlineGroupBtn?.addEventListener('click', () => performOfflineAction(el.offlineGroupBtn, async () => {
    const ids = selectedIds();
    if (!ids.length) throw new Error('Select shots to group first');
    const seriesId = crypto.randomUUID(), name = el.offlineSeriesName.value.trim() || 'Offline series';
    for (const id of ids) {
      const shot = await get('shots', id);
      if (shot) await saveRecord('shots', { ...shot, offline_series_id: seriesId, offline_series_name: name });
    }
    el.offlineStatus.textContent = `Grouped ${ids.length} shots as “${name}”. Regroup at any time using selection.`;
  }));
  el.offlineSuggestBtn?.addEventListener('click', () => performOfflineAction(el.offlineSuggestBtn, async () => {
    const ids = selectedIds();
    if (!ids.length) throw new Error('Select shots to use time-based suggestions');
    const selected = (await getAll('shots')).filter((s) => ids.includes(s.id));
    const { groups, excluded } = suggestOfflineSeries(selected);
    for (let i = 0; i < groups.length; i++) {
      const seriesId = crypto.randomUUID();
      for (const shot of groups[i]) await saveRecord('shots', { ...shot, offline_series_id: seriesId,
        offline_series_name: `Suggested series ${i + 1} · boot ${shot.device_boot_id}` });
    }
    el.offlineStatus.textContent = `${groups.length} suggested series applied. Review boundaries; ${excluded.length} records need manual grouping.`;
  }));
  const previewPainters = new WeakMap();
  let targetDisplayKey = "";
  store.subscribe((current) => {
    const key = `${current.targetViewMode}:${current.targetDistanceM}`;
    if (key === targetDisplayKey) return;
    targetDisplayKey = key;
    requestAnimationFrame(() => {
      for (const root of [el.historyList, el.recentShotsList]) {
        root?.querySelectorAll("canvas").forEach((canvas) => previewPainters.get(canvas)?.());
      }
    });
  });
  // Escape user-entered text before injecting into innerHTML.
  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function defaultSessionName(startTime) {
    const d = new Date(startTime);
    const hour = d.getHours();
    const partOfDay =
      hour < 5 ? "Night" : hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
    return `${partOfDay} Practice`;
  }

  function bowDisplayName(bow) {
    if (!bow) return "Default Bow";
    return bow.model + (bow.draw_weight ? ` (${bow.draw_weight} lbs)` : "");
  }

  async function loadShotHistoryList() {
    const generation = ++historyLoadGeneration;
    restoreChart(false); // Preserve the player before rebuilding its containing card.
    el.historyList.innerHTML = `<p class="note" style="padding: 24px; text-align: center;">Loading saved history...</p>`;
    try {
      const shots = (await getAll("shots")).map(shotForDisplay);
      const bows = await getAll("bow_profiles");
      const overrides = await getAll("session_overrides");
      if (generation !== historyLoadGeneration) return;
      const availableIds = new Set(shots.map(s => s.id));
      if (inlineReviewId && !availableIds.has(inlineReviewId)) el.exitReviewBtn.click();
      for (const id of selection) if (!availableIds.has(id)) selection.delete(id);
      for (const expanded of [expandedAnalysis, expandedMore]) {
        for (const id of expanded) if (!availableIds.has(id)) expanded.delete(id);
      }

      if (shots.length === 0) {
        el.historyList.innerHTML = `<p class="note" style="padding: 24px; text-align: center;">No saved shots yet. Shots taken within ${Math.round(SESSION_GAP_MS / 60000)} minutes of each other are grouped into a session automatically.</p>`;
        return;
      }

      const bowMap = new Map(bows.map(b => [b.id, b]));
      const overrideMap = new Map(overrides.map(o => [o.id, o]));

      // Group shots purely by their timestamps (newest session first).
      const groups = groupShotsByTime(shots);

      el.historyList.innerHTML = "";
      shotOrderLabels.clear();
      const historyPreviewJobs = [];
      let isFirst = true;
      for (const group of groups) {
        const override = overrideMap.get(group.anchorId) || overrideMap.get(group.legacyAnchorId) || null;
        if (override && override.id !== group.anchorId) {
          // Migrate old import anchors so deleting the earliest record cannot reset numbering.
          await put('session_overrides', { ...override, id: group.anchorId });
          if (generation !== historyLoadGeneration) return;
        }
        const order = sessionOrder(group.shots, override?.first_device_shot);
        group.shots = order.entries.map(e => e.shot);
        for (const entry of order.entries) shotOrderLabels.set(entry.shot.id, entry.label);
        const groupEl = document.createElement("div");
        groupEl.dataset.groupId = group.anchorId;
        groupEl.className = "session-group" + ((groupExpanded.get(group.anchorId) ?? isFirst) ? "" : " collapsed");
        isFirst = false;

        const sessionName = (override && override.name) || group.name || (group.timeKind === "imported" ? "Offline import · series unknown" : defaultSessionName(group.startTime));
        const dateStr = (group.timeKind === "imported" ? "Imported " : "") + new Date(group.startTime).toLocaleString();

        const bow = override && override.bow_profile_id ? bowMap.get(override.bow_profile_id) : null;
        const bowName = bowDisplayName(bow);

        const shotCount = group.shots.length;
        const offlineGroup = group.shots.every(s => s.stored_upload);
        const analyzedCount = group.shots.filter(s => savedOfflineScore(s.offline_analysis)?.total != null).length;
        const scores = group.shots.map(shotFloatScore).filter(Number.isFinite);
        const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : "Not calculated";

        const bowOptions = ['<option value="">Default Bow</option>']
          .concat(bows.map(b => {
            const sel = override && override.bow_profile_id === b.id ? " selected" : "";
            return `<option value="${escapeHtml(b.id)}"${sel}>${escapeHtml(bowDisplayName(b))}</option>`;
          }))
          .join("");

        groupEl.innerHTML = `
          <div class="session-header">
            <div class="session-meta">
              <div class="session-title-row">
                <span class="session-arrow-icon">▼</span>
                <span class="session-location">${escapeHtml(sessionName)}</span>
                <button class="session-edit-btn" type="button" title="Edit session name, bow and first shot number">✎</button>
              </div>
              <div class="session-info-row">
                <span class="session-date">${dateStr}</span>
                <span class="session-divider">|</span>
                <span class="session-bow">${escapeHtml(bowName)}</span>
              </div>
            </div>
            <button type="button" data-session-more aria-expanded="false" aria-controls="session-more-${encodeURIComponent(group.anchorId)}">More</button>
            <div class="session-stats">
              <div class="session-stat-badge">
                <span class="badge-label">Shots</span>
                <span class="badge-val">${shotCount}</span>
              </div>
              <div class="session-stat-badge">
                <span class="badge-label">${offlineGroup ? "Scored" : "Avg Float"}</span>
                <span class="badge-val">${offlineGroup ? `${analyzedCount}/${shotCount}` : avgScore}</span>
              </div>
            </div>
          </div>
          <div class="session-more" id="session-more-${encodeURIComponent(group.anchorId)}" hidden>
            <button type="button" data-session-delete class="danger">Delete session</button>
          </div>
          <div class="group-analysis-actions">
            <button type="button" data-group-analyze>Analyze group</button>
            <button type="button" data-group-open>Open group analysis</button>
            <button type="button" data-group-select>Select group</button>
            <span class="note" data-group-selection></span>
          </div>
          <div class="session-editor hidden">
            <div class="field">
              <label>Session Name</label>
              <input type="text" class="session-name-input" value="${escapeHtml(sessionName)}" placeholder="e.g. Morning 70m Practice">
            </div>
            <div class="field">
              <label>Bow Used</label>
              <select class="session-bow-input">${bowOptions}</select>
            </div>
            ${offlineGroup ? `<div class="field"><label>First device shot of this session</label>
              <input class="session-first-shot-input" type="number" min="0" max="${order.first ?? 4294967295}" step="1" value="${order.confirmed ? order.firstDeviceShot : ''}" placeholder="Unknown" ${order.continuous ? '' : 'disabled'}>
              <p class="note">Enter the actual first device shot ID (counter before practice + 1). Leave blank if unknown. Never reset the sensor counter to fix numbering; that clears pending records. If counter resets or IDs repeat, use a separate session.</p></div>` : ''}
            <div class="session-editor-actions">
              <button class="primary session-save-btn" type="button">Save</button>
              <button class="session-cancel-btn" type="button">Cancel</button>
            </div>
          </div>
          <details class="session-overview" open><summary>Session overview · scores & trends</summary>
            ${offlineSessionScoresHtml(group.shots, override?.first_device_shot)}
            ${buildSessionReview(group.shots, override?.first_device_shot)}
            ${buildSessionFloatPlot(group.shots, override?.first_device_shot)}
          </details>
          ${order.missing ? `<p class="session-gap-note">${order.missing} shot numbers missing from this group. <span>See order details below.</span></p>` : ''}
          <label class="session-sort">Sort shots
            <select data-shot-sort aria-label="Sort shots in this session">
              <option value="shot-order">Shot order</option>
              <option value="score-desc">Score: highest first</option>
              <option value="score-asc">Score: lowest first</option>
            </select>
          </label>
          <div class="session-shots-container"></div>
          <details class="session-order-details"><summary>Shot order & missing records</summary>${sessionTimelineHtml(group.shots, override?.first_device_shot)}</details>
        `;

        const headerEl = groupEl.querySelector(".session-header");
        const editorEl = groupEl.querySelector(".session-editor");
        headerEl.addEventListener("click", () => {
          groupEl.classList.toggle("collapsed");
          groupExpanded.set(group.anchorId, !groupEl.classList.contains("collapsed"));
        });

        const groupIds = group.shots.map(s => s.id);
        const moreButton = groupEl.querySelector('[data-session-more]');
        const morePanel = groupEl.querySelector('.session-more');
        moreButton.addEventListener('click', event => {
          event.stopPropagation();
          morePanel.hidden = !morePanel.hidden;
          moreButton.setAttribute('aria-expanded', String(!morePanel.hidden));
        });
        groupEl.querySelector('[data-session-delete]').addEventListener('click', async event => {
          event.stopPropagation();
          const button = event.currentTarget;
          if (button.disabled) return;
          if (!confirm(`Delete session “${sessionName}” and all ${groupIds.length} saved shots with their traces?\n\nThis cannot be undone.`)) return;
          button.disabled = true;
          button.textContent = 'Deleting…';
          try {
            await deleteShotRecords(groupIds, [group.anchorId, group.legacyAnchorId]);
            const deleted = new Set(groupIds), current = store.get(), updates = {};
            if (deleted.has(current.reviewShotId)) {
              Object.assign(updates, { reviewMode: false, reviewShotId: null, reviewTrace: null,
                reviewMicSeries: null, reviewInfo: '', reviewRangeEst: '', reviewReleaseIdx: null,
                reviewReleaseTimeMs: null, reviewHitIdx: null, reviewHitTimeMs: null,
                replayActive: false, replayPaused: false, replayProgress: 1 });
            }
            if (deleted.has(current.compareShotId)) {
              Object.assign(updates, { compareShotId: null, compareTrace: null, compareShotLabel: '', compareThresholdG: 12 });
              if (el.reviewCompareSelect) el.reviewCompareSelect.value = '';
            }
            if (Object.keys(updates).length) store.set(updates);
            for (const id of deleted) { selection.delete(id); expandedAnalysis.delete(id); expandedMore.delete(id); }
            groupExpanded.delete(group.anchorId);
            groupSort.delete(group.anchorId);
            if (!selection.size) selectionMode = false;
            await loadShotHistoryList();
            await loadRecentShotsList();
            updateBulkSelectCount();
            if (store.get().reviewShotId) await refreshReviewCompareOptions(store.get().reviewShotId);
            const scope = comparison.scope();
            if (scope?.ids.some(id => deleted.has(id))) {
              const remaining = scope.ids.filter(id => !deleted.has(id));
              if (remaining.length) await openComparison(remaining, scope.title, false);
              else el.offlineComparisonPanel.hidden = true;
            }
            bus.emit('log', `Deleted session “${sessionName}”: ${groupIds.length} saved shots.`);
          } catch (error) {
            button.disabled = false;
            button.textContent = 'Delete session';
            alert(`Could not delete session: ${error.message}`);
          }
        });
        groupEl.querySelector('[data-group-analyze]').addEventListener('click', (e) => {
          performOfflineAction(e.currentTarget, () => analyzeIds(groupIds), { compareIds: groupIds, title: sessionName });
        });
        groupEl.querySelector('[data-group-open]').addEventListener('click', async () => {
          try { await openComparison(groupIds, sessionName); } catch(e) { el.offlineStatus.textContent=e.message; }
        });
        groupEl.querySelector('[data-group-select]').addEventListener('click', () => {
          const all = groupIds.every(id => selection.has(id));
          for (const id of groupIds) { if (all) selection.delete(id); else selection.add(id); }
          updateBulkSelectCount();
        });
        // Edit button: open the inline editor without toggling collapse.
        groupEl.querySelector(".session-edit-btn").addEventListener("click", (e) => {
          e.stopPropagation();
          editorEl.classList.toggle("hidden");
        });
        groupEl.querySelector(".session-cancel-btn").addEventListener("click", (e) => {
          e.stopPropagation();
          editorEl.classList.add("hidden");
        });
        groupEl.querySelector(".session-save-btn").addEventListener("click", async (e) => {
          e.stopPropagation();
          const nameVal = groupEl.querySelector(".session-name-input").value.trim();
          const bowVal = groupEl.querySelector(".session-bow-input").value || null;
          const firstInput = groupEl.querySelector('.session-first-shot-input');
          if (firstInput && !firstInput.reportValidity()) return;
          const firstDeviceShot = firstInput?.value.trim() ? Number(firstInput.value) : null;
          const record = {
            ...override,
            first_device_shot: firstDeviceShot,
            id: group.anchorId,
            name: nameVal || null,
            bow_profile_id: bowVal,
            updated_at: new Date().toISOString(),
          };
          try {
            await put("session_overrides", record);
            bus.emit("log", `Updated session "${nameVal || defaultSessionName(group.startTime)}".`);
            await loadShotHistoryList();
          } catch (err) {
            console.error("Error saving session override:", err);
            bus.emit("log", `Error saving session: ${err.message}`);
          }
        });
        groupEl.querySelectorAll("[data-review-shot-id]").forEach((button) => {
          button.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const shotId = button.dataset.reviewShotId;
            const shot = group.shots.find((candidate) => candidate.id === shotId);
            if (shot) reviewShotTrace(shot);
          });
        });

        const containerEl = groupEl.querySelector(".session-shots-container");
        for (const shot of group.shots) {
          const peer = offlinePeerComparison(shot.offline_analysis, group.shots.filter(s => s.id !== shot.id).map(s => s.offline_analysis));
          const item = buildHistoryItemElement(shot, peer);
          item.addEventListener("click", (e) => {
            if (e.target.closest('button, input, details, .inline-shot-review, .inline-shot-analysis, .shot-more')) return;
            e.stopPropagation();
            reviewShotTrace(shot);
          });
          item.querySelector('[data-shot-analyze]')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (busy) return;
            if (expandedAnalysis.has(shot.id)) {
              expandedAnalysis.delete(shot.id);
              item.querySelector('.inline-shot-analysis').hidden = true;
              e.currentTarget.setAttribute('aria-expanded', 'false');
              return;
            }
            expandedAnalysis.add(shot.id);
            await performOfflineAction(e.currentTarget, () => analyzeIds([shot.id]));
            const card = [...el.historyList.querySelectorAll('.history-item')].find(node => node.dataset.shotId === shot.id);
            if (expandedAnalysis.has(shot.id) && historyVisible()) card?.querySelector('.inline-shot-analysis')?.scrollIntoView({block:'nearest',behavior:'smooth'});
          });
          item.querySelector('.inline-shot-analysis [data-score-window]')?.addEventListener('click', async () => {
            await reviewShotTrace(shot);
            if (store.get().reviewShotId === shot.id) chartPanel.querySelector('#reviewOfflineReport [data-score-window]')?.click();
          });
          item.querySelector('[data-shot-review]')?.addEventListener('click', (e) => {e.stopPropagation();reviewShotTrace(shot, {toggle:true});});
          const deleteBtn = item.querySelector(".history-item-delete-btn");
          deleteBtn?.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            deleteSavedShot(shot.id);
          });
          const exportBtn = item.querySelector(".history-item-export-btn");
          exportBtn?.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            exportSingleShot(shot.id);
          });
          containerEl.appendChild(item);
          historyPreviewJobs.push({ item, shot });
        }

        const sortSelect = groupEl.querySelector('[data-shot-sort]');
        sortSelect.value = groupSort.get(group.anchorId) || 'shot-order';
        const applyShotSort = () => {
          const mode = sortSelect.value;
          const cards = new Map([...containerEl.children].map(node => [node.dataset.shotId, node]));
          const ordered = group.shots.map((shot, index) => ({ shot, index,
            score: shot.stored_upload ? savedOfflineScore(shot.offline_analysis)?.total : shotFloatScore(shot) }));
          if (mode !== 'shot-order') ordered.sort((a,b) => {
            const hasA = Number.isFinite(a.score), hasB = Number.isFinite(b.score);
            if (hasA !== hasB) return hasA ? -1 : 1;
            if (!hasA) return a.index - b.index;
            return (mode === 'score-asc' ? a.score - b.score : b.score - a.score) || a.index - b.index;
          });
          // Move existing cards: preserve checkboxes, previews and event handlers.
          for (const {shot} of ordered) containerEl.appendChild(cards.get(shot.id));
        };
        sortSelect.addEventListener('change', () => {
          groupSort.set(group.anchorId, sortSelect.value);
          try { localStorage.setItem('openfloat_history_sort', JSON.stringify(Object.fromEntries(groupSort))); } catch { /* Keep the in-memory preference. */ }
          applyShotSort();
        });
        applyShotSort();
        el.historyList.appendChild(groupEl);
      }

      mountInlineReview();
      updateBulkSelectCount();
      setAnalysisBusy(busy);
      await paintHistoryShotPreviews(historyPreviewJobs);
    } catch (error) {
      console.error("Error loading shot history:", error);
      el.historyList.innerHTML = `<p class="note" style="padding: 24px; text-align: center; color: var(--red);">Failed to load history: ${error.message}</p>`;
    }
  }

  function formatShotCompareLabel(shot) {
    const timeStr = shotTimeLabel(shot);
    const score = displayScore(shot);
    const motion = savedOfflineScore(shot.offline_analysis);
    if (shot.stored_upload) return `${shotOrderLabels.get(shot.id) || `Device #${shot.device_shot_id}`} · Motion Score: ${motion?.total ?? 'not calculated'} · ${timeStr}`;
    const label = shot.label || (shot.peak_g > 15 ? "Arrow" : "Hold");
    return `${label} - ${timeStr} (Float Score: ${score})`;
  }

  async function refreshReviewCompareOptions(currentShotId, preserveSelection = true) {
    if (!el.reviewCompareSelect) return;

    const previous = preserveSelection ? el.reviewCompareSelect.value : "";
    const shots = (await getAll("shots")).map(shotForDisplay);
    const candidates = [];

    for (const candidate of shots) {
      if (candidate.id === currentShotId) continue;
      const trace = await get("shot_traces", candidate.id);
      if (trace && trace.payload && trace.payload.length >= 2) {
        candidates.push(candidate);
      }
    }

    candidates.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    el.reviewCompareSelect.innerHTML =
      '<option value="">None</option>' +
      candidates
        .map((s) => `<option value="${s.id}">${escapeHtml(formatShotCompareLabel(s))}</option>`)
        .join("");

    if (previous && [...el.reviewCompareSelect.options].some((opt) => opt.value === previous)) {
      el.reviewCompareSelect.value = previous;
    } else {
      el.reviewCompareSelect.value = "";
    }
  }

  async function loadReviewCompareShot(shotId) {
    if (!shotId) {
      store.set({
        compareShotId: null,
        compareTrace: null,
        compareShotLabel: "",
        compareThresholdG: 12,
      });
      return;
    }

    try {
      const shot = await get("shots", shotId);
      const trace = await get("shot_traces", shotId);
      if (!shot || !trace || !trace.payload || trace.payload.length < 2) {
        store.set({
          compareShotId: null,
          compareTrace: null,
          compareShotLabel: "",
          compareThresholdG: 12,
        });
        if (el.reviewCompareSelect) el.reviewCompareSelect.value = "";
        bus.emit("log", "Compare shot has no saved trace.");
        return;
      }

      const label = shot.label || formatShotCompareLabel(shot);
      store.set({
        compareShotId: shotId,
        compareTrace: traceForReview(trace).payload,
        compareShotLabel: label,
        compareThresholdG: shot.threshold_g != null ? Number(shot.threshold_g) : 12,
      });
      bus.emit("log", `Comparing with shot ${shotId.slice(0, 8)}…`);
    } catch (error) {
      console.error("Failed to load compare shot:", error);
      bus.emit("log", `Compare load failed: ${error.message}`);
    }
  }

  async function getActiveArrowSpeed() {
    const activeBowId = localStorage.getItem("openfloat_active_bow_id");
    if (activeBowId) {
      try {
        const profile = await get("bow_profiles", activeBowId);
        if (profile && profile.arrow_speed != null) {
          return Number(profile.arrow_speed);
        }
      } catch (error) {
        console.error("Error getting active bow speed:", error);
      }
    }
    return 280; // Fallback default speed
  }

  function estimateShotRange(trace, sampleRateHz, bowSpeedFps) {
    if (!trace || !trace.payload || trace.payload.length === 0) return null;
    const payload = trace.payload;
    const hz = sampleRateHz || 52;

    const getG = (f) => Math.sqrt((f.ax || 0) ** 2 + (f.ay || 0) ** 2 + (f.az || 0) ** 2);

    const getTimeMs = (idx) => {
      const f = payload[idx];
      if (f.tUs !== undefined) return f.tUs / 1000.0;
      return (idx * 1000.0) / hz;
    };

    let maxIdx = -1;
    let maxG = -1;
    for (let i = 0; i < payload.length; i++) {
      const g = getG(payload[i]);
      if (g > maxG) {
        maxG = g;
        maxIdx = i;
      }
    }

    if (maxG < 4.0 || maxIdx === -1) {
      return null;
    }

    const maxTime = getTimeMs(maxIdx);

    let releaseIdx = maxIdx;
    while (releaseIdx > 0) {
      if (getG(payload[releaseIdx]) <= 1.25) {
        break;
      }
      releaseIdx--;
    }

    const releaseTime = getTimeMs(releaseIdx);

    let searchStartIdx = -1;
    for (let i = releaseIdx; i < payload.length; i++) {
      if (getTimeMs(i) >= maxTime + 200) {
        searchStartIdx = i;
        break;
      }
    }

    if (searchStartIdx === -1) {
      return null;
    }

    let firstAbove15Idx = -1;
    for (let i = searchStartIdx; i < payload.length; i++) {
      const dt = getTimeMs(i) - releaseTime;
      if (dt > 2200) {
        break;
      }
      if ((payload[i].micAmp || 0) > 15) {
        firstAbove15Idx = i;
        break;
      }
    }

    if (firstAbove15Idx === -1) {
      return null;
    }

    let bestPeakIdx = firstAbove15Idx;
    let maxMic = payload[firstAbove15Idx].micAmp || 0;
    for (let i = firstAbove15Idx + 1; i < payload.length; i++) {
      const dt = getTimeMs(i) - releaseTime;
      if (dt > 2200) break;
      const mic = payload[i].micAmp || 0;
      if (mic <= 15) break;
      if (mic > maxMic) {
        maxMic = mic;
        bestPeakIdx = i;
      }
    }

    let hitIdx = bestPeakIdx;
    while (hitIdx > searchStartIdx && (payload[hitIdx].micAmp || 0) >= 10) {
      hitIdx--;
    }

    const hitTime = getTimeMs(hitIdx);
    const totalTimeSec = (hitTime - releaseTime) / 1000.0;
    if (totalTimeSec <= 0) return null;

    const V_sound = 1125.0;
    const b = 0.075;
    const A = b;
    const B = -(V_sound + bowSpeedFps + totalTimeSec * b * V_sound);
    const C = totalTimeSec * bowSpeedFps * V_sound;

    const discriminant = B * B - 4 * A * C;
    if (discriminant < 0) return null;

    const distanceFt = (-B - Math.sqrt(discriminant)) / (2 * A);
    if (distanceFt <= 0) return null;

    return {
      yards: distanceFt / 3.0,
      feet: distanceFt,
      releaseIdx,
      releaseTime,
      hitIdx,
      hitTime
    };
  }

  async function reviewShotTrace(shot, {toggle = false} = {}) {
    if (toggle && inlineReviewId === shot.id && store.get().reviewMode) {
      el.exitReviewBtn.click(); return;
    }
    const request = ++reviewRequest, inline = historyVisible();
    shot = shotForDisplay(shot);
    try {
      let trace = await get("shot_traces", shot.id);

      // For shots taken while connected, the device does not store a trace — the
      // browser captures it and only persists it after the follow-through window
      // (~1.5 s + buffer). The shot is clickable immediately, so a just-taken
      // shot's trace may still be in flight. Poll briefly before giving up.
      if (!trace || !trace.payload) {
        const ageMs = Date.now() - new Date(shot.timestamp).getTime();
        if (ageMs < 4000) {
          bus.emit("log", "Trace still being captured (follow-through); waiting…");
          const deadline = Date.now() + 4000;
          while ((!trace || !trace.payload) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 250));
            trace = await get("shot_traces", shot.id);
          }
        }
      }

      if (request !== reviewRequest) return;
      if (!trace || !trace.payload) {
        const currentShot = await get("shots", shot.id);
        const traceStatus = currentShot?.trace_status || shot.trace_status;
        const offlineMessage =
          traceStatus === "downloading"
            ? "This offline trace is still downloading from the sensor. Keep the BLE connection open until the Uploading count reaches zero."
            : traceStatus === "unavailable"
              ? "This offline trace is no longer present on the sensor. It was recorded before the current 80-trace session buffer, or it did not finish saving before power-off."
              : null;
        alert(
          "No saved trace for this shot yet.\n\n" +
            (offlineMessage ||
              "Live shots capture their trace shortly after the follow-through " +
              "window — try again in a moment. If a trace never appears, check that " +
              "“Trace Buffer Rate” in Settings isn’t set to Off."),
        );
        return;
      }

      trace = traceForReview(trace);
      const offlineScore = trace.source === 'firmware' ? savedOfflineScore(trace.analysis) : null;
      const reviewGroup = trace.source === 'firmware' ? groupShotsByTime(await getAll('shots')).find(g=>g.shots.some(s=>s.id===shot.id)) : null;
      const peer = offlinePeerComparison(trace.analysis, (reviewGroup?.shots || []).filter(s=>s.id!==shot.id).map(s=>s.offline_analysis));
      const timeStr = shotTimeLabel(shot);
      const score = shotFloatScore(shot);
      const info = `Float Score: ${score ?? "Not calculated"} | Peak Force: ${shot.peak_g.toFixed(1)}g | Stability: ${shot.stability_score == null ? "Not calculated" : `${shot.stability_score}%`} | ${timeStr} | Target: ${targetViewSummary(store.get().targetViewMode, store.get().targetDistanceM)}`;

      const holdStability = shot.hold_stability != null ? Math.round(shot.hold_stability) : (shot.stability_score != null ? Math.round(shot.stability_score) : null);
      const releaseQuality = shot.release_quality != null ? Math.round(shot.release_quality) : null;
      const followThrough = shot.follow_through != null ? Math.round(shot.follow_through) : null;
      const levelConsistency = shot.level_consistency != null ? Math.round(shot.level_consistency) : null;
      const roll = shot.cant_angle_deg || shot.roll_angle_deg || 0;
      
      const coaching = coachForScore({
        formScore: score,
        holdStability,
        releaseQuality,
        followThrough,
        roll
      });

      const speed = await getActiveArrowSpeed();
      const range = trace.source === "firmware" ? null : estimateShotRange(trace, trace.sample_rate_hz || 52, speed);
      const rangeText = range 
        ? `| Est. Range: ${range.yards.toFixed(1)} yds (${Math.round(range.feet)} ft) @ ${speed} fps`
        : "";

      if (request !== reviewRequest) return;
      if (!inline) restoreChart();
      inlineReviewId = inline ? shot.id : null;
      store.set({
        reviewMode: true,
        reviewOfflineReportHtml: trace.source === 'firmware' ? offlineScoreReport(trace.analysis, peer, {windowButtons:true}) : '',
        reviewOfflineIssueWindow: offlineScore?.issue?.windowMs || null,
        reviewOfflineIssueLabel: offlineScore?.issue?.label || '',
        reviewShotId: shot.id,
        reviewTrace: trace.payload,
        reviewMicSeries: resolveReviewMicSeries(trace, trace.sample_rate_hz || 52),
        reviewSampleRateHz: trace.sample_rate_hz || 52,
        reviewDetectorTiming: trace.timing?.version === 3,
        reviewThresholdG: shot.threshold_g != null ? Number(shot.threshold_g) : 12,
        reviewInfo: (trace.analysis?.kind === "per-shot-relative" ? `${timeStr} | Movement score: ${offlineScore?.total == null ? "not available" : `${offlineScore.total}/100`}` : info) + (trace.timing?.version === 3 ? ` | Detector timing: ${trace.timing.completeness}${trace.timing.dataGap ? " · data gap" : ""} | Boot: ${trace.timing.bootId ?? "unknown"}` : ""),
        reviewRangeEst: rangeText,
        reviewReleaseIdx: trace.timing?.releaseIndex ?? (range ? range.releaseIdx : null),
        reviewReleaseTimeMs: trace.timing?.releaseIndex != null ? 0 : (range ? range.releaseTime : null),
        reviewHitIdx: range ? range.hitIdx : null,
        reviewHitTimeMs: range ? range.hitTime : null,
        chartView: trace.source === "firmware" && trace.analysis?.status !== "calculated" ? "line" : "target",
        ...(trace.analysis?.status === "calculated" ? { targetViewMode: "fit" } : {}),
        replayActive: false,
        replayPaused: false,
        replayProgress: 1,
        traceZoom: 1,
        reviewCameraMode: trace.payload.some(p=>p.aim) ? "auto" : null,
        reviewCameraScale: null, reviewPanX: 0, reviewPanY: 0,
        compareShotId: null,
        compareTrace: null,
        compareShotLabel: "",
        compareThresholdG: 12,
        formScore: score,
        holdStability,
        releaseQuality,
        followThrough,
        levelConsistency,
        scoreVersion: shot.score_version || null,
        coachTitle: offlineScore ? offlineIssueLabel(offlineScore) : trace.analysis?.status === "calculated" ? "Offline relative aim" : score == null ? "Analysis not calculated" : coaching.coachTitle,
        coachText: trace.source === "firmware" ? (offlineScore?.issue?.evidence || offlineMetricsText(trace.analysis)) : score == null ? (trace.timing?.version === 3 ? "Offline angles and detector timing saved. Relative aiming reference not calculated yet." : "Offline angles saved. Release timing and aiming reference are unavailable.") : coaching.coachText,
        lastShotSummary: {
          timestamp: shot.timestamp,
          score,
          peakG: shot.peak_g,
          cant: roll,
          pitch: shot.pitch_angle_deg || 0,
        },
      });

      await refreshReviewCompareOptions(shot.id, false);
      if (request !== reviewRequest) return;
      if (el.reviewCompareSelect) el.reviewCompareSelect.value = "";

      bus.emit("log", `Entering review mode for shot ${shot.id.slice(0, 8)}...`);
      if (inline) {
        if (!mountInlineReview(true)) { await loadShotHistoryList(); mountInlineReview(true); }
      } else selectViewTab("tabDashboard");
    } catch (error) {
      console.error("Failed to load trace:", error);
      alert("Error fetching trace payload: " + error.message);
    }
  }

  el.exitReviewBtn.addEventListener("click", () => {
    reviewRequest++;
    store.set({
      reviewMode: false,
      reviewCameraMode: null, reviewCameraScale: null, reviewPanX: 0, reviewPanY: 0,
      reviewShotId: null,
      reviewTrace: null,
      reviewMicSeries: null,
      reviewSampleRateHz: 52,
      reviewThresholdG: 12,
      reviewInfo: "",
      reviewRangeEst: "",
      reviewReleaseIdx: null,
      reviewReleaseTimeMs: null,
      reviewHitIdx: null,
      reviewHitTimeMs: null,
      compareShotId: null,
      compareTrace: null,
      compareShotLabel: "",
      compareThresholdG: 12,
      replayActive: false,
      replayPaused: false,
      replayProgress: 1,
      traceZoom: 1,
      formScore: null,
      holdStability: null,
      releaseQuality: null,
      followThrough: null,
      levelConsistency: null,
      scoreVersion: null,
      coachTitle: null,
      coachText: null
    });
    if (el.reviewCompareSelect) {
      el.reviewCompareSelect.innerHTML = '<option value="">None</option>';
      el.reviewCompareSelect.value = "";
    }
    bus.emit("log", "Exited review mode. Returned to live telemetry stream.");
  });

  async function exportSingleShot(shotId) {
    try {
      const shot = await get("shots", shotId);
      if (!shot) {
        alert("Shot not found in database.");
        return;
      }
      const trace = await get("shot_traces", shotId);
      
      const payload = {
        format: "openfloat-shot-export",
        version: 1,
        exportedAt: new Date().toISOString(),
        shot,
        trace
      };

      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const dateStr = new Date(shot.timestamp).toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const a = document.createElement("a");
      a.href = url;
      a.download = `archeryaimtrace-shot-${shotId.slice(0, 8)}-${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      
      bus.emit("log", `Exported single shot ${shotId.slice(0, 8)} successfully.`);
    } catch (error) {
      console.error("Single shot export failed:", error);
      alert(`Failed to export shot: ${error.message}`);
    }
  }

  if (el.exportShotBtn) {
    el.exportShotBtn.addEventListener("click", () => {
      const currentShotId = store.get().reviewShotId;
      if (currentShotId) {
        exportSingleShot(currentShotId);
      } else {
        alert("No shot is currently being reviewed.");
      }
    });
  }

  if (el.reviewCompareSelect) {
    el.reviewCompareSelect.addEventListener("change", () => {
      loadReviewCompareShot(el.reviewCompareSelect.value);
    });
  }

  const RECENT_SHOTS_LIMIT = 5;

  function recentShotCardMetrics(shot) {
    shot = shotForDisplay(shot);
    const timeStr = shotTimeLabel(shot);
    const motion = savedOfflineScore(shot.offline_analysis);
    const score = motion ? motion.total ?? 'Incomplete' : displayScore(shot);
    const scoreLabel = motion ? 'Motion Score' : 'Float';
    const stability = shot.stability_score != null ? Math.round(shot.stability_score) : "--";
    const peakG = Number.isFinite(Number(shot.peak_g)) ? Number(shot.peak_g).toFixed(1) : "--";
    return { timeStr, score, scoreLabel, stability, peakG };
  }

  function buildHistoryItemElement(shot, peer = null) {
    shot = shotForDisplay(shot);
    const item = document.createElement("div");
    item.className = "history-item";
    item.dataset.shotId = shot.id;

    const chkClass = "history-item-checkbox";

    const timestampStr = shotTimeLabel(shot);
    const title = shot.stored_upload ? (shotOrderLabels.get(shot.id) || `Device #${shot.device_shot_id ?? shot.id.slice(0,8)}`).split(' · ')[0] : shot.label || (shot.peak_g > 15 ? "Arrow Release" : "Hold Capture");
    const motionScore = savedOfflineScore(shot.offline_analysis);
    const moreId = `shot-more-${shot.id}`, analysisId = `shot-analysis-${shot.id}`;

    item.innerHTML = `
      <input type="checkbox" class="${chkClass}" data-shot-id="${escapeHtml(shot.id)}" aria-label="Select shot ${escapeHtml(shot.device_shot_id ?? shot.id.slice(0,8))}"${selection.has(shot.id)?" checked":""}>
      <div class="history-item-preview-wrap is-empty" aria-hidden="true">
        <canvas class="history-item-trace-preview"></canvas>
      </div>
      <div class="history-item-body">
        <div class="history-meta">
          <div class="shot-title-row"><div class="history-title">${escapeHtml(title)}</div>
            <span class="shot-score-badge${(motionScore?.total ?? shotFloatScore(shot)) == null ? ' is-unscored' : ''}" title="${shot.stored_upload ? 'Movement score' : 'Float Score'}">${motionScore?.total != null ? `${motionScore.total}<small>/100</small>` : shotFloatScore(shot) != null ? `${Math.round(shotFloatScore(shot))}<small>/100</small>` : motionScore ? 'Incomplete' : 'Not scored'}</span>
          </div>
          ${motionScore ? `<div class="history-subtitle">Main issue: ${escapeHtml(offlineIssueLabel(motionScore))}</div>` : ''}
        </div>
        <div class="shot-analysis-actions"><button type="button" data-shot-review aria-expanded="false">Review</button>${shot.stored_upload ? `<button type="button" data-shot-analyze aria-expanded="${expandedAnalysis.has(shot.id)}" aria-controls="${escapeHtml(analysisId)}">Analyze shot</button>` : ''}<button type="button" data-shot-more aria-expanded="${expandedMore.has(shot.id)}" aria-controls="${escapeHtml(moreId)}">More</button></div>
        <div class="shot-more" id="${escapeHtml(moreId)}"${expandedMore.has(shot.id) ? '' : ' hidden'}>
        <p class="note">${escapeHtml(timestampStr)}${shot.stored_upload ? ` · Device #${escapeHtml(shot.device_shot_id ?? 'unknown')}` : ''}</p>
        <div class="shot-more-actions">
        <button
          type="button"
          class="history-item-export-btn mini-icon-btn"
          title="Export shot to JSON"
          aria-label="Export shot"
        >📤</button>
        <button
          type="button"
          class="history-item-delete-btn mini-icon-btn"
          title="Delete shot"
          aria-label="Delete shot"
        >🗑</button>
        </div>
        </div>
      </div>
      ${shot.stored_upload ? `<section class="inline-shot-analysis" id="${escapeHtml(analysisId)}" aria-label="Shot analysis"${expandedAnalysis.has(shot.id) ? '' : ' hidden'}>${offlineScoreReport(shot.offline_analysis, peer, {windowButtons:true})}</section>` : ''}
    `;
    item.querySelector('[data-shot-more]').addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !expandedMore.has(shot.id);
      if (open) expandedMore.add(shot.id); else expandedMore.delete(shot.id);
      item.querySelector('.shot-more').hidden = !open;
      e.currentTarget.setAttribute('aria-expanded', String(open));
    });
    const chk = item.querySelector(".history-item-checkbox");
    chk?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (chk.checked) selection.add(shot.id); else selection.delete(shot.id);
      updateBulkSelectCount();
    });
    return item;
  }

  function syncQueueTaskMatchesShot(task, shotId) {
    if (!task || !shotId) return false;
    if (task.targetId === shotId) return true;
    const payload = task.payload;
    if (!payload) return false;
    if (payload.shot_id === shotId) return true;
    if (payload.id === shotId) return true;
    return false;
  }

  async function purgeSyncQueueForShot(shotId) {
    const tasks = await getAll("sync_queue");
    const matches = tasks.filter((task) => syncQueueTaskMatchesShot(task, shotId));
    await Promise.all(matches.map((task) => remove("sync_queue", task.id)));
  }

  async function deleteSavedShot(shotId) {
    if (!shotId) return;

    let shot;
    try {
      shot = await get("shots", shotId);
    } catch (_) {
      shot = null;
    }
    if (!shot) return;

    const title = shot.stored_upload ? (shotOrderLabels.get(shot.id) || `Device #${shot.device_shot_id ?? shot.id.slice(0,8)}`).split(' · ')[0] : shot.label || (shot.peak_g > 15 ? "Arrow Release" : "Hold Capture");
    const hold = shot.offline_analysis?.metrics?.hold;
    const timeStr = shotTimeLabel(shot);
    const confirmed = confirm(
      `Delete this saved shot?\n\n${title}\n${timeStr}\n\nThis cannot be undone.`,
    );
    if (!confirmed) return;

    try {
      await purgeSyncQueueForShot(shotId);
      try {
        await remove("shot_traces", shotId);
      } catch (_) {}
      await remove("shots", shotId);

      try {
        const override = await get("session_overrides", shotId);
        if (override) await remove("session_overrides", shotId);
      } catch (_) {}

      const state = store.get();
      const updates = {};
      if (state.reviewMode && state.reviewShotId === shotId) {
        Object.assign(updates, {
          reviewMode: false,
          reviewShotId: null,
          reviewTrace: null,
          reviewMicSeries: null,
          reviewInfo: "",
          reviewRangeEst: "",
          reviewReleaseIdx: null,
          reviewReleaseTimeMs: null,
          reviewHitIdx: null,
          reviewHitTimeMs: null,
          replayActive: false,
          replayPaused: false,
          replayProgress: 1,
        });
      }
      if (state.compareShotId === shotId) {
        Object.assign(updates, {
          compareShotId: null,
          compareTrace: null,
          compareShotLabel: "",
          compareThresholdG: 12,
        });
        if (el.reviewCompareSelect) el.reviewCompareSelect.value = "";
      }
      if (Object.keys(updates).length > 0) store.set(updates);

      el.recentShotsList
        ?.querySelector(`.recent-shot-card[data-shot-id="${shotId}"]`)
        ?.remove();

      const historyItem = el.historyList?.querySelector(
        `.history-item[data-shot-id="${shotId}"]`,
      );
      if (historyItem) {
        const sessionGroup = historyItem.closest(".session-group");
        historyItem.remove();
        const remaining = sessionGroup?.querySelectorAll(".history-item").length ?? 0;
        if (remaining === 0 && sessionGroup) {
          sessionGroup.remove();
        } else if (sessionGroup) {
          const shotsLeft = sessionGroup.querySelectorAll(".history-item").length;
          const shotsBadge = sessionGroup.querySelector(
            ".session-stat-badge:first-child .badge-val",
          );
          if (shotsBadge) shotsBadge.textContent = String(shotsLeft);
        }
        const anyShots = el.historyList?.querySelector(".history-item");
        if (!anyShots) {
          el.historyList.innerHTML = `<p class="note" style="padding: 24px; text-align: center;">No saved shots yet. Shots taken within ${Math.round(SESSION_GAP_MS / 60000)} minutes of each other are grouped into a session automatically.</p>`;
        }
      } else {
        await loadShotHistoryList();
      }

      if (state.reviewMode && state.reviewShotId && state.reviewShotId !== shotId) {
        await refreshReviewCompareOptions(state.reviewShotId);
      }

      if (syncAdapter) syncAdapter.triggerSync();
      bus.emit("log", `Deleted shot "${title}".`);
    } catch (error) {
      console.error("Failed to delete shot:", error);
      bus.emit("log", `Delete failed: ${error.message}`);
      alert(`Could not delete shot: ${error.message}`);
    }
  }

  async function paintHistoryShotPreviews(jobs) {
    if (!el.historyList) return;
    const entries = jobs?.length
      ? jobs
      : [...el.historyList.querySelectorAll(".history-item[data-shot-id]")].map((item) => ({
          item,
          shot: null,
        }));

    await Promise.all(
      entries.map(async ({ item, shot }) => {
        const canvas = item.querySelector(".history-item-trace-preview");
        const wrap = item.querySelector(".history-item-preview-wrap");
        if (!canvas || !wrap) return;
        try {
          const shotId = item.dataset.shotId;
          const record = shot || (shotId ? await get("shots", shotId) : null);
          if (!record) return;
          let trace = null;
          try {
            trace = await get("shot_traces", record.id);
          } catch (_) {
            trace = null;
          }
          paintShotPreview(canvas, wrap, record, trace);
        } catch (error) {
          console.error("Failed to paint history shot preview:", error);
        }
      }),
    );
  }

  async function refreshHistoryShotPreview(localShotId) {
    if (!el.historyList || !localShotId) return;
    const item = el.historyList.querySelector(
      `.history-item[data-shot-id="${localShotId}"]`,
    );
    if (!item) return;
    try {
      const shot = await get("shots", localShotId);
      const trace = await get("shot_traces", localShotId);
      const canvas = item.querySelector(".history-item-trace-preview");
      const wrap = item.querySelector(".history-item-preview-wrap");
      if (!shot || !canvas || !wrap) return;
      paintShotPreview(canvas, wrap, shot, trace);
    } catch (error) {
      console.error("Failed to refresh history shot preview:", error);
    }
  }

  function paintShotPreview(canvas, wrap, shot, trace) {
    if (!canvas || !wrap) return;
    const thresholdG = shot.threshold_g != null ? Number(shot.threshold_g) : 12;
    const paint = () => {
      if (trace?.payload?.length >= 2) {
        drawTraceTargetPreview(canvas, traceForReview(trace).payload, {
          thresholdG,
          targetViewMode: store.get().targetViewMode,
          targetDistanceM: store.get().targetDistanceM,
        });
        wrap.classList.remove("is-empty");
      } else {
        drawEmptyTargetPreview(canvas, {
          targetViewMode: store.get().targetViewMode,
          targetDistanceM: store.get().targetDistanceM,
        });
        wrap.classList.add("is-empty");
      }
    };
    previewPainters.set(canvas, paint);
    watchTracePreviewResize(canvas, () => previewPainters.get(canvas)?.());
    requestAnimationFrame(() => requestAnimationFrame(paint));
  }

  function buildRecentShotCardElement(shot, trace, titleIndex, totalShots) {
    const item = document.createElement("div");
    item.className = "recent-shot-card";
    item.dataset.shotId = shot.id;

    const { timeStr, score, scoreLabel, stability, peakG } = recentShotCardMetrics(shot);
    const title = shot.label || `Shot #${Math.max(1, totalShots - titleIndex)}`;

    item.innerHTML = `
      <div class="recent-shot-preview-wrap is-empty" aria-hidden="true">
        <canvas class="recent-shot-preview"></canvas>
      </div>
      <div class="recent-shot-header">
        <span class="recent-shot-title">${escapeHtml(title)}</span>
        <span class="recent-shot-time">${escapeHtml(timeStr)}</span>
      </div>
      <div class="recent-shot-metrics">
        <div class="recent-shot-metric">
          <span class="metric-label">${scoreLabel}</span>
          <strong class="metric-val score">${score}</strong>
        </div>
        <div class="recent-shot-metric">
          <span class="metric-label">Stability</span>
          <strong class="metric-val">${stability}%</strong>
        </div>
        <div class="recent-shot-metric">
          <span class="metric-label">Peak G</span>
          <strong class="metric-val">${peakG}g</strong>
        </div>
      </div>
    `;

    const previewCanvas = item.querySelector(".recent-shot-preview");
    const previewWrap = item.querySelector(".recent-shot-preview-wrap");
    paintShotPreview(previewCanvas, previewWrap, shot, trace);

    item.addEventListener("click", () => {
      reviewShotTrace(shot);
    });
    return item;
  }

  function updateRecentShotCardMetrics(card, shot, titleIndex, totalShots) {
    const { timeStr, score, scoreLabel, stability, peakG } = recentShotCardMetrics(shot);
    const title = shot.label || `Shot #${Math.max(1, totalShots - titleIndex)}`;
    const titleEl = card.querySelector(".recent-shot-title");
    const timeEl = card.querySelector(".recent-shot-time");
    const scoreEl = card.querySelector(".metric-val.score");
    const metrics = card.querySelectorAll(".recent-shot-metric .metric-val");
    if (titleEl) titleEl.textContent = title;
    if (timeEl) timeEl.textContent = timeStr;
    if (scoreEl) scoreEl.textContent = String(score);
    const labelEl = card.querySelector(".recent-shot-metric .metric-label");
    if (labelEl) labelEl.textContent = scoreLabel;
    if (metrics[1]) metrics[1].textContent = `${stability}%`;
    if (metrics[2]) metrics[2].textContent = `${peakG}g`;
  }

  function trimRecentShotCards() {
    if (!el.recentShotsList) return;
    const cards = el.recentShotsList.querySelectorAll(".recent-shot-card");
    for (let i = RECENT_SHOTS_LIMIT; i < cards.length; i++) {
      cards[i].remove();
    }
  }

  function clearRecentShotsEmptyNote() {
    if (!el.recentShotsList) return;
    const note = el.recentShotsList.querySelector(":scope > .note");
    if (note) note.remove();
  }

  async function refreshRecentShotPreview(localShotId) {
    if (!el.recentShotsList || !localShotId) return;
    const card = el.recentShotsList.querySelector(
      `.recent-shot-card[data-shot-id="${localShotId}"]`,
    );
    if (!card) return;

    try {
      const shot = await get("shots", localShotId);
      const trace = await get("shot_traces", localShotId);
      if (!shot) return;
      const canvas = card.querySelector(".recent-shot-preview");
      const wrap = card.querySelector(".recent-shot-preview-wrap");
      paintShotPreview(canvas, wrap, shot, trace);
    } catch (error) {
      console.error("Failed to refresh recent shot preview:", error);
    }
  }

  async function upsertRecentShotCard(localShotId) {
    if (!el.recentShotsList || !localShotId) return;

    try {
      const shot = await get("shots", localShotId);
      if (!shot) return;

      const allShots = (await getAll("shots")).map(shotForDisplay);
      allShots.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      const totalShots = allShots.length;

      clearRecentShotsEmptyNote();

      let card = el.recentShotsList.querySelector(
        `.recent-shot-card[data-shot-id="${localShotId}"]`,
      );
      if (card) {
        updateRecentShotCardMetrics(card, shot, 0, totalShots);
        return;
      }

      const trace = await get("shot_traces", localShotId);
      card = buildRecentShotCardElement(shot, trace, 0, totalShots);
      el.recentShotsList.prepend(card);
      trimRecentShotCards();
    } catch (error) {
      console.error("Failed to upsert recent shot card:", error);
    }
  }

  function withPreservedScroll(run) {
    const root = document.scrollingElement || document.documentElement;
    const scrollTop = root.scrollTop;
    const finish = () => {
      requestAnimationFrame(() => {
        root.scrollTop = scrollTop;
      });
    };
    try {
      const result = run();
      if (result && typeof result.then === "function") {
        return result.then(finish, finish);
      }
      finish();
      return result;
    } catch (error) {
      finish();
      throw error;
    }
  }

  // Load recent shots for dashboard (full rebuild — only on init / tab switch)
  async function loadRecentShotsList() {
    if (!el.recentShotsList) return;
    try {
      const shots = (await getAll("shots")).map(shotForDisplay);
      if (!shots || shots.length === 0) {
        el.recentShotsList.innerHTML = `<p class="note" style="padding: 12px; text-align: center; width: 100%;">No shots captured in this session yet.</p>`;
        return;
      }

      shots.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      const recent = shots.slice(0, RECENT_SHOTS_LIMIT);

      el.recentShotsList.replaceChildren();

      const traceEntries = await Promise.all(
        recent.map(async (shot) => {
          try {
            const trace = await get("shot_traces", shot.id);
            return { shot, trace };
          } catch (_) {
            return { shot, trace: null };
          }
        }),
      );

      const fragment = document.createDocumentFragment();
      traceEntries.forEach(({ shot, trace }, index) => {
        fragment.appendChild(buildRecentShotCardElement(shot, trace, index, shots.length));
      });
      el.recentShotsList.appendChild(fragment);
    } catch (error) {
      console.error("Error loading recent shots:", error);
      el.recentShotsList.innerHTML = `<p class="note" style="padding: 12px; text-align: center; width: 100%;">Failed to load recent shots.</p>`;
    }
  }

  bus.on("shot-saved", async (payload) => {
    if (payload?.duplicate) return;
    const localShotId = payload?.localShotId;
    if (localShotId) {
      await upsertRecentShotCard(localShotId);
      return;
    }
    await withPreservedScroll(() => loadRecentShotsList());
  });

  let historyRefreshTimer = null;
  bus.on("shot-trace-saved", async (payload) => {
    clearTimeout(historyRefreshTimer);
    historyRefreshTimer = setTimeout(() => {
      if (el.historyList?.getClientRects().length && el.historyBulkActions?.classList.contains('hidden'))
        withPreservedScroll(() => loadShotHistoryList());
    }, 300);
    const localShotId = payload?.localShotId;
    if (localShotId) {
      await refreshRecentShotPreview(localShotId);
      await refreshHistoryShotPreview(localShotId);
    }
    const state = store.get();
    if (state.reviewMode && state.reviewShotId) {
      await refreshReviewCompareOptions(state.reviewShotId);
    }
  });

  bus.on("shot-trace-unavailable", async (payload) => {
    if (payload?.localShotId) {
      await refreshRecentShotPreview(payload.localShotId);
      await refreshHistoryShotPreview(payload.localShotId);
    }
  });

  // History list bulk select & delete feature
  function updateBulkSelectCount() {
    if (!el.historyList) return;
    el.historyList.querySelectorAll('.history-item-checkbox').forEach(chk => { chk.checked = selection.has(chk.dataset.shotId); });
    if (el.bulkSelectCount) el.bulkSelectCount.textContent = `${selection.size} selected across groups`;
    if (el.offlineCompareBtn) el.offlineCompareBtn.textContent = `Compare selected (${selection.size})`;
    el.historyDefaultActions?.classList.toggle('hidden', selection.size > 0 || selectionMode);
    el.historyBulkActions?.classList.toggle('hidden', selection.size === 0 && !selectionMode);
    for (const group of el.historyList.querySelectorAll('.session-group')) {
      const ids = [...group.querySelectorAll('.history-item-checkbox')].map(x => x.dataset.shotId);
      const count = ids.filter(id => selection.has(id)).length;
      group.querySelector('[data-group-selection]').textContent = `${count}/${ids.length} selected`;
      group.querySelector('[data-group-select]').textContent = count === ids.length ? 'Deselect group' : 'Select group';
    }
  }
  el.historySelectModeBtn?.addEventListener('click', () => {
    selectionMode = true; updateBulkSelectCount();
    el.offlineStatus.textContent = 'Use the checkboxes beside shots, or Select group. Selection spans groups; click Review to open a shot.';
  });
  el.bulkCancelBtn?.addEventListener('click', () => { selection.clear(); selectionMode = false; updateBulkSelectCount(); });
  el.bulkSelectAllBtn?.addEventListener('click', () => {
    const ids = [...el.historyList.querySelectorAll('.history-item-checkbox')].map(x => x.dataset.shotId);
    const all = ids.every(id => selection.has(id));
    for (const id of ids) { if (all) selection.delete(id); else selection.add(id); }
    updateBulkSelectCount();
  });

  if (el.bulkDeleteBtn) {
    el.bulkDeleteBtn.addEventListener("click", async () => {
      if (!el.historyList) return;
      const checkboxes = el.historyList.querySelectorAll(".history-item-checkbox");
      const selectedIds = Array.from(checkboxes)
        .filter((chk) => chk.checked)
        .map((chk) => chk.dataset.shotId);

      if (selectedIds.length === 0) {
        alert("No shots selected for deletion.");
        return;
      }

      const confirmed = confirm(
        `Delete ${selectedIds.length} selected shot${selectedIds.length > 1 ? "s" : ""}?\n\nThis cannot be undone.`,
      );
      if (!confirmed) return;

      try {
        bus.emit("log", `Bulk deleting ${selectedIds.length} shots...`);
        
        const state = store.get();
        let reviewClosed = false;
        let compareClosed = false;
        
        for (const shotId of selectedIds) {
          await purgeSyncQueueForShot(shotId);
          try {
            await remove("shot_traces", shotId);
          } catch (_) {}
          await remove("shots", shotId);

          try {
            const override = await get("session_overrides", shotId);
            if (override) await remove("session_overrides", shotId);
          } catch (_) {}

          if (state.reviewMode && state.reviewShotId === shotId) {
            reviewClosed = true;
          }
          if (state.compareShotId === shotId) {
            compareClosed = true;
          }
        }

        const updates = {};
        if (reviewClosed) {
          Object.assign(updates, {
            reviewMode: false,
            reviewShotId: null,
            reviewTrace: null,
            reviewMicSeries: null,
            reviewInfo: "",
            reviewRangeEst: "",
            reviewReleaseIdx: null,
            reviewReleaseTimeMs: null,
            reviewHitIdx: null,
            reviewHitTimeMs: null,
            replayActive: false,
            replayPaused: false,
            replayProgress: 1,
          });
        }
        if (compareClosed) {
          Object.assign(updates, {
            compareShotId: null,
            compareTrace: null,
            compareShotLabel: "",
            compareThresholdG: 12,
          });
          if (el.reviewCompareSelect) el.reviewCompareSelect.value = "";
        }
        if (Object.keys(updates).length > 0) store.set(updates);

        if (el.historyBulkActions) el.historyBulkActions.classList.add("hidden");
        if (el.historyDefaultActions) el.historyDefaultActions.classList.remove("hidden");
        
        await loadShotHistoryList();
        
        if (state.reviewMode && state.reviewShotId && !selectedIds.includes(state.reviewShotId)) {
          await refreshReviewCompareOptions(state.reviewShotId);
        }

        if (syncAdapter) syncAdapter.triggerSync();
        
        bus.emit("log", `Successfully deleted ${selectedIds.length} shots.`);
      } catch (error) {
        console.error("Bulk deletion failed:", error);
        alert(`Failed to delete shots: ${error.message}`);
      }
    });
  }

  // Redraw previews when the theme is cycled
  window.addEventListener("themechange", async () => {
    try {
      await loadRecentShotsList();
      await loadShotHistoryList();
    } catch (err) {
      console.error("Failed to reload shots lists on theme change:", err);
    }
  });

  return {
    loadShotHistoryList,
    loadRecentShotsList,
    withPreservedScroll,
    refreshReviewCompareOptions,
    refreshHistoryShotPreview,
    upsertRecentShotCard,
    reviewShotTrace,
    exportSingleShot,
    deleteSavedShot,
  };
}
