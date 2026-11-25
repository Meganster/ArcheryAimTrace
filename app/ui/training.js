// Steady Aim Training Game UI Module
// Runs the set/repetition program, audio cues, hold traces and saved results.

import { put, generateUUID } from "../core/db.js?v=aim-pipeline-163";
import { computeFloatScoreFromTrace } from "../telemetry/score.js?v=aim-pipeline-163";
import { drawTargetFace, getTargetViewPreset } from "./target-face.js?v=aim-pipeline-163";
import { drawAimTrace, hasAimTrace } from "./aim-trace.js?v=aim-pipeline-163";
import { aimAngles } from "../telemetry/aim-projection.js?v=aim-pipeline-163";

import { createTrainingClock, STEADY_AIM_PROGRAM, TRAINING_LIMITS, validateTrainingProgram, trainingPhases } from "./training-program.js?v=aim-pipeline-163";

// Marker colors that must flip with the page theme (white on the classic dark
// canvas, ink on light themes). Falls back to the classic palette when the
// --trace-* variables are not defined.
function canvasMarkerInk() {
  const styles = getComputedStyle(document.documentElement);
  return {
    dotRing: styles.getPropertyValue("--trace-dot-ring").trim() || "#FFFFFF",
    crosshair: styles.getPropertyValue("--trace-crosshair").trim() || "rgba(255, 255, 255, 0.6)",
    hold: styles.getPropertyValue("--green").trim() || "#30E39B",
    liveDot: styles.getPropertyValue("--cyan").trim() || "#35C7E8",
    refDot: styles.getPropertyValue("--red").trim() || "#FF5D73",
  };
}

// Stats Helper Functions
function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = mean(values.map((v) => (v - m) ** 2));
  return Math.sqrt(variance);
}

function getMaxFloatSpan(samples) {
  let maxDist = 0;
  // If we have a lot of samples, decimate for performance
  const step = Math.max(1, Math.floor(samples.length / 500));
  const pts = [];
  for (let i = 0; i < samples.length; i += step) {
    pts.push(samples[i]);
  }
  
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = aimAngles(pts[i]);
      const b = aimAngles(pts[j]);
      const dx = a && b ? a.horizontal - b.horizontal : (pts[i].roll || 0) - (pts[j].roll || 0);
      const dy = a && b ? a.vertical - b.vertical : (pts[i].pitch || 0) - (pts[j].pitch || 0);
      const dist = Math.hypot(dx, dy);
      if (dist > maxDist) maxDist = dist;
    }
  }
  return maxDist;
}

