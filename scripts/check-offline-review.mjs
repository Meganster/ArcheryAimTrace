import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
try {
const page = await browser.newPage({viewport:{width:1400,height:1100}});
await page.addInitScript(() => { window.canvasLabels=[]; const fill=CanvasRenderingContext2D.prototype.fillText; CanvasRenderingContext2D.prototype.fillText=function(text,...args){window.canvasLabels.push(String(text));if(window.canvasLabels.length>5000)window.canvasLabels.splice(0,1000);return fill.call(this,text,...args)}; });
const errors=[]; page.on('pageerror', e=>errors.push(e.message));
await page.goto(process.env.BASE_URL || 'http://127.0.0.1:4178/', {waitUntil:'networkidle'});
await page.waitForFunction(()=>document.body.dataset.appBuild==='aim-pipeline-163');
await page.evaluate(async () => {
 const {put,getAll,remove} = await import('/app/core/db.js?v=aim-pipeline-163');
 for (const s of await getAll('shots')) { await remove('shot_traces',s.id); await remove('shots',s.id); }
 for(let j=0;j<3;j++) {
  const id=`test-offline-${j}`, payload=[];
  for(let ms=-3000;ms<=1500;ms+=20) payload.push({tUs:ms*1000,roll:90+0.1*Math.sin(ms/300),pitch:-0.3*Math.cos(ms/300),yaw:80+0.3*Math.sin(ms/200),yawAvailable:true,accelAvailable:false,micAmp:ms===0?100:1,detectorEvent:ms===0});
  await put('shots',{id,device_id:'test',device_shot_id:j,stored_upload:true,imported_at:'2026-10-21T12:00:00Z',timestamp:'2026-10-21T12:00:00Z',timestamp_kind:'imported',import_batch_id:'test',device_boot_id:1,device_event_uptime_us:1000000+j*30000000,device_time_source:'device-processing-uptime',peak_g:15,trace_status:'saved'});
  await put('shot_traces',{shot_id:id,source:'firmware',payload,sample_rate_hz:50,raw:{bytes:[j,2,3]},timing:j===2?{}:{version:3,samplePeriodUs:20000,sampleRateSource:'configured-odr',mountProfile:2,releaseIndex:150,completeness:'complete'}});
 }
});
await page.locator('#navHistoryBtn').click();
await page.locator('.history-tools > summary').click();
await page.locator('#offlineDistance').fill('30'); await page.locator('#offlineFace').fill('80'); await page.locator('#offlineFace').blur();
await page.locator('#historySelectModeBtn').click(); await page.locator('#bulkSelectAllBtn').click();
await page.locator('#offlineAnalyzeBtn').click();
await page.waitForFunction(()=>document.getElementById('offlineStatus').textContent.includes('2 usable, 1 excluded'));
await page.waitForFunction(()=>document.getElementById('historyList').textContent.includes('30 m / 80 cm'));
assert.match(await page.locator('#historyList').textContent(), /30 m \/ 80 cm/);
await page.locator('#offlineSuggestBtn').click();
await page.waitForFunction(()=>document.getElementById('offlineStatus').textContent.includes('1 suggested series'));
await page.locator('#offlineSeriesName').fill('Fixture series'); await page.locator('#offlineGroupBtn').click();
await page.waitForFunction(()=>document.getElementById('offlineStatus').textContent.includes('Grouped 3'));
await page.screenshot({path:join(tmpdir(), 'openfloat-history144.png'),fullPage:true});
await page.locator('#bulkCancelBtn').click();
await page.locator('.history-item[data-shot-id="test-offline-0"]').click();
await page.waitForTimeout(300);
await page.screenshot({path:join(tmpdir(), 'openfloat-target144.png'),fullPage:true});
assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'review must not expand viewport');
assert.match(await page.locator('#targetFaceLabel').textContent(), /30m.*80 cm.*saved geometry/);
assert.equal(await page.locator('#targetDistanceSelect').isDisabled(),true);
const saved = await page.evaluate(async()=>{
 const {get,getAll}=await import('/app/core/db.js?v=aim-pipeline-163');
 const trace=await get('shot_traces','test-offline-0'); const shots=await getAll('shots');
 return {raw:trace.raw,payloadHasAim:trace.payload.some(p=>p.aim),analysis:trace.analysis.status,distance:trace.analysis.parameters.distanceMeters,series:new Set(shots.map(s=>s.offline_series_id)).size,settings:JSON.parse(localStorage.getItem('openfloat_settings')).offlineAnalysisParameters};
});
assert.deepEqual(saved.raw,{bytes:[0,2,3]});assert.equal(saved.payloadHasAim,false);assert.equal(saved.analysis,'calculated');assert.equal(saved.distance,30);assert.equal(saved.series,1);assert.equal(saved.settings.distanceMeters,30);
await page.locator('#targetViewModeSelect').selectOption('normalized');
await page.waitForFunction(()=>window.canvasLabels.some(s=>s.includes('Normalized shape only')));
await page.locator('#viewTraceBtn').click();
await page.waitForFunction(()=>window.canvasLabels.some(s=>s.includes('Reference -1500')) && window.canvasLabels.includes('DETECTOR'));
await page.screenshot({path:join(tmpdir(), 'openfloat-angles144.png'),fullPage:true});
assert.deepEqual(errors,[]);
console.log(JSON.stringify({saved,errors,reviewText:(await page.locator('body').innerText()).includes('Relative to mean pre-shot aim')}));
} finally {await browser.close();}
