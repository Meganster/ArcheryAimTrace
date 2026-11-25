// Decode firmware-uploaded shot trace byte streams and build shot_traces records.

export const FIRMWARE_TRACE_STRIDE_LEGACY = 6;
export const FIRMWARE_TRACE_STRIDE_WITH_MIC = 7;
export const FIRMWARE_TRACE_TIMED_FORMAT = 0x83;

function traceCrc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    if (i >= 48 && i < 52) continue;
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (~crc) >>> 0;
}

function decodeTimedTrace(bytes) {
  if (bytes.length < 52) throw new Error("Incomplete timed trace header");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0, true) !== 0x3354464f || v.getUint16(4, true) !== 3 || v.getUint16(6, true) !== 52)
    throw new Error("Unsupported timed trace header");
  if (v.getUint32(48, true) !== traceCrc32(bytes)) throw new Error("Timed trace checksum mismatch");
  const count = v.getUint16(38, true), stride = v.getUint16(36, true);
  const numerator = v.getUint32(16, true), denominator = v.getUint32(20, true);
  const firstTick = v.getInt32(32, true), flags = v.getUint16(42, true);
  const eventIndex = v.getUint16(40, true), bootId = v.getUint32(12, true);
  const uptime = Number(v.getBigUint64(24, true));
  if (count < 1 || count > 260 || bytes.length !== 52 + count * 7 || !stride || stride > 4096 ||
      !numerator || !denominator || denominator > 100000 || flags & ~63 ||
      !Number.isSafeInteger(uptime) || (!bootId && !(flags & 8)) || v.getUint16(44, true) > 3000)
    throw new Error("Invalid timed trace metadata");
  const expectedIndex = firstTick <= 0 ? Math.ceil(-firstTick / stride) : -1;
  const inside = expectedIndex >= 0 && expectedIndex < count;
  if ((inside && eventIndex !== expectedIndex) || (!inside && eventIndex !== 65535) ||
      Boolean(flags & 16) !== !inside) throw new Error("Inconsistent detector event index");
  const periodUs = numerator / denominator, tickUs = periodUs / stride;
  const timing = {
    version: 3, shotId: v.getUint32(8, true), bootId: bootId || null,
    eventUptimeUs: uptime, eventTimeSource: "device-processing-uptime",
    samplePeriodNumeratorUs: numerator, samplePeriodDenominator: denominator,
    samplePeriodUs: periodUs, sampleRateSource: "configured-odr",
    firstSampleTick: firstTick, ticksPerSample: stride,
    releaseIndex: inside ? eventIndex : null, releaseTimeSource: "detector-event",
    eventOffsetWithinSampleUs: inside ? (firstTick + eventIndex * stride) * tickUs : null,
    flags, preTruncated: Boolean(flags & 1), postTruncated: Boolean(flags & 2),
    dataGap: Boolean(flags & 4), bootIdentityUnknown: Boolean(flags & 8),
    eventOutside: Boolean(flags & 16), simulated: Boolean(flags & 32),
    completeness: flags & 7 ? "partial" : "complete",
    requestedFollowThroughMs: v.getUint16(44, true), mountProfile: v.getUint16(46, true),
  };
  const { trace } = decodeFirmwareTraceBytes(bytes.subarray(52), 7);
  trace.forEach((point, i) => Object.assign(point, {
    tUs: (firstTick + i * stride) * tickUs,
    releaseTimingAvailable: inside,
    detectorEvent: inside && i === eventIndex,
  }));
  return { trace, bytesPerPoint: 7, timing, wireFormat: FIRMWARE_TRACE_TIMED_FORMAT };
}

export function decodeFirmwareTraceBytes(rawBytes, bytesPerPoint = 0) {
  if (!(rawBytes instanceof Uint8Array) || rawBytes.length === 0) {
    throw new Error("Empty or invalid firmware trace");
  }
  if (bytesPerPoint === FIRMWARE_TRACE_TIMED_FORMAT) return decodeTimedTrace(rawBytes);
  const view = new DataView(
    rawBytes.buffer,
    rawBytes.byteOffset,
    rawBytes.byteLength,
  );
  const len = rawBytes.byteLength;
  // Never silently reinterpret a damaged declared format. 8 is the padded
  // trace_point structure from older firmware. With no stride, only an
  // unambiguous byte length can be decoded safely.
  const VALID_STRIDES = new Set([4, FIRMWARE_TRACE_STRIDE_LEGACY,
    FIRMWARE_TRACE_STRIDE_WITH_MIC, 8]);
  if (bytesPerPoint !== 0 && !VALID_STRIDES.has(bytesPerPoint)) {
    throw new Error(`Unsupported firmware trace stride: ${bytesPerPoint}`);
  }
  let stride = bytesPerPoint;

  if (!stride) {
    const candidates = [...VALID_STRIDES].filter((value) => len % value === 0);
    if (candidates.length !== 1) throw new Error("Ambiguous or incomplete firmware trace; stride required");
    [stride] = candidates;
  }
  if (len % stride !== 0) throw new Error("Incomplete firmware trace point");

  const numPoints = Math.floor(len / stride);
  const trace = [];

  for (let i = 0; i < numPoints; i++) {
    const offset = i * stride;
    const roll = view.getInt16(offset, true) / 100;
    const pitch = view.getInt16(offset + 2, true) / 100;
    const yaw = stride >= 6 ? view.getInt16(offset + 4, true) / 100 : null;
    const micAmp = stride >= 7 ? view.getUint8(offset + 6) : null;

    trace.push({
      accelAvailable: false,
      gyroAvailable: false,
      releaseTimingAvailable: false,
      roll,
      pitch,
      yaw,
      yawAvailable: stride >= 6,
      micAmp,
      micAvailable: stride >= 7,
    });
  }

  return { trace, bytesPerPoint: stride };
}

