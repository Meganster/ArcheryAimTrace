import { validAimPoint } from "../telemetry/aim-projection.js?v=aim-pipeline-164";
import { drawTargetFace } from "./target-face.js?v=aim-pipeline-164";

import { cameraPointUsable } from './review-camera.js?v=aim-pipeline-164';

export function hasAimTrace(data) {
  return data.some((point) => point.aim?.version === 1);
}

// Same mapper for dashboard, saved previews and training. Physical mode keeps
// the captured center and dimensions. Normalized review scales a completed
// trace's extent. Live normalized uses fixed capture geometry: otherwise tiny
// noise expands to fill the target and rolling history moves an unchanged pin.
export function aimTraceLayout(data, { cx, cy, radius, mode = "physical", zoom = 1, fitExtent = 0, live = false, compact = false, camera = null }) {
  const geometry = [...data].reverse().find((point) => point.aim?.version === 1)?.aim;
  if (!geometry || !Number.isFinite(geometry.distanceMeters) || geometry.distanceMeters <= 0 ||
      !Number.isFinite(geometry.faceDiameterCm) || geometry.faceDiameterCm <= 0) return null;
  const matching = data.filter((point) => validAimPoint(point.aim) &&
    point.aim.referenceId === geometry.referenceId);
  const extent = matching.reduce((value, point) =>
    Math.max(value, Math.hypot(point.aim.xMeters, point.aim.yMeters)), 0.0001);
  const faceRadiusMeters = geometry.faceDiameterCm / 200;
  const normalizeTrace = mode === "normalized" && !live && !camera;
  // Leave room above the target for labels and below for the status line.
  const fitRadius = compact ? radius : Math.max(1, Math.min(radius, cx - 24, cy - Math.min(90, cy / 2) - 12));
  const scale = camera ? camera.scale : mode === "fit"
    ? fitRadius / Math.max(faceRadiusMeters, extent / 0.85, fitExtent / 0.85)
    : normalizeTrace ? radius * 0.85 / extent : radius / faceRadiusMeters;
  return {
    geometry,
    extent,
    faceRadiusPixels: normalizeTrace ? radius : faceRadiusMeters * scale * zoom,
    map(point) {
      if (!validAimPoint(point?.aim) || point.aim.referenceId !== geometry.referenceId) return null;
      if (camera && !cameraPointUsable(point)) return null;
      return {
        x: cx + (camera?.panX || 0) + point.aim.xMeters * scale * zoom,
        y: cy + (camera?.panY || 0) - point.aim.yMeters * scale * zoom,
      };
    },
  };
}

// An edge arrow indicates an off-screen pin; it never changes its coordinates.
export function pinViewportMarker(point, { cx, cy, compact = false }) {
  if (!point || ![point.x, point.y, cx, cy].every(Number.isFinite) || cx <= 0 || cy <= 0) return null;
  const pad = Math.min(compact ? 8 : 18, cx / 3, cy / 3);
  const top = compact ? pad : Math.min(90, cy / 2);
  const bottom = cy * 2 - (compact ? pad : Math.min(30, cy / 3));
  const dx = point.x - cx;
  const dy = point.y - cy;
  const t = Math.min(1,
    dx === 0 ? Infinity : (cx - pad) / Math.abs(dx),
    dy === 0 ? Infinity : (dy < 0 ? cy - top : bottom - cy) / Math.abs(dy));
  return { x: cx + dx * t, y: cy + dy * t, offscreen: t < 1, angle: Math.atan2(dy, dx) };
}

