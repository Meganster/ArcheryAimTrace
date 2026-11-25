import test from "node:test";
import assert from "node:assert/strict";
import { TelemetryStore } from "../app/telemetry/telemetry.js";
import { EventBus, createStore } from "../app/core/store.js";
import { groupShotsByTime } from "../app/core/db.js";
import { shotForDisplay, shotFloatScore, shotTimeLabel } from "../app/core/shot-record.js";
import { buildFirmwareTraceRecord, traceForReview } from "../app/protocol/trace.js";
import { buildSessionReview, buildSessionFloatPlot } from "../app/ui/session-review.js";
import { drawTraceChart, reviewTimeRangeUs } from "../app/ui/trace-chart.js";
import { BleAdapter } from "../app/device/adapters.js";
import { CloudSyncAdapter } from "../app/telemetry/sync.js";
import { parseBinaryTraceFrame } from "../app/protocol/frame.js";

const event = { stored: true, shotId: 23, shotCount: 23, axMg: 0, ayMg: 1000,
  azMg: 16000, rollDeg: 0.12, pitchDeg: -1.23, yawDeg: 179.99 };
const rawBytes = new Uint8Array(35);
const view = new DataView(rawBytes.buffer);
for (let i = 0; i < 5; i++) {
  view.setInt16(i * 7, 123, true);
  view.setInt16(i * 7 + 2, -234, true);
  view.setInt16(i * 7 + 4, i % 2 ? -17999 : 17999, true);
  view.setUint8(i * 7 + 6, i);
}

function setup(t) {
  t.mock.method(globalThis, "setInterval", () => 0);
  const tables = { shots: new Map(), shot_traces: new Map(), sync_queue: new Map() };
  let seq = 0;
  const db = {
    fail: null,
    async put(table, record) {
      if (db.fail === table) throw new Error("simulated storage failure");
      tables[table].set(record.id || record.shot_id || ++seq, structuredClone(record));
    },
    async get(table, key) { return structuredClone(tables[table].get(key)); },
    async getAll(table) { return structuredClone([...tables[table].values()]); },
  };
  const store = createStore({});
  const bus = new EventBus();
  const saved = [], logs = [];
  bus.on("shot-trace-saved", (value) => saved.push(value));
  bus.on("log", (value) => logs.push(value));
  const telemetry = new TelemetryStore(bus, store, db);
  async function upload(bytes = rawBytes, stride = 7) {
    const count = Math.ceil(bytes.length / 19);
    for (let i = 0; i < count; i++) await telemetry.onTraceChunk({ shotId: event.shotId,
      chunkIndex: i, totalChunks: count, pointStride: i === 0 ? stride : 0,
      payload: [...bytes.slice(i * 19, (i + 1) * 19)] });
  }
  return { db, store, bus, telemetry, saved, logs, upload };
}

test("offline event import cannot borrow live metrics, orientation or capture time", async (t) => {
  const { db, telemetry, store } = setup(t);
  store.set({ formScore: 99, holdStability: 98, releaseQuality: 97, followThrough: 96, yaw: -45 });
  await telemetry.onShot(event);
  const [shot] = await db.getAll("shots");
  assert.equal(shot.shot_score, null);
  assert.equal(shot.stability_score, null);
  assert.equal(shot.release_quality, null);
  assert.equal(shot.packet_loss_count, null);
  assert.equal(shot.recorded_at, null);
  assert.equal(shot.timestamp_kind, "imported");
  assert.equal(shot.yaw_angle_deg, 179.99);
  assert.deepEqual(shot.raw_event, event);
  assert.match(shotTimeLabel(shot), /Imported.*shot time unknown/);
  // Repeat in the same connection and after reconnect; original receipt time stays fixed.
  await telemetry.onShot(event);
  telemetry.bus.emit("status", { mode: "reconnecting" });
  await telemetry.onShot(event);
  assert.deepEqual(await db.getAll("shots"), [shot]);
  telemetry.bus.emit("status", { mode: "reconnecting" });
  await telemetry.onShot({ ...event, yawDeg: 12 });
  assert.equal((await db.getAll("shots")).length, 2, "same id with different measurements is not a duplicate");
});