export function buildFirmwareTraceRecord({ localShotId, rawBytes, bytesPerPoint, deviceShotId }) {
  const decoded = decodeFirmwareTraceBytes(rawBytes, bytesPerPoint);
  if (decoded.timing && deviceShotId != null && decoded.timing.shotId !== deviceShotId)
    throw new Error("Timed trace belongs to a different device shot");
  return {
    ...buildShotTraceRecord({ localShotId, sampleRateHz: decoded.timing ? 1e6 / decoded.timing.samplePeriodUs : 52,
      payload: decoded.trace, source: "firmware" }),
    raw: { format: decoded.timing ? "firmware-timed-euler-v3" : "firmware-euler-cdeg", bytesPerPoint: decoded.bytesPerPoint,
      ...(decoded.timing ? { wireFormat: decoded.wireFormat } : {}),
      bytes: Array.from(rawBytes) },
    timing: decoded.timing || { sampleRateSource: "nominal-legacy", releaseIndex: null,
      releaseTimeSource: "unavailable", completeness: "unknown" },
    analysis: { version: 1, status: "not_calculated", parameters: null, result: null,
      reasons: [...(decoded.timing?.releaseIndex != null ? [] : ["release_timing_missing"]),
        ...(decoded.timing?.dataGap ? ["data_gap"] : []), "aim_reference_missing"] },
  };
}

// Sanitize old firmware imports for display without mutating their originals.
export function traceForReview(record) {
  if (!record || record.source !== "firmware") return record;
  return { ...record, payload: (record.analysis?.status === "calculated" && record.analysis?.result?.projected
    ? record.analysis.result.projected : record.payload || []).map((point) => {
    const { ax, ay, az, gx, gy, gz, rotDps, ...angles } = point;
    return { ...angles, accelAvailable: false, gyroAvailable: false,
      releaseTimingAvailable: record.timing?.version === 3 && record.timing.releaseIndex != null };
  }) };
}

export function extractMicWindow(micRingBuffer, shotTimeUs, preMs, postMs) {
  const preUs = Math.max(0, preMs) * 1000;
  const postUs = Math.max(0, postMs) * 1000;
  const startUs = shotTimeUs - preUs;
  const endUs = shotTimeUs + postUs;

  return micRingBuffer
    .filter((point) => point.tUs >= startUs && point.tUs <= endUs)
    .map((point) => ({
      tUs: point.tUs - shotTimeUs,
      micAmp: point.micAmp || 0,
    }));
}

export function estimateMicSampleRateHz(micSeries) {
  if (!micSeries || micSeries.length < 2) return 0;
  const spanUs = micSeries[micSeries.length - 1].tUs - micSeries[0].tUs;
  if (spanUs <= 0) return 0;
  return Math.round(((micSeries.length - 1) * 1000000) / spanUs);
}

export function micSeriesFromPayload(payload, sampleRateHz = 52) {
  if (!Array.isArray(payload) || payload.length === 0) return [];
  const dtUs = sampleRateHz > 0 ? Math.round(1000000 / sampleRateHz) : 19230;
  return payload.map((point, index) => ({
    tUs: Number.isFinite(Number(point.tUs)) ? Number(point.tUs) : index * dtUs,
    micAmp: point.micAmp || 0,
  }));
}

export function resolveReviewMicSeries(trace, sampleRateHz = 52) {
  if (!trace) return [];
  if (Array.isArray(trace.mic_series) && trace.mic_series.length > 0) {
    return trace.mic_series;
  }
  return micSeriesFromPayload(trace.payload, sampleRateHz);
}

export function micChartPointsFromSeries(micSeries) {
  if (!Array.isArray(micSeries) || micSeries.length === 0) return [];
  return micSeries.map((point) => ({
    tUs: Number.isFinite(Number(point.tUs)) ? Number(point.tUs) : undefined,
    micAmp: point.micAmp || 0,
  }));
}

export function buildShotTraceRecord({
  localShotId,
  sampleRateHz,
  payload,
  micSeries = null,
  source = "browser",
}) {
  const hasMicInPayload = Array.isArray(payload) &&
    payload.some((point) => (point.micAmp || 0) > 0);
  let resolvedMicSeries = Array.isArray(micSeries) ? micSeries : [];
  if (resolvedMicSeries.length === 0 && hasMicInPayload) {
    resolvedMicSeries = micSeriesFromPayload(payload, sampleRateHz);
  }
  const hasMicSeries = resolvedMicSeries.length > 0;

  return {
    shot_id: localShotId,
    sample_rate_hz: sampleRateHz,
    payload,
    source,
    has_mic: hasMicInPayload || hasMicSeries,
    mic_sample_rate_hz: hasMicSeries ? estimateMicSampleRateHz(resolvedMicSeries) : 0,
    mic_series: hasMicSeries ? resolvedMicSeries : null,
  };
}
