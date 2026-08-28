import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acknowledgeReplan,
  advanceChangeSupervisor,
  createChangeSupervisor,
  weightedDistance,
} from '../../src/agent/change-supervisor.mjs';

const valueSpec = {
  schemaVersion: 1,
  observationDimensions: 2,
  weights: [1, 2],
  target: [10, 10],
};

test('change supervisor measures one common weighted distance independent of world labels', () => {
  const supervisor = createChangeSupervisor({ goal: '达到目标', valueSpec });
  assert.equal(weightedDistance([8, 9], supervisor.objective), 4);
  assert.equal(supervisor.status, 'ACTIVE');
  assert.equal(supervisor.cycle, 0);
});

test('confirmed change advances the supervisor and records progress', () => {
  const supervisor = createChangeSupervisor({ goal: '达到目标', valueSpec });
  const next = advanceChangeSupervisor(supervisor, {
    beforeObservation: observation('state:0', [8, 9]),
    postObservation: observation('state:1', [9, 9]),
    verification: verification('ACTION', true),
  });
  assert.equal(next.status, 'ACTIVE');
  assert.equal(next.cycle, 1);
  assert.equal(next.lastChange.progress, 1);
  assert.equal(next.lastChange.evidence, 'CONFIRMED_ACTION');
  assert.equal(next.stagnation, 0);
});

test('ambiguous change cannot reset stagnation or claim confirmed improvement', () => {
  const supervisor = createChangeSupervisor({ goal: '达到目标', valueSpec, stagnationLimit: 2 });
  const next = advanceChangeSupervisor(supervisor, {
    beforeObservation: observation('state:0', [8, 9]),
    postObservation: observation('state:1', [9, 9]),
    verification: verification('AMBIGUOUS', false),
  });
  assert.equal(next.status, 'ACTIVE');
  assert.equal(next.lastChange.confirmed, false);
  assert.equal(next.lastChange.improved, false);
  assert.equal(next.stagnation, 1);
  assert.equal(next.bestDistance, null);
});

test('a confirmed action that reverses a prior ambiguous change counts as stagnation', () => {
  const supervisor = createChangeSupervisor({ goal: '达到目标', valueSpec, stagnationLimit: 3 });
  const ambiguous = advanceChangeSupervisor(supervisor, {
    beforeObservation: observation('state:0', [8, 9]),
    postObservation: observation('state:1', [9, 9]),
    verification: verification('AMBIGUOUS', false),
  });
  const regressed = advanceChangeSupervisor(ambiguous, {
    beforeObservation: observation('state:1', [9, 9]),
    postObservation: observation('state:2', [8, 9]),
    verification: verification('ACTION', true),
  });
  assert.equal(regressed.lastChange.progress, -1);
  assert.equal(regressed.lastChange.improved, false);
  assert.equal(regressed.stagnation, 2);
  assert.equal(regressed.bestDistance, 3);
});

test('reaching the objective is a deterministic stop decision', () => {
  const supervisor = createChangeSupervisor({ goal: '达到目标', valueSpec });
  const next = advanceChangeSupervisor(supervisor, {
    beforeObservation: observation('state:0', [9, 10]),
    postObservation: observation('state:1', [10, 10]),
    verification: verification('ACTION', true),
  });
  assert.equal(next.status, 'COMPLETED');
  assert.equal(next.lastChange.stopReason, 'OBJECTIVE_REACHED');
  assert.equal(next.lastChange.decision, 'STOP');
});

test('stagnation requests replanning and acknowledgement resumes without changing the objective', () => {
  const supervisor = createChangeSupervisor({ goal: '达到目标', valueSpec, stagnationLimit: 2 });
  const first = advanceChangeSupervisor(supervisor, {
    beforeObservation: observation('state:0', [8, 9]),
    postObservation: observation('state:1', [8, 9]),
    verification: verification('ACTION', true),
  });
  const replanning = advanceChangeSupervisor(first, {
    beforeObservation: observation('state:1', [8, 9]),
    postObservation: observation('state:2', [8, 9]),
    verification: verification('EXECUTION_REJECTED', false),
  });
  assert.equal(replanning.status, 'REPLAN_REQUIRED');
  assert.equal(replanning.lastChange.stopReason, 'STAGNATION');
  const resumed = acknowledgeReplan(replanning, '尝试另一条变化路径');
  assert.equal(resumed.status, 'ACTIVE');
  assert.equal(resumed.stagnation, 0);
  assert.equal(resumed.replanCount, 1);
  assert.deepEqual(resumed.objective, supervisor.objective);
});

