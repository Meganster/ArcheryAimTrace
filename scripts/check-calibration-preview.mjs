import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, serviceWorkers: 'block' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Expose only this isolated browser's store so live and recorded attitudes can
  // deliberately disagree; no test hooks are added to the production app.
  const source = await readFile(new URL('../app/core/store.js', import.meta.url), 'utf8');
  const needle = 'return {\n    get: () => state,';
  assert.ok(source.includes(needle));
  await page.route('**/app/core/store.js*', route => route.fulfill({
    contentType: 'application/javascript', body: source.replace(needle, 'return globalThis.__calibrationTestStore = {\n    get: () => state,'),
  }));
  await page.goto(process.env.BASE_URL || 'http://127.0.0.1:4180', { waitUntil: 'networkidle' });
  await page.locator('#navSettingsBtn').click();
  await page.locator('#navCalibrationBtn').click();
  await page.waitForFunction(() => {
    const c = document.getElementById('calibrationOrientationCanvas');
    return c.width > 300 && c.height > 200 && c.getContext('webgl2');
  });
  await page.evaluate(() => globalThis.__calibrationTestStore.set({
    roll: 20, pitch: 10, yaw: -40, cantOffset: 5, pitchOffset: 2, yawOffset: 10,
    levelRange: 30, levelTolerance: 2, reviewMode: true, replayProgress: 1,
    reviewTrace: [{ roll: -70, pitch: -30, yaw: 95 }],
  }));
  const read = id => page.locator(`#${id}`).textContent();
  assert.equal(await read('calibrationOrientationRollValue'), '15.0');
  assert.equal(await read('calibrationOrientationPitchValue'), '8.0');
  assert.equal(await read('calibrationOrientationYawValue'), '-50.0');
  assert.equal(await read('calibrationCantValue'), '15.0');
  assert.equal(await read('calibrationLevelAlertText'), 'right cant');
  assert.equal(await read('orientationRollValue'), '-75.0', 'Dashboard still reviews the recorded pose');
  const bubbleRight = await page.locator('#calibrationLevelBubble').evaluate(e => parseFloat(e.style.left));
  assert.equal(bubbleRight, 71);
  await page.evaluate(() => globalThis.__calibrationTestStore.set({ cantOffset: 20, pitchOffset: 10, yawOffset: -40 }));
  for (const id of ['calibrationOrientationRollValue', 'calibrationOrientationPitchValue', 'calibrationOrientationYawValue', 'calibrationCantValue']) {
    assert.equal(await read(id), '0.0', 'zero immediately updates both calibration displays');
  }
  assert.equal(await read('calibrationLevelAlertText'), 'Level');
  await page.evaluate(() => globalThis.__calibrationTestStore.set({ reviewMode: false, reviewTrace: null }));
  await page.locator('#navSettingsGeneralBtn').click();
  await page.locator('#demoBtn').click();
  await page.locator('#navCalibrationBtn').click();
  const before = await read('calibrationOrientationPitchValue');
  await page.waitForFunction(before => document.getElementById('calibrationOrientationPitchValue').textContent !== before, before);
  assert.ok(await page.evaluate(() => Math.abs(Number(document.getElementById('cantValue').textContent) - Number(document.getElementById('calibrationCantValue').textContent)) <= 0.1), 'live cant agrees with Dashboard');
  assert.ok(await page.evaluate(() => document.getElementById('calibrationOrientationPitchValue').textContent === document.getElementById('orientationPitchValue').textContent));
  // Demo deliberately disables device-zero commands; offset response was checked above.
  assert.ok(await page.locator('#zeroBtn').isDisabled());
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(tmpdir(), 'archeryaimtrace-calibration-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile preview fits');
  assert.ok(await page.locator('#calibrationOrientationCanvas').isVisible());
  await page.screenshot({ path: join(tmpdir(), 'archeryaimtrace-calibration-mobile.png') });
  await page.locator('#navDashboardBtn').click();
  assert.ok(await page.locator('#orientationCanvas').isVisible());
  await page.locator('#navSettingsBtn').click();
  assert.ok(await page.locator('#calibrationOrientationCanvas').isVisible());
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ livePreview: true, reviewIsolation: true, zeroOffsets: true, cantMatchesDashboard: true, mobile: true, errors }));
} finally { await browser.close(); }