test("raw firmware bytes survive import and retry; conflicting input cannot replace the original", async (t) => {
  const { db, telemetry, saved, upload, logs } = setup(t);
  await telemetry.onShot(event);
  await upload();
  const [trace] = await db.getAll("shot_traces");
  assert.deepEqual(trace.raw.bytes, [...rawBytes]);
  assert.equal(trace.analysis.result, null);
  assert.equal(trace.timing.releaseIndex, null);
  assert.equal(trace.payload[4].az, undefined);
  assert.equal(trace.payload[0].releaseTimingAvailable, false);
  assert.equal(saved.length, 1);
  trace.analysis.result = { futureAnalysis: 42 };
  await db.put("shot_traces", trace);
  await upload();
  assert.deepEqual((await db.getAll("shot_traces"))[0], trace);
  const changed = rawBytes.slice(); changed[0]++;
  await upload(changed);
  assert.deepEqual((await db.getAll("shot_traces"))[0], trace);
  assert.equal(saved.length, 2, "conflicting copy is not acknowledged");
  assert.ok(logs.some((line) => line.includes("differs from the saved original")));
});

test("partial, malformed and failed trace imports are not acknowledged", async (t) => {
  const { db, telemetry, saved, upload } = setup(t);
  await telemetry.onShot(event);
  await upload(rawBytes.slice(0, -1));
  assert.equal(saved.length, 0);
  assert.equal((await db.getAll("shot_traces")).length, 0);
  await telemetry.onTraceChunk({ shotId: 23, chunkIndex: 0, totalChunks: 2, pointStride: 7, payload: [...rawBytes.slice(0, 19)] });
  assert.equal(saved.length, 0);
  await telemetry.onTraceChunk({ shotId: 23, chunkIndex: 0, totalChunks: 3, pointStride: 7, payload: [0] });
  assert.equal(telemetry.pendingTraces.size, 0);
  db.fail = "shot_traces";
  await upload();
  assert.equal(saved.length, 0);
  assert.equal((await db.getAll("shots"))[0].trace_status, "downloading");
  db.fail = null;
  await upload();
  assert.equal(saved.length, 1);
});

test("calibrated browser recordings survive a firmware retry", async (t) => {
  const { db, telemetry, upload, saved } = setup(t);
  await telemetry.onShot(event);
  const [shot] = await db.getAll("shots");
  const trace = { shot_id: shot.id, source: "browser", payload: [{ aim: { version: 1 } }] };
  await db.put("shot_traces", trace);
  await upload();
  assert.deepEqual(await db.getAll("shot_traces"), [trace]);
  assert.equal(saved.length, 1);
});

test("unknown offline times form import batches, not inferred practice sessions", () => {
  const timestamp = "2026-10-21T12:00:00Z";
  const groups = groupShotsByTime([
    { id: "live", timestamp },
    { id: "a", timestamp, stored_upload: true, import_batch_id: "batch" },
    { id: "b", timestamp, stored_upload: true, import_batch_id: "batch" },
    { id: "legacy", timestamp, stored_upload: true },
  ]);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.find((group) => group.shots.length === 2).shots.map((s) => s.id), ["a", "b"]);
  assert.equal(groups.find((group) => group.shots.length === 2).timeKind, "imported");
});

test("old offline scores and synthetic acceleration are hidden without altering saved originals", () => {
  const shot = { id: "old", stored_upload: true, shot_score: 99, stability_score: 100, hold_stability: 98 };
  assert.equal(shotForDisplay(shot).shot_score, null);
  assert.equal(shotFloatScore(shot), null);
  assert.match(buildSessionReview([shot]), /not calculated/);
  assert.match(buildSessionFloatPlot([shot]), /Float Score Trend.*Unavailable/s);
  assert.equal(shot.shot_score, 99);
  const trace = { source: "firmware", payload: [{ roll: 1, pitch: 2, yaw: 3, ax: 0, ay: 0, az: 5 }] };
  assert.equal(traceForReview(trace).payload[0].az, undefined);
  assert.equal(trace.payload[0].az, 5);
});

test("offline review draws recorded angles without inventing a pin or release event", (t) => {
  const { store, telemetry } = setup(t);
  const originalDocument = globalThis.document, originalStyle = globalThis.getComputedStyle;
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalStyle === undefined) delete globalThis.getComputedStyle; else globalThis.getComputedStyle = originalStyle;
  });
  const trace = buildFirmwareTraceRecord({ localShotId: "test", rawBytes, bytesPerPoint: 7 });
  store.set({ reviewMode: true, reviewTrace: trace.payload, chartView: "target", reviewSampleRateHz: 52 });
  const texts = [];
  const ctx = new Proxy({}, { get: (_, key) => key === "fillText" ? (text) => texts.push(text) :
    key === "measureText" ? () => ({ width: 0 }) : () => {} });
  const canvas = { getBoundingClientRect: () => ({ width: 400, height: 400 }) };
  drawTraceChart(ctx, canvas, store, telemetry);
  assert.ok(texts.some((text) => text.includes("pin projection not calculated")));
  assert.equal(reviewTimeRangeUs(store.get(), trace.payload).start, 0);
  store.set({ chartView: "line" });
  drawTraceChart(ctx, canvas, store, telemetry);
  assert.ok(texts.some((text) => text.includes("release time unknown")));
});

