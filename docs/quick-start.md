# Quick Start

Build an ArcheryAimTrace sensor, flash the firmware, and stream live telemetry to this
web app. Budget about an hour for a first build; most of that is installing the
firmware toolchain once.

---

## 1. What you need

**Hardware**

- **Seeed Studio XIAO nRF54L15 Sense** — the microcontroller + BLE + onboard
  IMU (`LSM6DS3TR-C`) and PDM microphone. This is the whole brain of the device.
- **3.7 V LiPo battery**, ~70 mAh, with a protection circuit, for untethered
  range use. (You can also run from USB power during bring-up.)
- **Mounting putty** — a small ball of removable adhesive putty is enough to
  stick the board to the bow. Mount repeatability affects data quality.
- **USB-C cable** to connect the XIAO to your computer for flashing.

**Software**

- A **Chromium browser** (Chrome or Edge) — Web Bluetooth is required and is not
  available in Firefox or Safari.
- The **nRF Connect SDK (NCS) v3.3.0** toolchain, to build the firmware. The
  XIAO nRF54L15 board is built in to NCS v3.3.0 — no external board package
  needed.
- **OpenOCD** to flash the build over the board's CMSIS-DAP debug interface.

> You only install the firmware toolchain once. After that, reflashing is a
> two-command loop.

---

## 2. Assemble the hardware

1. Solder the battery leads (or a JST connector) to the XIAO's `BAT+` / `BAT-`
   pads, observing polarity. Skip this if you only plan to run from USB.
2. Press a small ball of mounting putty onto the bow and firmly seat the board
   on it so it sits rigidly — any flex or wobble shows up as noise in the trace.
   Make sure it is stuck securely enough that it **cannot become a projectile**
   or interfere with the bow under release shock.
3. Note the board's orientation on the bow. You will square it up later with the
   in-app axis mapping and the **Zero Calibration** button — it does not have to
   be perfectly aligned mechanically.

> **Safety:** ArcheryAimTrace is an experimental hobby/educational project, not a
> safety device. Always follow normal range safety rules.

---

## 3. Build the firmware

> Build the firmware from this repository so its trace format and features match
> the web app. See [firmware/BUILDING.md](../firmware/BUILDING.md) for mounting profiles.

The firmware lives in `firmware/` and targets
`xiao_nrf54l15/nrf54l15/cpuapp`. Build it with the NCS v3.3.0 toolchain. On a
typical Windows install the tested command is:

```powershell
& "C:\ncs\toolchains\b8b84efebd\nrfutil\bin\nrfutil.exe" toolchain-manager launch `
  --ncs-version v3.3.0 `
  --chdir "C:\ncs\v3.3.0" `
  -- west build `
  -p always `
  -b xiao_nrf54l15/nrf54l15/cpuapp `
  -d "firmware\build-v3.3.0" `
  "firmware"
```

A successful build produces:

```text
firmware/build-v3.3.0/merged.hex
```

The default config is **battery-safe**: it disables the USB UART console so the
board can boot from LiPo power. If you want serial logs on the bench, add the
USB overlay:

```powershell
-DOVERLAY_CONFIG=prj_uart.conf
```

> These two warnings are expected and harmless:
> `SB_CONFIG_PARTITION_MANAGER ... deprecated` and
> `BT_HCI_TX_STACK_SIZE was assigned 2048 but got 1536`.

For the complete build, flash, and verification guide — including the USB
serial overlay and tuning knobs — see [firmware/BUILDING.md](../firmware/BUILDING.md).

---

## 4. Flash the firmware

Connect the XIAO over USB and flash `merged.hex` with OpenOCD over the board's
CMSIS-DAP probe:

```powershell
openocd `
  -s "<seeed-support>/boards/arm/xiao_nrf54l15/support" `
  -s "C:/Program Files/OpenOCD/share/openocd/scripts" `
  -c "adapter serial <YOUR_PROBE_SERIAL>" `
  -f "<seeed-support>/boards/arm/xiao_nrf54l15/support/openocd.cfg" `
  -c "init" `
  -c "reset init" `
  -c "nrf54l-load firmware/build-v3.3.0/merged.hex" `
  -c "verify_image firmware/build-v3.3.0/merged.hex" `
  -c "reset run" `
  -c "shutdown"
```

Replace `<YOUR_PROBE_SERIAL>` with your probe's CMSIS-DAP serial and
`<seeed-support>` with the path to the Seeed support files. When it finishes,
the board resets and the new firmware runs immediately.

---

## 5. Verify it is running

After flashing, the firmware advertises over BLE as **`ArcheryAimTrace`** and
blinks the user LED. You are ready for the web app.

If you built with the USB UART overlay, you can also confirm boot over serial at
**115200 baud**. Open the port with DTR/RTS asserted, then reset the board; you
should see:

```text
*** Booting nRF Connect SDK v3.3.0 ***
# OPENFLOAT_PROTO,1
# target: Seeed XIAO nRF54L15 Sense
# imu_odr_hz: 1666
# IMU ready: ... accel+gyro ODR 1666 Hz ...
OFRAW,1,0,77728,900, ...
```

A healthy device streams ~833 averaged frames/s with zero FIFO overruns.

---

## 6. Open the web app

Serve the repo root over localhost (Web Bluetooth and native ES modules require
an `http://` origin, not a `file://` path):

