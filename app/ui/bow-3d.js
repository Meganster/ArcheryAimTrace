// 3D bow visualizer: Three.js scenes for the dashboard orientation view, the
// mount-orientation settings card, and the bow shop, plus the mount-orientation
// presets and model loading/customization helpers they share.

const THREE_URL = "https://esm.sh/three@0.164.1";
const GLTF_LOADER_URL = "https://esm.sh/three@0.164.1/examples/jsm/loaders/GLTFLoader.js";
const ORBIT_CONTROLS_URL = "https://esm.sh/three@0.164.1/examples/jsm/controls/OrbitControls.js";
const BOW_MODEL_URL = "Blender/BowModel.glb";
const BOW_MODEL_TARGET_SIZE = 3.35;
const MCU_MODEL_NAMES = [
  "MCU",
  "MCU_XIAO",
  "MCU_XIAO_NRF54L15",
  "MCU_XIAO_nRF54L15",
  "XIAO",
  "XIAO_MODULE",
];
const RISER_MODEL_NAMES = [
  "Riser",
  "Bow_Riser",
  "Bow_Compound_Riser",
];
const BOW_COMPOUND_PART_NAMES = [
  "String",
  "Top_Cam",
  "Bottom_Cam",
  "Riser",
  "Top_Text",
];

export const MOUNT_ORIENTATIONS = [
  {
    id: "firmware-x-90",
    label: "Current firmware mount",
    description: "Historical firmware mapping. Matches the legacy-x90 build profile; this preview does not detect the installed firmware.",
    axes: { x: "IMU X", y: "-IMU Z", z: "IMU Y" },
    firmware: "apply_mount_rotation: x'=x, y'=-z, z'=y",
    rotation: [0, 0, 0],
  },
  {
    id: "firmware-x-90-flipped",
    label: "Current mount, inverted sign",
    description: "Same physical mount with the firmware sign flipped for inverted cant or pitch.",
    axes: { x: "IMU X", y: "IMU Z", z: "-IMU Y" },
    firmware: "legacy-x90-inverted build profile",
    rotation: [Math.PI, 0, 0],
  },
  {
    id: "face-out-usb-up",
    label: "Face out, USB up",
    description: "Component side faces away from the bow, USB connector toward the upper limb.",
    axes: { x: "IMU X", y: "IMU Y", z: "IMU Z" },
    firmware: "identity mapping: x'=x, y'=y, z'=z",
    rotation: [0, 0, 0],
  },
  {
    id: "face-out-usb-down",
    label: "Face out, USB down",
    description: "Component side faces away from the bow, USB connector toward the lower limb.",
    axes: { x: "-IMU X", y: "-IMU Y", z: "IMU Z" },
    firmware: "rotate 180 degrees around board Z",
    rotation: [0, 0, Math.PI],
  },
  {
    id: "face-out-usb-left",
    label: "Face out, USB left",
    description: "Component side faces away from the bow, USB connector toward the string side.",
    axes: { x: "IMU Y", y: "-IMU X", z: "IMU Z" },
    firmware: "rotate 90 degrees clockwise around board Z",
    rotation: [0, 0, -Math.PI / 2],
  },
  {
    id: "face-out-usb-right",
    label: "Face out, USB right",
    description: "Component side faces away from the bow, USB connector toward the sight side.",
    axes: { x: "-IMU Y", y: "IMU X", z: "IMU Z" },
    firmware: "rotate 90 degrees counter-clockwise around board Z",
    rotation: [0, 0, Math.PI / 2],
  },
];

export function mountOrientationById(id) {
  return MOUNT_ORIENTATIONS.find((orientation) => orientation.id === id) || MOUNT_ORIENTATIONS[0];
}

export function cloneMountAxes(axes) {
  return { x: axes.x, y: axes.y, z: axes.z };
}

function negateAxisLabel(label) {
  return label.startsWith("-") ? label.slice(1) : `-${label}`;
}

export function rotateMountAxes(axes, bowAxis) {
  const next = cloneMountAxes(axes);
  if (bowAxis === "x") {
    next.y = negateAxisLabel(axes.z);
    next.z = axes.y;
  } else if (bowAxis === "y") {
    next.x = axes.z;
    next.z = negateAxisLabel(axes.x);
  } else if (bowAxis === "z") {
    next.x = negateAxisLabel(axes.y);
    next.y = axes.x;
  }
  return next;
}

export function mountFirmwareMappingText(axes) {
  return `x'=${axes.x.replace("IMU ", "").toLowerCase()}, y'=${axes.y.replace("IMU ", "").toLowerCase()}, z'=${axes.z.replace("IMU ", "").toLowerCase()}`;
}