export function mountTraining({ store, telemetry, el, bus }) {
  if (!el.trainingTargetCanvas) return;

  const ctx = el.trainingTargetCanvas.getContext("2d");
  
  let gameState = "idle";
  let timerInterval = null;
  let animationFrame = null;
  let audioCtx = null;
  const tones = new Set();
  let program = { ...STEADY_AIM_PROGRAM };
  let clock = createTrainingClock(program);
  const fields = Object.fromEntries(Object.keys(TRAINING_LIMITS).map(key => [key, el[`training_${key}`]]));
  let runToken = 0;
  let holds = [];
  let completedReps = 0;
  let holdStartedAt = null;
  let refRoll = 0;
  let refPitch = 0;
  let trainingSamples = [];

  let liveDotRoll = null;
  let liveDotPitch = null;

  function lockSettings(locked) {
    for (const field of Object.values(fields)) field.disabled = locked;
  }

  function readSettings(report = false) {
    for (const field of Object.values(fields)) {
      if (!field.checkValidity()) {
        if (report) field.reportValidity();
        return null;
      }
    }
    try {
      return validateTrainingProgram(Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value])));
    } catch { return null; }
  }

  function updateProgramSummary() {
    if (gameState !== "idle") return;
    const selected = readSettings();
    if (!selected) {
      el.trainingProgress.textContent = "Enter valid values in all training fields.";
      return;
    }
    const seconds = trainingPhases(selected).reduce((total, phase) => total + phase.seconds, 0);
    el.trainingProgress.textContent = `${selected.sets} sets × ${selected.reps} reps · ${Math.floor(seconds / 60)} min ${seconds % 60} sec`;
  }

  for (const [key, field] of Object.entries(fields)) {
    const [min, max] = TRAINING_LIMITS[key];
    field.min = min; field.max = max; field.step = 1; field.required = true;
    field.value = STEADY_AIM_PROGRAM[key];
    field.addEventListener("input", updateProgramSummary);
  }
  updateProgramSummary();

  function playTone(frequency, durationMs) {
    if (!audioCtx || audioCtx.state !== "running") return;
    const oscillator = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    oscillator.connect(gain);
    gain.connect(audioCtx.destination);
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + durationMs / 1000);
    tones.add(oscillator);
    oscillator.onended = () => { tones.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
    oscillator.start();
    oscillator.stop(audioCtx.currentTime + durationMs / 1000);
  }

  function stopActivity() {
    ++runToken;
    clock.stop();
    clearInterval(timerInterval);
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
    for (const tone of tones) { try { tone.stop(); } catch {} }
    tones.clear();
  }

  // React to connection states in the reactive store
  store.subscribe((state) => {
    const connected = state.connected;
    if (!connected && !["idle", "finished", "saving"].includes(gameState)) {
      endSession("Sensor disconnected. Session stopped.");
    }
    
    if (el.startTrainingBtn) {
      el.startTrainingBtn.disabled = !connected || gameState !== "idle";
    }

    if (el.trainingStatusText && el.trainingStatusDesc) {
      if (connected) {
        el.trainingStatusText.textContent = state.statusMode === "demo" ? "Demo Mode" : "Connected";
        el.trainingStatusText.style.color = "var(--green)";
        el.trainingStatusDesc.textContent = gameState === "idle"
          ? "Bow sensor is streaming. Press start to train." : "Bow sensor is streaming.";
      } else {
        el.trainingStatusText.textContent = "Disconnected";
        el.trainingStatusText.style.color = "var(--red)";
        el.trainingStatusDesc.textContent = "Connect a sensor or start demo mode to train.";
      }
    }

    // Live display updates during hold
    if (gameState === "holding" && state.sample) {
      liveDotRoll = state.roll;
      liveDotPitch = state.pitch;
      if (el.trainingCantBadge) {
        // Calculate calibrated cant
        const calRoll = state.roll - (state.cantOffset || 0);
        el.trainingCantBadge.textContent = `Cant: ${calRoll.toFixed(1)}°`;
        el.trainingCantBadge.style.color = Math.abs(calRoll) <= (state.levelTolerance || 2.0) ? "var(--green)" : "var(--amber)";
      }
    }
  });

  // Listen to raw samples from event bus to collect high-res trace data
  bus.on("sample", (sample) => {
    if (gameState !== "holding") return;
    
    const state = store.get();
    const now = performance.now();
    if (now >= clock.snapshot(now).deadline) return;
    
    trainingSamples.push({
      aim: state.aim,
      roll: state.roll,
      pitch: state.pitch,
      yaw: state.yaw || 0,
      gx: sample.gxDps || 0,
      gy: sample.gyDps || 0,
      gz: sample.gzDps || 0,
      ax: (sample.axMg || 0) / 1000,
      ay: (sample.ayMg || 0) / 1000,
      az: (sample.azMg || 1000) / 1000,
      timestamp: now,
      micAmp: sample.micAmp || 0
    });
  });

  // Setup click listeners
  el.startTrainingBtn.addEventListener("click", startSession);
  el.cancelTrainingBtn.addEventListener("click", cancelSession);
  el.pauseTrainingBtn.addEventListener("click", togglePause);
  el.saveTrainingShotBtn.addEventListener("click", saveSession);
  el.discardTrainingShotBtn.addEventListener("click", discardSession);

  // Resize canvas handler
  function resizeCanvas() {
    const canvas = el.trainingTargetCanvas;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  window.addEventListener("resize", resizeCanvas);

  function renderLoop() {
    if (gameState === "idle") return;

    const canvas = el.trainingTargetCanvas;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    
    // Ensure canvas backing store matches bounding rect
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      resizeCanvas();
    }

    ctx.clearRect(0, 0, w, h);

    const markerInk = canvasMarkerInk();
    const cx = w / 2;
    const cy = h / 2;
    const maxRadius = Math.min(w, h) * 0.45;

    if (hasAimTrace(trainingSamples) && (gameState === "holding" || ["finished", "saving"].includes(gameState))) {
      drawAimTrace(ctx, trainingSamples, {
        cx, cy, radius: maxRadius, mode: store.get().targetViewMode,
        phaseColor: () => markerInk.hold,
      });
      animationFrame = requestAnimationFrame(renderLoop);
      return;
    }

    // 1. Draw Target
    drawTargetFace(ctx, {
      cx,
      cy,
      maxRadius,
      preset: getTargetViewPreset(store.get().targetViewMode, store.get().targetDistanceM),
    });
    ctx.fillStyle = markerInk.crosshair;
    ctx.font = "12px sans-serif";
    ctx.fillText("Legacy cant/pitch · capture center in Settings → Calibration", 12, 56);

    // 2. Draw Center Crosshair
    ctx.strokeStyle = "rgba(142, 166, 160, 0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - maxRadius, cy);
    ctx.lineTo(cx + maxRadius, cy);
    ctx.moveTo(cx, cy - maxRadius);
    ctx.lineTo(cx, cy + maxRadius);
    ctx.stroke();

    if (gameState === "holding" && trainingSamples.length > 0) {
      // Live hold rendering (Fixed visual scale: 1.5° deflection reaches target blue ring)
      const scale = (maxRadius * 0.6) / 1.5;

      // Draw Trace Path
      ctx.save();
      ctx.strokeStyle = markerInk.hold;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = 0; i < trainingSamples.length; i++) {
        const pt = trainingSamples[i];
        const x = cx + (pt.roll - refRoll) * scale;
        const y = cy - (pt.pitch - refPitch) * scale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();

      // Draw Live Position Dot
      if (liveDotRoll !== null) {
        const lx = cx + (liveDotRoll - refRoll) * scale;
        const ly = cy - (liveDotPitch - refPitch) * scale;
        
        ctx.fillStyle = markerInk.liveDot; // Live indicator dot (cyan)
        ctx.beginPath();
        ctx.arc(lx, ly, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = markerInk.dotRing;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Crosshair for live dot
        ctx.strokeStyle = markerInk.crosshair;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(lx - 10, ly);
        ctx.lineTo(lx + 10, ly);
        ctx.moveTo(lx, ly - 10);
        ctx.lineTo(lx, ly + 10);
        ctx.stroke();
      }
    } else if (["finished", "saving"].includes(gameState) && trainingSamples.length >= 2) {
      // Finished view: auto-scale to review trajectory shape, center on average float point
      const rolls = trainingSamples.map((pt) => pt.roll);
      const pitches = trainingSamples.map((pt) => pt.pitch);
      const avgR = mean(rolls);
      const avgP = mean(pitches);

      let maxDev = 0.05;
      for (let i = 0; i < trainingSamples.length; i++) {
        const dev = Math.hypot(rolls[i] - avgR, pitches[i] - avgP);
        if (dev > maxDev) maxDev = dev;
      }
      const scale = (maxRadius * 0.9) / maxDev;

      // Draw standard-deviation ellipse (sigma error ellipse)
      const ellipseData = calculateSigmaEllipse(trainingSamples, scale);
      if (ellipseData) {
        const ecx = cx + (ellipseData.rollMean - avgR) * scale;
        const ecy = cy - (ellipseData.pitchMean - avgP) * scale;
        
        ctx.save();
        ctx.translate(ecx, ecy);
        ctx.rotate(-ellipseData.angle);
        ctx.fillStyle = markerInk.hold;
        ctx.strokeStyle = markerInk.hold;

        ctx.save();
        ctx.globalAlpha = 0.12;
        ctx.beginPath();
        ctx.ellipse(0, 0, ellipseData.radiusX, ellipseData.radiusY, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(0, 0, ellipseData.radiusX, ellipseData.radiusY, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        ctx.restore();
      }

      // Draw Trace Path
      ctx.strokeStyle = markerInk.hold; // Green trace
      ctx.lineWidth = 2.8;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = 0; i < trainingSamples.length; i++) {
        const pt = trainingSamples[i];
        const x = cx + (pt.roll - avgR) * scale;
        const y = cy - (pt.pitch - avgP) * scale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Draw final reference crosshair on the center of average float
      ctx.fillStyle = markerInk.refDot;
      ctx.strokeStyle = markerInk.dotRing;
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    if (gameState === "holding" || ["finished", "saving"].includes(gameState)) {
      animationFrame = requestAnimationFrame(renderLoop);
    }
  }

  function calculateSigmaEllipse(points, scale) {
    if (points.length < 8) return null;

    const rolls = points.map((pt) => pt.roll || 0);
    const pitches = points.map((pt) => pt.pitch || 0);
    const rollMean = mean(rolls);
    const pitchMean = mean(pitches);
    
    let covRoll = 0;
    let covPitch = 0;
    let covCross = 0;

    for (let i = 0; i < points.length; i++) {
      const dx = rolls[i] - rollMean;
      const dy = pitches[i] - pitchMean;
      covRoll += dx * dx;
      covPitch += dy * dy;
      covCross += dx * dy;
    }

    covRoll /= points.length;
    covPitch /= points.length;
    covCross /= points.length;

    const traceVal = covRoll + covPitch;
    const delta = Math.sqrt(Math.max(0, ((covRoll - covPitch) / 2) ** 2 + covCross ** 2));
    const lambda1 = Math.max(0.0001, traceVal / 2 + delta);
    const lambda2 = Math.max(0.0001, traceVal / 2 - delta);
    const angle = Math.atan2(2 * covCross, covRoll - covPitch) / 2;

    const radiusX = Math.max(8, Math.sqrt(lambda1) * scale);
    const radiusY = Math.max(6, Math.sqrt(lambda2) * scale);

    return {
      rollMean,
      pitchMean,
      radiusX,
      radiusY,
      angle
    };
  }

  async function startSession() {
    if (gameState !== "idle" || !store.get().connected) return;
    const selected = readSettings(true);
    if (!selected) return;
    program = selected;
    clock = createTrainingClock(program);
    lockSettings(true);
    gameState = "starting";
    const token = ++runToken;
    holds = [];
    completedReps = 0;
    trainingSamples = [];
    el.startTrainingBtn.classList.add("hidden");
    el.cancelTrainingBtn.classList.remove("hidden");
    el.trainingResultsCard.classList.add("hidden");
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      await audioCtx.resume(); // Unlock audio from the Start button gesture.
      if (token !== runToken) return;
      if (audioCtx.state !== "running") throw new Error("Audio is unavailable");
      el.pauseTrainingBtn.classList.remove("hidden");
      el.pauseTrainingBtn.textContent = "Pause";
      el.pauseTrainingBtn.disabled = false;
      enterPhase(clock.start(performance.now()));
      timerInterval = setInterval(tick, 50);
    } catch (error) {
      if (token !== runToken) return;
      resetToIdle();
      el.trainingProgress.textContent = "Sound could not start. Allow audio and press Start again.";
      bus.emit("log", `Steady Aim audio: ${error.message}`);
    }
  }

  function updateTimer(state) {
    const seconds = state.remainingMs / 1000;
    el.trainingHoldTimerBadge.textContent = `Hold · ${seconds.toFixed(1)}s`;
    const whole = Math.ceil(seconds);
    el.trainingCountdownVal.textContent = whole >= 60
      ? `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}` : String(whole);
    el.timerProgress.style.strokeDashoffset = String(339.3 * (1 - seconds / state.phase.seconds));
  }

  function enterPhase(state) {
    const phase = state.phase;
    gameState = phase.kind;
    el.trainingStatusDesc.textContent = "Follow the sound cues: draw, hold, relax.";
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
    el.trainingDisplayDefault.classList.add("hidden");
    el.trainingProgress.textContent = `Set ${phase.set} / ${program.sets} · Rep ${phase.rep} / ${program.reps} · ${completedReps} / ${program.sets * program.reps} completed`;
    const holding = gameState === "holding";
    el.trainingDisplayActive.classList.toggle("hidden", holding);
    el.trainingTargetWrapper.classList.toggle("hidden", !holding);
    el.trainingPhaseLabel.textContent = gameState === "draw" ? "Draw to full draw" :
      gameState === "set-rest" ? `Rest · next: set ${phase.set + 1}` : "Relax · next repetition";
    el.trainingPhaseLabel.style.color = gameState === "draw" ? "var(--amber)" : "var(--cyan)";
    el.timerProgress.style.stroke = gameState === "draw" ? "var(--amber)" : "var(--cyan)";
    updateTimer(state);
    if (gameState === "draw") playTone(440, 200);
    if (holding) {
      trainingSamples = [];
      holdStartedAt = new Date().toISOString();
      const active = store.get();
      refRoll = liveDotRoll = active.roll;
      refPitch = liveDotPitch = active.pitch;
      playTone(880, 350);
      resizeCanvas();
      animationFrame = requestAnimationFrame(renderLoop);
    }
  }

  function tick() {
    const state = clock.tick(performance.now());
    if (state.interrupted) {
      endSession("Timer interrupted. Session stopped; incomplete hold excluded.");
      return;
    }
    if (state.ended?.kind === "holding") {
      playTone(660, 300);
      completedReps++;
      if (trainingSamples.length >= 5) {
        holds.push({ id: generateUUID(), timestamp: holdStartedAt,
          set: state.ended.set, rep: state.ended.rep, samples: trainingSamples,
          ...holdStats(trainingSamples) });
      }
    }
    if (state.complete) endSession("Training complete.", true);
    else if (state.changed) enterPhase(state);
    else if (state.active) updateTimer(state);
  }

  async function togglePause() {
    if (gameState === "paused") {
      const token = runToken;
      gameState = "resuming";
      el.pauseTrainingBtn.disabled = true;
      try {
        await audioCtx.resume();
        if (token !== runToken) return;
        if (audioCtx.state !== "running") throw new Error("Audio is unavailable");
        enterPhase(clock.resume(performance.now()));
        el.pauseTrainingBtn.textContent = "Pause";
        timerInterval = setInterval(tick, 50);
      } catch {
        if (token !== runToken) return;
        gameState = "paused";
        el.trainingPhaseLabel.textContent = "Paused · allow audio, then resume";
      } finally {
        if (token === runToken) el.pauseTrainingBtn.disabled = false;
      }
      return;
    }
    if (!["draw", "holding", "rest", "set-rest"].includes(gameState)) return;
    // Settle a completed phase first, including its result and end cue.
    tick();
    if (!clock.snapshot(performance.now()).active) return;
    const state = clock.pause(performance.now());
    gameState = "paused";
    clearInterval(timerInterval);
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
    for (const tone of tones) { try { tone.stop(); } catch {} }
    tones.clear();
    if (state.restartDraw) trainingSamples = [];
    el.pauseTrainingBtn.textContent = "Resume";
    el.trainingTargetWrapper.classList.add("hidden");
    el.trainingDisplayActive.classList.remove("hidden");
    updateTimer(state);
    el.trainingPhaseLabel.textContent = state.restartDraw
      ? "Paused · relax; resume restarts this repetition" : "Paused · rest timer stopped";
    el.trainingStatusDesc.textContent = "Training paused. Press Resume when ready.";
  }

  function holdStats(samples) {
    const rolls = samples.map(s => s.roll);
    const pitches = samples.map(s => s.pitch);
    const angles = samples.map(aimAngles);
    const aimReady = angles.every(Boolean) && samples.every(p => p.aim?.referenceId === samples[0].aim?.referenceId);
    const rollStd = stdDev(rolls), pitchStd = stdDev(pitches);
    const horizontalStd = aimReady ? stdDev(angles.map(p => p.horizontal)) : rollStd;
    const verticalStd = aimReady ? stdDev(angles.map(p => p.vertical)) : pitchStd;
    const gyro = mean(samples.map(s => Math.hypot(s.gx, s.gy, s.gz)));
    return { score: Math.round(Math.max(0, Math.min(100, 100 - (horizontalStd + verticalStd) * 18 - gyro * 0.7))),
      rollStd, pitchStd, maxFloat: getMaxFloatSpan(samples) };
  }

  function endSession(message, completed = false) {
    // Let the final hold-end tone finish on normal completion.
    if (completed) {
      ++runToken; clock.stop(); clearInterval(timerInterval);
      cancelAnimationFrame(animationFrame);
    } else stopActivity();
    gameState = "finished";
    el.cancelTrainingBtn.classList.add("hidden");
    el.pauseTrainingBtn.classList.add("hidden");
    el.startTrainingBtn.classList.add("hidden");
    el.trainingDisplayActive.classList.add("hidden");
    el.trainingProgress.textContent = `${message} ${completedReps} / ${program.sets * program.reps} completed · ${holds.length} holds recorded`;
    el.trainingResultsCard.classList.remove("hidden");
    el.saveTrainingShotBtn.disabled = !holds.length;
    el.saveTrainingShotBtn.textContent = `Save ${holds.length} holds`;
    el.resultSteadinessScore.textContent = holds.length ? Math.round(mean(holds.map(h => h.score))) : "—";
    el.resultAvgCantDev.textContent = holds.length ? `${mean(holds.map(h => h.rollStd)).toFixed(2)}°` : "—";
    el.resultAvgPitchDev.textContent = holds.length ? `${mean(holds.map(h => h.pitchStd)).toFixed(2)}°` : "—";
    el.resultMaxFloat.textContent = holds.length ? `${Math.max(...holds.map(h => h.maxFloat)).toFixed(2)}°` : "—";
    el.resultCoachingTitle.textContent = message;
    el.resultCoachingText.textContent = holds.length
      ? "Average score and deviations across recorded holds. The target shows the last recorded hold. Each hold is saved separately."
      : "No complete holds with enough sensor data were recorded.";
    trainingSamples = holds.at(-1)?.samples || [];
    el.trainingTargetWrapper.classList.toggle("hidden", !holds.length);
    if (holds.length) { resizeCanvas(); animationFrame = requestAnimationFrame(renderLoop); }
    bus.emit("log", `Steady Aim: ${message} ${completedReps}/${program.sets * program.reps} repetitions, ${holds.length} recorded holds.`);
  }

  async function saveSession() {
    if (gameState !== "finished" || !holds.length) return;
    gameState = "saving";
    el.discardTrainingShotBtn.disabled = true;
    
    el.saveTrainingShotBtn.disabled = true;
    el.saveTrainingShotBtn.textContent = "Saving...";
    
    try {
      for (const hold of holds) {
        if (hold.saved) continue;
        const trainingSamples = hold.samples;
        const rolls = trainingSamples.map((s) => s.roll);
        const pitches = trainingSamples.map((s) => s.pitch);
        const avgRoll = mean(rolls);
        const avgPitch = mean(pitches);
        const score = hold.score;
      
        let maxG = 0;
        for (const s of trainingSamples) {
          const g = Math.hypot(s.ax, s.ay, s.az);
          if (g > maxG) maxG = g;
        }
      
        const sessionShotId = hold.id;
        const timestamp = hold.timestamp;
        const label = `Steady Aim · Set ${hold.set}/${program.sets} · Rep ${hold.rep}/${program.reps} · ${program.holdSeconds}s`;
        const elapsedMs = trainingSamples.at(-1).timestamp - trainingSamples[0].timestamp;
        const sampleRateHz = elapsedMs > 0 ? (trainingSamples.length - 1) * 1000 / elapsedMs : 52;
        const traceForScore = trainingSamples.map((s) => ({
          tUs: Math.round((s.timestamp - trainingSamples[0].timestamp) * 1000),
          releaseTimingAvailable: false,
          ax: s.ax,
          ay: s.ay,
          az: s.az,
          gx: s.gx || 0,
          gy: s.gy || 0,
          gz: s.gz || 0,
          roll: s.roll,
          pitch: s.pitch,
          yaw: s.yaw || 0,
          aim: s.aim,
          micAmp: s.micAmp || 0,
        }));
        const floatScore = computeFloatScoreFromTrace(traceForScore, { sampleRateHz, isManual: true });
      
        const shotRecord = {
          id: sessionShotId,
          session_id: null,
          device_id: "OpenFloat-Sensor",
          timestamp,
          peak_g: Number(maxG.toFixed(2)),
          cant_angle_deg: Number(avgRoll.toFixed(1)),
          pitch_angle_deg: Number(avgPitch.toFixed(1)),
          yaw_angle_deg: 0,
          roll_angle_deg: Number(avgRoll.toFixed(1)),
          stability_score: score,
          shot_score: floatScore.formScore,
          hold_stability: floatScore.holdStability,
          release_quality: floatScore.releaseQuality,
          follow_through: floatScore.followThrough,
          level_consistency: floatScore.levelConsistency,
          score_version: floatScore.scoreVersion,
          packet_loss_count: 0,
          label: label
        };
      
        await put("shots", shotRecord);
        await put("sync_queue", {
          table: "shots",
          action: "CREATE",
          targetId: sessionShotId,
          payload: shotRecord,
          status: "pending"
        });
      
        const tracePayload = {
          shot_id: sessionShotId,
          sample_rate_hz: sampleRateHz,
          source: "browser-manual-recording",
          payload: traceForScore
        };
      
        await put("shot_traces", tracePayload);
        await put("sync_queue", {
          table: "shot_traces",
          action: "CREATE",
          targetId: sessionShotId,
          payload: tracePayload,
          status: "pending"
        });
      
        bus.emit("log", `Steady Aim training session saved successfully (ID: ${sessionShotId.slice(0, 8)}).`);
      
        // Notify main app to refresh history list & recent shots
        bus.emit("shot-saved", {
          shotId: null,
          stored: false,
          localShotId: sessionShotId
        });
      
        bus.emit("shot-trace-saved", {
          localShotId: sessionShotId,
          deviceShotId: null
        });
      
        hold.saved = true;
      }

      // Clear results and go back to default screen
      resetToIdle();
      bus.emit("log", "Steady Aim holds saved successfully.");
    } catch (err) {
      gameState = "finished";
      console.error("Failed to save training shot:", err);
      bus.emit("log", `Failed to save training shot: ${err.message}`);
      alert(`Error saving training shot: ${err.message}`);
    } finally {
      el.saveTrainingShotBtn.disabled = false;
      el.saveTrainingShotBtn.textContent = "Save holds";
      el.discardTrainingShotBtn.disabled = false;
    }
  }

  function cancelSession() {
    if (["idle", "finished", "saving"].includes(gameState)) return;
    endSession("Session stopped; incomplete hold excluded.");
  }

  function discardSession() {
    if (gameState !== "saving") resetToIdle();
  }

  function resetToIdle() {
    stopActivity();
    gameState = "idle";
    el.cancelTrainingBtn.classList.add("hidden");
    el.pauseTrainingBtn.classList.add("hidden");
    el.startTrainingBtn.classList.remove("hidden");
    el.startTrainingBtn.disabled = !store.get().connected;
    el.trainingDisplayActive.classList.add("hidden");
    el.trainingTargetWrapper.classList.add("hidden");
    el.trainingResultsCard.classList.add("hidden");
    el.trainingDisplayDefault.classList.remove("hidden");
    lockSettings(false);
    updateProgramSummary();
    trainingSamples = [];
    holds = [];
  }
}