test("BLE never acknowledges received bytes or timed-out downloads before durable save", (t) => {
  let timerId = 0;
  const timers = new Map();
  t.mock.method(globalThis, "setTimeout", (fn) => { timers.set(++timerId, fn); return timerId; });
  t.mock.method(globalThis, "clearTimeout", (id) => timers.delete(id));
  const bus = new EventBus();
  const adapter = new BleAdapter(bus);
  const acks = [], requests = [];
  adapter.ackShot = (id) => acks.push(id);
  adapter.requestTrace = (id) => requests.push(id);
  bus.emit("shot-saved", { stored: true, shotId: 23 });
  adapter._onTraceChunkReceived({ shotId: 23, chunkIndex: 0, totalChunks: 1 });
  assert.deepEqual(acks, []);
  for (let i = 0; i < 3; i++) {
    const timeout = timers.get(adapter.traceTimer);
    assert.ok(timeout);
    timeout();
  }
  assert.deepEqual(acks, []);
  assert.deepEqual(requests, [23, 23, 23]);
  bus.emit("shot-trace-saved", { deviceShotId: 24 });
  assert.deepEqual(acks, []);
  bus.emit("shot-trace-saved", { deviceShotId: 23 });
  assert.deepEqual(acks, [23]);
  bus.emit("shot-saved", { stored: true, shotId: 25 });
  bus.emit("shot-trace-unavailable", { deviceShotId: 25 });
  assert.deepEqual(acks, [23, 25]);
});

test("IndexedDB put resolves only after commit and rejects a post-request abort", async (t) => {
  const previous = globalThis.indexedDB;
  let tx, request;
  globalThis.indexedDB = { open: () => {
    const open = {};
    queueMicrotask(() => open.onsuccess({ target: { result: { transaction: () => {
      tx = { objectStore: () => ({ transaction: tx, put: () => { request = { result: "key" }; return request; } }) };
      return tx;
    } } } }));
    return open;
  } };
  t.after(() => { if (previous === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = previous; });
  const { put } = await import("../app/core/db.js?offline-transaction-test");
  let committed = false;
  const writing = put("shots", {}).then(() => { committed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  request.onsuccess?.();
  await Promise.resolve();
  assert.equal(committed, false);
  tx.oncomplete();
  await writing;
  assert.equal(committed, true);
  const aborting = put("shots", {});
  await new Promise((resolve) => setImmediate(resolve));
  tx.onabort();
  await assert.rejects(aborting, /aborted/);
});

test("cloud payload preserves import provenance and raw trace metadata", async () => {
  const payloads = [];
  const sb = { from: (table) => ({ upsert: async (payload) => { payloads.push({ table, payload }); return {}; } }) };
  const context = { user: { id: "user" }, reportedSchemaSkips: new Set(), bus: { emit() {} } };
  await CloudSyncAdapter.prototype.syncTask.call(context, sb, { table: "shots", action: "CREATE",
    payload: { id: "test", imported_at: "2026-10-21", recorded_at: null, raw_event: event, timestamp_kind: "imported" } });
  assert.deepEqual(payloads[0].payload.import_metadata.raw_event, event);
  assert.equal(payloads[0].payload.import_metadata.recorded_at, null);
  const trace = buildFirmwareTraceRecord({ localShotId: "test", rawBytes, bytesPerPoint: 7 });
  await CloudSyncAdapter.prototype.syncTask.call(context, sb, { table: "shot_traces", action: "UPDATE", payload: trace });
  assert.deepEqual(payloads[1].payload.metadata.raw.bytes, [...rawBytes]);
  assert.equal(payloads[1].payload.metadata.timing.releaseIndex, null);
});

test("trace frames cannot read payload outside the frame or declare invalid chunk indices", () => {
  const frame = new Uint8Array(29);
  frame.set([79, 70, 1, 6]);
  frame[7] = 1;
  frame[8] = 20;
  assert.equal(parseBinaryTraceFrame(frame), null);
  frame[8] = 7;
  frame[6] = 1;
  assert.equal(parseBinaryTraceFrame(frame), null);
  frame[6] = 0;
  assert.equal(parseBinaryTraceFrame(frame).payload.length, 7);
});