export function mountOrientationState(state) {
  const preset = mountOrientationById(state.mountOrientation);
  return {
    ...preset,
    axes: state.mountAxes || preset.axes,
    rotation: state.mountRotation || preset.rotation,
    description: state.mountOrientation === "custom"
      ? "Custom mount preview built from 90 degree rotations around the bow axes."
      : preset.description,
    firmware: state.mountOrientation === "custom"
      ? mountFirmwareMappingText(state.mountAxes || preset.axes)
      : preset.firmware,
  };
}

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function radians(degrees) {
  return degrees * (Math.PI / 180);
}

export function calibratedAngle(value, offset) {
  return (Number.isFinite(value) ? value : 0) - (Number.isFinite(offset) ? offset : 0);
}

export function wrapAngleDeg(value) {
  let wrapped = value;
  while (wrapped > 180) wrapped -= 360;
  while (wrapped < -180) wrapped += 360;
  return wrapped;
}

// Display contract shared by Dashboard and the mount calibrator. Inputs are
// the calibrated numeric angles, not a second relative sensor quaternion.
// The imported model uses X for cant, Z for pitch and Y for heading.
export function modelDisplayRotation(roll, pitch, yaw, {
  modelInvertRoll = false, modelInvertPitch = false,
  modelSwapRollPitch = false, modelIgnoreYaw = false,
} = {}, baseYaw = 0) {
  const cant = (modelInvertRoll ? -1 : 1) * radians(roll);
  const tilt = (modelInvertPitch ? 1 : -1) * radians(pitch);
  return {
    x: modelSwapRollPitch ? tilt : cant,
    y: radians(baseYaw + (modelIgnoreYaw ? 0 : yaw)),
    z: modelSwapRollPitch ? cant : tilt,
    order: "XYZ",
  };
}

export function calibratedModelPose(sample, settings = {}) {
  const roll = calibratedAngle(sample.roll, settings.cantOffset);
  const pitch = calibratedAngle(sample.pitch, settings.pitchOffset);
  const yaw = wrapAngleDeg(calibratedAngle(sample.yaw, settings.yawOffset));
  return { roll, pitch, yaw, ...modelDisplayRotation(roll, pitch, yaw, settings) };
}

function blendAngleDeg(current, target, weight) {
  return wrapAngleDeg(current + wrapAngleDeg(target - current) * weight);
}

function viewRollDegrees(state) {
  return Number.isFinite(Number(state.viewRoll)) ? Number(state.viewRoll) : 0;
}

function applyCameraViewRoll(camera, rollDegrees, fallbackQuaternion = null, controls = null) {
  if (!controls && fallbackQuaternion) {
    camera.quaternion.copy(fallbackQuaternion);
  }
  camera.rotateZ(radians(rollDegrees));
}

function makeLine(THREE, points, color, opacity = 1) {
  const geometry = new THREE.BufferGeometry().setFromPoints(
    points.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
  );
  return new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({
      color,
      transparent: opacity < 1,
      opacity,
    }),
  );
}

function makeAxisLabel(THREE, text, color) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = "800 38px Inter, Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 8;
  ctx.strokeStyle = cssVar("--bg") || "#0b1512";
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const label = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }),
  );
  label.scale.set(0.86, 0.32, 1);
  label.renderOrder = 10;
  return label;
}

function makeAxisGuide(THREE, options = {}) {
  const {
    size = 1.45,
    xLabel = "+X",
    yLabel = "+Y",
    zLabel = "+Z",
    showNegativeLabels = false,
  } = options;
  const guide = new THREE.Group();
  const textColorStr = cssVar("--text") || "#E6F4EF";
  const colors = {
    x: 0x30e39b,
    y: new THREE.Color(textColorStr).getHex(),
    z: 0xffbe5c,
  };
  const labelColors = {
    x: "#30E39B",
    y: textColorStr,
    z: "#FFBE5C",
  };

  guide.add(makeLine(THREE, [[-size, 0, 0], [size, 0, 0]], colors.x, 0.72));
  guide.add(makeLine(THREE, [[0, -size, 0], [0, size, 0]], colors.y, 0.44));
  guide.add(makeLine(THREE, [[0, 0, -size], [0, 0, size]], colors.z, 0.58));

  const labelOffset = size + 0.18;
  const labels = [
    [xLabel, labelColors.x, [labelOffset, 0, 0]],
    [yLabel, labelColors.y, [0, labelOffset, 0]],
    [zLabel, labelColors.z, [0, 0, labelOffset]],
  ];
  if (showNegativeLabels) {
    labels.push(
      ["-X", labelColors.x, [-labelOffset, 0, 0]],
      ["-Y", labelColors.y, [0, -labelOffset, 0]],
      ["-Z", labelColors.z, [0, 0, -labelOffset]],
    );
  }

  for (const [text, color, position] of labels) {
    const label = makeAxisLabel(THREE, text, color);
    label.position.set(...position);
    guide.add(label);
  }

  return guide;
}

