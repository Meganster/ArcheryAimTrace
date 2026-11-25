import test from 'node:test';
import assert from 'node:assert/strict';
import { trainingPhases, createTrainingClock, validateTrainingProgram } from '../app/ui/training-program.js';

test('trainer runs 3 × 10 holds with 7s draw, 3s hold, 3s rep rest and two 120s set breaks', () => {
  const phases = trainingPhases();
  assert.equal(phases.filter(p => p.kind === 'holding').length, 30);
  assert.equal(phases.filter(p => p.kind === 'rest').length, 27);
  assert.equal(phases.filter(p => p.kind === 'set-rest').length, 2);
  assert.equal(phases.reduce((sum, p) => sum + p.seconds, 0), 621);
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i];
    if (p.kind !== 'holding') continue;
    assert.deepEqual(phases[i - 1], { kind: 'draw', set: p.set, rep: p.rep, seconds: 7 });
    assert.equal(p.seconds, 3);
    assert.equal(phases[i + 1]?.kind, p.rep < 10 ? 'rest' : p.set < 3 ? 'set-rest' : undefined);
  }
});

test('trainer deadlines advance once, stop immediately and restart at the first repetition', () => {
  const clock = createTrainingClock();
  assert.equal(clock.start(100).remainingMs, 7000);
  assert.equal(clock.tick(7099).phase.kind, 'draw');
  const hold = clock.tick(7100);
  assert.equal(hold.phase.kind, 'holding');
  assert.equal(hold.remainingMs, 3000);
  assert.equal(clock.tick(7100).changed, undefined);
  assert.equal(clock.tick(10100).phase.kind, 'rest');
  clock.stop();
  assert.equal(clock.tick(999999).active, false);
  assert.equal(clock.tick(999999).changed, undefined);
  assert.deepEqual(clock.start(999999).phase, trainingPhases()[0]);
});

test('trainer completes all phases without a final rest and does not skip cues after suspension', () => {
  const clock = createTrainingClock();
  let state = clock.start(0), holds = 0;
  while (state.active) {
    state = clock.tick(state.deadline);
    if (state.ended.kind === 'holding') holds++;
  }
  assert.equal(holds, 30);
  assert.equal(state.complete, true);
  assert.equal(state.deadline, 621000);
  clock.start(0);
  const suspended = clock.tick(300000);
  assert.equal(suspended.interrupted, true);
  assert.equal(suspended.active, false);
  assert.equal(suspended.ended, undefined);
});

test('custom intervals control every phase; zero breaks are omitted and invalid values rejected', () => {
  const program = { sets: 2, reps: 2, drawSeconds: 5, holdSeconds: 4, repRestSeconds: 0, setRestSeconds: 9 };
  const phases = trainingPhases(program);
  assert.equal(phases.reduce((sum, p) => sum + p.seconds, 0), 45);
  assert.equal(phases.filter(p => p.kind === 'rest').length, 0);
  assert.equal(phases.filter(p => p.kind === 'set-rest').length, 1);
  assert.equal(trainingPhases({ ...program, setRestSeconds: 0 }).length, 8);
  for (const bad of [{ sets: 0 }, { reps: 1.5 }, { holdSeconds: '' }, { drawSeconds: NaN }, { repRestSeconds: -1 }, { setRestSeconds: Infinity }]) {
    assert.throws(() => validateTrainingProgram(bad), RangeError);
  }
});

test('pausing a hold restarts its draw, without counting a partial repetition', () => {
  const clock = createTrainingClock();
  clock.start(0);
  clock.tick(7000);
  const paused = clock.pause(8500);
  assert.equal(paused.paused, true);
  assert.equal(paused.restartDraw, true);
  assert.equal(paused.phase.kind, 'draw');
  assert.equal(paused.remainingMs, 7000);
  assert.equal(clock.tick(600000).changed, undefined);
  const resumed = clock.resume(600000);
  assert.equal(resumed.deadline, 607000);
  assert.equal(resumed.phase.rep, 1);
  assert.equal(clock.tick(607000).phase.kind, 'holding');
  assert.equal(clock.tick(610000).ended.kind, 'holding');
  assert.equal(clock.tick(610000).changed, undefined);
});

test('rest pauses freeze the remaining time, repeated pauses and cancellation do not advance the program', () => {
  const clock = createTrainingClock({ sets: 2, reps: 1, drawSeconds: 1, holdSeconds: 1, setRestSeconds: 120 });
  clock.start(0); clock.tick(1000); clock.tick(2000);
  assert.equal(clock.pause(12000).remainingMs, 110000);
  assert.equal(clock.pause(900000).remainingMs, 110000);
  assert.equal(clock.resume(900000).deadline, 1010000);
  assert.equal(clock.pause(910000).remainingMs, 100000);
  clock.stop();
  assert.equal(clock.resume(1000000).active, false);
  assert.equal(clock.start(1000000).phase.set, 1);
});
