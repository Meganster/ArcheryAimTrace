const TARGET_FACE_PRESETS = [
  {
    distanceMeters: 18,
    label: "18m",
    faceLabel: "WA 40 cm face",
    faceDiameterCm: 40,
    note: "Indoor / 18 m",
  },
  {
    distanceMeters: 30,
    label: "30m",
    faceLabel: "80 cm face",
    faceDiameterCm: 80,
    note: "Training / 30 m",
  },
  {
    distanceMeters: 50,
    label: "50m",
    faceLabel: "80 cm face",
    faceDiameterCm: 80,
    note: "Outdoor / 50 m",
  },
  {
    distanceMeters: 60,
    label: "60m",
    faceLabel: "122 cm face",
    faceDiameterCm: 122,
    note: "Outdoor / 60 m",
  },
  {
    distanceMeters: 70,
    label: "70m",
    faceLabel: "122 cm face",
    faceDiameterCm: 122,
    note: "Olympic / 70 m",
  },
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function getTargetFacePreset(distanceMeters) {
  const distance = Number(distanceMeters);
  if (!Number.isFinite(distance) || distance <= 0) {
    return TARGET_FACE_PRESETS[TARGET_FACE_PRESETS.length - 1];
  }

  const exact = TARGET_FACE_PRESETS.find((preset) => preset.distanceMeters === distance);
  if (exact) return exact;

  if (distance < 24) return TARGET_FACE_PRESETS[0];
  if (distance < 40) return TARGET_FACE_PRESETS[1];
  if (distance < 55) return TARGET_FACE_PRESETS[2];
  if (distance < 65) return TARGET_FACE_PRESETS[3];
  return TARGET_FACE_PRESETS[4];
}

export function getTargetViewPreset(mode, distanceMeters) {
  if (mode === "fit") return { ...getTargetFacePreset(distanceMeters), note: "Auto fit", isNormalized: false };
  const normalized = String(mode || "").toLowerCase() === "normalized";
  if (normalized) {
    return {
      distanceMeters: Number.isFinite(Number(distanceMeters)) ? Number(distanceMeters) : 70,
      label: "Normalized",
      faceLabel: "fixed 122 cm reference",
      faceDiameterCm: 122,
      note: "Normalized view",
      isNormalized: true,
    };
  }
  return { ...getTargetFacePreset(distanceMeters), isNormalized: false };
}

export function targetViewMode(value) {
  return ["physical", "normalized", "fit"].includes(value) ? value : "fit";
}

export function formatTargetFaceLabel(preset) {
  if (!preset) return "";
  return `${preset.label} · ${preset.faceLabel}`;
}

export function drawTargetFace(ctx, {
  cx,
  cy,
  maxRadius,
  preset,
  showLabel = true,
  colors = ["#FFFFFF", "#1E1E1E", "#00B5E2", "#EE383E", "#FFE000"],
  lineColor = "rgba(142, 166, 160, 0.35)",
  labelColor = "#E6F4EF",
  labelBg = "rgba(11, 22, 27, 0.72)",
} = {}) {
  if (!ctx || !Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(maxRadius)) return;

  const face = preset || TARGET_FACE_PRESETS[TARGET_FACE_PRESETS.length - 1];
  const faceScale = clamp(face.faceDiameterCm / 122, 0.32, 1);
  const faceRadius = maxRadius * faceScale;
  const radii = [faceRadius, faceRadius * 0.8, faceRadius * 0.6, faceRadius * 0.4, faceRadius * 0.2];

  ctx.save();
  ctx.translate(cx, cy);

  // Subtle target board backdrop helps the smaller indoor faces read as
  // intentionally smaller instead of looking like a rendering bug.
  ctx.fillStyle = "rgba(255, 255, 255, 0.02)";
  ctx.beginPath();
  ctx.arc(0, 0, faceRadius * 1.08, 0, Math.PI * 2);
  ctx.fill();

  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = colors[i];
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, radii[i], 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, radii[i] - (radii[i] - (radii[i + 1] || 0)) / 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.lineWidth = 1.2;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
  ctx.beginPath();
  ctx.arc(0, 0, faceRadius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();

  if (showLabel) {
    ctx.save();
    ctx.font = "800 11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const label = formatTargetFaceLabel(face);
    const padX = 10;
    const padY = 8;
    const textWidth = Math.ceil(ctx.measureText(label).width);
    const boxWidth = Math.max(116, textWidth + padX * 2);
    const boxHeight = 28;
    ctx.fillStyle = labelBg;
    ctx.strokeStyle = "rgba(142, 166, 160, 0.35)";
    ctx.lineWidth = 1;
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(12, 12, boxWidth, boxHeight, 8);
    } else {
      ctx.beginPath();
      ctx.rect(12, 12, boxWidth, boxHeight);
    }
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = labelColor;
    ctx.fillText(label, 12 + padX, 12 + padY - 1);
    ctx.restore();
  }
}

export function targetFaceSummary(distanceMeters) {
  const preset = getTargetFacePreset(distanceMeters);
  return `${preset.note}: ${formatTargetFaceLabel(preset)}`;
}

export function targetViewSummary(mode, distanceMeters) {
  const preset = getTargetViewPreset(mode, distanceMeters);
  return `${preset.note}: ${formatTargetFaceLabel(preset)}`;
}

export { TARGET_FACE_PRESETS };
