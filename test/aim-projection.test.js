import test from "node:test";
import assert from "node:assert/strict";
import {
  aimDirection, aimToCanvas, createAimReference, orientationQuaternion, projectAim, captureAimPoint,
} from "../app/telemetry/aim-projection.js";
import { aimTraceLayout, drawAimTrace, pinViewportMarker } from "../app/ui/aim-trace.js";
import { computeFloatScoreFromTrace, AIM_SCORE_VERSION } from "../app/telemetry/score.js";
import {
  applyAxisMapping, composeAxisMappings, detectMountFromGravity,
  firmwareMappingFromWizard, FIRMWARE_MOUNTS, isProperAxisMapping,
} from "../app/telemetry/mount-mapping.js";

const pose = (roll = 0, pitch = 0, yaw = 0) => ({ roll, pitch, yaw });
const close = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const reference = (sample = pose(), distanceMeters = 18) =>
  createAimReference(sample, { distanceMeters, faceDiameterCm: 40 });

test("reported captures compose with legacy firmware into raw Y, Z, X", () => {
  const result = detectMountFromGravity([1, 0, 0], [0, -1, 0]);
  assert.deepEqual(result.mapping, [3, 1, 2]);
  assert.deepEqual(result.axes, { x: "IMU Z", y: "IMU X", z: "IMU Y" });
  assert.deepEqual(firmwareMappingFromWizard(result.mapping, "legacy-x90"), [2, 3, 1]);
  // Rerunning the wizard after flashing must preserve the new raw mapping.
  const corrected = detectMountFromGravity([0, 0, 1], [0, 1, 0]);
  assert.deepEqual(firmwareMappingFromWizard(corrected.mapping, "left-side-usb-string"), [2, 3, 1]);
});

test("mount mappings preserve length, handedness and composition", () => {
  for (const mapping of Object.values(FIRMWARE_MOUNTS)) {
    assert.equal(isProperAxisMapping(mapping), true);
    close(Math.hypot(...applyAxisMapping(mapping, [3, -4, 12])), 13);
    assert.deepEqual(
      applyAxisMapping(composeAxisMappings([1, -3, 2], mapping), [3, -4, 12]),
      applyAxisMapping([1, -3, 2], applyAxisMapping(mapping, [3, -4, 12])),
    );
  }
  assert.equal(isProperAxisMapping([1, 3, 2]), false);
  assert.throws(() => composeAxisMappings([1, 3, 2], [1, 2, 3]));
  assert.throws(() => firmwareMappingFromWizard([3, 1, 2], "unknown"));
});

test("wizard rejects parallel, opposite, zero and off-axis captures", () => {
  for (const tilted of [[1, 0, 0], [-1, 0, 0], [0, 0, 0]]) {
    assert.ok(detectMountFromGravity([1, 0, 0], tilted).error);
  }
  assert.ok(detectMountFromGravity([1, 1, 0], [0, 0, 1]).error);
  assert.ok(detectMountFromGravity([NaN, 0, 0], [0, 1, 0]).error);
  assert.ok(detectMountFromGravity([1, 0, 0], [0.6, -0.8, 0]).error);
});

test("pin right/up has correct screen signs and physical angular scale", () => {
  const ref = reference();
  const right = projectAim(pose(0, 0, -1), ref);
  const up = projectAim(pose(0, -1, 0), ref);
  const displacement = 18 * Math.tan(Math.PI / 180);
  close(right.xMeters, displacement);
  close(right.yMeters, 0);
  close(up.xMeters, 0);
  close(up.yMeters, displacement);
  const canvas = aimToCanvas(up, { cx: 200, cy: 200, faceRadiusPixels: 100 });
  close(canvas.x, 200);
  close(canvas.y, 200 - displacement / 0.2 * 100);
  close(projectAim(pose(0, 0, -1), reference(pose(), 36)).xMeters, displacement * 2);
});

test("pure cant does not move the forward ray, including combined rotations", () => {
  const ref = reference();
  for (const roll of [-170, -45, 0, 35, 179]) {
    const p = projectAim(pose(roll), ref);
    close(p.xMeters, 0);
    close(p.yMeters, 0);
    const combined = projectAim(pose(roll, -4, 3), ref);
    const baseline = projectAim(pose(0, -4, 3), ref);
    close(combined.xMeters, baseline.xMeters);
    close(combined.yMeters, baseline.yMeters);
  }
});

