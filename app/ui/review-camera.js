// Experimental review-only camera. Measurement coordinates stay unchanged.
import { validAimPoint } from '../telemetry/aim-projection.js?v=aim-pipeline-164';

export const TARGET_VIEW_ANGLE_LIMIT = 80;
const views = new WeakMap();
export const getReviewCamera = canvas => views.get(canvas);
export function cameraPointUsable(point) {
  const a = point?.aim;
  return validAimPoint(a) && Math.hypot(a.xMeters, a.yMeters) <= a.distanceMeters * Math.tan(TARGET_VIEW_ANGLE_LIMIT * Math.PI / 180);
}
export function fitReviewCamera(data, {cx, cy, mode = 'auto', progress = 1, compare = null}) {
  const geometry = data.find(p => p.aim)?.aim;
  if (!geometry) return null;
  const count = Math.max(1, Math.min(data.length, Math.ceil(data.length * progress)));
  const window = geometry.referenceWindowMs || [-1500, -300];
  const sameGeometry = p => p.aim?.referenceId === geometry.referenceId;
  let selected = data.filter((p,i) => sameGeometry(p) && (mode === 'full' || mode === 'aim'
    ? mode === 'full' || (Number.isFinite(p.tUs) && p.tUs >= window[0]*1000 && p.tUs <= 0)
    : i < count));
  if (!selected.length) selected = data.slice(0,count).filter(sameGeometry);
  // Overlay must use the same physical scale and analysis settings.
  const other = compare?.find(p=>p.aim)?.aim;
  if (other && other.distanceMeters === geometry.distanceMeters && other.faceDiameterCm === geometry.faceDiameterCm &&
      other.comparisonKey === geometry.comparisonKey) {
    const n = Math.max(1,Math.ceil(compare.length*progress));
    selected = selected.concat(compare.filter((p,i)=>mode === 'full' || (mode === 'aim'
      ? Number.isFinite(p.tUs) && p.tUs >= window[0]*1000 && p.tUs <= 0 : i<n)));
  }
  const extent = selected.filter(cameraPointUsable).reduce((max,p)=>Math.max(max,Math.hypot(p.aim.xMeters,p.aim.yMeters)),0);
  const available = Math.max(1,Math.min(cx-24,cy-100,cy-40));
  const radius = geometry.faceDiameterCm/200;
  const scale = available / Math.max(radius,extent/0.85);
  const hardScale = available / Math.max(radius,extent);
  const latest = data[count-1];
  return {scale,hardScale,extent,count,geometry,outsideTarget:!!latest?.aim && !cameraPointUsable(latest)};
}
export function updateReviewCamera(canvas,state,data,{cx,cy,now=performance.now()}) {
  if (!state.reviewCameraMode || !state.reviewMode) { views.delete(canvas); return null; }
  const mode=state.reviewCameraMode;
  const fit=fitReviewCamera(data,{cx,cy,mode,progress:state.replayProgress ?? 1,compare:state.compareTrace});
  if(!fit)return null;
  const previous=views.get(canvas);
  const key=JSON.stringify([state.reviewShotId,mode,cx,cy,state.compareShotId]);
  let scale=mode==='manual' && state.reviewCameraScale>0 ? state.reviewCameraScale : fit.scale;
  if(mode==='auto' && state.replayActive && !state.replayPaused && previous?.key===key &&
      fit.count>=previous.count && fit.count-previous.count<Math.max(8,data.length*0.1)) {
    const alpha=1-Math.exp(-Math.min(100,Math.max(0,now-previous.now))/140);
    scale=Math.exp(Math.log(previous.scale)+(Math.log(fit.scale)-Math.log(previous.scale))*alpha);
    // Keep the visible prefix inside the frame even during fast movement.
    scale=Math.min(scale,fit.hardScale);
  }
  const view={...fit,key,now,scale,panX:mode==='manual' ? state.reviewPanX||0 : 0,
    panY:mode==='manual' ? state.reviewPanY||0 : 0};
  views.set(canvas,view);
  return view;
}
