// Relative aiming-ray projection. Requires bow-aligned fusion data:
// X forward, Y left, Z up; quaternion rotates body vectors into world space.
// No cant/pitch zero offsets are subtracted from the orientation.
export const AIM_PROJECTION_VERSION = 1;
const RAD = Math.PI / 180;
const isDirectionSign = (value) => value === 1 || value === -1;
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function unit(v) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) return null;
  const length = Math.hypot(...v);
  return length > 1e-9 ? v.map((value) => value / length) : null;
}

export function orientationQuaternion(sample) {
  if (!sample) return null;
  const keys = ["qw", "qx", "qy", "qz"];
  if (keys.every((key) => Number.isFinite(sample[key]))) {
    const q = keys.map((key) => sample[key]);
    const length = Math.hypot(...q);
    return length > 1e-9 ? q.map((value) => value / length) : null;
  }
  // Never fabricate horizontal aiming from a legacy trace without yaw.
  if (sample.yawAvailable === false ||
      !["roll", "pitch", "yaw"].every((key) => Number.isFinite(sample[key]))) return null;
  const [r, p, y] = [sample.roll, sample.pitch, sample.yaw].map((angle) => angle * RAD / 2);
  const [cr, cp, cy] = [r, p, y].map(Math.cos);
  const [sr, sp, sy] = [r, p, y].map(Math.sin);
  return [
    cr * cp * cy + sr * sp * sy,
    sr * cp * cy - cr * sp * sy,
    cr * sp * cy + sr * cp * sy,
    cr * cp * sy - sr * sp * cy,
  ];
}

export function aimDirection(sample, bodyRay = [1, 0, 0]) {
  const q = orientationQuaternion(sample);
  const v = unit(bodyRay);
  if (!q || !v) return null;
  const [w, ...xyz] = q;
  const uv = cross(xyz, v);
  const uuv = cross(xyz, uv);
  return unit(v.map((value, i) => value + 2 * (w * uv[i] + uuv[i])));
}

export function createAimReference(sample, {
  distanceMeters,
  faceDiameterCm,
  bodyRay = [1, 0, 0],
  horizontalSign = 1,
  verticalSign = 1,
} = {}) {
  return createAimReferenceFromDirection(aimDirection(sample, bodyRay), {
    distanceMeters, faceDiameterCm, bodyRay, horizontalSign, verticalSign,
  });
}

export function createAimReferenceFromDirection(direction, {
  distanceMeters, faceDiameterCm, bodyRay = [1, 0, 0], horizontalSign = 1, verticalSign = 1,
} = {}) {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0 ||
      !Number.isFinite(faceDiameterCm) || faceDiameterCm <= 0 ||
      !isDirectionSign(horizontalSign) || !isDirectionSign(verticalSign)) return null;
  const ray = unit(bodyRay);
  const forward = unit(direction);
  if (!forward) return null;
  // Horizon stays level even if the bow is canted when the reference is captured.
  const right = unit(cross(forward, [0, 0, 1]));
  if (!right) return null; // A vertical aiming direction has no defined horizon.
  const up = unit(cross(right, forward));
  return {
    version: AIM_PROJECTION_VERSION,
    forward, right, up, bodyRay: ray, distanceMeters, faceDiameterCm,
    horizontalSign, verticalSign,
  };
}

export function projectAim(sample, reference) {
  if (!reference || reference.version !== AIM_PROJECTION_VERSION ||
      !Number.isFinite(reference.distanceMeters) || reference.distanceMeters <= 0 ||
      !Number.isFinite(reference.faceDiameterCm) || reference.faceDiameterCm <= 0) return null;
  const basis = ["forward", "right", "up"].map((key) => unit(reference[key]));
  if (basis.some((axis) => !axis)) return null;
  const [forward, right, up] = basis;
  if (Math.abs(dot(forward, right)) > 1e-6 ||
      Math.abs(dot(forward, up)) > 1e-6 ||
      dot(cross(right, forward), up) < 1 - 1e-6) return null;
  const direction = aimDirection(sample, reference.bodyRay);
  if (!direction) return null;
  const depth = dot(direction, forward);
  if (depth <= 1e-3) return null; // Behind/along the plane: do not draw infinity.
  // Direction checks belong to this capture, not to the renderer or Euler
  // angles. Old references without explicit signs retain their original axes.
  const horizontalSign = reference.horizontalSign === undefined ? 1 : reference.horizontalSign;
  const verticalSign = reference.verticalSign === undefined ? 1 : reference.verticalSign;
  if (!isDirectionSign(horizontalSign) || !isDirectionSign(verticalSign)) return null;
  const xMeters = horizontalSign * reference.distanceMeters * dot(direction, right) / depth;
  const yMeters = verticalSign * reference.distanceMeters * dot(direction, up) / depth;
  const faceRadiusMeters = reference.faceDiameterCm / 200;
  return {
    xMeters, yMeters,
    xRadii: xMeters / faceRadiusMeters,
    yRadii: yMeters / faceRadiusMeters,
  };
}

export function aimToCanvas(projected, { cx, cy, faceRadiusPixels }) {
  if (!projected || ![projected.xRadii, projected.yRadii, cx, cy, faceRadiusPixels].every(Number.isFinite) ||
      faceRadiusPixels <= 0) return null;
  return {
    x: cx + projected.xRadii * faceRadiusPixels,
    y: cy - projected.yRadii * faceRadiusPixels,
  };
}

// Store projected coordinates and their calibration identity with the sample.
// This makes browser recordings reproducible without using today's settings.
export function captureAimPoint(sample, reference) {
  if (!reference?.id || reference.version !== AIM_PROJECTION_VERSION) return null;
  const projected = projectAim(sample, reference);
  return {
    version: AIM_PROJECTION_VERSION,
    referenceId: reference.id,
    distanceMeters: reference.distanceMeters,
    faceDiameterCm: reference.faceDiameterCm,
    horizontalSign: reference.horizontalSign === undefined ? 1 : reference.horizontalSign,
    verticalSign: reference.verticalSign === undefined ? 1 : reference.verticalSign,
    xMeters: projected?.xMeters ?? null,
    yMeters: projected?.yMeters ?? null,
  };
}

export function validAimPoint(aim) {
  return aim?.version === AIM_PROJECTION_VERSION && typeof aim.referenceId === "string" &&
    Number.isFinite(aim.xMeters) && Number.isFinite(aim.yMeters) &&
    Number.isFinite(aim.distanceMeters) && aim.distanceMeters > 0 &&
    Number.isFinite(aim.faceDiameterCm) && aim.faceDiameterCm > 0;
}

export function aimAngles(point) {
  if (!validAimPoint(point?.aim)) return null;
  return {
    horizontal: Math.atan2(point.aim.xMeters, point.aim.distanceMeters) / RAD,
    vertical: Math.atan2(point.aim.yMeters, point.aim.distanceMeters) / RAD,
  };
}
