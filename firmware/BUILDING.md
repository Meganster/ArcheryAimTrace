# Building the ArcheryAimTrace Firmware

The firmware is a Zephyr / nRF Connect SDK (NCS) application for the
**Seeed Studio XIAO nRF54L15 Sense**. It reads the onboard IMU at full rate,
runs the orientation math and shot detection, samples the PDM microphone
envelope, and streams telemetry to the web app over BLE.

- Board target: `xiao_nrf54l15/nrf54l15/cpuapp`
- Tested SDK: **NCS v3.3.0** (also builds on v3.1.0 via the legacy path below)
- Device UI: user LED (status + shot pulse), user button (calibration), and the
  BLE/serial telemetry stream

## Archived local firmware image (21 October 2026)

This pre-rename image is kept locally for recovery and still advertises its old
BLE name. It is not a release of the renamed source. Build the current source
below for the new device name. The image uses left-side, components-outward,
USB-to-string mounting:
`artifacts/openfloat-xiao-nrf54l15-left-usb-string-timed-v5-2026-10-21.hex`
when the locally prepared image is available. This ignored directory is not
part of a source checkout; otherwise build the left-side profile below.
SHA-256: `8c368ec7fd97d6f335fa1648d77e6a0d7be0a97f41e6bf6cec514cdebc29d55c`.
Built with NCS v3.3.0; Flash 179128 B, RAM 83828 B. The adjacent JSON manifest
records source hashes and HEX validation. Flashing remains a manual step.

Use web build `aim-pipeline-142` or later for the new envelope. The image adds
sample-clock capture, detector timing, boot identity and CRC-protected metadata;
orientation fusion and gyro bias calibration are unchanged. Existing schema-2
slots remain readable. The HEX contains no settings-storage data; a programmer's
full-chip erase can nevertheless remove saved settings and traces.

See [offline trace protocol](../docs/reference/offline-trace-v3.md). This image
has been compiled and tested with production C/browser fixtures, but not flashed
or tested on a physical bow by the agent. Per-shot pin projection remains the
next application stage.

## Prerequisites

1. **nRF Connect SDK v3.3.0** and a matching toolchain. The easiest setup is the
   [nRF Connect for VS Code](https://docs.nordicsemi.com/bundle/nrf-connect-vscode/page/index.html)
   extension, or a manual install via `nrfutil`/`west`. NCS v3.3.0 ships a
   built-in `xiao_nrf54l15` board, so **no external board package is required**.
2. **OpenOCD** with the Seeed XIAO nRF54L15 support files, for flashing over the
   board's CMSIS-DAP debug interface.

> **Do not pass an external Seeed `BOARD_ROOT` on NCS v3.3.0.** It collides with
> the built-in board definition and fails with
> `Board(s): {'xiao_nrf54l15'}, defined multiple times.`

## Build

Run `west build` **from the root of the installed NCS workspace**, not from
this application directory. `west build` is a Zephyr extension command and is
only available after `west` finds that workspace. Pass this application
directory as the final argument instead.

For example, from an nRF Connect terminal, where `<ncs-root>` is the directory
reported by `nrfutil sdk-manager list` and `<project-root>` is this repository:

```sh
cd <ncs-root>
west build -p always -b xiao_nrf54l15/nrf54l15/cpuapp \
  -d <project-root>/firmware/build-v3.3.0 \
  <project-root>/firmware
```

On macOS, `nrfutil sdk-manager install v3.3.0` normally installs the workspace
at `/opt/nordic/ncs/v3.3.0`. If you launch the toolchain explicitly, the
equivalent is:

```sh
cd /opt/nordic/ncs/v3.3.0
nrfutil sdk-manager toolchain launch --ncs-version v3.3.0 -- \
  west build -p always -b xiao_nrf54l15/nrf54l15/cpuapp \
    -d /path/to/ArcheryAimTrace/firmware/build-v3.3.0 \
    /path/to/ArcheryAimTrace/firmware
```

A successful build produces the flashable image at:

```text
firmware/build-v3.3.0/merged.hex
```

These two warnings are expected and harmless:

```text
warning: SB_CONFIG_PARTITION_MANAGER is enabled, partition manager has been deprecated
warning: BT_HCI_TX_STACK_SIZE was assigned 2048 but got 1536
```

### Sensor mounting profiles

The mounting profile rotates **raw accelerometer and gyroscope vectors before
orientation fusion**. The default `legacy-x90` preserves existing behavior.
Choose a profile explicitly; the browser's board preview does not configure it.

| `OPENFLOAT_MOUNT` | Raw IMU → fusion frame |
| --- | --- |
| `legacy-x90` (default) | `(x, -z, y)` |
| `legacy-x90-inverted` | `(x, z, -y)` |
| `left-side-usb-string` | `(y, z, x)` |

`left-side-usb-string` is the candidate for the left-side riser installation
tested by the October 20 guided captures: board back against the riser,
components facing out, USB toward the string. It composes the observed
stream-to-bow mapping `(z, x, y)` with the legacy firmware rotation, then
converts the wizard's Y-up frame into the fusion frame (X forward, Y left,
Z up). Confirm these directions on the physical bow after flashing.