function addCylinderBetween(THREE, group, start, end, radius, material) {
  const a = new THREE.Vector3(...start);
  const b = new THREE.Vector3(...end);
  const midpoint = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  const direction = new THREE.Vector3().subVectors(b, a);
  const cylinder = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, direction.length(), 18),
    material,
  );
  cylinder.position.copy(midpoint);
  cylinder.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.normalize(),
  );
  group.add(cylinder);
  return cylinder;
}

function buildXiaoModule(THREE) {
  const module = new THREE.Group();
  module.rotation.order = "XYZ";

  const board = new THREE.Mesh(
    new THREE.BoxGeometry(0.36, 0.58, 0.045),
    new THREE.MeshStandardMaterial({
      color: 0x163f47,
      metalness: 0.12,
      roughness: 0.46,
    }),
  );
  module.add(board);

  const chip = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.18, 0.04),
    new THREE.MeshStandardMaterial({
      color: 0x061014,
      metalness: 0.18,
      roughness: 0.36,
    }),
  );
  chip.position.z = 0.044;
  module.add(chip);

  const usb = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.08, 0.06),
    new THREE.MeshStandardMaterial({
      color: 0xc7d5d0,
      metalness: 0.5,
      roughness: 0.26,
    }),
  );
  usb.position.set(0, 0.34, 0.02);
  module.add(usb);

  const imuDot = new THREE.Mesh(
    new THREE.SphereGeometry(0.032, 18, 12),
    new THREE.MeshStandardMaterial({
      color: 0xffbe5c,
      metalness: 0.1,
      roughness: 0.32,
    }),
  );
  imuDot.position.set(0.09, -0.07, 0.06);
  module.add(imuDot);

  return module;
}

function applyModuleOrientation(module, orientationState) {
  if (!module) return;
  const orientation = typeof orientationState === "string"
    ? mountOrientationById(orientationState)
    : mountOrientationState(orientationState || {});
  module.rotation.set(...orientation.rotation);
}

function mountPositionOffset(state) {
  const value = Array.isArray(state.mountPositionOffset)
    ? state.mountPositionOffset
    : [0, 0, 0];
  return [
    Number.isFinite(Number(value[0])) ? Number(value[0]) : 0,
    Number.isFinite(Number(value[1])) ? Number(value[1]) : 0,
    Number.isFinite(Number(value[2])) ? Number(value[2]) : 0,
  ];
}

function applyModulePosition(module, state) {
  if (!module) return;
  const bow = module.parent;
  if (!bow) return;
  const basePosition = module.userData.basePosition || module.position;
  const offset = mountPositionOffset(state || {});
  const offsetVector = module.userData.mountOffsetVector || module.position.clone();
  offsetVector.set(offset[0], offset[1], offset[2]);
  module.userData.mountOffsetVector = offsetVector;

  const originPosition = module.userData.originPosition || module.position.clone();
  originPosition.copy(basePosition).sub(offsetVector);
  module.userData.originPosition = originPosition;

  for (const child of bow.children) {
    if (child === module) continue;
    if (!child.userData.moduleOriginBasePosition) {
      child.userData.moduleOriginBasePosition = child.position.clone();
    }
    child.position.copy(child.userData.moduleOriginBasePosition).sub(originPosition);
  }

  module.position.set(0, 0, 0);
}

