import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acknowledgeReplan,
  advanceChangeSupervisor,
  createChangeSupervisor,
  enableGoal,
  normalizeChangeSupervisorState,
  resumeChangeSupervisor,
  reviseGoalPlan,
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
  assert.equal(supervisor.enabled, true);
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

test('fresh feedback settlement cannot confirm progress for the current action', () => {
  const supervisor = createChangeSupervisor({ goal: '达到目标', valueSpec });
  const next = advanceChangeSupervisor(supervisor, {
    beforeObservation: observation('state:0', [8, 9]),
    postObservation: observation('state:1', [9, 9]),
    verification: verification('ACTION', true),
    hasFreshFeedbackSettlement: true,
  });
  assert.equal(next.lastChange.evidence, 'AMBIGUOUS');
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
  assert.equal(resumed.strategy.mode, 'EXPLORATORY');
  assert.equal(resumed.strategy.revision, 1);
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

test('a completed supervision cycle can be resumed as the next continuous cycle', () => {
  const supervisor = createChangeSupervisor({ goal: '达到目标', valueSpec, maxCycles: 1 });
  const completed = advanceChangeSupervisor(supervisor, {
    beforeObservation: observation('state:0', [10, 10]),
    postObservation: observation('state:1', [10, 10]),
    verification: verification('ACTION', true),
  });
  const resumed = resumeChangeSupervisor(completed);
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(resumed.status, 'ACTIVE');
  assert.equal(resumed.cycle, completed.cycle);
  assert.equal(resumed.lastChange.replanReason, 'runtime-continuation');
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

test('goal activation is durable and legacy states normalize without an activation marker', () => {
  const disabled = createChangeSupervisor({ goal: '默认目标', enabled: false, valueSpec });
  const enabled = enableGoal(disabled, '用户目标');
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.goal, '用户目标');
  assert.equal(enabled.plan.rootGoal, '用户目标');
  assert.equal(enableGoal(disabled, '用户目标', undefined, true).plannerEnabled, true);
  const legacy = { ...createChangeSupervisor({ goal: '逼近 ValueSpec 目标', valueSpec }) };
  delete legacy.enabled;
  assert.equal(normalizeChangeSupervisorState(legacy).enabled, false);
});

test('goal plans cannot drift from the supervisor goal', () => {
  assert.throws(
    () => createChangeSupervisor({
      goal: '监督目标',
      valueSpec,
      plan: { rootGoal: '另一个目标', stages: [{ id: 'root', goal: '阶段', objective: valueSpec }] },
    }),
    /rootGoal must equal the supervisor goal/u,
  );
});

test('a goal plan advances through measurable stages using the same distance rule', () => {
  const supervisor = createChangeSupervisor({
    goal: '完成两阶段变化',
    valueSpec,
    plan: {
      schemaVersion: 1,
      rootGoal: '完成两阶段变化',
      stages: [
        { id: 'approach', goal: '先接近目标', objective: { ...valueSpec, target: [9, 10] } },
        { id: 'settle', goal: '再达到目标' },
      ],
    },
  });
  const approach = advanceChangeSupervisor(supervisor, {
    beforeObservation: observation('state:0', [8, 9]),
    postObservation: observation('state:1', [9, 10]),
    verification: verification('ACTION', true),
  });
  assert.equal(approach.status, 'ACTIVE');
  assert.equal(approach.plan.revision, 1);
  assert.equal(approach.plan.activeStageId, 'settle');
  assert.equal(approach.plan.stages[0].status, 'COMPLETED');
  assert.deepEqual(approach.objective.target, [10, 10]);
  const completed = advanceChangeSupervisor(approach, {
    beforeObservation: observation('state:1', [9, 10]),
    postObservation: observation('state:2', [10, 10]),
    verification: verification('ACTION', true),
  });
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.lastChange.stopReason, 'OBJECTIVE_REACHED');
});

test('replanning can replace only the unfinished suffix and preserves completed stages', () => {
  const supervisor = createChangeSupervisor({
    goal: '保留完成历史',
    valueSpec,
    stagnationLimit: 1,
    plan: {
      rootGoal: '保留完成历史',
      stages: [
        { id: 'done', goal: '已完成阶段', objective: { ...valueSpec, target: [9, 10] } },
        { id: 'stuck', goal: '原停滞阶段', objective: { ...valueSpec, target: [10, 10] } },
        { id: 'final', goal: '最终阶段' },
      ],
    },
  });
  const first = advanceChangeSupervisor(supervisor, {
    beforeObservation: observation('state:0', [8, 9]),
    postObservation: observation('state:1', [9, 10]),
    verification: verification('ACTION', true),
  });
  const stuck = advanceChangeSupervisor(first, {
    beforeObservation: observation('state:1', [9, 10]),
    postObservation: observation('state:2', [9, 10]),
    verification: verification('ACTION', true),
  });
  const revised = reviseGoalPlan(stuck, {
    rootGoal: '保留完成历史',
    stages: [
      { id: 'done', goal: '已完成阶段', objective: { ...valueSpec, target: [9, 10] } },
      { id: 'detour', goal: '改走新阶段', objective: { ...valueSpec, target: [9, 11] } },
      { id: 'final', goal: '最终阶段' },
    ],
  });
  assert.equal(stuck.status, 'REPLAN_REQUIRED');
  assert.equal(revised.plan.revision, 2);
  assert.equal(revised.plan.stages[0].status, 'COMPLETED');
  assert.equal(revised.plan.activeStageId, 'detour');
  assert.deepEqual(revised.plan.stages[0].objective.target, [9, 10]);
  assert.equal(acknowledgeReplan(revised).status, 'ACTIVE');
  assert.throws(
    () => reviseGoalPlan(stuck, {
      rootGoal: '保留完成历史',
      stages: [
        { id: 'done', goal: '被篡改', objective: { ...valueSpec, target: [0, 0] } },
        { id: 'detour', goal: '改走新阶段', objective: { ...valueSpec, target: [9, 11] } },
      ],
    }),
    /cannot rewrite a completed stage/u,
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
