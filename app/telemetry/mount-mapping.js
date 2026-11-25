// Coordinate conventions:
// raw IMU -> streamed fusion axes -> wizard bow axes (X forward, Y up, Z right).
// The final fusion frame instead uses X forward, Y left, Z up.
// Signed permutations use ±1, ±2, ±3 for source X, Y, Z.
export const FIRMWARE_MOUNTS = Object.freeze({
  "legacy-x90": Object.freeze([1, -3, 2]),
  "legacy-x90-inverted": Object.freeze([1, 3, -2]),
  "left-side-usb-string": Object.freeze([2, 3, 1]),
});

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

export function applyAxisMapping(mapping, vector) {
  return mapping.map((axis) => Math.sign(axis) * vector[Math.abs(axis) - 1]);
}

export function isProperAxisMapping(mapping) {
  if (!Array.isArray(mapping) || mapping.length !== 3 ||
      !mapping.every((axis) => Number.isInteger(axis) && Math.abs(axis) >= 1 && Math.abs(axis) <= 3) ||
      new Set(mapping.map(Math.abs)).size !== 3) return false;
  const rows = mapping.map((axis) => [1, 2, 3].map((i) =>
    Math.abs(axis) === i ? Math.sign(axis) : 0));
  return dot(rows[0], cross(rows[1], rows[2])) === 1;
}

export function composeAxisMappings(outputFromIntermediate, intermediateFromInput) {
  if (!isProperAxisMapping(outputFromIntermediate) || !isProperAxisMapping(intermediateFromInput)) {
    throw new Error("Mount mappings must be proper rotations, not reflections.");
  }
  return outputFromIntermediate.map((axis) =>
    Math.sign(axis) * intermediateFromInput[Math.abs(axis) - 1]);
}

export function firmwareMappingFromWizard(streamToBow, currentFirmwareProfile) {
  const rawToStream = FIRMWARE_MOUNTS[currentFirmwareProfile];
  if (!rawToStream) throw new Error("The installed firmware profile must be known.");
  // Model Y-up -> fusion Z-up. This is a rotation, not just a Y/Z swap.
  return composeAxisMappings(
    composeAxisMappings([1, -3, 2], streamToBow),
    rawToStream,
  );
}

export function axisMappingLabels(mapping) {
  return Object.fromEntries(mapping.map((axis, i) => [
    ["x", "y", "z"][i],
    `${axis < 0 ? "-" : ""}IMU ${["X", "Y", "Z"][Math.abs(axis) - 1]}`,
  ]));
}

export function detectMountFromGravity(level, cantedRight) {
  const up = unit(level);
  const tiltedUp = unit(cantedRight);
  if (!up || !tiltedUp) return { error: "Invalid gravity capture. Repeat both positions." };
  const separation = Math.acos(Math.max(-1, Math.min(1, dot(up, tiltedUp)))) * 180 / Math.PI;
  if (Math.abs(separation - 90) > 20) {
    return { error: "Captures must be about 90° apart. Keep the arrow direction fixed and cant the top limb fully to your right." };
  }
  const right = unit(tiltedUp.map((value, i) => -value + dot(tiltedUp, up) * up[i]));
  const forward = cross(up, right);
  const mapping = [];
  for (const axis of [forward, up, right]) {
    const index = axis.map(Math.abs).indexOf(Math.max(...axis.map(Math.abs)));
    if (Math.abs(axis[index]) < Math.cos(20 * Math.PI / 180)) {
      return { error: "The board is between axis-aligned positions. Check the mount and repeat both captures; a 90° axis preset would be inaccurate." };
    }
    mapping.push(Math.sign(axis[index]) * (index + 1));
  }
  if (!isProperAxisMapping(mapping)) return { error: "Could not resolve a proper rotation. Repeat both captures." };
  return { mapping, axes: axisMappingLabels(mapping), separationDeg: separation };
}