Build this profile in a separate directory, from the NCS workspace:

```sh
nrfutil sdk-manager toolchain launch --ncs-version v3.3.0 -- \
  west build -b xiao_nrf54l15/nrf54l15/cpuapp \
    -d /path/to/ArcheryAimTrace/firmware/build-left-usb-string \
    /path/to/ArcheryAimTrace/firmware \
    -- -DOPENFLOAT_MOUNT=left-side-usb-string
```

Check the CMake message `ArcheryAimTrace mounting profile: left-side-usb-string`.
The flash image is `firmware/build-left-usb-string/merged.hex`. The serial
banner also reports the profile, when using the UART overlay. BLE does not
yet report the installed profile automatically.

Level zero is saved atomically together with its profile. A different profile
ignores the previous device offsets; repeat **Zero Calibration** after verifying
the three motion axes. Browser offsets also need a new Zero. Old shot traces
are not remapped automatically.

For browser-connected relative pin tracking:

1. Verify side lean → Cant, up/down aim → Pitch, left/right aim → Yaw.
2. In **Relative pin tracking**, check the axes verification box for this
   connection. This is a manual check, not device profile detection.
3. Select **Physical target face** and the actual distance.
4. Hold the pin still on the target center and press **Pin at center — capture**.
5. Test horizontal, vertical and circular motions without drawing the string,
   then record and replay a short trace.

The reference resets on disconnect or distance change. Browser recordings
save projected positions, reference identity, distance and face diameter.
Firmware-only offline traces lack this reference and remain labeled legacy
cant/pitch. Use browser-connected capture for the new projection until offline
calibration metadata is implemented.

### Power and serial configurations

- **`prj.conf` (default)** is battery-safe: it disables the USB UART console so
  the board can boot from Li-ion battery power.
- **`prj_uart.conf`** is an overlay that re-enables the USB serial console for
  bench debugging. Add it to the build:

  ```sh
  west build -p always -b xiao_nrf54l15/nrf54l15/cpuapp -d build-v3.3.0 . \
    -- -DOVERLAY_CONFIG=prj_uart.conf
  ```

- **`app.overlay`** adds the IMU power supply, sets the PDM queue size, and
  routes the console for USB debug builds.

> The BLE config keeps a larger MTU / data-length than the Zephyr defaults
> (`CONFIG_BT_BUF_ACL_RX_SIZE=217`, `CONFIG_BT_BUF_ACL_TX_SIZE=217`,
> `CONFIG_BT_L2CAP_TX_MTU=212`) so the high-rate notification path can batch six
> 20-byte live frames into 120-byte notifications. The tiny defaults fragment or
> block that path; very large 251-byte settings caused net-buffer faults during
> bring-up. Retest boot and BLE if these values change.

## Flash

Connect the board over USB and flash `merged.hex` with OpenOCD over the
CMSIS-DAP probe. Replace the angle-bracket placeholders with your local paths
and your probe's CMSIS-DAP serial:

```sh
openocd \
  -s "<seeed-support>/boards/arm/xiao_nrf54l15/support" \
  -s "<openocd-scripts>" \
  -c "adapter serial <PROBE_SERIAL>" \
  -f "<seeed-support>/boards/arm/xiao_nrf54l15/support/openocd.cfg" \
  -c "init" \
  -c "reset init" \
  -c "nrf54l-load build-v3.3.0/merged.hex" \
  -c "verify_image build-v3.3.0/merged.hex" \
  -c "reset run" \
  -c "shutdown"
```

The board resets and runs the new firmware immediately. You can also flash with
`west flash` if your environment is configured for the XIAO runner.