```powershell
python -m http.server 4178
```

Then open **http://localhost:4178/** in Chrome or Edge. The app also runs fully
offline once its assets have been cached.

---

## 7. Connect over Bluetooth

1. Power the sensor (battery or USB) and move it so it is awake.
2. In the app header, click the **Disconnected** status badge (top-left).
3. In the browser's Bluetooth picker, choose your **`ArcheryAimTrace`** device
   and pair.
4. The badge turns green and the Dashboard begins streaming: the bow orientation
   visualizer moves, the Shot Sequence Trace fills, and the live rate shows
   ~833 Hz.

If the link drops, the app retries automatically (up to 6 times with backoff)
and the firmware resumes advertising — usually it reconnects on its own.


> No sensor yet? The **▶ Demo** button in **Settings → General** streams synthetic motion
> so you can explore the whole dashboard first.

---

## 8. First calibration

1. Mount the XIAO rigidly on the bow riser first. Do not calibrate while the
   board is loose, flexing, or touching a moving part.
2. Open **Settings → Calibration → Sensor & 3D Alignment** and pick the mount preset that
   matches how the board is physically rotated on the riser.
3. For a left-handed bow, mirror the right-handed installation logically: the
   board still needs to sit flat on the riser with the component side facing
   away from the bow. Use the preset whose USB direction matches the actual
   bow side in your build:
   - `face-out-usb-right` if the connector points toward the bow's sight side.
   - `face-out-usb-left` if the connector points toward the bow's string side.
   The exact side depends on how your bow is mirrored, so trust the physical
   placement over the handedness label.
4. Bring the bow to your normal shooting posture. If you want the dashboard
   zero to represent full-draw form, draw to anchor first, then settle. What
   matters is that the bow is level and still when you zero.
5. Make the bow level using the physical bubble or a trusted external level.
   The goal is to define a level reference, not to aim at the yellow.
6. In **Settings → Calibration**, click **Zero Calibration** to capture the current roll and
   pitch as the level reference. The bubble level and 3D bow should now read
   level.
7. If the on-screen bow is rotated relative to your real mount, revisit
   **Settings → Calibration → Sensor & 3D Alignment** and adjust the mount axis mapping until
   the model matches reality. Zero calibration does not fix wrong axis mapping.

## 9. Target View Modes

Use the new view selector in the dashboard header to switch between:

- **Normalized**: the earlier ArcheryAimTrace-style view. The target face is a fixed
  reference and the trace stays normalized to the shot's own movement extent.
- **Physical target face**: the face scales to the selected training distance
  such as 18 m, 30 m, 50 m, 60 m, or 70 m.

If you are comparing raw hold consistency across sessions, keep **Normalized**
selected. If you want the target to reflect a real field setup, use
**Physical target face** and pick the distance preset.

## 10. Offline Session Recovery

With **Trace Buffer Rate** enabled and **Persist Traces Offline (RRAM)** on,
the sensor keeps one offline session of up to **80 complete shot traces**. Each
trace contains a fixed 3.5-second pre-shot window and a 1.5-second
follow-through window at 52 Hz.

After reconnecting, leave Bluetooth connected until the header's **Importing**
count reaches zero. The browser imports each shot and its matching trace before
acknowledging it to the sensor, so an interrupted import resumes on the next
connection. The 81st offline shot replaces the oldest trace in the session.

Wait at least a few seconds after the final arrow before powering the sensor
off, so the follow-through window can freeze and persist. Firmware using this
80-trace storage format clears the legacy offline trace slots on first boot.

That's it — take a shot and it appears in **Recent Shots** with an ArcheryAimTrace
Float Score. From here, explore **Steady Aim** for hold drills and **Saved
Shots** for session review.

Steady Aim automatically saves each completed hold and its trace to this
browser’s local database. Watch the saved-holds counter; no final Save is
required. Disconnecting stops the drill and excludes the incomplete hold, while
completed, saved holds remain available after reloading. If saving fails, keep
the page open and use **Retry saving** on the results screen.

In **Saved Shots**, **Review** expands Trace Review Mode directly beneath the
selected shot. Playback controls stay immediately below the target. Choose
**Close review** to collapse it, or **Review** on another shot to switch the
open player. Sorting the session keeps the review attached to its shot.
**Analyze shot** calculates and expands the score, main issue, peer comparison
and measurements beneath that shot; click it again to collapse the analysis.
**More**, beside Analyze shot, reveals metadata, export and delete actions.
