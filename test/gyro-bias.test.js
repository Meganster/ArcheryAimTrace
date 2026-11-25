import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeBinaryFrame } from "../app/protocol/frame.js";
import { gyroCalibrationBusy, gyroCalibrationMessage } from "../app/telemetry/gyro-calibration.js";
import { aimCaptureReadiness } from "../app/telemetry/aim-capture.js";

test("firmware bias calibration removes constant drift, preserves real motion and rejects disturbed measurements", () => {
  const dir = mkdtempSync(join(tmpdir(), "openfloat-bias-"));
  const source = join(dir, "probe.c");
  writeFileSync(source, `
#include <assert.h>
#include "gyro_bias.h"
#include "imu_units.h"
int main(void) {
  assert(fabsf(1000 * OF_GYRO_2000DPS_RAD_PER_LSB * 57.295779513f - 70) < 1e-4f);
  assert(fabsf(-100 * OF_GYRO_2000DPS_RAD_PER_LSB * 57.295779513f + 7) < 1e-4f);
  struct of_gyro_bias cal = {0};
  float a[3] = {0,0,9.81f}, g[3] = {0.004f,-0.003f,0.005f}, out[3];
  of_gyro_bias_apply(&cal,g,out);
  assert(out[2] == g[2]);
  of_gyro_bias_start(&cal);
  for (int i=0;i<1100 && cal.status==1;i++) of_gyro_bias_update(&cal,a,g,0.01f);
  assert(cal.status==2 && cal.valid);
  of_gyro_bias_apply(&cal,g,out);
  for (int i=0;i<3;i++) assert(fabsf(out[i]) < 1e-7f);
  // No deadband or automatic learning: tiny real yaw remains measurable.
  g[2] += 0.0002f;
  for (int i=0;i<5000;i++) {
    of_gyro_bias_update(&cal,a,g,0.01f);
    of_gyro_bias_apply(&cal,g,out);
    assert(fabsf(out[2]-0.0002f)<1e-7f);
  }
  float old = cal.bias[2];
  of_gyro_bias_start(&cal);
  for (int i=0;i<130;i++) of_gyro_bias_update(&cal,a,g,0.01f);
  a[0]=0.5f;
  for (int i=0;i<30 && cal.status==1;i++) of_gyro_bias_update(&cal,a,g,0.01f);
  assert(cal.status==3 && cal.reason==OF_GYRO_ACCEL_SHIFT);
  assert(cal.observed>cal.limit);
  assert(cal.bias[2]==old && cal.valid);
  a[0]=0;
  of_gyro_bias_start(&cal);
  for (int i=0;i<1100 && cal.status==1;i++) {
    g[0]= cal.windows%2 ? 0.005f : -0.005f;
    of_gyro_bias_update(&cal,a,g,0.01f);
  }
  assert(cal.status==3 && cal.bias[2]==old && cal.reason==OF_GYRO_BLOCK_NOISE);
  assert(cal.axis==1 && cal.elapsed>=8);
  of_gyro_bias_start(&cal); g[0]=0.2f;
  for (int i=0;i<150 && cal.status==1;i++) of_gyro_bias_update(&cal,a,g,0.01f);
  assert(cal.status==3 && cal.reason==OF_GYRO_RATE && cal.axis==1);
  of_gyro_bias_start(&cal); g[0]=NAN;
  assert(of_gyro_bias_update(&cal,a,g,0.01f)==3);
  of_gyro_bias_start(&cal); g[0]=0;
  assert(of_gyro_bias_update(&cal,a,g,0)==3);
  // Same decision at 833 Hz output, legacy 1111 Hz, and lower rates. Startup movement
  // is excluded; isolated accel outliers and bounded noise do not cause failure.
  float rates[4]={0.0009f,0.0012f,0.002f,0.01f};
  for (int rate=0;rate<4;rate++) {
    of_gyro_bias_start(&cal);
    for (int i=0;i<15000 && cal.status==1;i++) {
      bool settling=cal.settling<OF_GYRO_SETTLE_SECONDS;
      a[0]=settling ? 2.0f : (i%2 ? 0.3924f : -0.3924f);
      g[0]=settling ? 0.5f : 0.004f + (i%2 ? 0.001f : -0.001f);
      if (!settling && cal.count==0) a[0]=0.5f;
      of_gyro_bias_update(&cal,a,g,rates[rate]);
    }
    assert(cal.status==2 && cal.reason==OF_GYRO_OK);
    assert(fabsf(cal.bias[0]-0.004f)<0.00002f);
  }
  old=cal.bias[2];
  of_gyro_bias_start(&cal); a[0]=0; a[2]=8.5f; g[0]=0;
  for (int i=0;i<200 && cal.status==1;i++) of_gyro_bias_update(&cal,a,g,0.01f);
  assert(cal.status==3 && cal.reason==OF_GYRO_GRAVITY);
  assert(cal.observed>0.13f && cal.limit==0.05f && cal.bias[2]==old);
  of_gyro_bias_start(&cal); a[2]=9.81f;
  for (int i=0;i<200 && cal.status==1;i++) {
    a[0]=i%2 ? 1.0f : -1.0f;
    of_gyro_bias_update(&cal,a,g,0.01f);
  }
  assert(cal.status==3 && cal.reason==OF_GYRO_ACCEL_NOISE && cal.bias[2]==old);
  // Regression: measured 1.606 dps under the OLD conversion corresponds to
  // 1.842 dps at the datasheet's 70 mdps/LSB. Stable broadband noise must not
  // be confused with instability of its DC mean. Deterministic white-noise
  // simulation, not a recording of the user's device.
  uint32_t random=4321;
  a[0]=0; a[2]=9.81f;
  of_gyro_bias_start(&cal);
  for (int i=0;i<15000 && cal.status==1;i++) {
    for (int axis=0;axis<3;axis++) {
      random = random * 1664525u + 1013904223u;
      float noise=((float)(random>>8)/16777216.0f * 2 - 1) * 1.7320508f * 1.606f * 1.14688f;
      float truth[3]={0.004f,-0.003f,0.005f};
      g[axis]=truth[axis] + noise / 57.295779513f;
    }
    of_gyro_bias_update(&cal,a,g,0.0009f);
  }
  assert(cal.status==2 && cal.valid);
  assert(cal.raw_noise_dps[0]>1.7f && cal.raw_noise_dps[0]<2.0f);
  assert(cal.error_dps[0]<OF_GYRO_ERROR_LIMIT_DPS);
  assert(fabsf(cal.bias[0]-0.004f)*57.295779513f<0.05f);
  // A stable block mean must not hide extreme raw noise, a slow change in
  // DC level, or an insufficiently precise estimate. Each preserves old bias.
  for (int mode=0;mode<3;mode++) {
    old=cal.bias[0];
    of_gyro_bias_start(&cal);
    g[1]=g[2]=0;
    for (int i=0;i<15000 && cal.status==1;i++) {
      float dps = mode==0 ? (i%2 ? 6.0f : -6.0f)
        : mode==1 ? (cal.windows<16 ? 0.07f : -0.07f)
        : (cal.windows%2 ? 0.143f : -0.143f);
      g[0]=dps / 57.295779513f;
      of_gyro_bias_update(&cal,a,g,0.0009f);
    }
    assert(cal.status==3 && cal.bias[0]==old);
    assert(cal.reason==(mode==0 ? OF_GYRO_NOISE : mode==1 ? OF_GYRO_TREND : OF_GYRO_MEAN_ERROR));
  }
  of_gyro_bias_start(&cal);
  of_gyro_bias_reject(&cal,OF_GYRO_STREAM_GAP,0,1,0);
  assert(cal.status==3 && cal.bias[0]==old);
  int32_t record[4]={2,100,-200,300};
  of_gyro_bias_restore(&cal,record,2);
  assert(cal.status==2 && cal.valid && cal.bias[1]<0);
  assert(fabsf(cal.bias[2]-300.0f/57295.779513f)<1e-7f);
  of_gyro_bias_restore(&cal,record,0);
  assert(!cal.valid && cal.status==0);
  record[1]=5001;
  of_gyro_bias_restore(&cal,record,2);
  assert(!cal.valid);
  return 0;
}
`);
  try {
    const binary = join(dir, "probe");
    const compiled = spawnSync("cc", ["-std=c99", "-Wall", "-Wextra", "-Werror", "-I", fileURLToPath(new URL("../firmware/src/", import.meta.url)), source, "-lm", "-o", binary], { encoding: "utf8" });
    assert.equal(compiled.status, 0, compiled.stderr);
    const run = spawnSync(binary, [], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("gyro calibration status decodes independently of live orientation, including signed bias and batched offsets", () => {
  const bytes = new Uint8Array(58);
  bytes.set([79,70,1,8,2,1,100], 29);
  const view = new DataView(bytes.buffer);
  view.setInt16(37, -125, true);
  view.setInt16(39, 230, true);
  view.setInt16(41, -5, true);
  const decoded = decodeBinaryFrame(bytes, 29);
  assert.equal(decoded.kind, "gyro-calibration");
  assert.equal(decoded.byteLength, 29);
  assert.deepEqual(decoded.gyroCalibration, {status:2,valid:true,progress:100,biasDps:[-0.125,0.23,-0.005]});
  // Extension is opt-in; older frames retain their original shape.
  bytes[55]=1;
  bytes[36]=6;
  bytes[53]=3;
  bytes[54]=2;
  view.setFloat32(43, 0.42, true);
  view.setFloat32(47, 0.15, true);
  view.setUint16(51, 4100, true);
  const diagnostic=decodeBinaryFrame(bytes,29).gyroCalibration.diagnostic;
  assert.equal(diagnostic.reason,6);
  assert.equal(diagnostic.axis,3);
  assert.equal(diagnostic.phase,2);
  assert.equal(diagnostic.elapsedMs,4100);
  assert.ok(Math.abs(diagnostic.observed-0.42)<1e-6);
  assert.ok(Math.abs(diagnostic.limit-0.15)<1e-6);
  bytes[55]=2;
  view.setUint16(56,1842,true);
  assert.equal(decodeBinaryFrame(bytes,29).gyroCalibration.diagnostic.rawNoiseMaxDps,1.842);
  bytes[33]=9;
  assert.equal(decodeBinaryFrame(bytes,29),null);
  bytes[32]=9;
  assert.equal(decodeBinaryFrame(bytes,29),null, "unknown management frames must never become live orientations");
});

test("capture is blocked during gyro calibration and failure is not presented as success", () => {
  const state = {connected:true,statusMode:"live",sample:{},lastSampleReceivedAt:100,aimAxesVerified:true,roll:0,pitch:0,yaw:0};
  for (const status of [1,5]) {
    const busy={...state,gyroCalibration:{status,progress:50}};
    assert.equal(gyroCalibrationBusy(busy),true);
    assert.equal(aimCaptureReadiness(busy,100).ready,false);
  }
  assert.match(gyroCalibrationMessage({...state,gyroCalibration:{status:3}}),/rejected/);
  assert.match(gyroCalibrationMessage({...state,gyroCalibration:{status:4,valid:true}}),/saving failed/);
  assert.match(gyroCalibrationMessage({...state,gyroCalibration:{status:2,valid:true}}),/calibrated and saved/);
  assert.match(gyroCalibrationMessage(state),/requires firmware/);
});

test("calibration reports measured rejection cause and distinguishes settling and missing old bias", () => {
  const state={connected:true,statusMode:"live"};
  const message=(cal)=>gyroCalibrationMessage({...state,gyroCalibration:cal});
  assert.match(message({status:1,diagnostic:{phase:1}}),/Settling for 1 second/);
  assert.match(message({status:1,progress:50,diagnostic:{phase:2}}),/50%/);
  const diagnostic={reason:6,axis:3,observed:0.42,limit:0.15,elapsedMs:4100};
  const rejected=message({status:3,valid:true,diagnostic});
  assert.match(rejected,/gyroscope noise .* Z after 4.1 s: 0.420 °\/s, limit 0.150 °\/s/);
  assert.match(rejected,/previous bias is retained/);
  assert.match(message({status:3,valid:false,diagnostic}),/No bias has been applied/);
  assert.match(message({status:3}),/older firmware/);
  for (let reason=1;reason<=15;reason++) {
    const detail=message({status:3,diagnostic:{...diagnostic,reason}});
    assert.doesNotMatch(detail,/unknown sensor check/);
  }
  assert.doesNotMatch(message({status:3,diagnostic:{reason:1,observed:NaN,limit:20}}),/NaN|undefined/);
  assert.match(message({status:3,diagnostic:{reason:13,elapsedMs:12,observed:96}}),/FIFO overflow.*after 12 ms/);
  assert.match(message({status:3,diagnostic:{reason:14,elapsedMs:15,observed:2,limit:0}}),/expected 0, received 2/);
  assert.match(message({status:3,diagnostic:{reason:15,elapsedMs:6,observed:-5}}),/I2C transfer failed after 6 ms: driver error -5/);
  const success=message({status:2,valid:true,diagnostic:{reason:0,rawNoiseMaxDps:1.842,observed:0.019}});
  assert.match(success,/Raw noise up to 1.842 °\/s; estimated bias error 0.019 °\/s/);
  assert.match(success,/Verify residual drift/);
});
