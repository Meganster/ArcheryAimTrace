import { aimDirection, validAimPoint } from "./aim-projection.js?v=aim-pipeline-163";
import { gyroCalibrationBusy } from "./gyro-calibration.js?v=aim-pipeline-163";

export const AIM_SAMPLE_MAX_AGE_MS = 2000;

// Report what telemetry actually projected, rather than only the checkbox or
// captured preference. This also exposes mixed cached module versions.
export function aimTrackingStatus(reference, aim) {
  const blocked = (reason) => ({ active: false, reason });
  if (!reference) return blocked("Capture the aiming center to start relative pin tracking.");
  if (!aim || aim.referenceId !== reference.id) {
    return blocked("Center captured — waiting for projected live data. If this persists, reload the page.");
  }
  const horizontalSign = reference.horizontalSign ?? 1;
  const verticalSign = reference.verticalSign ?? 1;
  if ((aim.horizontalSign ?? 1) !== horizontalSign || (aim.verticalSign ?? 1) !== verticalSign) {
    return blocked("Projection directions do not match the capture. Reload the page to update all tracking modules.");
  }
  if (!validAimPoint(aim)) {
    return blocked("Pin cannot be projected onto this target plane. Aim toward the captured center.");
  }
  return {
    active: true,
    reason: `Relative aim active · ${aim.distanceMeters} m · horizontal ${horizontalSign === -1 ? "reversed" : "normal"} · vertical ${verticalSign === -1 ? "reversed" : "normal"}`,
  };
}

// Use receipt time, not the previous one-second FPS bucket or device clock.
export function aimCaptureReadiness(state, now = performance.now()) {
  const blocked = (reason) => ({ ready: false, reason });
  if (state.reviewMode) return blocked("Exit Review to return to the live sensor before capturing the center.");
  if (!state.connected) return blocked("Connect the sensor before capturing the center.");
  if (gyroCalibrationBusy(state)) return blocked("Wait for gyroscope calibration to finish before capturing the center.");
  if (!state.sample || !Number.isFinite(state.lastSampleReceivedAt)) {
    return blocked("Waiting for live sensor data.");
  }
  const age = now - state.lastSampleReceivedAt;
  if (!Number.isFinite(age) || age < 0 || age > AIM_SAMPLE_MAX_AGE_MS) {
    return blocked("Sensor data stopped. Check the connection or reconnect the sensor.");
  }
  if (!state.aimAxesVerified) return blocked("Check the firmware axes, then tick the checkbox above.");
  const forward = aimDirection(state);
  if (!forward) return blocked("Waiting for valid sensor orientation.");
  if (Math.hypot(forward[0], forward[1]) < 1e-9) {
    return blocked("Point the bow toward the target, not vertically, before capturing the center.");
  }
  return { ready: true, reason: "Ready: select the distance, hold the pin at the center, then press Pin at center — capture." };
}
