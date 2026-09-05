import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acknowledgeReplan,
  advanceChangeSupervisor,
  createChangeSupervisor,
  normalizeChangeSupervisorState,
} from '../../src/agent/change-supervisor.mjs';

const valueSpec = {
  schemaVersion: 1,
  observationDimensions: 1,
  weights: [1],
  target: [0],
};

test('acknowledging a replan records a bounded exploration episode bound to the entry best distance', () => {
  const supervisor = createChangeSupervisor({ goal: '达到目标', valueSpec, stagnationLimit: 3 });
  const stagnant = stagnateToReplan(supervisor);
  const acknowledged = acknowledgeReplan(stagnant, 'supervisor-stagnation');
  assert.equal(acknowledged.status, 'ACTIVE');
  assert.equal(acknowledged.strategy.mode, 'EXPLORATORY');
  assert.equal(acknowledged.exploration.enteredAtCycle, stagnant.cycle);
  assert.equal(acknowledged.exploration.startBestDistance, 0);
  assert.equal(acknowledged.exploration.verifiedSteps, 0);
  assert.deepEqual(normalizeChangeSupervisorState(acknowledged).exploration, acknowledged.exploration);
});

test('exploration returns to balanced value selection once its bounded verification budget is exhausted', () => {
  const acknowledged = acknowledgedExplorationSupervisor();
  let state = acknowledged;
  for (let step = 1; step <= 11; step += 1) {
    state = advanceChangeSupervisor(state, oscillatingStep(state, step));
    assert.equal(state.status, 'ACTIVE');
    assert.equal(state.strategy.mode, 'EXPLORATORY', `expected EXPLORATORY through step ${step}`);
    assert.equal(state.exploration.verifiedSteps, step);
  }
  state = advanceChangeSupervisor(state, oscillatingStep(state, 12));
  assert.equal(state.status, 'ACTIVE');
  assert.equal(state.strategy.mode, 'BALANCED');
  assert.equal(state.strategy.reason, 'exploration-budget-exhausted');
  assert.equal(state.exploration, undefined);
});

test('exploration exits early on confirmed improvement beyond its entry best distance', () => {
  const supervisor = createChangeSupervisor({ goal: '达到目标', valueSpec, stagnationLimit: 3 });
  let state = advanceChangeSupervisor(supervisor, {
    beforeObservation: observation('state:0', [3]),
    postObservation: observation('state:1', [2]),
    verification: verification('ACTION', true),
  });
  state = stagnateToReplan(state, 'state:1', [2]);
  const acknowledged = acknowledgeReplan(state, 'supervisor-stagnation');
  assert.equal(acknowledged.exploration.startBestDistance, 2);
  const improved = advanceChangeSupervisor(acknowledged, {
    beforeObservation: observation('state:4', [2]),
    postObservation: observation('state:5', [1]),
    verification: verification('ACTION', true),
  });
  assert.equal(improved.status, 'ACTIVE');
  assert.equal(improved.strategy.mode, 'BALANCED');
  assert.equal(improved.strategy.reason, 'exploration-improved');
  assert.equal(improved.exploration, undefined);
});

test('an exploratory strategy without an exploration record keeps the legacy latch semantics', () => {
  const acknowledged = acknowledgedExplorationSupervisor();
  const legacy = { ...acknowledged };
  delete legacy.exploration;
  let state = legacy;
  for (let step = 1; step <= 30; step += 1) {
    state = advanceChangeSupervisor(state, oscillatingStep(state, step));
    assert.equal(state.status, 'ACTIVE');
    assert.equal(state.strategy.mode, 'EXPLORATORY');
  }
});

test('acknowledging a second replan during exploration toggles back and drops the episode record', () => {
  const acknowledged = acknowledgedExplorationSupervisor();
  let replanned = acknowledged;
  for (let index = 0; index < 3; index += 1) {
    replanned = advanceChangeSupervisor(replanned, {
      beforeObservation: observation(`state:${4 + index * 2}`, [3]),
      postObservation: observation(`state:${5 + index * 2}`, [3]),
      verification: verification('ACTION', true),
    });
  }
  assert.equal(replanned.status, 'REPLAN_REQUIRED');
  const toggled = acknowledgeReplan(replanned, 'supervisor-stagnation');
  assert.equal(toggled.status, 'ACTIVE');
  assert.equal(toggled.strategy.mode, 'BALANCED');
  assert.equal(toggled.exploration, undefined);
});

function stagnateToReplan(supervisor, statePrefix = 'state:', startVector = [0]) {
  let state = supervisor;
  for (let index = 0; index < 3; index += 1) {
    state = advanceChangeSupervisor(state, {
      beforeObservation: observation(`${statePrefix}${index}`, startVector),
      postObservation: observation(`${statePrefix}${index + 1}`, [startVector[0] + index + 1]),
      verification: verification('ACTION', true),
    });
  }
  assert.equal(state.status, 'REPLAN_REQUIRED');
  return state;
}

function acknowledgedExplorationSupervisor() {
  const supervisor = createChangeSupervisor({ goal: '达到目标', valueSpec, stagnationLimit: 3 });
  const stagnant = stagnateToReplan(supervisor);
  return acknowledgeReplan(stagnant, 'supervisor-stagnation');
}

// 轨道式步进：确认进展与回退交替，停滞计数永远到不了重规划阈值，
// 但相对进入探索时的最优距离没有任何全局改善——正是周期世界陷阱的形状。
function oscillatingStep(state, step) {
  const before = step % 2 === 1 ? [3] : [2];
  const after = step % 2 === 1 ? [2] : [3];
  return {
    beforeObservation: observation(`state:${step * 2}`, before),
    postObservation: observation(`state:${step * 2 + 1}`, after),
    verification: verification('ACTION', true),
  };
}

function observation(stateVersion, vector) {
  return { schemaVersion: 1, stateVersion, intervalId: `${stateVersion}:interval`, vector };
}

function verification(attribution, learnable) {
  return {
    schemaVersion: 1,
    error: [0],
    attribution,
    confidence: learnable ? 1 : 0,
    learnable,
  };
}
