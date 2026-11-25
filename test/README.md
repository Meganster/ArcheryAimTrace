# ArcheryAimTrace JavaScript tests

This repository uses Node's built-in test runner with no npm dependencies.

Run the pure-function unit suite from the repository root:

```powershell
node --test test/
```

The tests import the browser app's ES modules directly. Keep fixtures small and
focused so the suite stays useful for a buildless static app.

Mounting tests also require a host C compiler named `cc`. They compile the
actual firmware transform header for each profile and compare it with the
browser's coordinate composition. No Nordic SDK is needed for these tests.

The aiming tests cover ray projection, cant independence, angular wraparound,
physical scale, saved-coordinate replay, invalid samples and drawing gaps.

### IMU transport regression checks

`imu-fifo.test.js` compiles the production FIFO reader against a scripted I2C
transport. It checks full sample boundaries, incomplete tails, caller capacity,
pre/post-read alignment, overflow, recovery errors and signed I2C error codes.
Invalid batches must never reach conversion. Configuration checks cover the
400 kHz limit, 1666 Hz input, 833 Hz output and 52 Hz offline trace stride.
These host tests do not replace validation on the physical sensor.
# Offline import integrity

`trace-timing.test.js` compiles the production capture ring, schema-2/3 storage
loader, timed-envelope serializer and BLE chunk writer. Browser decoding and
import are checked against their real output, including quality flags, CRC,
follow-through changes, reboot identity, sample-relative timestamps and detector
markers with silent audio.

`offline-import.test.js` exercises the real telemetry importer with an isolated
in-memory persistence adapter: live-score isolation, unknown capture times,
lossless raw bytes, idempotent retries, conflicting/truncated transfers and failed
storage. It also checks BLE acknowledgement timing, IndexedDB commit/abort,
legacy display sanitization, recorded-angle rendering and cloud provenance.
These tests do not constitute a real-device BLE or shooting test.

## Relative offline analysis (web 143)

`offline-aim.test.js` covers directional means across ±180°, cant independence,
sideways bow orientation, drift retention, invalid/missing windows, physical
scale, centimetre metrics, immutable raw records, repeatable recalculation,
boot/batch-constrained series suggestions and comparison compatibility.
`trace-timing.test.js` also passes production C output through import, analysis
and review, checks stored settings survive a retry and separates reboot records.

An isolated Chromium UI scenario is in `scripts/check-offline-review.mjs`.
It needs Playwright and an installed Chromium, and a local server on port 4178.
It launches a fresh profile; it does not access the user's saved browser data.
Set `PLAYWRIGHT_MODULE` to an importable module/path and `BROWSER_EXECUTABLE`
to your Chromium executable, then run `node scripts/check-offline-review.mjs`.
The scenario checks selection, recalculation, grouping, fixed target geometry,
viewport width, unchanged raw records and JavaScript errors. Screenshots go to
the system temporary directory. No BLE device is used.

## Group analysis (web 144)

`offline-comparison.test.js` verifies cross-group membership retention,
compatibility partitioning, missing-window exclusion, deduplication and a shared
physical scale for the overlay (including gap handling).

`scripts/check-group-analysis.mjs` uses an isolated Chromium profile to exercise
whole-group and single-shot analysis, persistent selection, cross-group comparison,
incompatible geometry, selective recalculation, pair review and immutable originals.
Run with the same `PLAYWRIGHT_MODULE` / `BROWSER_EXECUTABLE` setup as above.

Build 145: `session-order.test.js` covers reversed upload order, an 80-record
retained tail, persistent start-based numbering with gaps/deletion, reset counters,
multiple devices, unscored drill totals and separate hold-trend cohorts.
`check-group-analysis.mjs` also verifies Session Review visibility, ascending cards,
editing the session start and its persistence after reload in an isolated browser.

Build 146: `offline-score.test.js` verifies score anchors and weights, monotonicity,
observational issues, missing/nonfinite inputs, post-rotation neutrality, geometry
and heading invariance, raw preservation, persistence, comparable peers and score
trend gaps. The group browser check also verifies per-shot score reports, peer
counts and issue-window highlighting in review. Formula: docs/reference/offline-motion-score.md.

Build 148: the group browser check verifies inline Review without navigation,
playback, switching and closing shots, retention during sorting and recalculation,
restoring the Dashboard chart on navigation, and fit at 390 px viewport width.

Build 149 adds checks for More beside Analyze shot, inline analysis toggling,
peer details, issue-window review, sorting retention and mobile analysis layout.
