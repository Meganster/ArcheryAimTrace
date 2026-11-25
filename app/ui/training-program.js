export const STEADY_AIM_PROGRAM = Object.freeze({
  sets: 3, reps: 10, drawSeconds: 7, holdSeconds: 3,
  repRestSeconds: 3, setRestSeconds: 120,
});

export const TRAINING_LIMITS = Object.freeze({
  sets: [1, 10], reps: [1, 50], drawSeconds: [1, 300], holdSeconds: [1, 300],
  repRestSeconds: [0, 600], setRestSeconds: [0, 1800],
});

export function validateTrainingProgram(values = {}) {
  const program = {};
  for (const [key, [min, max]] of Object.entries(TRAINING_LIMITS)) {
    const value = values[key] ?? STEADY_AIM_PROGRAM[key];
    const number = Number(value);
    if (String(value).trim() === '' || !Number.isInteger(number) || number < min || number > max) {
      throw new RangeError(`${key}: enter a whole number from ${min} to ${max}.`);
    }
    program[key] = number;
  }
  return program;
}

export function trainingPhases(values = STEADY_AIM_PROGRAM) {
  const p = validateTrainingProgram(values);
  const phases = [];
  for (let set = 1; set <= p.sets; set++) {
    for (let rep = 1; rep <= p.reps; rep++) {
      phases.push({ kind: 'draw', set, rep, seconds: p.drawSeconds });
      phases.push({ kind: 'holding', set, rep, seconds: p.holdSeconds });
      if (rep < p.reps && p.repRestSeconds > 0) phases.push({ kind: 'rest', set, rep, seconds: p.repRestSeconds });
    }
    // The two-minute set break replaces the short repetition break.
    if (set < p.sets && p.setRestSeconds > 0) phases.push({ kind: 'set-rest', set, rep: p.reps, seconds: p.setRestSeconds });
  }
  return phases;
}

// Monotonic deadlines avoid cumulative countdown error. Never fast-forward
// through draw/hold cues if the browser was suspended.
export function createTrainingClock(program = STEADY_AIM_PROGRAM) {
  const phases = trainingPhases(program);
  let index = -1;
  let deadline = 0;
  let active = false;
  let paused = false;
  let pauseRemaining = 0;
  let restartDraw = false;
  const snapshot = now => ({
    phase: phases[index] || null, active, paused, restartDraw, deadline,
    remainingMs: paused ? pauseRemaining : active ? Math.max(0, deadline - now) : 0,
  });
  return {
    start(now) { index = 0; active = true; paused = false; restartDraw = false; deadline = now + phases[0].seconds * 1000; return snapshot(now); },
    tick(now) {
      if (!active || now < deadline) return snapshot(now);
      if (now - deadline > 1000) {
        active = false;
        return { ...snapshot(now), interrupted: true };
      }
      const ended = phases[index];
      index++;
      active = index < phases.length;
      if (active) deadline = now + phases[index].seconds * 1000;
      return { ...snapshot(now), ended, changed: true, complete: !active };
    },
    pause(now) {
      if (!active) return snapshot(now);
      pauseRemaining = Math.max(0, deadline - now);
      restartDraw = ['draw', 'holding'].includes(phases[index].kind);
      if (restartDraw) {
        if (phases[index].kind === 'holding') index--;
        pauseRemaining = phases[index].seconds * 1000;
      }
      active = false;
      paused = true;
      return snapshot(now);
    },
    resume(now) {
      if (!paused) return snapshot(now);
      deadline = now + pauseRemaining;
      paused = false;
      active = true;
      return snapshot(now);
    },
    stop() { active = false; paused = false; restartDraw = false; },
    snapshot,
  };
}
