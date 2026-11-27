import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const base = process.env.BASE_URL || 'http://127.0.0.1:4180';
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  await page.route(`${base}/`, route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`${base}/`);
  await page.evaluate(async () => {
    document.querySelectorAll('.tab-view').forEach(e => e.classList.add('hidden-view'));
    document.getElementById('tabHistory').classList.remove('hidden-view');
    const db = await import('/app/core/db.js?v=aim-pipeline-164');
    for (const [id, time] of [['a', '12:00'], ['b', '12:01'], ['c', '16:00']]) {
      await db.put('shots', { id, timestamp: `2026-11-25T${time}:00Z`, label: id, shot_score: 80 });
      await db.put('shot_traces', { shot_id: id, sample_rate_hz: 50, payload: [] });
    }
    await db.put('session_overrides', { id: 'a', name: 'Delete this session' });
    await db.put('session_overrides', { id: 'c', name: 'Keep this session' });
    await db.put('sync_queue', { targetId: 'a' });
    await db.put('sync_queue', { payload: { shot_id: 'b' } });
    await db.put('sync_queue', { payload: { id: 'a' } });
    await db.put('sync_queue', { targetId: 'c' });
    // Force an abort and verify no partial deletion before exercising the UI.
    const transact = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = transact.apply(this, args);
      if (Array.isArray(args[0]) && args[0].includes('sync_queue')) queueMicrotask(() => tx.abort());
      return tx;
    };
    let aborted = false;
    try { await db.deleteShotRecords(['a', 'b'], ['a']); } catch { aborted = true; }
    finally { IDBDatabase.prototype.transaction = transact; }
    if (!aborted || (await db.getAll('shots')).length !== 3 || (await db.getAll('shot_traces')).length !== 3 || (await db.getAll('sync_queue')).length !== 4) throw Error('Atomic rollback failed');
    const { createStore, EventBus } = await import('/app/core/store.js');
    const { initHistory } = await import('/app/ui/history.js?v=aim-pipeline-164');
    const store = createStore({ reviewMode: false, connected: false, recentShots: [], threshold: 12 });
    const el = Object.fromEntries([...document.querySelectorAll('[id]')].map(e => [e.id, e]));
    const history = initHistory({ store, state: store.get(), bus: new EventBus(), el, selectViewTab() {}, saveSettingsToCache() {} });
    window.fixture = { store, history, db };
    await history.loadShotHistoryList();
  });
  const group = page.locator('.session-group[data-group-id="a"]');
  const wasCollapsed = await group.evaluate(e => e.classList.contains('collapsed'));
  await group.locator('[data-session-more]').click();
  assert.equal(await group.evaluate(e => e.classList.contains('collapsed')), wasCollapsed);
  assert.equal(await group.locator('[data-session-delete]').isVisible(), true);
  page.once('dialog', dialog => dialog.dismiss());
  await group.locator('[data-session-delete]').click();
  assert.equal(await page.evaluate(async () => (await fixture.db.getAll('shots')).length), 3);
  await page.evaluate(() => fixture.store.set({ reviewMode: true, reviewShotId: 'a', compareShotId: 'b', replayActive: true }));
  page.once('dialog', async dialog => {
    assert.match(dialog.message(), /Delete this session.*all 2 saved shots/s);
    await dialog.accept();
  });
  await group.locator('[data-session-delete]').click();
  await page.waitForFunction(() => !document.querySelector('.session-group[data-group-id="a"]'));
  const remaining = await page.evaluate(async () => ({
    shots: await fixture.db.getAll('shots'), traces: await fixture.db.getAll('shot_traces'),
    overrides: await fixture.db.getAll('session_overrides'), queue: await fixture.db.getAll('sync_queue'), state: fixture.store.get(),
  }));
  assert.deepEqual(remaining.shots.map(s => s.id), ['c']);
  assert.deepEqual(remaining.traces.map(s => s.shot_id), ['c']);
  assert.deepEqual(remaining.overrides.map(s => s.id), ['c']);
  assert.equal(remaining.queue.length, 1);
  assert.equal(remaining.queue[0].targetId, 'c');
  assert.equal(remaining.state.reviewMode, false);
  assert.equal(remaining.state.compareShotId, null);
  assert.equal(remaining.state.replayActive, false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-session-more]').click();
  await page.locator('.session-group').screenshot({ style: "header { position: static !important; }", path: join(tmpdir(), 'openfloat-session158-more.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cancel: true, sessionOnly: true, traces: true, metadata: true, pendingUploads: true, reviewClosed: true, atomicRollback: true, mobile: true, errors }));
} finally { await browser.close(); }