async function createOrbitControls(camera, canvas, target) {
  try {
    const { OrbitControls } = await import(ORBIT_CONTROLS_URL);
    const controls = new OrbitControls(camera, canvas);
    controls.target.copy(target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minDistance = 1.4;
    controls.maxDistance = 7.5;
    controls.update();
    return controls;
  } catch (error) {
    console.warn("Unable to load orbit controls for 3D preview.", error);
    return null;
  }
}

function modelAlignmentRotation(state) {
  const value = Array.isArray(state.modelAlignmentRotation)
    ? state.modelAlignmentRotation
    : [0, 0, 0];
  return [
    Number.isFinite(Number(value[0])) ? Number(value[0]) : 0,
    Number.isFinite(Number(value[1])) ? Number(value[1]) : 0,
    Number.isFinite(Number(value[2])) ? Number(value[2]) : 0,
  ];
}

function applyModelAlignment(modelRoot, state) {
  if (!modelRoot) return;
  const rotation = modelAlignmentRotation(state);
  modelRoot.rotation.set(...rotation);
}

function degreesLabel(radiansValue) {
  return `${Math.round(radiansValue * (180 / Math.PI))} deg`;
}

function normalizedHexColor(value, fallback = "#c7d5d0") {
  const text = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
}

function materialKey(name) {
  return String(name || "material")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "material";
}

function materialLabel(name) {
  return String(name || "Material")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function materialList(material) {
  if (!material) return [];
  return Array.isArray(material) ? material : [material];
}

function cloneMeshMaterials(mesh) {
  if (!mesh || mesh.userData.materialsClonedForAimTrace) return;
  if (Array.isArray(mesh.material)) {
    mesh.material = mesh.material.map((material) => material.clone());
  } else if (mesh.material) {
    mesh.material = mesh.material.clone();
  }
  mesh.userData.materialsClonedForAimTrace = true;
}

function materialLuminance(material) {
  if (!material?.color) return 1;
  return material.color.r * 0.2126 + material.color.g * 0.7152 + material.color.b * 0.0722;
}

function captureBaseMaterialColor(material) {
  if (!material?.color || material.userData.aimTraceBaseColor) return;
  material.userData.aimTraceBaseColor = `#${material.color.getHexString()}`;
  material.userData.aimTraceBaseLuminance = materialLuminance(material);
}

function isBowCompoundMesh(mesh) {
  const partNames = new Set(BOW_COMPOUND_PART_NAMES);
  if (partNames.has(mesh.name)) return true;
  let node = mesh;
  while (node) {
    if (node.name === "Bow_Compound_Default") return true;
    if (partNames.has(node.name)) return true;
    node = node.parent;
  }
  return false;
}

function isRiserMesh(mesh) {
  const names = new Set(RISER_MODEL_NAMES);
  if (names.has(mesh.name)) return true;
  let node = mesh;
  while (node) {
    if (String(node.name || "").toLowerCase().includes("riser")) return true;
    node = node.parent;
  }
  return materialList(mesh.material).some((material) => String(material.name || "").toLowerCase().includes("riser"));
}

function bowMaterialColors(state = {}) {
  const colors = state.bowMaterialColors && typeof state.bowMaterialColors === "object"
    ? { ...state.bowMaterialColors }
    : {};
  if (state.bowRiserColor && !colors.riser) {
    colors.riser = state.bowRiserColor;
  }
  if (state.bowHandleColor && !colors.grip) {
    colors.grip = state.bowHandleColor;
  }
  return colors;
}

function collectBowMaterials(modelRoot) {
  const materialsByKey = new Map();
  if (!modelRoot) return [];
  modelRoot.traverse((child) => {
    if (!child.isMesh || !isBowCompoundMesh(child)) return;
    for (const material of materialList(child.material)) {
      if (!material?.color) continue;
      captureBaseMaterialColor(material);
      const name = material.name || child.name || "material";
      const key = materialKey(name);
      if (!materialsByKey.has(key)) {
        materialsByKey.set(key, {
          key,
          label: materialLabel(name),
          defaultColor: material.userData.aimTraceBaseColor || `#${material.color.getHexString()}`,
        });
      }
    }
  });
  return [...materialsByKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function applyBowCustomization(modelRoot, state = {}) {
  if (!modelRoot) return;
  const colors = bowMaterialColors(state);
  modelRoot.traverse((child) => {
    if (!child.isMesh || !isBowCompoundMesh(child)) return;
    cloneMeshMaterials(child);
    const materials = materialList(child.material);
    for (const material of materials) {
      if (!material?.color) continue;
      captureBaseMaterialColor(material);
      const key = materialKey(material.name || child.name);
      const defaultColor = material.userData.aimTraceBaseColor || `#${material.color.getHexString()}`;
      material.color.set(normalizedHexColor(colors[key], defaultColor));
      material.needsUpdate = true;
    }
  });
}

function renderBowMaterialColorControls(materials, store, el, saveSettingsToCache = null) {
  if (!el.bowMaterialColorList) return;
  const currentColors = bowMaterialColors(store.get());
  el.bowMaterialColorList.replaceChildren();

  for (const material of materials) {
    const control = document.createElement("div");
    control.className = "bow-color-control";

    const label = document.createElement("label");
    const inputId = `bowMaterialColor-${material.key}`;
    label.htmlFor = inputId;
    label.textContent = material.label;

    const row = document.createElement("div");
    row.className = "bow-color-row";

    const input = document.createElement("input");
    input.type = "color";
    input.id = inputId;
    input.value = normalizedHexColor(currentColors[material.key], material.defaultColor);

    const value = document.createElement("span");
    value.textContent = input.value.toUpperCase();

    input.addEventListener("input", () => {
      const nextColors = {
        ...bowMaterialColors(store.get()),
        [material.key]: input.value,
      };
      store.set({ bowMaterialColors: nextColors });
      value.textContent = input.value.toUpperCase();
      if (typeof saveSettingsToCache === "function") {
        saveSettingsToCache();
      }
    });

    row.append(input, value);
    control.append(label, row);
    el.bowMaterialColorList.append(control);
  }
}

function findNamedMountPoint(root) {
  const mountNames = new Set([
    "XIAO_MOUNT_POINT",
    "XIAO_MOUNT",
    "MODULE_MOUNT_POINT",
    "MODULE_MOUNT",
  ]);
  let mountPoint = null;
  root.traverse((child) => {
    if (!mountPoint && mountNames.has(child.name)) {
      mountPoint = child;
    }
  });
  return mountPoint;
}

function findNamedPivotPoint(root) {
  const pivotNames = new Set([
    "BOW_PIVOT",
    "BOW_CENTER",
    "BOW_ORIGIN",
    "GRIP_CENTER",
    "PRESSURE_POINT",
  ]);
  let pivotPoint = null;
  root.traverse((child) => {
    if (!pivotPoint && pivotNames.has(child.name)) {
      pivotPoint = child;
    }
  });
  return pivotPoint;
}

function findNamedModelPart(root, names) {
  const nameSet = new Set(names);
  const directChild = root.children.find((child) => nameSet.has(child.name));
  if (directChild) return directChild;

  let match = null;
  root.traverse((child) => {
    if (!match && nameSet.has(child.name)) {
      match = child;
    }
  });
  return match;
}

function detachModelPart(THREE, root, names) {
  const source = findNamedModelPart(root, names);
  if (!source || !source.parent) return null;

  root.updateMatrixWorld(true);
  source.updateWorldMatrix(true, true);
  const detached = source.clone(true);
  source.matrixWorld.decompose(detached.position, detached.quaternion, detached.scale);
  detached.name = source.name;
  detached.userData.importedModelPart = source.name;
  source.parent.remove(source);
  return detached;
}

function attachXiaoModule(THREE, bow, mountPoint = null, moduleModel = null) {
  const xiaoModule = moduleModel || buildXiaoModule(THREE);
  xiaoModule.rotation.order = "XYZ";
  if (!moduleModel) {
    xiaoModule.scale.setScalar(0.86);
  }

  if (mountPoint) {
    bow.updateMatrixWorld(true);
    const mountPosition = new THREE.Vector3();
    const mountQuaternion = new THREE.Quaternion();
    mountPoint.getWorldPosition(mountPosition);
    mountPoint.getWorldQuaternion(mountQuaternion);
    bow.worldToLocal(mountPosition);
    xiaoModule.position.copy(mountPosition);
    xiaoModule.quaternion.copy(mountQuaternion);
  } else if (!moduleModel) {
    xiaoModule.position.set(-0.22, 0.0, 0.16);
  }
  xiaoModule.userData.basePosition = xiaoModule.position.clone();

  bow.add(xiaoModule);
  bow.userData.xiaoModule = xiaoModule;
  return xiaoModule;
}

function buildProceduralBowModel(THREE) {
  const bow = new THREE.Group();
  bow.rotation.order = "YZX";

  const riserMaterial = new THREE.MeshStandardMaterial({
    color: 0x35c7e8,
    metalness: 0.22,
    roughness: 0.42,
  });
  const limbMaterial = new THREE.MeshStandardMaterial({
    color: 0x30e39b,
    metalness: 0.08,
    roughness: 0.55,
  });
  const stringMaterial = new THREE.LineBasicMaterial({ color: 0xe6f4ef });
  const sightMaterial = new THREE.MeshStandardMaterial({
    color: 0xffbe5c,
    metalness: 0.18,
    roughness: 0.34,
  });

  const riser = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 2.25, 0.16),
    riserMaterial,
  );
  riser.name = "Riser";
  bow.add(riser);

  addCylinderBetween(THREE, bow, [0, 1.08, 0], [0.24, 1.62, 0], 0.045, limbMaterial);
  addCylinderBetween(THREE, bow, [0, -1.08, 0], [0.24, -1.62, 0], 0.045, limbMaterial);

  const stringGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0.24, 1.62, -0.08),
    new THREE.Vector3(-0.18, 0, -0.14),
    new THREE.Vector3(0.24, -1.62, -0.08),
  ]);
  bow.add(new THREE.Line(stringGeometry, stringMaterial));

  const sightRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.18, 0.018, 12, 48),
    sightMaterial,
  );
  sightRing.position.set(0.43, 0.24, 0.25);
  sightRing.rotation.y = Math.PI / 2;
  bow.add(sightRing);

  addCylinderBetween(THREE, bow, [0.08, 0.24, 0.08], [0.43, 0.24, 0.25], 0.018, sightMaterial);

  const levelBar = new THREE.Mesh(
    new THREE.BoxGeometry(0.46, 0.035, 0.035),
    new THREE.MeshStandardMaterial({
      color: 0xe6f4ef,
      metalness: 0.05,
      roughness: 0.5,
    }),
  );
  levelBar.position.set(0.43, -0.05, 0.25);
  bow.add(levelBar);

  attachXiaoModule(THREE, bow);

  return bow;
}