test("direction corrections independently reverse screen axes without changing center, distance or cant", () => {
  const center = pose(15, -7, 179);
  const movement = pose(45, -8, -179);
  const normal = reference(center);
  const before = projectAim(movement, normal);
  for (const horizontalSign of [1, -1]) {
    for (const verticalSign of [1, -1]) {
      const ref = createAimReference(center, {
        distanceMeters: 18, faceDiameterCm: 40, horizontalSign, verticalSign,
      });
      const after = projectAim(movement, ref);
      close(after.xMeters, before.xMeters * horizontalSign);
      close(after.yMeters, before.yMeters * verticalSign);
      close(Math.hypot(after.xMeters, after.yMeters), Math.hypot(before.xMeters, before.yMeters));
      const origin = projectAim(center, ref);
      close(origin.xMeters, 0);
      close(origin.yMeters, 0);
      const canted = projectAim({ ...center, roll: 80 }, ref);
      close(canted.xMeters, 0);
      close(canted.yMeters, 0);
      assert.deepEqual(projectAim(movement, JSON.parse(JSON.stringify(ref))), after);
    }
  }
});

test("old captures retain their signs and malformed direction corrections cannot collapse or scale a trace", () => {
  const ref = reference();
  const old = { ...ref };
  delete old.horizontalSign;
  delete old.verticalSign;
  assert.deepEqual(projectAim(pose(0, -2, -1), old), projectAim(pose(0, -2, -1), ref));
  for (const sign of [0, 2, NaN, null, "-1"]) {
    for (const key of ["horizontalSign", "verticalSign"]) {
      assert.equal(createAimReference(pose(), { distanceMeters: 18, faceDiameterCm: 40, [key]: sign }), null);
      assert.equal(projectAim(pose(), { ...ref, [key]: sign }), null);
    }
  }
});

test("reference keeps the horizon level and handles yaw wrapping", () => {
  const ref = reference(pose(70, 0, 179));
  const p = projectAim(pose(-30, 0, -179), ref);
  close(p.xMeters, -18 * Math.tan(2 * Math.PI / 180));
  close(p.yMeters, 0);
  const elevated = pose(40, -20, 30);
  const center = projectAim(elevated, reference(elevated));
  close(center.xMeters, 0);
  close(center.yMeters, 0);
});

test("Euler recordings and normalized quaternion live data project identically", () => {
  const sample = pose(31, -7, 42);
  const [qw, qx, qy, qz] = orientationQuaternion(sample);
  const fromQ = { qw: qw * 3, qx: qx * 3, qy: qy * 3, qz: qz * 3 };
  const ref = reference(pose(0, 0, 40));
  const a = projectAim(sample, ref);
  const b = projectAim(fromQ, ref);
  close(a.xMeters, b.xMeters);
  close(a.yMeters, b.yMeters);
  assert.deepEqual(projectAim(fromQ, JSON.parse(JSON.stringify(ref))), b);
});

test("bad orientations, missing yaw, invalid references and backwards rays are rejected", () => {
  assert.equal(aimDirection({ roll: 0, pitch: 0 }), null);
  assert.equal(aimDirection({ ...pose(), yawAvailable: false }), null);
  assert.equal(aimDirection({ qw: null, qx: null, qy: null, qz: null }), null);
  assert.equal(aimDirection({ qw: 0, qx: 0, qy: 0, qz: 0 }), null);
  assert.equal(reference(pose(0, 90, 0)), null);
  assert.equal(reference(pose(), -1), null);
  assert.equal(projectAim(pose(0, 0, 90), reference()), null);
  assert.equal(projectAim(pose(0, 0, 180), reference()), null);
  assert.equal(projectAim(pose(), { ...reference(), right: [1, 0, 0] }), null);
  assert.equal(aimToCanvas(null, { cx: 0, cy: 0, faceRadiusPixels: 100 }), null);
});

test("saved coordinates preserve physical scale, center and gaps across replay", () => {
  const ref = { ...reference(), id: "test-reference" };
  const data = [pose(), pose(20, 0, -0.5), pose(20, 0, -1)].map((p) =>
    ({ ...p, aim: captureAimPoint(p, ref) }));
  const options = { cx: 200, cy: 200, radius: 100, mode: "physical" };
  const layout = aimTraceLayout(data, options);
  const restored = JSON.parse(JSON.stringify(data));
  const replay = aimTraceLayout(restored, options);
  close(layout.map(data[2]).x, 200 + 100 * 18 * Math.tan(Math.PI / 180) / 0.2);
  assert.deepEqual(replay.map(restored[2]), layout.map(data[2]));
  assert.deepEqual(layout.map(data[0]), { x: 200, y: 200 });
  // A different trace amplitude must not change the physical scale.
  assert.deepEqual(aimTraceLayout([data[0], data[2]], options).map(data[2]), layout.map(data[2]));
  const invalid = { aim: captureAimPoint(pose(0, 0, 180), ref) };
  assert.equal(layout.map(invalid), null);
  assert.equal(layout.map({ aim: { ...data[0].aim, referenceId: "other" } }), null);
  const miniature = aimTraceLayout(data, { ...options, radius: 50 });
  close(miniature.map(data[2]).x - 200, (layout.map(data[2]).x - 200) / 2);
});

