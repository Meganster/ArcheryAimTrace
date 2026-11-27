# ArcheryAimTrace

Bow-motion tracking, shot review, and structured aiming practice with a BLE
sensor and a browser app. Record at the range, import saved traces, review a
whole session, and compare individual shots. Practice data is stored locally;
an account is not required.

## Run locally

From the repository root:

```sh
python3 -m http.server 4178
```

Open **http://localhost:4178/** in Chrome or Edge. On macOS, `./start.sh` starts
the server and opens the browser. Web Bluetooth requires a supported browser
and localhost or HTTPS; opening `index.html` directly is not sufficient.

Without a sensor, open **Settings → General → Demo**. The app also includes
sample shots for exploring Saved Shots. After the app has cached its assets,
it can be used offline as an installed web app.

## What you can do

- **Dashboard:** see live bow orientation, cant, and relative pin movement.
- **Saved Shots:** review sessions, follow shot order, sort by score, compare
  shots and groups, and replay traces with an adaptive target scale.
- **Shot analysis:** see a 0–100 score, the main detected issue, and trends
  across the session. Scores describe measured motion, not target impact points.
- **Steady Aim:** run configurable sets and repetitions with draw, hold, and
  rest intervals, sound cues, and pause/resume. Defaults are 3 sets of 10,
  7 seconds to draw, 3 seconds to hold, 3 seconds between repetitions,
  and 2 minutes between sets. Each completed hold and its trace are saved
  automatically to this browser’s local database. A disconnect or page reload
  retains saved holds; an interrupted, incomplete hold is excluded.
- **Settings → Calibration:** configure sensor/model alignment, zero the
  orientation, calibrate gyroscope bias, and capture the target center.
- **Settings → Bow Setup:** customize the 3D bow. General also contains bow
  profiles, backup/restore, telemetry settings, and diagnostics.
- **Settings → Guide:** read setup and protocol documentation inside the app.

Shot and backup exports use the `archeryaimtrace-` filename prefix. Existing
exports and locally stored data remain readable: persisted database keys,
record identifiers, and protocol UUIDs are retained for compatibility.

## Sensor and firmware

The firmware targets the **Seeed Studio XIAO nRF54L15 Sense** with its onboard
LSM6DS3TR-C IMU and uses Zephyr / nRF Connect SDK. Build the source in this
repository using the instructions in [firmware/BUILDING.md](firmware/BUILDING.md).
Choose the mounting profile that matches the physical sensor installation.

The current configuration reads the IMU at 1666 Hz, averages pairs of samples
for approximately 833 Hz orientation updates, and records offline traces at
approximately 52 Hz. The sensor retains up to **80 full traces**; shot metadata
has a separate 100-record capacity. Older entries are overwritten when their
respective storage limits are reached. Import sessions regularly.

New firmware builds advertise as **ArcheryAimTrace**. Already flashed sensors
remain connectable through the unchanged service UUID and legacy name filter;
renaming the web app does not require reflashing a working sensor.

## Measurement limits

Pin traces show changes in aiming direction relative to a captured reference,
not the arrow's measured impact location. Gyroscope-based heading may drift;
calibrate bias on a stationary support and capture the center before use.
Older saved traces without a captured aiming reference use a legacy angle
projection and may not represent the same target coordinates.

Shot detection responds to the sensor's measured impulse. Trace phase markers
are analysis boundaries, not a verified timestamp of the beginning of string
release. The project is experimental; mount hardware securely and follow
normal range safety rules.

## Development and documentation

The web app uses native JavaScript modules and does not require a bundler.

```sh
node --test test/
python3 tools/verify_follow_through_trace.py
python3 tools/build_docs_index.py
```

- [Quick Start](docs/quick-start.md)
- [Feature Status](docs/feature-status.md)
- [Technical architecture](Blueprint.md)
- [BLE commands](docs/reference/ble-commands.md)
- [Offline trace format](docs/reference/offline-trace-v3.md)

Source layout: `app/` for the browser application, `firmware/` for the sensor,
`tools/` for host utilities, `test/` and `scripts/` for checks, and `docs/` for
the in-app Guide. `Blender/` and `FreeCAD/` contain 3D and mechanical source assets.

The BLE diagnostic client is `tools/archeryaimtrace_ble_client.py` (requires
`python3 -m pip install bleak`). Optional self-hosted cloud sync uses the schema
in [supabase/schema.sql](supabase/schema.sql); local use does not depend on it.

## Origin and license

**ArcheryAimTrace is based on [OpenFloat Archery](https://github.com/DevanMetz/Open-Float-Archery).**
This version develops the calibration workflow, offline session review, shot
comparison and scoring, trace playback, configurable training, and Settings
navigation independently of the original project.

The original copyright notice is preserved in [LICENSE](LICENSE). Firmware
sources retain their Apache-2.0 SPDX headers. Dependency notices are listed in
[THIRD_PARTY_NOTICES.md](docs/licenses/THIRD_PARTY_NOTICES.md).
