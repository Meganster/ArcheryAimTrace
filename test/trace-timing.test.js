import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFirmwareTraceBytes, buildFirmwareTraceRecord, traceForReview } from "../app/protocol/trace.js";
import { parseBinaryTraceFrame } from "../app/protocol/frame.js";
import { TelemetryStore } from "../app/telemetry/telemetry.js";
import { EventBus, createStore } from "../app/core/store.js";
import { drawTraceChart, reviewTimeRangeUs } from "../app/ui/trace-chart.js";

const firmware = readFileSync(new URL("../firmware/src/main.c", import.meta.url), "utf8");

test("production ring freeze produces verifiable timing across follow windows, gaps and restarts", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "openfloat-timing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const structures = firmware.slice(firmware.indexOf("struct trace_point {"), firmware.indexOf("static struct trace_point ram_trace_buffer"));
  const functions = firmware.slice(firmware.indexOf("static void ram_trace_push("), firmware.indexOf("struct trace_load_context"));
  const upload = firmware.slice(firmware.indexOf("static void trace_upload_work_handler("), firmware.indexOf("static const struct bt_data ad[]"));
  const loader = firmware.slice(firmware.indexOf("struct trace_load_context"), firmware.indexOf("static bool trace_load_for_upload("));
  const code = `
#include <assert.h>
#include <errno.h>
#include <sys/types.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "trace_timing.h"
#include "imu_stream.h"
#define __packed __attribute__((packed))
#define BUILD_ASSERT(a,b) _Static_assert(a,b)
#define BIT(n) (1u<<(n))
#define printk(...) ((void)0)
#define TRACE_CAPACITY 260
#define TRACE_SCHEMA_VERSION 3
#define TRACE_MAGIC 0x4f465432u
#define TRACE_PERSIST_STAGING_SLOTS 2
#define OFFLINE_TRACE_SLOT_COUNT 80
#define OPENFLOAT_MOUNT 2
${structures}
static struct trace_point ram_trace_buffer[TRACE_CAPACITY];
static uint64_t ram_trace_ticks[TRACE_CAPACITY];
static uint64_t trace_output_tick, trace_event_tick, trace_due_tick, trace_event_uptime;
static uint32_t trace_boot_id = 7, trace_decimate_counter;
static uint16_t trace_event_flags, trace_event_follow_ms;
static struct stored_trace trace_persist_buffers[2];
static uint16_t ram_trace_count, ram_trace_write_idx;
static unsigned trace_persist_pending_mask;
static unsigned trace_persist_next_slot;
static int trace_persist_work, buffer_nvs_enabled = 1;
static bool trace_freeze_pending;
static uint32_t trace_freeze_shot_id, follow_through_ms = 1500;
static unsigned atomic_get(unsigned *p) { return *p; }
static void atomic_or(unsigned *p, unsigned v) { *p |= v; }
static void k_work_submit(int *p) { (void)p; }
static uint64_t k_uptime_ticks(void) { return 9000000; }
static uint64_t k_ticks_to_us_floor64(uint64_t n) { return n; }
struct k_work {};
static bool ble_notify_enabled = true, trace_upload_in_progress;
static int trace_upload_chunk_idx, trace_upload_work;
static struct stored_trace trace_upload_buffer;
static struct { int attrs[3]; } openfloat_svc;
#define OPENFLOAT_BLE_FRAME_SIZE 29
#define TRACE_CHUNK_PAYLOAD_SIZE 19
#define K_MSEC(n) (n)
#define ARG_UNUSED(n) ((void)(n))
typedef ssize_t (*settings_read_cb)(void *, void *, size_t);
static ssize_t read_stored(void *arg, void *out, size_t size) { memcpy(out,arg,size); return (ssize_t)size; }
static void k_work_reschedule(int *work, int ms) { (void)work; (void)ms; }
static void put_u16_le(uint8_t *out, unsigned offset, unsigned value) { of_trace_put(out+offset,value,2); }
static int bt_gatt_notify(void *conn, int *attr, const void *data, size_t size) {
  (void)conn; (void)attr; fwrite(data,1,size,stdout); return 0;
}
${loader}
${upload}
static uint8_t trace_mic_amp_byte(void) { return 17; }
${functions}
static void tick(uint64_t n) {
  trace_output_tick = n;
  if (++trace_decimate_counter >= OF_OFFLINE_TRACE_STRIDE) {
    trace_decimate_counter = 0;
    ram_trace_push(9000, -123, 17999);
  }
  if (trace_freeze_pending && n >= trace_due_tick && trace_decimate_counter == 0)
    trace_freeze_pending_slot();
}
int main(int argc, char **argv) {
  int mode = argc > 1 ? atoi(argv[1]) : 0;
  assert(of_trace_follow_ticks(1500,1666,2) == 1250);
  assert(of_trace_event_index(-17,16,4) == 2);
  assert(of_trace_event_index(1,16,4) == UINT16_MAX);
  if (mode == 1) follow_through_ms = 0;
  if (mode == 2) follow_through_ms = 3000;
  if (mode == 6) trace_boot_id = 8;
  if (mode == 7) trace_boot_id = 0;
  uint64_t event = mode == 3 ? 40 : 3001;
  if (mode == 14) { event = 0; follow_through_ms = 0; }
  for (uint64_t i=1; i<=event; i++) tick(i);
  schedule_trace_freeze(70001, mode == 8);
  // Mid-window settings changes must not alter the recorded deadline.
  if (mode == 9) follow_through_ms = 3000;
  for (uint64_t i=event+1; i<=event+5000 && trace_freeze_pending; i++) {
    tick(i);
    if (mode == 4 && i == event+40) { trace_stream_gap(); break; }
    if (mode == 5 && i == event+40) { schedule_trace_freeze(70002,false); break; }
  }
  struct stored_trace *out = &trace_persist_buffers[0];
  assert(out->version == 3 && out->count > 0 && out->count <= 260);
  assert(sizeof(struct stored_trace) * 80 == 150720);
  if (mode == 12) {
    struct trace_load_context ctx = {.shot_id=70001};
    struct stored_trace old = *out;
    old.version = 2;
    assert(trace_load_direct("",sizeof(old)-OF_TRACE_HEADER_SIZE,read_stored,&old,&ctx) == 1);
    assert(ctx.loaded && trace_upload_buffer.version == 2);
    for (unsigned i=0; i<OF_TRACE_HEADER_SIZE; i++) assert(trace_upload_buffer.timing[i] == 0);
    ctx.loaded = false;
    assert(trace_load_direct("",sizeof(*out),read_stored,out,&ctx) == 1);
    assert(ctx.loaded && trace_upload_buffer.version == 3);
    ctx.loaded = false;
    assert(trace_load_direct("",sizeof(*out)-OF_TRACE_HEADER_SIZE,read_stored,out,&ctx) == 0);
    assert(!ctx.loaded);
  }
  if (mode == 10 || mode == 11) {
    trace_upload_buffer = *out;
    if (mode == 11) trace_upload_buffer.version = 2;
    trace_upload_in_progress = true;
    while (trace_upload_in_progress) trace_upload_work_handler(NULL);
    return 0;
  }
  fwrite(out->timing, 1, OF_TRACE_HEADER_SIZE, stdout);
  fwrite(out->points, 7, out->count, stdout);
}
`;
  writeFileSync(join(dir, "timing.c"), code);
  const compiled = spawnSync("cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-Wno-unused-parameter", "-I",
    fileURLToPath(new URL("../firmware/src", import.meta.url)), join(dir, "timing.c"), "-o", join(dir, "timing")], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const run = (mode = 0) => {
    const result = spawnSync(join(dir, "timing"), [String(mode)]);
    assert.equal(result.status, 0, String(result.stderr));
    return new Uint8Array(result.stdout);
  };
  const bytes = run();
  run(12); // Actual storage loader accepts v2 in place, v3 and rejects a truncated v3.
  for (const mode of [10, 11]) {
    const stream = run(mode);
    const packets = [];
    for (let i=0; i<stream.length; i+=29) packets.push(parseBinaryTraceFrame(stream, i));
    assert.ok(packets.every(Boolean));
    const data = new Uint8Array(packets.flatMap((packet) => packet.payload));
    const format = packets[0].pointStride;
    assert.equal(format, mode === 10 ? 0x83 : 7);
    assert.equal(packets.length, packets[0].totalChunks);
    if (mode === 10) assert.deepEqual(data, bytes);
    assert.equal(decodeFirmwareTraceBytes(data, format).trace.length, 260);
  }
  const normal = decodeFirmwareTraceBytes(bytes, 0x83);
  assert.equal(normal.timing.shotId, 70001);
  assert.equal(normal.timing.bootId, 7);
  assert.equal(normal.timing.completeness, "complete");
  assert.equal(normal.timing.releaseIndex, 181);
  assert.equal(normal.trace[181].detectorEvent, true);
  assert.ok(normal.trace[180].tUs < 0 && normal.trace[181].tUs >= 0);
  assert.ok(normal.trace.at(-1).tUs >= 1500000);
  assert.ok(normal.trace.at(-1).tUs < 1500000 + normal.timing.samplePeriodUs);
  assert.equal(normal.timing.samplePeriodUs, 32000000 / 1666);
  assert.equal(normal.trace[0].roll, 90);
  const record = buildFirmwareTraceRecord({ localShotId: "example", rawBytes: bytes, bytesPerPoint: 0x83, deviceShotId: 70001 });
  assert.equal(record.sample_rate_hz, 52.0625);
  assert.equal(record.mic_series[0].tUs, record.payload[0].tUs);
  assert.equal(traceForReview(record).payload[181].releaseTimingAvailable, true);
  assert.deepEqual(record.analysis.reasons, ["aim_reference_missing"]);
  assert.throws(() => buildFirmwareTraceRecord({ localShotId: "wrong", rawBytes: bytes, bytesPerPoint: 0x83, deviceShotId: 1 }), /different device shot/);
  for (const [mode, follow] of [[1, 0], [2, 3000], [9, 1500]]) {
    const result = decodeFirmwareTraceBytes(run(mode), 0x83);
    assert.equal(result.timing.requestedFollowThroughMs, follow);
    assert.ok(result.trace.at(-1).tUs >= follow * 1000);
    assert.ok(result.trace.at(-1).tUs < follow * 1000 + result.timing.samplePeriodUs);
  }
  assert.equal(decodeFirmwareTraceBytes(run(3), 0x83).timing.preTruncated, true);
  const gap = decodeFirmwareTraceBytes(run(4), 0x83);
  assert.equal(gap.timing.dataGap, true);
  assert.equal(gap.timing.postTruncated, true);
  assert.equal(decodeFirmwareTraceBytes(run(5), 0x83).timing.postTruncated, true);
  assert.equal(decodeFirmwareTraceBytes(run(7), 0x83).timing.bootIdentityUnknown, true);
  assert.equal(decodeFirmwareTraceBytes(run(8), 0x83).timing.simulated, true);
  const outside = decodeFirmwareTraceBytes(run(14), 0x83);
  assert.equal(outside.timing.releaseIndex, null);
  assert.equal(outside.timing.eventOutside, true);
  for (const at of [8, 12, 24, 32, 40, 48, 55, bytes.length - 1]) {
    const bad = bytes.slice(); bad[at] ^= 1;
    assert.throws(() => decodeFirmwareTraceBytes(bad, 0x83), /checksum/);
  }
  assert.throws(() => decodeFirmwareTraceBytes(bytes.slice(0, -7), 0x83), /checksum/);

  await t.test("review shows detector time without fabricating a pin or arrow-release marker", (t) => {
    const oldDocument = globalThis.document, oldStyle = globalThis.getComputedStyle;
    globalThis.document = { documentElement: {} };
    globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
    t.after(() => {
      if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
      if (oldStyle === undefined) delete globalThis.getComputedStyle; else globalThis.getComputedStyle = oldStyle;
    });
    const store = createStore({ reviewMode: true, reviewTrace: record.payload,
      reviewMicSeries: record.mic_series, reviewSampleRateHz: record.sample_rate_hz,
      reviewDetectorTiming: true, reviewReleaseIdx: record.timing.releaseIndex,
      reviewReleaseTimeMs: 0, chartView: "line" });
    const labels = [];
    const ctx = new Proxy({}, { get: (_, key) => key === "fillText" ? (text) => labels.push(text) :
      key === "measureText" ? () => ({ width: 0 }) :
      ["moveTo", "lineTo"].includes(key) ? (...values) => assert.ok(values.every(Number.isFinite)) : () => {} });
    const canvas = { getBoundingClientRect: () => ({ width: 600, height: 400 }) };
    drawTraceChart(ctx, canvas, store, { getTrace: () => [] });
    assert.ok(labels.includes("DETECTOR"), JSON.stringify({ labels, first: record.mic_series[0], range: reviewTimeRangeUs(store.get(), record.payload) }));
    assert.ok(!labels.includes("RELEASE"));
    labels.length = 0;
    store.set({ reviewMicSeries: record.mic_series.map((point) => ({ ...point, micAmp: 0 })) });
    drawTraceChart(ctx, canvas, store, { getTrace: () => [] });
    assert.ok(labels.includes("DETECTOR"), "silent audio must not hide a known detector event");
    const range = reviewTimeRangeUs(store.get(), record.payload);
    assert.ok(range.start < 0 && range.end > 0);
    store.set({ chartView: "target" });
    drawTraceChart(ctx, canvas, store, { getTrace: () => [] });
    assert.ok(labels.some((label) => label.includes("pin projection not calculated")));
  });

  await t.test("timed import is idempotent, persists timing and separates reboot identities", async (t) => {
    t.mock.method(globalThis, "setInterval", () => 0);
    const tables = { shots: new Map(), shot_traces: new Map(), sync_queue: new Map() };
    let queueId = 0;
    const db = {
      async put(table, value) { tables[table].set(value.id || value.shot_id || ++queueId, structuredClone(value)); },
      async get(table, id) { return structuredClone(tables[table].get(id)); },
      async getAll(table) { return structuredClone([...tables[table].values()]); },
    };
    const bus = new EventBus(), store = createStore({}), telemetry = new TelemetryStore(bus, store, db);
    const event = { shotId: 70001, stored: true, shotCount: 100, axMg: 0, ayMg: 1000, azMg: 10000,
      rollDeg: 90, pitchDeg: -1.23, yawDeg: 179.99 };
    const upload = async (raw) => {
      await telemetry.onShot(event);
      for (let i = 0; i < raw.length; i += 19) await telemetry.onTraceChunk({ shotId: 70001,
        chunkIndex: i / 19, totalChunks: Math.ceil(raw.length / 19), pointStride: i === 0 ? 0x83 : 0,
        payload: [...raw.slice(i, i + 19)] });
    };
    await upload(bytes);
    const [shot] = await db.getAll("shots");
    assert.equal(shot.device_boot_id, 7);
    assert.equal(shot.device_event_uptime_us, 9000000);
    assert.equal(shot.recorded_at, null, "uptime must not be presented as wall-clock capture time");
    const savedTrace = await db.get("shot_traces", shot.id);
    assert.equal(savedTrace.analysis.status, "calculated");
    assert.equal(savedTrace.analysis.kind, "per-shot-relative");
    assert.ok(traceForReview(savedTrace).payload.every((p) => p.aim?.referenceType === "per-shot-relative"));
    assert.ok(savedTrace.payload.every((p) => !p.aim), "raw angles never overwritten");
    assert.equal(shot.offline_analysis.status, "calculated");
    store.set({ offlineAnalysisParameters: { distanceMeters: 70, faceDiameterCm: 122 } });
    bus.emit("status", { mode: "reconnecting" });
    await upload(bytes);
    assert.equal((await db.getAll("shots")).length, 1);
    assert.deepEqual((await db.get("shot_traces", shot.id)).analysis, savedTrace.analysis, "retry retains saved geometry");
    bus.emit("status", { mode: "reconnecting" });
    await upload(run(6));
    assert.equal((await db.getAll("shots")).length, 2);
    assert.equal((await db.getAll("shot_traces")).length, 2);
    assert.deepEqual((await db.getAll("shot_traces"))[0].raw.bytes, [...bytes]);
  });
});
