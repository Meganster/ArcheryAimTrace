import test from 'node:test';
import assert from 'node:assert/strict';
import { computeOfflineScore, offlinePeerComparison, OFFLINE_SCORE_VERSION } from '../app/telemetry/offline-score.js';
import { analyzeOfflineTrace, offlineShotSummary, withOfflineAnalysis } from '../app/telemetry/offline-aim.js';
import { offlineScoreReport, offlineSessionScoresHtml } from '../app/ui/offline-score.js';
const parameters = {referenceWindowMs:[-1500,-300],preWindowMs:[-300,0],postWindowMs:[100,1000],distanceMeters:18,faceDiameterCm:40};
const metrics = () => ({hold:{xStdDeg:0,yStdDeg:0,cantStdDeg:0},pre:{xStdDeg:0,yStdDeg:0,deltaXDeg:0,deltaYDeg:0},post:{deltaXDeg:0,deltaYDeg:0}});
const calculate = (modify = ()=>{}, params = {}) => {
  const m=metrics();modify(m);
  const a={status:'calculated',version:1,parameters:{...parameters,...params},result:{metrics:m}};
  return {...a,score:computeOfflineScore(a)};
};
const record = (fn=()=>({}),end=1500) => {
  const payload=[];
  for(let ms=-3000;ms<=end;ms+=20)payload.push({tUs:ms*1000,roll:0,pitch:0,yaw:0,yawAvailable:true,accelAvailable:false,...fn(ms)});
  return {source:'firmware',shot_id:'raw',raw:{bytes:[1,2,3]},payload,timing:{version:3,mountProfile:2,releaseIndex:150,samplePeriodUs:20000,completeness:'complete'}};
};
test('offline score has fixed anchors and weights; perfect angles do not force an issue',()=>{
  const perfect=calculate().score;
  assert.equal(perfect.total,100);assert.equal(perfect.issue,null);
  const anchors=calculate(m=>{m.hold.xStdDeg=.15;m.hold.cantStdDeg=.5;m.pre.deltaXDeg=.3;}).score;
  assert.equal(anchors.total,50);
  assert.deepEqual(Object.values(anchors.components).map(c=>c.score),[50,50,50]);
  assert.equal(anchors.issue.key,'hold');assert.equal(anchors.issue.weightedLoss,25);
});
test('more measured motion reduces scores and issues identify movement, not inferred technique',()=>{
  const values=[0,.05,.15,.30,1].map(x=>calculate(m=>{m.hold.yStdDeg=x;}).score.components.hold.score);
  assert.ok(values.every((v,i)=>!i||v<values[i-1]));
  assert.match(calculate(m=>{m.hold.yStdDeg=.5;}).score.issue.label,/Vertical hold/);
  assert.match(calculate(m=>{m.pre.deltaXDeg=-1;}).score.issue.label,/left before detector/);
  assert.match(calculate(m=>{m.pre.xStdDeg=1;}).score.issue.label,/oscillates/);
  assert.match(calculate(m=>{m.hold.cantStdDeg=2;}).score.issue.label,/Cant changes/);
});
test('missing and nonfinite components cannot become zero or a complete inflated score',()=>{
  for(const mutate of [m=>m.pre=null,m=>m.hold.xStdDeg=NaN,m=>m.hold.cantStdDeg=-1,m=>m.pre.deltaYDeg=Infinity]){
    const s=calculate(mutate).score;
    assert.equal(s.status,'partial');assert.equal(s.total,null);assert.ok(s.reasons.length);
  }
  assert.equal(computeOfflineScore({status:'not_calculated',reasons:['data_gap']}).total,null);
  assert.deepEqual(computeOfflineScore(null).reasons,['analysis_not_calculated']);
});
test('after-detector movement is descriptive and missing post does not change the total',()=>{
  const full=calculate(m=>{m.hold.xStdDeg=.2;}).score;
  const large=calculate(m=>{m.hold.xStdDeg=.2;m.post.deltaYDeg=-60;}).score;
  const none=calculate(m=>{m.hold.xStdDeg=.2;m.post=null;}).score;
  assert.equal(full.total,large.total);assert.equal(full.total,none.total);
  assert.match(large.post.description,/not penalized/);assert.equal(none.post,null);
});
test('real trace scoring preserves originals and is invariant to distance, heading wrap and constant cant',()=>{
  const fn=ms=>({yaw:179.99+Math.sin(ms/200)*.1,pitch:.08*Math.cos(ms/300),roll:179.9});
  const r=record(fn), original=structuredClone(r), next=withOfflineAnalysis(r);
  const distant=analyzeOfflineTrace(r,{distanceMeters:70,faceDiameterCm:122});
  const rotated=analyzeOfflineTrace(record(ms=>{const p=fn(ms);return {...p,yaw:p.yaw-180,roll:-25};}));
  assert.deepEqual(r,original);assert.deepEqual(next.payload,original.payload);assert.deepEqual(next.raw,original.raw);
  assert.equal(next.analysis.score.total,distant.score.total);
  assert.equal(next.analysis.score.total,rotated.score.total);
  assert.equal(next.analysis.score.components.cant.score,100);
  const summary=offlineShotSummary(next.analysis);
  assert.deepEqual(summary.offline_analysis.score,next.analysis.score);
  assert.equal(summary.shot_score,null,'legacy Float Score remains separate');
  assert.deepEqual(withOfflineAnalysis(next).analysis.score,next.analysis.score);
});
test('peer comparison excludes incomplete scores, other versions and other analysis windows',()=>{
  const a=calculate(m=>{m.hold.xStdDeg=.2;}), b=calculate();
  const other=calculate(()=>{},{referenceWindowMs:[-1000,-500]});
  const partial=calculate(m=>{m.pre=null;});
  const old={...b,score:{...b.score,version:'future'}};
  assert.equal(offlinePeerComparison(a,[other,partial,old]),null);
  const comparison=offlinePeerComparison(a,[b,other,partial,old]);
  assert.equal(comparison.count,1);assert.equal(comparison.mean,100);assert.equal(comparison.difference,a.score.total-100);
});
test('reports expose score evidence, partial assessment and separate session trends without formulas',()=>{
  const a=calculate(m=>{m.pre.deltaYDeg=1;}), b=calculate(()=>{},{distanceMeters:30});
  const html=offlineScoreReport(a,{count:2,mean:90,difference:a.score.total-90},{windowButtons:true});
  assert.match(html,/Main issue.*up before detector/);assert.match(html,/data-score-window/);
  assert.match(html,/Other comparable shots.*2/);assert.doesNotMatch(html,/How the score is calculated|100 \/ \(1|√|Weights:/);
  assert.match(html,/<details class="score-measurements">/);
  const shot=(id,analysis)=>({id:String(id),device_shot_id:id,device_id:'a',import_batch_id:'b',stored_upload:true,offline_analysis:analysis});
  const session=offlineSessionScoresHtml([shot(1,a),shot(3,a),shot(4,b)],1);
  assert.equal((session.match(/Offline Motion Score Trend/g)||[]).length,2);
  assert.match(session,/Recurring issues/);assert.match(session,/Session #1/);
  assert.doesNotMatch(session,/d="M [^"]* L /,'missing numbers are not connected');
  assert.match(offlineScoreReport(calculate(m=>m.pre=null)),/Incomplete/);
  assert.equal(a.score.version,OFFLINE_SCORE_VERSION);
});
