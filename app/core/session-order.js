// Capture order is independent of upload time. Never compact missing device IDs.
export function sessionOrder(shots, firstDeviceShot = null) {
  const items = [...shots];
  const offline = items.length > 0 && items.every(s => s.stored_upload);
  const idsValid = offline && items.every(s => Number.isSafeInteger(s.device_shot_id) && s.device_shot_id >= 0);
  const oneDevice = new Set(items.map(s => s.device_id)).size === 1;
  const bootKnown = items.every(s => Number.isSafeInteger(s.device_boot_id) && s.device_boot_id > 0);
  const oneBatch = new Set(items.map(s => s.import_batch_id)).size === 1 && !!items[0]?.import_batch_id;
  const timed = bootKnown && items.every(s => Number.isSafeInteger(s.device_event_uptime_us));
  if (offline && timed) items.sort((a,b) => a.device_boot_id - b.device_boot_id || a.device_event_uptime_us - b.device_event_uptime_us || a.device_shot_id - b.device_shot_id);
  else if (idsValid && oneDevice && oneBatch) items.sort((a,b) => a.device_shot_id - b.device_shot_id);
  else items.sort((a,b) => Date.parse(a.recorded_at || a.timestamp) - Date.parse(b.recorded_at || b.timestamp));
  const continuous = idsValid && oneDevice && (timed || oneBatch) && items.every((s,i) => !i || s.device_shot_id > items[i-1].device_shot_id);
  const first = continuous ? items[0].device_shot_id : null;
  const last = continuous ? items.at(-1).device_shot_id : null;
  const confirmed = continuous && Number.isSafeInteger(firstDeviceShot) && firstDeviceShot >= 0 && firstDeviceShot <= first;
  const gaps = [];
  if (continuous) {
    let previous = confirmed ? firstDeviceShot - 1 : first - 1;
    for (const shot of items) {
      if (shot.device_shot_id > previous + 1) gaps.push({ from: previous + 1, to: shot.device_shot_id - 1 });
      previous = shot.device_shot_id;
    }
  }
  const entries = items.map((shot,i) => ({ shot,
    number: confirmed ? shot.device_shot_id - firstDeviceShot + 1 : continuous ? shot.device_shot_id : i + 1,
    label: confirmed ? `Session #${shot.device_shot_id - firstDeviceShot + 1} · Device #${shot.device_shot_id}` :
      continuous ? `Device #${shot.device_shot_id}` : offline ? `Device #${shot.device_shot_id ?? '?'} · order uncertain` : `Shot #${i+1}`,
  }));
  return { entries, offline, continuous, confirmed, first, last, gaps,
    missing: gaps.reduce((n,g) => n + g.to - g.from + 1, 0),
    firstDeviceShot: confirmed ? firstDeviceShot : null };
}