test("aim renderer never joins across missing data or draws a detector marker", () => {
  const ref = { ...reference(), id: "renderer-test" };
  const data = [-0.2, -0.3, 180, -0.5].map((yaw) => ({
    aim: captureAimPoint(pose(0, 0, yaw), ref),
  }));
  const lines = [];
  const arcs = [];
  const ctx = new Proxy({}, { get: (_, method) => {
    if (method === "lineTo") return (...args) => lines.push(args);
    if (method === "arc") return (...args) => arcs.push(args);
    if (method === "measureText") return () => ({ width: 50 });
    return () => {};
  } });
  assert.equal(drawAimTrace(ctx, data, {
    cx: 200, cy: 200, radius: 100, mode: "physical", releaseIndex: 1, compact: true,
  }), true);
  // Target rendering has no lineTo calls: only one segment before the gap.
  assert.equal(lines.length, 1);
  const reticle = arcs.find(([, , r]) => r === 4);
  assert.equal(reticle, undefined, "no separate detector marker");
});

test("phase markers sit at orange-to-red junctions and respect replay, gaps and decimation", () => {
  const ref = { ...reference(), id: "boundary-test" };
  const data = Array.from({ length: 1000 }, (_, i) => ({
    aim: captureAimPoint(pose(0, 0, -i / 10000), ref),
  }));
  const options = {
    cx: 200, cy: 200, radius: 50, mode: "physical", compact: true,
    phaseAt: i => i < 500 ? "break" : i < 700 ? "release" : i < 800 ? "break" : "release",
    phaseColor: i => i < 500 || (i >= 700 && i < 800) ? "orange" : "red",
  };
  const layout = aimTraceLayout(data, options);
  function markers(progress = 1) {
    const arcs = [];
    const ctx = new Proxy({}, { get: (_, method) => {
      if (method === "arc") return (...args) => { if (args[2] === 4) arcs.push(args.slice(0, 2)); };
      return () => {};
    } });
    drawAimTrace(ctx, data, { ...options, progress });
    return arcs;
  }
  const xy = i => { const p = layout.map(data[i]); return [p.x, p.y]; };
  assert.deepEqual(markers(), [xy(499), xy(799)]);
  assert.deepEqual(markers(0.5), [], "red segment not visible yet");
  assert.deepEqual(markers(0.501), [xy(499)]);
  data[500].gapBefore = true;
  assert.deepEqual(markers(), [xy(799)], "no marker across a gap");
  delete data[500].gapBefore;
  data[498].aim = null;
  assert.deepEqual(markers(), [xy(799)], "no orange segment before the junction");
});

test("physical zoom magnifies target rings and trajectory together", () => {
  const ref = { ...reference(), id: "zoom-test" };
  const data = [pose(), pose(0, 0, -0.1)].map((p) => ({ aim: captureAimPoint(p, ref) }));
  function drawAt(zoom) {
    const arcs = [];
    const ctx = new Proxy({}, { get: (_, method) => {
      if (method === "arc") return (...args) => arcs.push(args);
      return () => {};
    } });
    drawAimTrace(ctx, data, { cx: 200, cy: 200, radius: 100, mode: "physical", zoom, compact: true });
    return arcs;
  }
  const normal = drawAt(1);
  const zoomed = drawAt(2);
  // First arc is the backdrop, last arc is the final sample marker.
  close(zoomed[0][2], normal[0][2] * 2);
  close(zoomed.at(-1)[0] - 200, (normal.at(-1)[0] - 200) * 2);
});

test("auto fit keeps large excursions visible while preserving pin-to-target proportions", () => {
  const ref = { ...reference(), id: "fit" };
  const data = [pose(), pose(0, -10, -15), pose(0, 12, 8)].map((p) => ({ aim: captureAimPoint(p, ref) }));
  for (const [cx, cy] of [[200, 200], [500, 250], [100, 100]]) {
    const options = { cx, cy, radius: Math.min(cx, cy) * 0.9 };
    const physical = aimTraceLayout(data, { ...options, mode: "physical" });
    const fit = aimTraceLayout(data, { ...options, mode: "fit" });
    assert.ok(fit.faceRadiusPixels < physical.faceRadiusPixels);
    for (const p of data) {
      const point = fit.map(p);
      assert.equal(pinViewportMarker(point, { cx, cy }).offscreen, false);
      close((point.x - cx) / fit.faceRadiusPixels, p.aim.xMeters / 0.2);
      close((cy - point.y) / fit.faceRadiusPixels, p.aim.yMeters / 0.2);
    }
    assert.deepEqual(fit.map(data[0]), { x: cx, y: cy });
  }
});

