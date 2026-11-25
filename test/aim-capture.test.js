import test from "node:test";
import assert from "node:assert/strict";
import { aimCaptureReadiness, aimTrackingStatus } from "../app/telemetry/aim-capture.js";
import { TelemetryStore } from "../app/telemetry/telemetry.js";
import { createStore, EventBus } from "../app/core/store.js";
import { createAimReference, orientationQuaternion } from "../app/telemetry/aim-projection.js";
import { aimTraceLayout } from "../app/ui/aim-trace.js";
import { drawTraceChart } from "../app/ui/trace-chart.js";

const readyState = () => ({
  connected: true, sample: {}, lastSampleReceivedAt: 100,
  aimAxesVerified: true, roll: 0, pitch: 0, yaw: 0, hz: 0,
});

test("capture uses fresh data even before the first Hz update, and rejects stale data despite positive Hz", () => {
  assert.equal(aimCaptureReadiness(readyState(), 100).ready, true);
  assert.equal(aimCaptureReadiness(readyState(), 2100).ready, true);
  const stale = aimCaptureReadiness({ ...readyState(), hz: 52 }, 2101);
  assert.equal(stale.ready, false);
  assert.match(stale.reason, /data stopped/);
});

test("capture explains every blocker, with review taking priority over connection and checkbox", () => {
  for (const [patch, reason] of [
    [{ reviewMode: true, connected: false, aimAxesVerified: false }, /Exit Review/],
    [{ connected: false }, /Connect the sensor/],
    [{ sample: null }, /Waiting for live/],
    [{ lastSampleReceivedAt: null }, /Waiting for live/],
    [{ lastSampleReceivedAt: 101 }, /data stopped/],
    [{ aimAxesVerified: false }, /checkbox/],
    [{ yaw: NaN }, /valid sensor orientation/],
    [{ pitch: 90 }, /not vertically/],
  ]) {
    const result = aimCaptureReadiness({ ...readyState(), ...patch }, 100);
    assert.equal(result.ready, false);
    assert.match(result.reason, reason);
  }
});

test("live telemetry enables capture, preserves confirmation during samples, and invalidates it across reconnect", (t) => {
  t.mock.method(globalThis, "setInterval", () => 0);
  const bus = new EventBus();
  const store = createStore({});
  const telemetry = new TelemetryStore(bus, store);
  const sample = {
    sequence: 0, dtUs: 19230, axMg: 0, ayMg: 0, azMg: 1000,
    gxDps: 0, gyDps: 0, gzDps: 0,
    qw: 1, qx: 0, qy: 0, qz: 0, rollDeg: 0, pitchDeg: 0, yawDeg: 0,
  };
  bus.emit("status", { mode: "live", text: "Connected" });
  store.set({ aimAxesVerified: true });
  assert.equal(aimCaptureReadiness(store.get()).ready, false);
  bus.emit("sample", sample);
  assert.equal(store.get().hz, 0);
  assert.equal(aimCaptureReadiness(store.get()).ready, true);
  bus.emit("sample", { ...sample, sequence: 1 });
  assert.equal(store.get().aimAxesVerified, true);
  store.set({ reviewMode: true });
  assert.equal(aimCaptureReadiness(store.get()).ready, false);
  store.set({ reviewMode: false });
  assert.equal(aimCaptureReadiness(store.get()).ready, true);
  bus.emit("status", { mode: "reconnecting", text: "Reconnecting" });
  bus.emit("status", { mode: "live", text: "Connected" });
  assert.equal(store.get().lastSampleReceivedAt, null);
  assert.equal(store.get().aimAxesVerified, false);
  assert.equal(aimCaptureReadiness(store.get()).ready, false);
  telemetry.reset();
  assert.equal(store.get().lastSampleReceivedAt, null);
});

