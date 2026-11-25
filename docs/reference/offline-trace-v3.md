# Offline trace timing, version 3

Web build: `aim-pipeline-142`. Firmware: `timed-v5-2026-10-21`.

The format records the **shot detector event**, not an independently measured
arrow departure. Its event position is determined in the IMU processing thread.
The sample clock comes from configured ODR and decimation; it is not a calibrated
wall clock. No software claim of absolute millimetre accuracy follows from it.

## Storage and migration

The 12-byte schema-2 prefix and seven-byte angle/mic points stay in place. A
52-byte wire header is appended to the stored structure. Each slot occupies
1884 bytes; 80 slots occupy 150720 bytes before Settings/ZMS overhead. The
settings partition remains 0x60000 bytes at 0x105000.

The loader accepts existing 1832-byte schema-2 slots and new 1884-byte schema-3
slots. Updating the schema marker does **not** delete old slots. Old records
remain untimed; their timing is not reconstructed from current browser settings.
The firmware still uses cyclic storage: subsequent shots overwrite old slots.

`openfloat/bootseq` is incremented and saved before capture starts. Deep-sleep
wake and reboot produce another identifier. A failed write/invalid settings load
produces an unknown identity (zero plus flag). The counter is device-local and
does not survive a complete settings erase. It is not a globally unique UUID.
Gyroscope bias and mounting-profile settings use their existing keys.

## BLE envelope

The existing 29-byte type-6 chunk framing stays unchanged: up to 19 payload
bytes, low 16 bits of shot ID in the frame, and a format tag at byte 28 of
chunk zero. Tag **0x83** means a timed envelope; 4/6/7/8 remain legacy strides.
The serialized stream is the header below followed by exactly `count * 7`
bytes of Roll/Pitch/Yaw (signed centidegrees) and mic amplitude. The header
contains the full 32-bit shot ID and must match the requested event.

All integers are little-endian. Offsets are relative to the reassembled stream.

| Offset | Type | Meaning |
| --- | --- | --- |
| 0 | 4 bytes | ASCII `OFT3` |
| 4 | u16 | Version = 3 |
| 6 | u16 | Header size = 52 |
| 8 | u32 | Full device shot ID |
| 12 | u32 | Persisted boot counter; zero means unknown |
| 16 | u32 | Sample-period numerator in microseconds: 32000000 |
| 20 | u32 | Sample-period denominator: 1666 |
| 24 | u64 | Processing uptime at detection, microseconds |
| 32 | i32 | First stored point's output-tick offset from event |
| 36 | u16 | Output ticks per stored point: 16 |
| 38 | u16 | Count, 1–260 |
| 40 | u16 | First stored point at/after event; 65535 if outside window |
| 42 | u16 | Quality flags below |
| 44 | u16 | Follow-through milliseconds snapshotted at detection |
| 46 | u16 | Mount profile; 2 = left-side-usb-string |
| 48 | u32 | CRC-32/ISO-HDLC over bytes 0–47 followed by all points |

CRC initial value is 0xffffffff, reflected polynomial 0xedb88320, final XOR
0xffffffff. The CRC field itself is skipped. A full default trace occupies
1872 wire bytes (99 chunks), within the existing 8-bit chunk count.

| Flag | Meaning |
| --- | --- |
| 1 | Prehistory shortened; ring had fewer than 260 points |
| 2 | Follow-through stopped before requested deadline |
| 4 | FIFO/I²C discontinuity observed during pending capture |
| 8 | Boot counter could not be established |
| 16 | Detector event is outside the stored window |
| 32 | Software-triggered test event |

## Clock and event location

`periodUs = numerator / denominator`, about 19207.683 µs, or 52.0625 Hz.
For point `i`, `tUs = (firstTick + i * stride) * periodUs / stride`.
The detector event itself is at zero. `event_index` is the first point at or
after zero, not necessarily an exact sample at zero. Its offset can be up to
one stored-point period; the time axis preserves that offset.

The follow-through deadline is computed from the snapshotted milliseconds and
ODR. Capture freezes at the first decimated point meeting that deadline, with
at most one stored-point interval of rounding. The ring is copied only by the
IMU thread, never by a concurrent timer. Changing follow-through during capture
does not move that capture's deadline. A new shot can force the previous pending
capture to end early; that record is marked accordingly.

A FIFO gap ends any pending record with a gap flag and clears prehistory so
later records do not silently bridge missing samples. Auto-sleep waits for
pending capture/persistence. Sudden loss of power can still interrupt a write;
hardware persistence and sleep/wake tests remain necessary.

Processing uptime allows ordering/interval estimates within one boot. It
includes processing latency and is not an RTC date/time. The browser keeps
`recorded_at` unknown instead of presenting import time as capture time.

## Browser interpretation

The browser validates version, byte count, CRC, full shot ID and event index.
It retains the original envelope in `raw`, timing/quality in `timing`, and
derived results separately in `analysis`. Known boot/uptime identities separate
offline events whose shot counters were reused. A calibrated browser recording
remains protected from replacement by an uploaded angle-only trace.

Review draws a fixed **DETECTOR** marker at zero; dragging cannot rewrite it.
The marker remains visible with silent audio. It does not estimate target impact
or arrow flight time. The relative aiming reference and per-shot analysis are
the next implementation stage; an offline pin is not yet calculated.

## Validation

`test/trace-timing.test.js` compiles the production ring, storage loader, header
serializer and BLE chunk writer. Their output is decoded by the browser code.
Cases cover follow-through 0/1500/3000 ms, settings changes during capture,
short prehistory, forced interruption, FIFO gap, unknown boot, simulated event,
schema-2 reads, truncated/corrupt transfers, repeated imports and different boots.
The UI test verifies the detector marker and finite canvas coordinates.

Tests and a successful target build are not a real-device shooting test.
