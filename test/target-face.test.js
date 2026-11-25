import test from "node:test";
import assert from "node:assert/strict";

import {
  TARGET_FACE_PRESETS,
  formatTargetFaceLabel,
  getTargetFacePreset,
  getTargetViewPreset,
  targetFaceSummary,
  targetViewSummary,
  targetViewMode,
} from "../app/ui/target-face.js";

test("target face presets map standard distances to the expected target face", () => {
  assert.equal(TARGET_FACE_PRESETS.length >= 5, true);

  assert.deepEqual(getTargetFacePreset(18), {
    distanceMeters: 18,
    label: "18m",
    faceLabel: "WA 40 cm face",
    faceDiameterCm: 40,
    note: "Indoor / 18 m",
  });

  assert.deepEqual(getTargetFacePreset(30), {
    distanceMeters: 30,
    label: "30m",
    faceLabel: "80 cm face",
    faceDiameterCm: 80,
    note: "Training / 30 m",
  });

  assert.deepEqual(getTargetFacePreset(50), {
    distanceMeters: 50,
    label: "50m",
    faceLabel: "80 cm face",
    faceDiameterCm: 80,
    note: "Outdoor / 50 m",
  });

  assert.deepEqual(getTargetFacePreset(60), {
    distanceMeters: 60,
    label: "60m",
    faceLabel: "122 cm face",
    faceDiameterCm: 122,
    note: "Outdoor / 60 m",
  });

  assert.deepEqual(getTargetFacePreset(70), {
    distanceMeters: 70,
    label: "70m",
    faceLabel: "122 cm face",
    faceDiameterCm: 122,
    note: "Olympic / 70 m",
  });
});

test("auto fit retains the selected distance and saved view preferences", () => {
  assert.equal(targetViewMode("fit"), "fit");
  assert.equal(targetViewMode("physical"), "physical");
  assert.equal(targetViewMode("normalized"), "normalized");
  assert.equal(targetViewMode(undefined), "fit");
  const preset = getTargetViewPreset("fit", 18);
  assert.equal(preset.distanceMeters, 18);
  assert.equal(preset.faceDiameterCm, 40);
  assert.equal(preset.note, "Auto fit");
});

test("target face helpers fall back predictably for non-standard distances", () => {
  assert.deepEqual(getTargetFacePreset(44), {
    distanceMeters: 50,
    label: "50m",
    faceLabel: "80 cm face",
    faceDiameterCm: 80,
    note: "Outdoor / 50 m",
  });

  assert.deepEqual(getTargetFacePreset("not-a-number"), {
    distanceMeters: 70,
    label: "70m",
    faceLabel: "122 cm face",
    faceDiameterCm: 122,
    note: "Olympic / 70 m",
  });

  assert.equal(formatTargetFaceLabel(getTargetFacePreset(18)), "18m · WA 40 cm face");
  assert.equal(targetFaceSummary(70), "Olympic / 70 m: 70m · 122 cm face");
  assert.equal(targetViewSummary("normalized", 70), "Normalized view: Normalized · fixed 122 cm reference");
  assert.equal(targetViewSummary("physical", 18), "Indoor / 18 m: 18m · WA 40 cm face");
  assert.deepEqual(getTargetViewPreset("normalized", 18), {
    distanceMeters: 18,
    label: "Normalized",
    faceLabel: "fixed 122 cm reference",
    faceDiameterCm: 122,
    note: "Normalized view",
    isNormalized: true,
  });
});