test("reversed right/up movements reach the live target and replay with capture-specific corrections", (t) => {
  t.mock.method(globalThis, "setInterval", () => 0);
  const bus = new EventBus();
  const store = createStore({});
  const telemetry = new TelemetryStore(bus, store);
  const makeReference = (id, sign) => ({
    ...createAimReference({ roll: 0, pitch: 0, yaw: 0 }, {
      distanceMeters: 18, faceDiameterCm: 40, horizontalSign: sign, verticalSign: sign,
    }), id,
  });
  const reversed = makeReference("corrected", -1);
  store.set({ aimReference: reversed });
  // Synthetic inputs whose uncorrected projection moves left and down.
  for (const [sequence, pitchDeg, yawDeg] of [[0, 0, 0], [1, 0, 0.1], [2, 0.1, 0]]) {
    const [qw, qx, qy, qz] = orientationQuaternion({ roll: 0, pitch: pitchDeg, yaw: yawDeg });
    bus.emit("sample", {
      sequence, dtUs: 19230, axMg: 0, ayMg: 0, azMg: 1000,
      gxDps: 0, gyDps: 0, gzDps: 0,
      qw, qx, qy, qz, rollDeg: 0, pitchDeg, yawDeg,
    });
  }
  const data = telemetry.trace;
  const options = { cx: 200, cy: 200, radius: 100, mode: "physical" };
  const layout = aimTraceLayout(data, options);
  // Exercise the actual dashboard entry point, not only the shared mapper.
  const originalDocument = globalThis.document;
  const originalComputedStyle = globalThis.getComputedStyle;
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalComputedStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = originalComputedStyle;
  });
  const texts = [];
  const arcs = [];
  const ctx = new Proxy({}, { get: (_, key) => {
    if (key === "fillText") return (text) => texts.push(text);
    if (key === "arc") return (...args) => arcs.push(args);
    if (key === "measureText") return () => ({ width: 0 });
    return () => {};
  } });
  store.set({ chartView: "target", targetViewMode: "physical" });
  const canvas = { getBoundingClientRect: () => ({ width: 400, height: 400 }) };
  drawTraceChart(ctx, canvas, store, telemetry);
  assert.ok(texts.includes("Pin projection · H reversed · V reversed"));
  assert.ok(!texts.some((text) => text.includes("Legacy")));
  assert.ok(arcs.find(([, y, radius]) => radius === 5 && y < 200), "actual dashboard pin must move up");
  const physicalPin = arcs.find(([, , radius]) => radius === 5);
  texts.length = 0;
  arcs.length = 0;
  store.set({ targetViewMode: "normalized" });
  drawTraceChart(ctx, canvas, store, telemetry);
  assert.deepEqual(arcs.find(([, , radius]) => radius === 5), physicalPin,
    "live dashboard must not magnify small movements to fill the normalized target");
  assert.ok(texts.some((text) => text.includes("fixed live scale")));
  store.set({ targetViewMode: "physical" });
  assert.equal(layout.map(data[0]).x, 200);
  assert.equal(layout.map(data[0]).y, 200);
  assert.ok(layout.map(data[1]).x > 200, "rightward check must now appear right");
  assert.ok(layout.map(data[2]).y < 200, "upward check must now appear up");
  assert.equal(store.get().aim, data[2].aim);
  assert.equal(store.get().aim.horizontalSign, -1);
  assert.equal(store.get().aim.verticalSign, -1);
  const saved = JSON.parse(JSON.stringify(data));
  // A later capture or changed browser preference must not mirror saved data.
  store.set({ aimReference: makeReference("normal", 1) });
  const replay = aimTraceLayout(saved, options);
  for (let i = 0; i < saved.length; i++) {
    assert.deepEqual(replay.map(saved[i]), layout.map(data[i]));
  }
  texts.length = 0;
  arcs.length = 0;
  drawTraceChart(ctx, canvas, store, telemetry);
  assert.ok(texts.some((text) => text.includes("waiting for projected live data")));
  assert.ok(!texts.some((text) => text.includes("Legacy")), "a new capture cannot fall back to old cant/pitch");
  store.set({ aimReference: { ...reversed, horizontalSign: 1 } });
  texts.length = 0;
  drawTraceChart(ctx, canvas, store, telemetry);
  assert.ok(texts.some((text) => text.includes("directions do not match")));
  bus.emit("status", { mode: "reconnecting", text: "Reconnecting" });
  bus.emit("status", { mode: "live", text: "Connected" });
  texts.length = 0;
  arcs.length = 0;
  drawTraceChart(ctx, canvas, store, telemetry);
  assert.ok(texts.some((text) => text.includes("Pin tracking paused")));
  assert.ok(!texts.some((text) => text.includes("Legacy")));
  assert.ok(!arcs.some(([, , radius]) => radius === 5), "no misleading live pin before recapture");
});

test("tracking status checks the actual projected point instead of trusting capture preferences", () => {
  const ref = { id: "ref", horizontalSign: -1, verticalSign: -1 };
  assert.equal(aimTrackingStatus(ref, null).active, false);
  const point = {
    version: 1, referenceId: "ref", distanceMeters: 18, faceDiameterCm: 40,
    xMeters: 0.1, yMeters: 0.2,
  };
  assert.match(aimTrackingStatus(ref, point).reason, /directions do not match/);
  const corrected = { ...point, horizontalSign: -1, verticalSign: -1 };
  assert.equal(aimTrackingStatus(ref, corrected).active, true);
  assert.equal(aimTrackingStatus(ref, { ...corrected, xMeters: null }).active, false);
  assert.equal(aimTrackingStatus(ref, { ...corrected, referenceId: "old" }).active, false);
});
