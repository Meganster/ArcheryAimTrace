// Imported device events do not contain wall-clock capture times or scores.
// Keep their receipt time for ordering, explicitly separate from capture time.
export const OFFLINE_IMPORT_VERSION = 1;
const SCORE_FIELDS = ["shot_score", "stability_score", "hold_stability",
  "release_quality", "follow_through", "level_consistency", "score_version"];

export function shotTimeUnknown(shot) {
  return shot?.timestamp_kind === "imported" ||
    (shot?.stored_upload === true && !shot?.recorded_at);
}

export function shotStoredAt(shot) {
  return shot?.imported_at || shot?.timestamp;
}

export function unscoredFields() {
  return Object.fromEntries(SCORE_FIELDS.map((key) => [key, null]));
}

export function offlineShotFields(shot, importedAt, batchId) {
  const angle = (value) => Number.isFinite(value) ? Number(value.toFixed(2)) : null;
  return {
    ...unscoredFields(),
    import_version: OFFLINE_IMPORT_VERSION,
    imported_at: importedAt,
    recorded_at: null,
    timestamp: importedAt, // Compatibility sort key; never a capture-time claim.
    timestamp_kind: "imported",
    import_batch_id: batchId,
    raw_event: structuredClone(shot),
    analysis_status: "not_calculated",
    analysis_reason: "Offline trace has no recorded release timing or aiming reference.",
    packet_loss_count: null,
    cant_angle_deg: angle(shot.rollDeg),
    roll_angle_deg: angle(shot.rollDeg),
    pitch_angle_deg: angle(shot.pitchDeg),
    yaw_angle_deg: angle(shot.yawDeg),
  };
}

// Old imports may contain scores copied from unrelated live browser state.
// Hide them at read time without destroying the original stored record.
export function shotForDisplay(shot) {
  if (!shot?.stored_upload || shot.analysis_status === "calculated") return shot;
  return { ...shot, ...unscoredFields(), analysis_status: "not_calculated" };
}

export function shotFloatScore(shot) {
  const record = shotForDisplay(shot);
  const value = record?.shot_score ?? record?.stability_score;
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

export function shotTimeLabel(shot) {
  const time = Date.parse(shotStoredAt(shot));
  const label = Number.isFinite(time) ? new Date(time).toLocaleString() : "unknown";
  return shotTimeUnknown(shot) ? `Imported ${label} · shot time unknown` : label;
}

// Current devices have no boot UUID. Restrict dedup to the same event fields;
// same-id events with different measurements must not swallow a new shot.
export function sameDeviceEvent(record, event) {
  if (record.device_id !== "OpenFloat-Sensor" || record.device_shot_id !== event.shotId) return false;
  if (record.raw_event) {
    const keys = ["shotCount", "axMg", "ayMg", "azMg", "rollDeg", "pitchDeg", "yawDeg",
      "thresholdG", "clickerDtMs", "impactDtMs"];
    return keys.every((key) => record.raw_event[key] === event[key]);
  }
  const round = (value) => Number.isFinite(value) ? Number(value.toFixed(1)) : null;
  return Number.isFinite(event.rollDeg) && Number.isFinite(event.pitchDeg) && Number.isFinite(event.yawDeg) &&
    round(record.roll_angle_deg) === round(event.rollDeg) &&
    round(record.pitch_angle_deg) === round(event.pitchDeg) &&
    round(record.yaw_angle_deg) === round(event.yawDeg) &&
    Math.abs(record.peak_g - Math.hypot(event.axMg, event.ayMg, event.azMg) / 1000) < 0.0001;
}