async function loadBowModel(THREE) {
  try {
    const { GLTFLoader } = await import(GLTF_LOADER_URL);
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(BOW_MODEL_URL);
    const model = gltf.scene;
    const bow = new THREE.Group();
    bow.rotation.order = "YZX";
    bow.userData.modelSource = BOW_MODEL_URL;

    const mountPoint = findNamedMountPoint(model);
    const pivotPoint = findNamedPivotPoint(model);
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    if (pivotPoint) {
      pivotPoint.updateWorldMatrix(true, false);
      const pivot = new THREE.Vector3();
      pivotPoint.getWorldPosition(pivot);
      model.position.sub(pivot);
      bow.userData.modelPivotSource = pivotPoint.name;
    } else {
      model.position.sub(center);
      bow.userData.modelPivotSource = "bounding-box";
    }

    const maxDimension = Math.max(size.x, size.y, size.z);
    const scale = maxDimension > 0 ? BOW_MODEL_TARGET_SIZE / maxDimension : 1;
    model.scale.setScalar(scale);

    model.traverse((child) => {
      if (child.isMesh) {
        child.frustumCulled = false;
      }
    });

    const mcuModel = detachModelPart(THREE, model, MCU_MODEL_NAMES);

    bow.add(model);
    bow.userData.modelRoot = model;
    attachXiaoModule(THREE, bow, mountPoint, mcuModel);
    return bow;
  } catch (error) {
    console.warn(`Unable to load ${BOW_MODEL_URL}; using procedural bow fallback.`, error);
    return buildProceduralBowModel(THREE);
  }
}

