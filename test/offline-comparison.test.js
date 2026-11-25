import test from 'node:test';
import assert from 'node:assert/strict';
import { withOfflineAnalysis } from '../app/telemetry/offline-aim.js';
import { buildOfflineComparison, comparisonGroupMetrics, comparisonPoints } from '../app/telemetry/offline-comparison.js';
import { drawOfflineComparison } from '../app/ui/offline-comparison.js';
function entry(id, group, distance=18, end=1500) {
 const payload=[];
 for(let ms=-3000;ms<=end;ms+=20) payload.push({tUs:ms*1000,roll:0,pitch:ms/10000,yaw:ms/10000,yawAvailable:true,detectorEvent:ms===0});
 const trace=withOfflineAnalysis({shot_id:id,source:'firmware',raw:{bytes:[1]},payload,timing:{version:3,mountProfile:2,releaseIndex:150,samplePeriodUs:20000,completeness:'complete'}},{distanceMeters:distance});
 return {shot:{id,device_shot_id:id},trace,groupId:group,groupName:group};
}
test('cross-group comparison uses trace analysis and splits incompatible geometry without mutating groups',()=>{
 const entries=[entry('a','One'),entry('b','Two'),entry('c','Two',30),{shot:{id:'d'},groupId:'Three'}];
 const before=structuredClone(entries), m=buildOfflineComparison([...entries,entries[0]]);
 assert.equal(m.total,4);assert.equal(m.cohorts.length,2);assert.equal(m.excluded.length,1);
 assert.deepEqual(m.cohorts[0].entries.map(e=>e.groupName),['One','Two']);
 assert.deepEqual(entries,before);
});
test('group metrics count only complete windows and never treat a missing post window as zero',()=>{
 const m=buildOfflineComparison([entry('a','One'),entry('b','One',18,0)]);
 const hold=comparisonGroupMetrics(m.cohorts[0],'hold'), post=comparisonGroupMetrics(m.cohorts[0],'post');
 assert.equal(hold[0].usable,2);assert.equal(post[0].usable,1);assert.equal(post[0].total,2);
 assert.equal(post[0].metrics.xStdDeg,m.cohorts[0].entries[0].analysis.result.metrics.post.xStdDeg);
 assert.equal(comparisonPoints(m.cohorts[0].entries[1],'post').length,0);
 assert.ok(comparisonPoints(m.cohorts[0].entries[1],'full').length>0);
});
test('group overlay preserves equal physical scaling, separates windows and omits missing samples',()=>{
 const m=buildOfflineComparison([entry('a','One'),entry('b','Two')]);
 const strokes=[];const labels=[];let current=[];
 const ctx=new Proxy({measureText:()=>({width:100}),fillText:(s)=>labels.push(s),beginPath:()=>{current=[];},moveTo:(...p)=>current.push(p),lineTo:(...p)=>current.push(p),stroke(){if(current.length===2)strokes.push({color:this.strokeStyle,points:current});}}, {get:(o,k)=>k in o?o[k]:()=>{}});
 drawOfflineComparison(ctx,m.cohorts[0],{width:700,height:500,phase:'hold',mode:'fit',colorForGroup:g=>g});
 const first=strokes.filter(s=>s.color==='One'), second=strokes.filter(s=>s.color==='Two');
 assert.equal(first.length,60);assert.deepEqual(first.map(s=>s.points),second.map(s=>s.points));
 assert.ok(labels.some(s=>s.includes('shared fit')));
 const a=m.cohorts[0].entries[0], idx=a.points.findIndex(p=>p.tUs===-1000000);
 a.points[idx].aim.xMeters=null;strokes.length=0;
 drawOfflineComparison(ctx,m.cohorts[0],{width:700,height:500,phase:'hold',colorForGroup:g=>g});
 assert.equal(strokes.filter(s=>s.color==='One').length,58);
});
