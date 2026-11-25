// Device uptime is meaningful only within a known boot. Limit suggestions to
// one import batch because the current BLE identity is not a persistent UUID.
export function suggestOfflineSeries(shots, gapMs = 180000) {
  const buckets = new Map();
  const excluded = [];
  for (const shot of shots) {
    if (!shot.stored_upload || !shot.import_batch_id || !shot.device_boot_id ||
        !Number.isSafeInteger(shot.device_event_uptime_us) || shot.device_event_uptime_us < 0 ||
        shot.device_time_source !== 'device-processing-uptime') {
      excluded.push(shot.id); continue;
    }
    const key = JSON.stringify([shot.device_id, shot.import_batch_id, shot.device_boot_id]);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(shot);
  }
  const groups = [];
  for (const items of buckets.values()) {
    items.sort((a, b) => a.device_event_uptime_us - b.device_event_uptime_us || String(a.id).localeCompare(String(b.id)));
    let group;
    for (const shot of items) {
      if (!group || shot.device_event_uptime_us - group.at(-1).device_event_uptime_us > gapMs * 1000) {
        group = []; groups.push(group);
      }
      group.push(shot);
    }
  }
  return { groups, excluded };
}
