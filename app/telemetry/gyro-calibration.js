export function gyroCalibrationBusy(state) {
  return state.gyroCalibration?.status === 1 || state.gyroCalibration?.status === 5;
}

function rejectionDetail(cal) {
  const d = cal.diagnostic;
  if (!d) return "the sensor did not report a specific cause (older firmware)";
  const elapsed = Number.isFinite(d.elapsedMs)
    ? (d.elapsedMs < 1000 ? ` after ${d.elapsedMs} ms` : ` after ${(d.elapsedMs / 1000).toFixed(1)} s`) : "";
  if (d.reason === 13) return `FIFO overflow/full detected${elapsed} (status ${d.observed})`;
  if (d.reason === 14) return `FIFO word alignment lost${elapsed}: expected ${d.limit}, received ${d.observed}`;
  if (d.reason === 15) return `I2C transfer failed${elapsed}: driver error ${d.observed}`;
  const checks = {
    1: ["invalid sample interval", "ms"],
    2: ["non-finite sensor data", ""],
    3: ["mean angular rate too high", "°/s"],
    4: ["mean acceleration differs from 1 g", "g"],
    5: ["acceleration changed during measurement", "g"],
    6: ["gyroscope noise (standard deviation)", "°/s"],
    7: ["too few samples", "samples"],
    8: ["acceleration noise (RMS)", "g"],
    9: ["gyroscope block means unstable", "°/s"],
    10: ["estimated bias error too large", "°/s"],
    11: ["gyroscope mean changed between measurement halves", "°/s"],
    12: ["sensor data interrupted (FIFO or I2C)", "gaps"],
  };
  const check = checks[d.reason];
  if (!check) return `unknown sensor check ${d.reason}`;
  const axis = ["", " X", " Y", " Z"][d.axis] ?? "";
  const numbers = d.reason !== 2 && Number.isFinite(d.observed) && Number.isFinite(d.limit)
    ? `: ${d.observed.toFixed(3)} ${check[1]}, ${d.reason === 7 ? "minimum" : "limit"} ${d.limit.toFixed(3)} ${check[1]}` : "";
  return `${check[0]}${axis}${elapsed}${numbers}`;
}

export function gyroCalibrationMessage(state) {
  if (!state.connected) return "Connect the sensor to calibrate its gyroscope.";
  if (state.statusMode === "demo") return "Gyroscope calibration requires the real sensor.";
  if (state.gyroCalibrationError) return state.gyroCalibrationError;
  const cal = state.gyroCalibration;
  if (!cal) return "Gyroscope status unavailable. This control requires firmware with gyro calibration support.";
  if (cal.status === 1) return cal.diagnostic?.phase === 1
    ? "Settling for 1 second — leave the bow on a stationary support. Measurement follows automatically."
    : `Measuring gyroscope bias: ${cal.progress}% — leave the bow on a stationary support.`;
  if (cal.status === 5) return "Saving gyroscope calibration…";
  if (cal.status === 3) return `Calibration rejected: ${rejectionDetail(cal)}. ${cal.valid ? "The previous bias is retained." : "No bias has been applied."} If the bow was stationary, copy this message for diagnosis.`;
  if (cal.status === 4) return "Bias applied for this session, but saving failed. Recalibrate after restarting the sensor.";
  if (cal.status === 2 && cal.valid) {
    const d = cal.diagnostic;
    const quality = d?.rawNoiseMaxDps > 0 && d.reason === 0 && Number.isFinite(d.observed)
      ? ` Raw noise up to ${d.rawNoiseMaxDps.toFixed(3)} °/s; estimated bias error ${d.observed.toFixed(3)} °/s.` : "";
    return `Gyroscope bias calibrated and saved.${quality} Aim at the target and capture the center again. Verify residual drift on the stationary support.`;
  }
  return "Place the bow on a stationary support, then press Calibrate gyroscope. Allow about 9 seconds: 1 second to settle, then 8 seconds of measurement.";
}