## Verify

After flashing, the firmware advertises over BLE as **`ArcheryAimTrace`** and
blinks the user LED. Connect from the web app (see the repo `README.md`) or use
the host-side test client in `tools/archeryaimtrace_ble_client.py`.

If you built with the `prj_uart.conf` overlay, you can also confirm boot over
serial at **115200 baud**. Open the port with DTR/RTS asserted, then reset the
board. Expected lines:

```text
*** Booting nRF Connect SDK v3.3.0 ***
# OPENFLOAT_PROTO,1
# target: Seeed XIAO nRF54L15 Sense
# imu_odr_hz: 1666
# IMU ready: ... accel+gyro ODR 1666 Hz, accel +/- 16g, gyro +/- 2000 dps
# IMU INT1 watermark on gpio@10a000 pin 2, FTH=8 samples
OFRAW,1,0,77728,1200,-753,654,-104,505,-525,488,3,3,0,1000000,228,223,17,0
```

The verification serial stream prints every 100th output frame (~8.3 Hz of text)
so 115200 baud can keep up; the BLE stream itself runs at ~833 averaged
frames/s. A healthy device shows `fifo_overruns=0` and `fifo_resyncs=0` in the
periodic `# CPU_LOAD` line. If a serial client sees no bytes, make sure no other
app holds the port, then assert DTR/RTS and reset the board with the port open.

## How it runs (key tuning knobs)

The IMU is configured through raw registers for **1666 Hz ODR** and read via an
interrupt-driven FIFO watermark on INT1 (P0.02). Each output frame averages 2
raw samples (`dt_us = 1200`, ~833 frames/s). The relevant constants in
`src/imu_stream.h` and `src/main.c`:

| Constant | Purpose |
| --- | --- |
| `IMU_ODR_HZ` / `LSM6DSL_IMU_ODR_REG` | IMU output data rate (keep both in sync) |
| `LSM6DSL_FIFO_WATERMARK_SAMPLES` | FIFO threshold; larger = lower CPU, larger batches |
| `SAMPLES_PER_OUTPUT` | Averaging window / output frame rate |
| `AUDIO_SAMPLES_PER_BLOCK` | PDM mic block size (~1143 blocks/s) |
| `AUDIO_ENVELOPE_TAU_S` | Mic peak-follower decay (5 ms) |
| `AUDIO_BLE_SCALE_DIVISOR` | Scales the `mic_amp` byte into 0–255 |

If `init_imu_interrupt()` fails at boot, the loop falls back to cooperative FIFO
polling automatically.

