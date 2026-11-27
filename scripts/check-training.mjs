import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  const base = process.env.BASE_URL || 'http://127.0.0.1:4180';
  await page.route(`${base}/`, route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`${base}/`);
  await page.evaluate(async () => {
    document.querySelectorAll('.tab-view').forEach(e => e.classList.add('hidden-view'));
    document.getElementById('tabTraining').classList.remove('hidden-view');
    const { createStore, EventBus } = await import('/app/core/store.js');
    const { mountTraining } = await import('/app/ui/training.js?v=aim-pipeline-164');
    let now = 0, nextId = 0;
    const intervals = new Map(), frames = new Map();
    Object.defineProperty(performance, 'now', { value: () => now });
    window.setInterval = (fn, ms) => { const id = ++nextId; intervals.set(id, { fn, ms, next: now + ms }); return id; };
    window.clearInterval = id => intervals.delete(id);
    window.requestAnimationFrame = fn => { const id = ++nextId; frames.set(id, fn); return id; };
    window.cancelAnimationFrame = id => frames.delete(id);
    window.cues = [];
    let audioContexts = 0;
    window.AudioContext = class {
      constructor() { audioContexts++; this.state = 'suspended'; }
      get currentTime() { return now / 1000; }
      async resume() { this.state = 'running'; }
      createGain() { return { connect() {}, disconnect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
      createOscillator() { return { frequency: { value: 0 }, connect() {}, disconnect() {},
        start() { cues.push({ at: now, frequency: this.frequency.value }); }, stop() { this.onended?.(); } }; }
    };
    const store = createStore({ connected: true, statusMode: 'live', roll: 0, pitch: 0, yaw: 0,
      cantOffset: 0, levelTolerance: 2, targetViewMode: 'normalized', targetDistanceM: 18, sample: {} });
    const bus = new EventBus();
    const el = Object.fromEntries([...document.querySelectorAll('[id]')].map(e => [e.id, e]));
    mountTraining({ store, el, bus });
    window.fixture = { store, audioContexts: () => audioContexts,
      advance(ms) {
        const end = now + ms;
        while (now < end) {
          now = Math.min(end, now + 50);
          bus.emit('sample', { azMg: 1000 });
          for (const [id, timer] of [...intervals]) {
            if (intervals.has(id) && now >= timer.next) { timer.next += timer.ms; timer.fn(); }
          }
          for (const [id, fn] of [...frames]) { frames.delete(id); fn(); }
        }
      },
      suspend(ms) { now += ms; for (const timer of [...intervals.values()]) timer.fn(); },
    };
  });
  const advance = ms => page.evaluate(ms => fixture.advance(ms), ms);
  const progress = () => page.locator('#trainingProgress').textContent();
  const waitSaved = count => page.waitForFunction(count =>
    document.getElementById('trainingSaveStatus').textContent === `${count} / ${count} holds saved`, count, { polling: 50 });
  const counts = () => page.evaluate(async () => {
    const db = await import('/app/core/db.js?v=aim-pipeline-164');
    return [ (await db.getAll('shots')).length, (await db.getAll('shot_traces')).length,
      (await db.getAll('sync_queue')).length ];
  });
  await page.locator('#startTrainingBtn').click();
  await page.waitForFunction(() => cues.length === 1, null, { polling: 50 });
  assert.equal(await page.locator('#trainingCountdownVal').textContent(), '7');
  await advance(7000);
  assert.equal(await page.locator('#trainingHoldTimerBadge').textContent(), 'Hold · 3.0s');
  await advance(3000);
  assert.match(await page.locator('#trainingPhaseLabel').textContent(), /Relax/);
  await waitSaved(1);
  assert.deepEqual(await counts(), [1, 1, 2]); // Saved during set, without Save.
  assert.equal(await page.locator('#trainingResultsCard').isVisible(), false);
  assert.deepEqual(await page.evaluate(() => cues.slice(0, 3)), [
    { at: 0, frequency: 440 }, { at: 7000, frequency: 880 }, { at: 10000, frequency: 660 },
  ]);
  await advance(3000);
  assert.match(await progress(), /Rep 2 \/ 10/);
  await advance(114000);
  assert.match(await page.locator('#trainingPhaseLabel').textContent(), /next: set 2/);
  assert.equal(await page.locator('#trainingCountdownVal').textContent(), '2:00');
  await page.locator('#tabTraining').screenshot({ style: "header { position: static !important; }", path: join(tmpdir(), 'openfloat-training157-rest.png') });
  await advance(120000);
  assert.match(await progress(), /Set 2 \/ 3 · Rep 1 \/ 10/);
  await advance(374000);
  assert.match(await progress(), /30 \/ 30 completed · 30 holds recorded/);
  const cues = await page.evaluate(() => window.cues);
  assert.equal(cues.length, 90);
  for (let i = 0; i < 30; i++) {
    assert.deepEqual(cues.slice(i * 3, i * 3 + 3).map(c => c.frequency), [440, 880, 660]);
    assert.equal(cues[i * 3 + 1].at - cues[i * 3].at, 7000);
    assert.equal(cues[i * 3 + 2].at - cues[i * 3 + 1].at, 3000);
  }
  assert.equal(await page.evaluate(() => fixture.audioContexts()), 1);
  await waitSaved(30);
  assert.equal(await page.locator('#saveTrainingShotBtn').isVisible(), false);
  await page.locator('#discardTrainingShotBtn').click();
  await page.waitForFunction(() => !document.getElementById('trainingDisplayDefault').classList.contains('hidden'), null, { polling: 50 });
  const saved = await page.evaluate(async () => {
    const db = await import('/app/core/db.js?v=aim-pipeline-164');
    return { shots: await db.getAll('shots'), traces: await db.getAll('shot_traces') };
  });
  assert.equal(saved.shots.length, 30);
  assert.equal(new Set(saved.shots.map(s => s.label)).size, 30);
  assert.equal(saved.traces.length, 30);
  for (const trace of saved.traces) {
    assert.ok(trace.payload.length >= 5);
    assert.ok(trace.payload.at(-1).tUs < 3000000);
    assert.ok(trace.payload.every(p => p.releaseTimingAvailable === false));
  }
  // Cancellation preserves completed holds, drops partial ones and stops cues.
  await page.locator('#startTrainingBtn').click();
  await page.waitForFunction(() => cues.length === 91, null, { polling: 50 });
  await advance(18000);
  await page.locator('#cancelTrainingBtn').click();
  assert.match(await progress(), /1 \/ 30 completed · 1 holds recorded/);
  const cueCount = await page.evaluate(() => cues.length);
  await advance(20000);
  assert.equal(await page.evaluate(() => cues.length), cueCount);
  await waitSaved(1);
  await page.locator('#discardTrainingShotBtn').click();
  await page.locator('#startTrainingBtn').click();
  await page.waitForFunction(() => document.getElementById('trainingPhaseLabel').textContent.includes('Draw'), null, { polling: 50 });
  await advance(18000); // One complete hold and part of the next.
  await waitSaved(1);
  await page.evaluate(() => fixture.store.set({ connected: false }));
  assert.match(await progress(), /Sensor disconnected/);
  assert.deepEqual(await counts(), [32, 32, 64]);
  await page.locator('#discardTrainingShotBtn').click();
  assert.equal(await page.locator('#startTrainingBtn').isDisabled(), true);
  await page.evaluate(() => fixture.store.set({ connected: true }));
  await page.locator('#startTrainingBtn').click();
  await page.waitForFunction(() => !document.getElementById('trainingDisplayActive').classList.contains('hidden'), null, { polling: 50 });
  await page.evaluate(() => fixture.suspend(30000));
  assert.match(await progress(), /Timer interrupted/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#discardTrainingShotBtn').click();
  await page.locator('#tabTraining').screenshot({ style: "header { position: static !important; }", path: join(tmpdir(), 'openfloat-training157-mobile.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  // Custom program, validation, immutable settings, pause/resume and saving.
  const setField = (key, value) => page.locator(`#training_${key}`).fill(String(value));
  await setField('holdSeconds', '');
  await page.locator('#startTrainingBtn').click();
  assert.equal(await page.locator('#cancelTrainingBtn').isVisible(), false);
  for (const [key, value] of Object.entries({ sets: 2, reps: 2, drawSeconds: 2, holdSeconds: 4, repRestSeconds: 3, setRestSeconds: 5 })) await setField(key, value);
  assert.match(await progress(), /2 sets × 2 reps · 0 min 35 sec/);
  await page.locator('#startTrainingBtn').click();
  await page.waitForFunction(() => !document.getElementById('pauseTrainingBtn').classList.contains('hidden'), null, { polling: 50 });
  assert.equal(await page.locator('#training_holdSeconds').isDisabled(), true);
  await advance(1000);
  await page.locator('#pauseTrainingBtn').click();
  assert.match(await page.locator('#trainingPhaseLabel').textContent(), /Paused/);
  const pausedCues = await page.evaluate(() => cues.length);
  await advance(600000);
  assert.equal(await page.evaluate(() => cues.length), pausedCues);
  await page.locator('#pauseTrainingBtn').click();
  await page.waitForFunction(() => document.getElementById('pauseTrainingBtn').textContent === 'Pause', null, { polling: 50 });
  assert.equal(await page.locator('#trainingCountdownVal').textContent(), '2');
  await advance(3000); // Draw + one second of hold.
  await page.locator('#pauseTrainingBtn').click();
  await advance(60000);
  await page.locator('#pauseTrainingBtn').click();
  await page.waitForFunction(() => document.getElementById('pauseTrainingBtn').textContent === 'Pause', null, { polling: 50 });
  await advance(6000); // Full redraw + full hold, partial hold discarded.
  assert.match(await progress(), /1 \/ 4 completed/);
  await advance(1000);
  await page.locator('#pauseTrainingBtn').click();
  assert.equal(await page.locator('#trainingCountdownVal').textContent(), '2');
  await advance(60000);
  await page.locator('#pauseTrainingBtn').click();
  await page.waitForFunction(() => document.getElementById('pauseTrainingBtn').textContent === 'Pause', null, { polling: 50 });
  await advance(2000);
  assert.match(await progress(), /Rep 2 \/ 2/);
  for (let i = 0; i < 30 && !(await page.locator('#trainingResultsCard').isVisible()); i++) await advance(1000);
  assert.match(await progress(), /4 \/ 4 completed · 4 holds recorded/);
  await waitSaved(4);
  await page.locator('#discardTrainingShotBtn').click();
  await page.waitForFunction(() => !document.getElementById('trainingDisplayDefault').classList.contains('hidden'), null, { polling: 50 });
  const customShots = await page.evaluate(async () => (await (await import('/app/core/db.js?v=aim-pipeline-164')).getAll('shots')).filter(s => s.label.endsWith('4s')));
  assert.equal(customShots.length, 4);
  assert.ok(customShots.every(s => /Set [12]\/2 · Rep [12]\/2/.test(s.label)));
  assert.equal(await page.locator('#training_holdSeconds').isDisabled(), false);
  assert.equal(await page.locator('#training_holdSeconds').inputValue(), '4');
  await page.locator('#tabTraining').screenshot({ style: "header { position: static !important; }", path: join(tmpdir(), 'openfloat-training158-options.png') });
  // Storage failure is visible, retry works, and repeated requests are idempotent.
  await page.evaluate(async () => {
    const db = await (await import('/app/core/db.js?v=aim-pipeline-164')).initDb();
    window.originalTransaction = db.transaction;
    db.transaction = function (stores, mode, ...args) {
      if (mode === 'readwrite') throw new DOMException('Test quota exhausted', 'QuotaExceededError');
      return originalTransaction.call(this, stores, mode, ...args);
    };
  });
  await page.locator('#startTrainingBtn').click();
  await page.waitForFunction(() => document.getElementById('pauseTrainingBtn').textContent === 'Pause', null, { polling: 50 });
  await advance(6000);
  await page.waitForFunction(() => document.getElementById('trainingSaveStatus').textContent.includes('1 not saved'), null, { polling: 50 });
  assert.deepEqual(await counts(), [36, 36, 72]);
  await page.locator('#cancelTrainingBtn').click();
  await page.waitForFunction(() => !document.getElementById('saveTrainingShotBtn').disabled, null, { polling: 50 });
  assert.equal(await page.locator('#saveTrainingShotBtn').isVisible(), true);
  await page.evaluate(async () => {
    const db = await (await import('/app/core/db.js?v=aim-pipeline-164')).initDb();
    db.transaction = originalTransaction;
  });
  await page.locator('#saveTrainingShotBtn').click();
  await waitSaved(1);
  assert.deepEqual(await counts(), [37, 37, 74]);
  const atomic = await page.evaluate(async () => {
    const db = await import('/app/core/db.js?v=aim-pipeline-164');
    let aborted = false;
    try { await db.saveShotWithTrace({ id: 'atomic-test' }, { shot_id: 'atomic-test', payload: () => {} }); }
    catch (error) { aborted = error.name === 'DataCloneError'; }
    const missing = !(await db.get('shots', 'atomic-test')) && !(await db.get('shot_traces', 'atomic-test'));
    const queueBefore = (await db.getAll('sync_queue')).length;
    const shot = { id: 'atomic-test' }, trace = { shot_id: 'atomic-test', payload: [] };
    await Promise.all([db.saveShotWithTrace(shot, trace), db.saveShotWithTrace(shot, trace)]);
    return { aborted, missing, queueBefore, queueAfter: (await db.getAll('sync_queue')).length };
  });
  assert.deepEqual(atomic, { aborted: true, missing: true, queueBefore: 74, queueAfter: 76 });
  await page.locator('#discardTrainingShotBtn').click();
  await page.reload();
  assert.deepEqual(await counts(), [38, 38, 76]); // Survives a new page context.
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ fullProgram: true, cues: 90, savedHolds: 30, autosave: true, retry: true, atomicRollback: true, reload: true, cancel: true, disconnect: true, suspension: true, mobile: true, errors }));
} finally { await browser.close(); }
