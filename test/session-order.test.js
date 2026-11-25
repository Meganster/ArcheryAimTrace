import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionOrder } from '../app/core/session-order.js';
import { buildSessionReview, buildSessionFloatPlot, buildSessionHoldPlot } from '../app/ui/session-review.js';
import { sessionTimelineHtml } from '../app/ui/session-timeline.js';
const shot = (id, extra = {}) => ({ id:`s${id}`, device_shot_id:id, device_id:'sensor', stored_upload:true,
  import_batch_id:'batch', device_boot_id:1, device_event_uptime_us:id*1000000,
  timestamp:new Date(1700000000000-id*1000).toISOString(), ...extra });
test('session order uses capture sequence instead of reversed import timestamps', () => {
  const order = sessionOrder([shot(205),shot(201),shot(203)],201);
  assert.deepEqual(order.entries.map(e=>e.number),[1,3,5]);
  assert.equal(order.missing,2);
  assert.deepEqual(order.gaps,[{from:202,to:202},{from:204,to:204}]);
  assert.equal(order.confirmed,true);
});
test('retained tail is not silently numbered from one and deletion does not compact numbering', () => {
  const tail = Array.from({length:80},(_,i)=>shot(221+i));
  const unknown = sessionOrder(tail);
  assert.equal(unknown.entries[0].number,221);
  assert.equal(unknown.confirmed,false);
  const known = sessionOrder(tail,201);
  assert.equal(known.entries[0].number,21);
  assert.equal(known.entries.at(-1).number,100);
  assert.equal(known.missing,20);
  assert.equal(sessionOrder(tail.slice(1),201).entries[0].number,22);
  assert.match(sessionTimelineHtml(tail,201),/session #1–20/);
});
test('counter reset, duplicate IDs, unknown batches and multiple devices cannot produce false session numbers', () => {
  for (const items of [[shot(50),shot(1,{device_boot_id:2})], [shot(1),shot(1)],
    [shot(1),shot(2,{device_id:'other'})], [shot(1,{device_boot_id:null,import_batch_id:null})]]) {
    assert.equal(sessionOrder(items,1).confirmed,false);
  }
  assert.equal(sessionOrder([shot(50),shot(51,{device_boot_id:2,device_event_uptime_us:1})],50).confirmed,true);
  assert.equal(sessionOrder([shot(5)],6).confirmed,false);
});
test('unscored offline shots remain in Session Review and drill counts; missing score is explicit', () => {
  const html = buildSessionReview([shot(1),shot(2)]);
  assert.match(html,/Session Review/);assert.match(html,/Shots by drill/);
  assert.match(html,/Offline · drill not recorded <strong>2/);
  assert.match(buildSessionFloatPlot([shot(1)]),/Float Score Trend/);
  assert.match(buildSessionFloatPlot([shot(1)]),/Unavailable/);
});
test('hold trends partition settings and skip missing or excluded shots without interpolating', () => {
  const a = { status:'calculated', version:1, parameters:{distanceMeters:18,referenceWindowMs:[-1500,-300]},metrics:{hold:{xStdDeg:0.03,yStdDeg:0.04}} };
  const html = buildSessionHoldPlot([shot(3,{offline_analysis:a}),shot(1,{offline_analysis:a}),shot(2),
    shot(4,{offline_analysis:{...a,parameters:{...a.parameters,distanceMeters:30}}})],1);
  assert.equal((html.match(/Hold Stability Trend/g)||[]).length,2);
  assert.match(html,/0.050° latest/);
  assert.match(html,/Session #1 · Device #1/);
  assert.doesNotMatch(html, /d="M [^"]* L /);
});

test('import group anchor stays stable when the oldest imported record is deleted', async () => {
  const { groupShotsByTime } = await import('../app/core/db.js');
  const shots = [shot(101),shot(102),shot(103)];
  const before = groupShotsByTime(shots)[0];
  const after = groupShotsByTime(shots.filter(s=>s.id !== before.legacyAnchorId))[0];
  assert.equal(before.anchorId,'import-batch');
  assert.equal(after.anchorId,before.anchorId);
});