export async function initOrientationVisualizer(el, store, { liveOnly = false } = {}) {
  if (!el.orientationCanvas) return;

  let THREE;
  try {
    THREE = await import(THREE_URL);
  } catch (error) {
    el.orientationCanvas.classList.add("orientation-unavailable");
    return;
  }

  const canvas = el.orientationCanvas;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  camera.position.set(3.2, 1.7, 4.2);
  camera.lookAt(0, 0, 0);
  const baseCameraQuaternion = camera.quaternion.clone();
  const controls = await createOrbitControls(camera, canvas, new THREE.Vector3(0, 0, 0));

  scene.add(new THREE.AmbientLight(0xe6f4ef, 1.1));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.9);
  keyLight.position.set(3, 4, 5);
  scene.add(keyLight);

  const guide = new THREE.Group();
  guide.add(makeLine(THREE, [[-1.45, 0, 0], [1.45, 0, 0]], 0x30e39b, 0.72));
  guide.add(makeLine(THREE, [[0, -1.45, 0], [0, 1.45, 0]], 0xe6f4ef, 0.36));
  guide.add(makeLine(THREE, [[0, 0, -1.2], [0, 0, 1.2]], 0xffbe5c, 0.42));
  scene.add(guide);

  const bow = await loadBowModel(THREE);
  scene.add(bow);

  let targetRoll = 0;
  let targetPitch = 0;
  let targetYaw = 0;
  let viewRoll = 0;
  let targetQuat = null;
  let visualQuat = null;

  store.subscribe((state) => {
    let roll = state.roll;
    let pitch = state.pitch;
    let yaw = state.yaw || 0;

    if (!liveOnly && state.reviewMode && state.reviewTrace && state.reviewTrace.length > 0) {
      const progress = Math.max(0, Math.min(1, state.replayProgress ?? 1));
      const idx = Math.min(state.reviewTrace.length - 1, Math.floor(progress * (state.reviewTrace.length - 1)));
      const pt = state.reviewTrace[idx];
      roll = pt.roll || 0;
      pitch = pt.pitch || 0;
      yaw = pt.yaw || 0;
    }

    const pose = calibratedModelPose({ roll, pitch, yaw }, state);
    targetRoll = pose.roll;
    targetPitch = pose.pitch;
    targetYaw = pose.yaw;
    applyModuleOrientation(bow.userData.xiaoModule, state);
    applyModulePosition(bow.userData.xiaoModule, state);
    applyModelAlignment(bow.userData.modelRoot, state);
    applyBowCustomization(bow.userData.modelRoot, state);
    viewRoll = viewRollDegrees(state);
    if (el.orientationRollValue) {
      el.orientationRollValue.textContent = targetRoll.toFixed(1);
    }
    if (el.orientationPitchValue) {
      el.orientationPitchValue.textContent = targetPitch.toFixed(1);
    }
    if (el.orientationYawValue) {
      el.orientationYawValue.textContent = targetYaw.toFixed(1);
    }
    if (el.calOffsetRollValue) {
      el.calOffsetRollValue.textContent = (Number(state.cantOffset) || 0).toFixed(1);
    }
    if (el.calOffsetPitchValue) {
      el.calOffsetPitchValue.textContent = (Number(state.pitchOffset) || 0).toFixed(1);
    }
    if (el.calOffsetYawValue) {
      el.calOffsetYawValue.textContent = (Number(state.yawOffset) || 0).toFixed(1);
    }

    // Match the calibrator's zero-offset and axis semantics for live and
    // recorded samples alike. Quaternion interpolation only smooths display;
    // it must not introduce a different calibration frame.
    targetQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(pose.x, pose.y, pose.z, pose.order),
    );
  });

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function animate() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      requestAnimationFrame(animate);
      return;
    }
    if (canvas.width !== Math.round(rect.width * renderer.getPixelRatio()) ||
        canvas.height !== Math.round(rect.height * renderer.getPixelRatio())) {
      resize();
    }

    if (targetQuat) {
      if (!visualQuat) visualQuat = targetQuat.clone();
      else visualQuat.slerp(targetQuat, 0.16);
      bow.quaternion.copy(visualQuat);
    }
    guide.rotation.z = 0;

    if (controls) controls.update();
    applyCameraViewRoll(camera, viewRoll, baseCameraQuaternion, controls);
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }

  window.addEventListener("resize", resize);
  resize();
  animate();
}