test("off-screen markers preserve direction and leave measured positions untouched", () => {
  const cx = 200, cy = 200;
  for (const [x, y] of [[2000, 200], [-2000, 200], [200, -2000], [200, 2000], [2000, -2000]]) {
    const point = { x, y };
    const marker = pinViewportMarker(point, { cx, cy });
    assert.equal(marker.offscreen, true);
    assert.ok(marker.x >= 18 && marker.x <= 382);
    assert.ok(marker.y >= 90 && marker.y <= 370);
    close((marker.x - cx) * (y - cy) - (marker.y - cy) * (x - cx), 0, 1e-8);
    assert.deepEqual(point, { x, y });
  }
  assert.equal(pinViewportMarker({ x: 210, y: 190 }, { cx, cy }).offscreen, false);
  assert.equal(pinViewportMarker(null, { cx, cy }), null);
});

test("physical renderer displays an edge arrow and message for an off-screen pin", () => {
  const ref = { ...reference(), id: "outside" };
  const data = [pose(), pose(0, -10, 0)].map((p) => ({ aim: captureAimPoint(p, ref) }));
  const translations = [], text = [];
  const ctx = new Proxy({}, { get: (_, key) => {
    if (key === "translate") return (...args) => translations.push(args);
    if (key === "fillText") return (value) => text.push(value);
    if (key === "measureText") return () => ({ width: 0 });
    return () => {};
  } });
  drawAimTrace(ctx, data, { cx: 200, cy: 200, radius: 180, mode: "physical" });
  assert.ok(translations.some(([x, y]) => x === 200 && y === 90));
  assert.ok(text.some((value) => value.startsWith("Pin outside view")));
});

test("aim scoring measures horizontal aim separately from cant", () => {
  const ref = { ...reference(), id: "score-test" };
  const makeTrace = (cant, yaw) => Array.from({ length: 80 }, (_, i) => {
    const p = pose(cant ? Math.sin(i) * 10 : 0, 0, yaw ? Math.sin(i) * 2 : 0);
    return { ...p, ax: 0, ay: 0, az: 1, rotDps: 0, aim: captureAimPoint(p, ref) };
  });
  const baseline = computeFloatScoreFromTrace(makeTrace(false, false), { isManual: true });
  const canted = computeFloatScoreFromTrace(makeTrace(true, false), { isManual: true });
  const wandering = computeFloatScoreFromTrace(makeTrace(false, true), { isManual: true });
  assert.equal(baseline.scoreVersion, AIM_SCORE_VERSION);
  assert.equal(canted.holdStability, baseline.holdStability);
  assert.ok(canted.levelConsistency < baseline.levelConsistency);
  assert.ok(wandering.holdStability < baseline.holdStability);
});

test("sideways live normalized capture keeps small pitch changes at a fixed scale", () => {
  const center = pose(90, 0, 58.8);
  const ref = { ...reference(center), id: "sideways-live" };
  const data = [center, pose(90, 0.001, 58.8)].map(p => ({ aim: captureAimPoint(p, ref) }));
  const options = { cx: 200, cy: 200, radius: 100, mode: "normalized", live: true };
  const layout = aimTraceLayout(data, options);
  close(layout.map(data[0]).x, 200);
  close(layout.map(data[0]).y, 200);
  close(layout.map(data[1]).y - 200, 0.1570796327, 1e-8);
  close(data[1].aim.yMeters, -0.0003141592654, 1e-10);
  // Completed trace review keeps its explicitly amplitude-normalized view.
  const review = aimTraceLayout(data, { ...options, live: false });
  close(review.map(data[1]).y - 200, 85);
  for (const roll of [80, 90, 100]) {
    const point = { aim: captureAimPoint(pose(roll, 0, 58.8), ref) };
    close(layout.map(point).x, 200);
    close(layout.map(point).y, 200);
  }
});

test("rolling history cannot move an unchanged normalized live pin", () => {
  const ref = { ...reference(pose(90, 0, 58.8)), id: "fixed-history" };
  const pin = { aim: captureAimPoint(pose(90, 0.001, 58.8), ref) };
  const excursion = { aim: captureAimPoint(pose(90, 5, 58.8), ref) };
  const options = { cx: 200, cy: 200, radius: 100, mode: "normalized", live: true };
  const withHistory = aimTraceLayout([excursion, pin], options).map(pin);
  const afterExpiry = aimTraceLayout([pin], options).map(pin);
  assert.deepEqual(withHistory, afterExpiry);
  assert.deepEqual(afterExpiry, aimTraceLayout([pin], { ...options, mode: "physical" }).map(pin));
  const recaptured = { ...reference(pose(90, 0.001, 58.8)), id: "new-center" };
  const newPin = { aim: captureAimPoint(pose(90, 0.001, 58.8), recaptured) };
  const layout = aimTraceLayout([pin, newPin], options);
  close(layout.map(newPin).x, 200);
  close(layout.map(newPin).y, 200);
  assert.equal(layout.map(pin), null);
});
