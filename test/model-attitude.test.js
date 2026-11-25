import test from 'node:test';
import assert from 'node:assert/strict';
import { calibratedModelPose, modelDisplayRotation } from '../app/ui/bow-3d.js';

const radians = value => value * Math.PI / 180;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('model cant and pitch retain calibrator directions at nonzero calibration origins', () => {
  for (const [roll, pitch, yaw] of [[0, 0, 0], [143.9, 80.5, -149], [-170, -60, 175]]) {
    const settings = { cantOffset: roll, pitchOffset: pitch, yawOffset: yaw };
    const zero = calibratedModelPose({ roll, pitch, yaw }, settings);
    close(zero.x, 0); close(zero.y, 0); close(zero.z, 0);
    for (const delta of [-25, 25]) {
      const cant = calibratedModelPose({ roll: roll + delta, pitch, yaw }, settings);
      close(cant.x, radians(delta)); close(cant.y, 0); close(cant.z, 0);
      const tilt = calibratedModelPose({ roll, pitch: pitch + delta, yaw }, settings);
      close(tilt.x, 0); close(tilt.y, 0); close(tilt.z, -radians(delta));
    }
  }
});

test('live quaternion presence and recorded Euler samples use the same display calibration', () => {
  const settings = { cantOffset: 143.9, pitchOffset: 80.5, yawOffset: 175 };
  const recorded = { roll: 159.1, pitch: 82.8, yaw: -175 };
  // These are supplementary transport fields; display uses the same derived
  // angles as the calibrator, rather than applying another quaternion zero.
  const live = { ...recorded, qw: 0.5, qx: 0.5, qy: 0.5, qz: 0.5 };
  const original = JSON.stringify({ live, settings });
  assert.deepEqual(calibratedModelPose(live, settings), calibratedModelPose(recorded, settings));
  close(calibratedModelPose(live, settings).y, radians(10));
  assert.equal(JSON.stringify({ live, settings }), original);
});

test('Dashboard and calibrator share axis options; preview adds only its fixed heading', () => {
  for (const modelInvertRoll of [false, true]) {
    for (const modelInvertPitch of [false, true]) {
      for (const modelSwapRollPitch of [false, true]) {
        for (const modelIgnoreYaw of [false, true]) {
          const settings = { modelInvertRoll, modelInvertPitch, modelSwapRollPitch, modelIgnoreYaw };
          const main = calibratedModelPose({ roll: 15.2, pitch: -2.3, yaw: -91.5 }, settings);
          const preview = modelDisplayRotation(main.roll, main.pitch, main.yaw, settings, 12);
          close(main.x, preview.x); close(main.z, preview.z);
          close(preview.y - main.y, radians(12));
          close(main.y, modelIgnoreYaw ? 0 : radians(-91.5));
          assert.equal(main.order, 'XYZ');
        }
      }
    }
  }
});