export async function mountOrientationSettings({ store, el }) {
  if (!el.mountOrientationCanvas) return;

  let THREE;
  try {
    THREE = await import(THREE_URL);
  } catch (error) {
    el.mountOrientationCanvas.classList.add("orientation-unavailable");
    return;
  }

  const canvas = el.mountOrientationCanvas;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  camera.position.set(3.1, 1.25, 4.1);
  camera.lookAt(0, 0, 0);
  const baseCameraQuaternion = camera.quaternion.clone();
  const controls = await createOrbitControls(camera, canvas, new THREE.Vector3(0, 0, 0));

  scene.add(new THREE.AmbientLight(0xe6f4ef, 1.15));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
  keyLight.position.set(3, 4, 5);
  scene.add(keyLight);

  const guide = makeAxisGuide(THREE, {
    size: 1.18,
    xLabel: "X axis",
    yLabel: "Y axis",
    zLabel: "Z axis",
  });
  scene.add(guide);

  const bow = await loadBowModel(THREE);
  bow.rotation.y = radians(12);
  scene.add(bow);
  let viewRoll = 0;

  // Live orientation so users can wiggle-test the mount from this card.
  // Mirrors the dashboard visualizer; 12 deg base yaw keeps the static
  // three-quarter view when no sensor is streaming.
  const MOUNT_PREVIEW_BASE_YAW_DEG = 12;
  let targetRoll = 0;
  let targetPitch = 0;
  let targetYaw = 0;
  let visualRoll = 0;
  let visualPitch = 0;
  let visualYaw = 0;
  let modelRollSign = 1;
  let modelPitchSign = -1;
  let modelSwapRollPitch = false;
  let modelIgnoreYaw = false;

  function updateOrientation(state) {
    const pose = calibratedModelPose(state, state);
    targetRoll = pose.roll;
    targetPitch = pose.pitch;
    targetYaw = pose.yaw;
    modelRollSign = state.modelInvertRoll ? -1 : 1;
    modelPitchSign = state.modelInvertPitch ? 1 : -1;
    modelSwapRollPitch = !!state.modelSwapRollPitch;
    modelIgnoreYaw = !!state.modelIgnoreYaw;
    if (el.mountLiveCantValue) el.mountLiveCantValue.textContent = targetRoll.toFixed(1);
    if (el.mountLivePitchValue) el.mountLivePitchValue.textContent = targetPitch.toFixed(1);

    const orientation = mountOrientationState(state);
    applyModuleOrientation(bow.userData.xiaoModule, state);
    applyModulePosition(bow.userData.xiaoModule, state);
    applyModelAlignment(bow.userData.modelRoot, state);
    applyBowCustomization(bow.userData.modelRoot, state);
    if (el.mountOrientationDescription) {
      el.mountOrientationDescription.textContent = orientation.description;
    }
    if (el.mountAxisXValue) el.mountAxisXValue.textContent = orientation.axes.x;
    if (el.mountAxisYValue) el.mountAxisYValue.textContent = orientation.axes.y;
    if (el.mountAxisZValue) el.mountAxisZValue.textContent = orientation.axes.z;
    if (el.mountFirmwareNote) {
      el.mountFirmwareNote.textContent = `Preview only: ${orientation.firmware}. Guided results use streamed axes and Bow Y up; they must be composed with the installed firmware mapping and converted to Z-up before use in firmware.`;
    }
    if (el.mountOrientationSelect && el.mountOrientationSelect.value !== state.mountOrientation) {
      el.mountOrientationSelect.value = state.mountOrientation;
    }
    const modelRotation = modelAlignmentRotation(state);
    if (el.modelAxisXValue) el.modelAxisXValue.textContent = degreesLabel(modelRotation[0]);
    if (el.modelAxisYValue) el.modelAxisYValue.textContent = degreesLabel(modelRotation[1]);
    if (el.modelAxisZValue) el.modelAxisZValue.textContent = degreesLabel(modelRotation[2]);
    if (el.modelInvertRollToggle) el.modelInvertRollToggle.checked = !!state.modelInvertRoll;
    if (el.modelInvertPitchToggle) el.modelInvertPitchToggle.checked = !!state.modelInvertPitch;
    if (el.modelSwapRollPitchToggle) el.modelSwapRollPitchToggle.checked = !!state.modelSwapRollPitch;
    if (el.modelIgnoreYawToggle) el.modelIgnoreYawToggle.checked = !!state.modelIgnoreYaw;
    viewRoll = viewRollDegrees(state);
    if (el.mountViewRollValue) el.mountViewRollValue.textContent = Math.round(viewRoll);
    if (el.mountViewRollSlider) el.mountViewRollSlider.value = String(viewRoll);
    const position = mountPositionOffset(state);
    if (el.mountPositionXValue) el.mountPositionXValue.textContent = position[0].toFixed(2);
    if (el.mountPositionYValue) el.mountPositionYValue.textContent = position[1].toFixed(2);
    if (el.mountPositionZValue) el.mountPositionZValue.textContent = position[2].toFixed(2);
    if (el.mountPositionXSlider) el.mountPositionXSlider.value = String(position[0]);
    if (el.mountPositionYSlider) el.mountPositionYSlider.value = String(position[1]);
    if (el.mountPositionZSlider) el.mountPositionZSlider.value = String(position[2]);
  }

  store.subscribe(updateOrientation);
  updateOrientation(store.get());

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function animate() {
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== Math.round(rect.width * renderer.getPixelRatio()) ||
        canvas.height !== Math.round(rect.height * renderer.getPixelRatio())) {
      resize();
    }

    visualRoll += (targetRoll - visualRoll) * 0.16;
    visualPitch += (targetPitch - visualPitch) * 0.16;
    visualYaw = blendAngleDeg(visualYaw, modelIgnoreYaw ? 0 : targetYaw, 0.16);

    const rotation = modelDisplayRotation(visualRoll, visualPitch, visualYaw, {
      modelInvertRoll: modelRollSign === -1,
      modelInvertPitch: modelPitchSign === 1,
      modelSwapRollPitch,
      modelIgnoreYaw,
    }, MOUNT_PREVIEW_BASE_YAW_DEG);
    bow.rotation.set(rotation.x, rotation.y, rotation.z, rotation.order);
    if (controls) controls.update();
    applyCameraViewRoll(camera, viewRoll, baseCameraQuaternion, controls);
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }

  window.addEventListener("resize", resize);
  resize();
  animate();
}