export function drawAimTrace(ctx, data, {
  cx, cy, radius, mode = "physical", zoom = 1, progress = 1,
  phaseAt = () => "hold", phaseColor = () => "#30E39B",
  compare = null, compact = false, live = false, camera = null,
} = {}) {
  let layout = aimTraceLayout(data, { cx, cy, radius, mode, zoom, live, compact, camera });
  if (!layout) return false;
  let other = compare && hasAimTrace(compare) ? aimTraceLayout(compare, { cx, cy, radius, mode, zoom, live, camera }) : null;
  const compatible = !other || (!layout.geometry.comparisonKey && !other.geometry.comparisonKey) ||
    layout.geometry.comparisonKey === other.geometry.comparisonKey;
  const sameTarget = compatible && other && other.geometry.distanceMeters === layout.geometry.distanceMeters &&
    other.geometry.faceDiameterCm === layout.geometry.faceDiameterCm;
  if (!camera && mode === "fit" && sameTarget) {
    const fitExtent = Math.max(layout.extent, other.extent);
    layout = aimTraceLayout(data, { cx, cy, radius, mode, zoom, fitExtent, live, compact });
    other = aimTraceLayout(compare, { cx, cy, radius, mode, zoom, fitExtent, live, compact });
  }
  const { geometry } = layout;
  drawTargetFace(ctx, {
    cx: cx + (camera?.panX || 0), cy: cy + (camera?.panY || 0), maxRadius: layout.faceRadiusPixels,
    // drawTargetFace scales its radius by diameter/122. Use a full-sized face;
    // its label and the physical trace scale use the captured dimensions.
    preset: {
      faceDiameterCm: 122,
      label: `${geometry.distanceMeters}m`,
      faceLabel: `${geometry.faceDiameterCm} cm · ${mode === "fit" ? "auto fit" : mode}`,
    },
    showLabel: !compact,
  });
  ctx.save();
  // Avoid unbounded canvas paths when the sensor points far off the target.
  ctx.beginPath();
  ctx.rect(0, 0, cx * 2, cy * 2);
  ctx.clip();
  const count = Math.max(0, Math.min(data.length, Math.ceil(data.length * progress)));
  const step = Math.max(1, Math.floor(count / Math.max(200, radius * 4)));
  const boundaries = [];
  function strokeTrace(trace, mapper, color, visibleCount, stride, phase = () => null) {
    let previous = null;
    let previousPhase = null;
    ctx.lineWidth = compact ? 1.5 : 2.5;
    for (let i = 0; i < visibleCount; i++) {
      const point = mapper(trace[i]);
      if (trace[i].gapBefore || (i && trace[i].aim?.samplePeriodUs &&
          trace[i].tUs - trace[i - 1].tUs > trace[i].aim.samplePeriodUs * 1.5)) {
        previous = null;
        previousPhase = null;
      }
      if (!point) { previous = null; previousPhase = null; continue; }
      const currentPhase = phase(i);
      // Keep both ends of colour boundaries when simplifying the path.
      const phaseBoundary = (i > 0 && phase(i - 1) !== currentPhase) ||
        (i + 1 < visibleCount && phase(i + 1) !== currentPhase);
      if (i % stride !== 0 && i !== visibleCount - 1 && !phaseBoundary) continue;
      if (previous) {
        // A segment takes its endpoint's colour, so the junction is its start.
        if (previousPhase === "break" && currentPhase === "release") {
          boundaries.push({ point: previous, color: color(i) });
        }
        ctx.strokeStyle = color(i);
        ctx.beginPath();
        ctx.moveTo(previous.x, previous.y);
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
        previousPhase = currentPhase;
      }
      previous = point;
    }
  }
  if (compare && hasAimTrace(compare)) {
    // Physical comparisons require the same distance and face diameter.
    if (compatible && other && (mode === "normalized" || sameTarget)) {
      strokeTrace(compare, other.map, () => "#35C7E8",
        Math.ceil(compare.length * progress), step);
    }
  }
  strokeTrace(data, layout.map, phaseColor, count, step, phaseAt);
  for (const { point, color } of boundaries) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(point.x, point.y, compact ? 4 : 9, 0, Math.PI * 2);
    ctx.stroke();
  }
  let pinOffscreen = false;
  for (const [index, color, size] of [
    [count - 1, "#35C7E8", compact ? 3 : 5],
  ]) {
    if (!Number.isInteger(index) || index < 0 || index >= count) continue;
    const point = layout.map(data[index]);
    if (!point) continue;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    if (index === count - 1 && color === "#35C7E8") {
      const marker = pinViewportMarker(point, { cx, cy, compact });
      if (marker?.offscreen) {
        pinOffscreen = true;
        ctx.save();
        ctx.translate(marker.x, marker.y);
        ctx.rotate(marker.angle);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(-12, -6);
        ctx.lineTo(-12, 6);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        continue;
      }
    }
    ctx.beginPath();
    ctx.arc(point.x, point.y, size, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
  if (!compact) {
    ctx.save();
    ctx.fillStyle = "#8ea6a0";
    ctx.font = "12px sans-serif";
    const latest = data[count - 1]?.aim;
    const signs = `H ${geometry.horizontalSign === -1 ? "reversed" : "normal"} · V ${geometry.verticalSign === -1 ? "reversed" : "normal"}`;
    ctx.fillText(geometry.referenceType === 'per-shot-relative'
      ? `Relative to mean pre-shot aim · ${geometry.referenceWindowMs.join('…')} ms`
      : `Pin projection · ${signs}`, 12, 56);
    if (validAimPoint(latest)) {
      ctx.fillText(`Pin: X ${(latest.xMeters * 100).toFixed(2)} cm (right +) · Y ${(latest.yMeters * 100).toFixed(2)} cm (up +)`, 12, 74);
    }
    const mixed = data.some((point) => point.aim && point.aim.referenceId !== geometry.referenceId);
    const compareMismatch = compare?.length && (!compatible || !hasAimTrace(compare) ||
      (mode !== "normalized" && compare.some((point) => point.aim &&
        (point.aim.distanceMeters !== geometry.distanceMeters ||
         point.aim.faceDiameterCm !== geometry.faceDiameterCm))));
    ctx.fillText(
      camera?.outsideTarget ? "Outside target view (>80° or no forward intersection) — see Angles." :
        pinOffscreen ? "Pin outside view — edge arrow shows direction. Choose Auto fit to see the full trace." :
        mixed ? "Multiple references — showing the latest calibration" :
        compareMismatch ? "Comparison unavailable: analysis settings or target differ" :
        mode === "normalized" && !live ? "Normalized shape only — trace sizes cannot be compared in cm" :
        geometry.referenceType === 'per-shot-relative' ? `Per-shot relative aim · Orange → red boundary · ${mode} · ${signs}` :
        live && mode === "normalized" ? "Relative aim · normalized · fixed live scale" :
          `Relative aim · captured center · ${mode}${zoom !== 1 ? ` · zoom ${zoom.toFixed(1)}x` : ""}`,
      12, cy * 2 - 12,
    );
    ctx.restore();
  }
  return true;
}