The BLE GATT services, characteristics, frame layout, and the full ASCII
control-command set are documented in the repo `README.md` and `docs/`. The
LSM6DS3TR-C supports I2C up to **400 kHz**, per table 7 of the
[ST datasheet](https://www.st.com/resource/en/datasheet/lsm6ds3tr-c.pdf).
The former 1 MHz bus configuration exceeded this specification. The current
1666 Hz input produces ~20 kB/s of payload, leaving room for transaction and
status overhead at 400 kHz. The output averages two samples (about 833 Hz).
Offline 52 Hz traces use stride 16 so their duration remains consistent.

FIFO reads start at pattern 0 and contain only complete six-word samples;
a trailing partial sample remains in hardware. Maximum burst size is 192 bytes.
Status/pattern is checked again after the burst, before conversion or fusion.
Overrun/full or alignment loss discards the entire batch. Misalignment recovery
consumes only the words needed to reach the next sample boundary; an impossible
pattern resets the FIFO. Errors in status, data, or recovery transfers retain
the I2C driver's actual error code. This does not verify each byte against a
checksum: transport noise that does not change the pattern remains possible.
A 20 ms bounded interrupt wait also services status when interrupts/data stop.

## Explicit stationary gyroscope calibration

The browser build `aim-pipeline-139` provides **Calibrate gyroscope — keep still**.
Place the bow on a stationary support before pressing it. Firmware discards one
second for settling, then measures 32 non-overlapping 250 ms blocks (about eight
seconds). Leave the bow untouched until saving completes, about nine seconds total.

Raw gyro conversion now uses the LSM6DS3TR-C sensitivity of **70 mdps/LSB** for
±2000 dps, from [ST's datasheet, table 3](https://www.st.com/resource/en/datasheet/lsm6ds3tr-c.pdf).
The former full-scale/32768 formula gave 61.035 mdps/LSB and understated rates.
This correction increases reported rates/noise by 1.14688; it does not explain
or cure the user's high noise. The observed 1.606 dps raw standard deviation is
not evidence that this is normal sensor noise. Its physical/data-path origin
remains unconfirmed without a recording or further device measurements.

Calibration evaluates DC bias precision separately from raw sample dispersion:

- Mean acceleration magnitude within 0.05 g of gravity; change from the first
  block within 0.03 g; vector acceleration RMS noise within each block ≤0.05 g.
- Mean rate within each block ≤5 dps per axis.
- Raw gyro standard deviation ≤5 dps (gross corruption/vibration guard).
- Standard deviation of block means ≤0.15 dps per axis.
- Estimated standard error of the bias, block SD / sqrt(32), ≤0.025 dps per axis.
- Difference between means of the first and second 16 blocks ≤0.10 dps per axis.
- Any observed FIFO overrun, resync or I2C read failure rejects an active attempt;
  output averaging never bridges the discontinuity.

These are engineering acceptance thresholds, not ST noise specifications or a
guaranteed heading accuracy. Block estimates reduce the assumption that adjacent
high-rate samples are independent; long correlations and constant slow rotation
remain limitations. There is no adaptive learning, deadband or new motion filter
while aiming. Bias is subtracted before Madgwick integration. A rejected attempt
retains the prior usable bias. High raw noise alone cannot certify a bad mean,
and passing calibration does not prove sensor health or eliminate yaw drift.

The `openfloat/gyro_bias_v2` NVS record contains four int32 values: mounting profile
and XYZ bias in milli-degrees/second. Values are bounded to ±5 dps per axis;
another mounting profile invalidates the record. The old `openfloat/gyro_bias`
key is ignored because it used the incorrect conversion. Recalibration is
required after this firmware upgrade. NVS writes run outside the IMU loop;
save failure is reported separately from application in RAM.

BLE commands are `gyrobias` (begin) and `gyrobias?` (status). The existing live
characteristic carries a 29-byte protocol-1 type-8 frame: byte 4 status
(0 uncalibrated, 1 collecting, 2 saved/restored, 3 rejected, 4 save failed,
5 saving), byte 5 bias-valid, byte 6 measurement percent, and signed int16 XYZ
milli-dps at offsets 8, 10, 12. Byte 26 is diagnostic extension version (0 legacy,
1 earlier diagnostics, 2 current). Byte 7 is the rejection reason:
0 none, 1 invalid interval, 2 non-finite input, 3 mean angular rate,
4 deviation from gravity, 5 acceleration change, 6 raw gyro SD,
7 too few samples, 8 acceleration RMS noise, 9 block-mean SD,
10 estimated bias error, 11 first/second-half mean change, 12 legacy FIFO/I2C gap,
13 FIFO overrun/full, 14 FIFO word alignment, 15 I2C transfer error.
For 13 the observed field holds FIFO_STATUS2; for 14 observed/threshold hold
received/expected pattern; for 15 observed holds the signed driver error code.
Transport errors are sent without requiring another valid sensor sample.
Offsets 14 and 18 hold little-endian float32 observed value and threshold.
Units: ms for 1, unused for 2, dps for 3/6/9/10/11, g for 4/5/8,
samples for 7, gap count for 12. On successful current calibration (reason 0),
these fields report the maximum estimated bias error and its threshold in dps.
Offset 22 is uint16 elapsed wall-clock ms including settling (saturates at 65535); byte 24 is axis
(0 unspecified, 1 X, 2 Y, 3 Z); byte 25 is phase (0 idle, 1 settling, 2 measuring).
Version 2 adds uint16 maximum raw gyro SD in milli-dps at offset 27, saturating
at 65535. Zero means unavailable on restore or before final statistics.
Unknown management types must not become live orientation samples.

After success, capture the aiming center again and measure residual drift on a
stationary support for 30 seconds. Reconnection also requires a new center;
persisted bias does not provide an absolute heading.

## Legacy NCS v3.1.0 path

NCS v3.1.0 predates the built-in board, so it needs the external Seeed board
package via `BOARD_ROOT`:

```sh
west build -p always -b xiao_nrf54l15/nrf54l15/cpuapp -d build . \
  -- -DBOARD_ROOT="<path-to>/platform-seeedboards/zephyr"
```

Use v3.1.0 only as a comparison point; **v3.3.0 is the supported target.**