test('maximum cycles halt even when actions remain safe', () => {
  const supervisor = createChangeSupervisor({ goal: '达到目标', valueSpec, maxCycles: 1 });
  const next = advanceChangeSupervisor(supervisor, {
    beforeObservation: observation('state:0', [8, 9]),
    postObservation: observation('state:1', [8, 9]),
    verification: verification('ACTION', true),
  });
  assert.equal(next.status, 'HALTED');
  assert.equal(next.lastChange.stopReason, 'MAX_CYCLES');
});

test('negative tolerance is rejected instead of making the objective unreachable by definition', () => {
  assert.throws(
    () => createChangeSupervisor({ goal: '达到目标', valueSpec, tolerance: -1 }),
    /tolerance must not be negative/u,
  );
});

test('valueSpec tolerance is preserved unless the caller explicitly overrides it', () => {
  const supervisor = createChangeSupervisor({
    goal: '达到目标',
    valueSpec: { ...valueSpec, tolerance: 2 },
  });
  assert.equal(supervisor.objective.tolerance, 2);
  assert.equal(
    createChangeSupervisor({ goal: '达到目标', valueSpec, tolerance: 3 })
      .objective.tolerance,
    3,
  );
});

test('supervisor snapshots data descriptors before reading untrusted inputs', () => {
  let getterReads = 0;
  const hostileValueSpec = Object.defineProperties({}, {
    schemaVersion: { value: 1, enumerable: true },
    observationDimensions: { value: 2, enumerable: true },
    weights: { value: [1, 2], enumerable: true },
    target: {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error('hostile getter executed');
      },
    },
  });
  assert.throws(
    () => createChangeSupervisor({ goal: '达到目标', valueSpec: hostileValueSpec }),
    /target must be a data property/u,
  );
  assert.equal(getterReads, 0);

  const supervisor = createChangeSupervisor({ goal: '达到目标', valueSpec });
  const hostileState = new Proxy(supervisor, {
    get() {
      throw new Error('hostile proxy getter executed');
    },
  });
  const next = advanceChangeSupervisor(hostileState, {
    beforeObservation: observation('state:0', [8, 9]),
    postObservation: observation('state:1', [9, 9]),
    verification: verification('ACTION', true),
  });
  assert.equal(next.lastChange.improved, true);

  let lastChangeReads = 0;
  const hostileLastChange = {
    schemaVersion: 1,
    beforeStateVersion: 'state:0',
    afterStateVersion: 'state:1',
    beforeDistance: 3,
    afterDistance: 1,
    progress: 2,
    evidence: 'CONFIRMED_ACTION',
    confirmed: true,
    improved: true,
    decision: 'CONTINUE',
    stopReason: null,
  };
  Object.defineProperty(hostileLastChange, 'afterDistance', {
    enumerable: true,
    get() {
      lastChangeReads += 1;
      throw new Error('hostile lastChange getter executed');
    },
  });
  assert.throws(
    () => advanceChangeSupervisor({ ...supervisor, lastChange: hostileLastChange }, {
      beforeObservation: observation('state:0', [8, 9]),
      postObservation: observation('state:1', [9, 9]),
      verification: verification('ACTION', true),
    }),
    /afterDistance must be a data property/u,
  );
  assert.equal(lastChangeReads, 0);
});

function observation(stateVersion, vector) {
  return { schemaVersion: 1, stateVersion, intervalId: `${stateVersion}:interval`, vector };
}

function verification(attribution, learnable) {
  return {
    schemaVersion: 1,
    error: [0, 0],
    attribution,
    confidence: learnable ? 1 : 0,
    learnable,
  };
}