export async function mountBowShop({ store, el, saveSettingsToCache = null }) {
  if (!el.bowShopCanvas) return;

  let THREE;
  try {
    THREE = await import(THREE_URL);
  } catch (error) {
    el.bowShopCanvas.classList.add("orientation-unavailable");
    return;
  }

  const canvas = el.bowShopCanvas;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  camera.position.set(3.2, 1.35, 4.25);
  camera.lookAt(0, 0, 0);
  const controls = await createOrbitControls(camera, canvas, new THREE.Vector3(0, 0, 0));

  scene.add(new THREE.AmbientLight(0xe6f4ef, 1.15));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
  keyLight.position.set(3, 4, 5);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x35c7e8, 0.55);
  fillLight.position.set(-3, 1.5, 2);
  scene.add(fillLight);

  const guide = makeAxisGuide(THREE, {
    size: 1.1,
    xLabel: "X",
    yLabel: "Y",
    zLabel: "Z",
  });
  scene.add(guide);

  const bow = await loadBowModel(THREE);
  bow.rotation.y = radians(12);
  scene.add(bow);
  renderBowMaterialColorControls(
    collectBowMaterials(bow.userData.modelRoot),
    store,
    el,
    saveSettingsToCache,
  );

  function updateCustomization(state) {
    applyModuleOrientation(bow.userData.xiaoModule, state);
    applyModulePosition(bow.userData.xiaoModule, state);
    applyModelAlignment(bow.userData.modelRoot, state);
    applyBowCustomization(bow.userData.modelRoot, state);
  }

  store.subscribe(updateCustomization);
  updateCustomization(store.get());

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function animate() {
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== Math.round(rect.width * renderer.getPixelRatio()) ||
        canvas.height !== Math.round(rect.height * renderer.getPixelRatio())) {
      resize();
    }

    bow.rotation.y = radians(12);
    if (controls) controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }

  window.addEventListener("resize", resize);
  resize();
  animate();
}
