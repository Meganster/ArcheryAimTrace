# Offline Motion Score v1

Web build 146. This is an initial engineering heuristic of measured bow motion,
not a validated skill grade, target points, or the old Float Score. Higher means
less angular movement according to the fixed formula. It needs field validation
against real traces and expert review. No firmware change is required for valid
timed-v3 angle traces from the supported mounting profile.

## Inputs and formula

Existing analysis validates mount, timing, continuous samples, orientation,
reference direction and complete measurement windows before scoring. Default
windows relative to the detector event are hold −1500…−300 ms, pre −300…0 ms,
and descriptive post +100…+1000 ms. Detector latency relative to arrow departure
is unknown; this is not an assessment of the instant of release.

Each component is `100 / (1 + (movement / scale)^2)`:

| Component | Movement | Scale giving 50 points | Weight |
|---|---|---|---|
| Hold | √(σX² + σY²), degrees | 0.15° | 50% |
| Before-detector control | max(√(ΔX² + ΔY²), 2 × √(σX² + σY²)), degrees | 0.30° | 35% |
| Cant consistency | Circularly unwrapped cant standard deviation during hold | 0.50° | 15% |

The total is the rounded weighted mean of the **unrounded** component scores.
Component scores are rounded only for display. Missing/nonfinite components yield
an incomplete assessment with no total; weights are never redistributed to inflate
it. A missing post window does not invalidate a complete pre-shot motion score.

Distances and target-face sizes are excluded from the formula. A constant heading
or mounting cant is not penalized. Slow sensor drift is not removed and can affect
movement measurements. Scores do not prove shooting technique or impact accuracy.
The score ignores acceleration/gyro peaks that are absent from offline records.

## Main issue and evidence

A component qualifies only when its displayed score is below 70. Among qualifying
components, the largest weighted point loss is the main issue. No issue is forced
if none qualifies. Hold movement is horizontal/vertical when one standard deviation
exceeds the other by 1.5×; otherwise both axes are named. Pre-detector movement names
net direction only when net travel is at least the 2σ spread; otherwise it reports
oscillation. Cant reports variation, not a presumed incorrect installation angle.

Each issue stores its measured evidence, window and point contribution. Issues from
partial assessments are explicitly tentative. The UI can show the corresponding
window on the shared target trace or highlight it on the individual angle chart.
No issue claims a specific causal fault of the grip, release hand, or posture.

Post-detector ΔX/ΔY is descriptive. Natural bow rotation/follow-through is not a
score penalty and cannot become the main issue in this version.

## Persistence, comparisons and recalculation

`analysis.score` and `shot.offline_analysis.score` contain the score version,
components, evidence, total/status, reasons and descriptive post metrics. Original
trace bytes, payload, timing and old Float Score fields are untouched. Legacy Float
Score fields remain null for offline records. Existing export and cloud metadata
include the nested score along with the analysis.

`offline-motion-v1` is immutable: changing thresholds, weights, issue rules or
required windows requires a new version. Session charts and peer means require the
same score version, analysis version and parameters. Peer means exclude the current
shot, incomplete scores and unanalysed records. The UI reports the peer sample count;
a one-shot session has no peer comparison. Import groups are not verified training
boundaries, so the UI calls this a group comparison.

Run Analyze shot / Analyze group to recalculate older saved analyses. New imports
calculate the score as part of the existing offline analysis. Changing analysis
settings requires recalculation; saved results keep their own settings. Different
settings produce separate score trends; missing IDs or unavailable scores are not
interpolated.
