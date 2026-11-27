import { sessionOrder } from '../core/session-order.js?v=aim-pipeline-164';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function sessionTimelineHtml(shots, firstDeviceShot = null) {
  const order = sessionOrder(shots, firstDeviceShot);
  const unavailable = shots.filter(s => s.trace_status === 'unavailable').length;
  const range = order.gaps.map(g => {
    const offset = order.confirmed ? firstDeviceShot - 1 : 0;
    return `#${g.from-offset}${g.to === g.from ? '' : `–${g.to-offset}`}`;
  }).join(', ');
  return `<div class="session-timeline"><strong>Shot order · earliest → latest</strong>
    <p class="note">${order.continuous ? `${order.entries[0].label} → ${order.entries.at(-1).label}. ${order.confirmed ? 'Session numbering preserves missing shots.' : 'Device numbers; session start is unknown. Set the first device shot in Edit session to number from the true start.'}` : order.offline ? 'Order is uncertain: missing timing, multiple devices or a reset counter. Split records into sessions with one continuous counter.' : 'Ordered by capture time.'}</p>
    ${order.continuous ? `<p class="note">Missing records ${order.missing}${range ? ` (${order.confirmed ? 'session' : 'device'} ${range})` : ''}. Numbers absent from this group may exist in another group. ${order.confirmed ? '' : 'Earlier missing shots cannot be counted without the session start.'}</p>` : ''}
    ${order.offline ? `<p class="note">Device capacity: 80 traces / 100 event records. Unavailable traces: ${unavailable}. A missing record or trace alone does not prove overwrite; it may be unimported, deleted or unsaved. Imported browser copies remain available.</p>` : ''}
    ${order.confirmed && order.entries.at(-1).number > 80 ? `<p class="note">80-trace capacity crossed at Session #81. At the latest saved shot, the nominal device trace window is Session #${Math.max(1,order.entries.at(-1).number-79)}–${order.entries.at(-1).number}; older slots may have been overwritten. This does not remove browser copies.</p>` : ''}
    <div class="session-sequence">${order.entries.map(e => `<button type="button" data-review-shot-id="${esc(e.shot.id)}" title="${esc(e.label)}">${esc(e.label)}${e.shot.trace_status === 'unavailable' ? ' · trace unavailable' : ''}</button>`).join('')}</div></div>`;
}
