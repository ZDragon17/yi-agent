import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KERNEL_LEARNING_VERSIONS, learn, step, verify } from '../../src/kernel/index.mjs';
import { canonicalDigest } from '../../src/runtime/schema.mjs';

const ALPHA = 'tok_SCALEALPHA1';
const BETA = 'tok_SCALEBETA1';
const VALUE_SPEC = {
  schemaVersion: 1,
  observationDimensions: 1,
  weights: [1],
  target: [100],
  tolerance: 0,
  valueMode: 'distance-v2',
};

test('multi-scale context writes window-1 evidence for the current version only', () => {
  const current = drivePeriodicSchedule({ learningVersion: KERNEL_LEARNING_VERSIONS.current, steps: 6 });
  const currentShortKeys = h0Keys(current.memory);
  assert.equal(currentShortKeys.length, 2);
  const sampleCounts = currentShortKeys
    .map((key) => Object.values(current.memory.contextModels[key])
      .reduce((sum, m) => sum + m.sampleCount, 0))
    .sort((left, right) => left - right);
  assert.deepEqual(sampleCounts, [2, 3]);

  const legacy = drivePeriodicSchedule({ learningVersion: 24, steps: 6 });
  assert.deepEqual(h0Keys(legacy.memory), []);
});

test('prediction prefers the more specific window-2 key and falls back to window-1', () => {
  const recentHistory = [
    { schemaVersion: 1, token: ALPHA, actualDelta: [1], historyOrder: 1 },
    { schemaVersion: 1, token: BETA, actualDelta: [1], historyOrder: 2 },
  ];
  const h1Key = `h1:${canonicalDigest(recentHistory.map(({ token, actualDelta }) => ({ token, actualDelta })))}`;
  const h0Key = `h0:${canonicalDigest([{ token: BETA, actualDelta: [1] }])}`;
  const memory = {
    schemaVersion: 1,
    actionModels: {},
    relationModels: {},
    contextModels: {
      [h1Key]: { [ALPHA]: model([5]) },
      [h0Key]: { [ALPHA]: model([-5]) },
    },
    recentHistory,
  };
  const intent = step({
    observation: observation([0], 'state:scale:0'),
    memory,
    valueSpec: VALUE_SPEC,
    capabilities: [capability(ALPHA)],
    rngState: rng(5),
  });
  assert.deepEqual(intent.expectation.expectedDelta, [5]);

  const withoutSpecific = {
    ...memory,
    contextModels: { [h0Key]: { [ALPHA]: model([-5]) } },
  };
  const fallback = step({
    observation: observation([0], 'state:scale:1'),
    memory: withoutSpecific,
    valueSpec: VALUE_SPEC,
    capabilities: [capability(ALPHA)],
    rngState: rng(7),
  });
  assert.deepEqual(fallback.expectation.expectedDelta, [-5]);
});

function drivePeriodicSchedule({ learningVersion, steps }) {
  const winners = [ALPHA, BETA];
  let memory = newMemory();
  let value = 0;
  for (let index = 0; index < steps; index += 1) {
    const winner = winners[index % winners.length];
    const before = observation([value], `state:scale:drive:${index}`);
    const intent = step({
      observation: before,
      memory,
      valueSpec: VALUE_SPEC,
      capabilities: [capability(winner)],
      rngState: rng(index + 1),
    });
    assert.equal(intent.choice.token, winner);
    const postObservation = observation([value + 1], `state:scale:drive:${index + 1}`);
    const receipt = {
      schemaVersion: 1,
      status: 'ACCEPTED',
      token: winner,
      basedOnVersion: before.stateVersion,
      policyVersion: 'policy:scale:drive',
      constraintsDigest: 'sha256:scale-drive',
      executionNonce: `execution:scale:${index}`,
      effectDigest: 'sha256:scale-effect',
      rejectionReason: null,
      attributionWindowComplete: true,
      confounderCount: 0,
    };
    const verification = verify({ intent, receipt, postObservation });
    memory = learn({
      memory,
      intent,
      receipt,
      postObservation,
      verification,
      learningVersion,
    }).nextMemory;
    value += 1;
  }
  return { memory };
}

function h0Keys(memory) {
  return Object.keys(memory.contextModels ?? {}).filter((key) => key.startsWith('h0:'));
}

function newMemory() {
  return {
    schemaVersion: 1,
    actionModels: {},
    relationModels: {},
    pendingCredits: [],
    settledFeedback: [],
    pendingCreditPolicy: { schemaVersion: 1, maxAge: 8 },
    beliefModels: {},
    contextModels: {},
    recentHistory: [],
    historyClock: 0,
    historyAccumulator: '0000000000000000000000000000000000000000000000000000000000000000',
    lastVerifiedSteps: {},
    modelClock: 0,
    contextKeyScale: 9,
  };
}

test('context keys canonicalize floating-point reconstruction residue into one key', () => {
  const residue = 4.440892098500626e-16;
  const withScaleA = learnFromHistory({ token: ALPHA, actualDelta: [residue] }, newMemory());
  const withScaleB = learnFromHistory({ token: ALPHA, actualDelta: [0] }, newMemory());
  assert.equal(withScaleA.contextKey, withScaleB.contextKey);

  const { contextKeyScale: _legacyScale, ...legacyMemory } = newMemory();
  const withoutScaleA = learnFromHistory(
    { token: ALPHA, actualDelta: [residue] },
    legacyMemory,
  );
  const withoutScaleB = learnFromHistory(
    { token: ALPHA, actualDelta: [0] },
    { ...legacyMemory },
  );
  assert.notEqual(withoutScaleA.contextKey, withoutScaleB.contextKey);
});

// 一次 learn 把动作前记忆的最近历史写入 h1/h0 上下文证据；
// 两条语义相同（残差 vs 精确零）的历史在带 scale 的记忆中必须产生同一键。
function learnFromHistory(entry, memory) {
  const base = {
    ...memory,
    recentHistory: [{ schemaVersion: 1, ...entry, historyOrder: 1 }],
    historyClock: 1,
  };
  const before = observation([10], 'state:scale:residue:0');
  const intent = step({
    observation: before,
    memory: base,
    valueSpec: VALUE_SPEC,
    capabilities: [capability(ALPHA)],
    rngState: rng(31),
  });
  const post = observation([11], 'state:scale:residue:1');
  const learnResult = learn({
    memory: base,
    intent,
    receipt: receipt(ALPHA, before, 'execution:scale:r1'),
    postObservation: post,
    verification: verify({
      intent,
      receipt: receipt(ALPHA, before, 'execution:scale:r1'),
      postObservation: post,
    }),
    learningVersion: KERNEL_LEARNING_VERSIONS.current,
  });
  const contextKeys = Object.keys(learnResult.nextMemory.contextModels ?? {})
    .filter((key) => key.startsWith('h1:'));
  assert.equal(contextKeys.length, 1);
  return { contextKey: contextKeys[0], memory: learnResult.nextMemory };
}

function receipt(token, before, executionNonce) {
  return {
    schemaVersion: 1,
    status: 'ACCEPTED',
    token,
    basedOnVersion: before.stateVersion,
    policyVersion: 'policy:scale:residue',
    constraintsDigest: 'sha256:scale-residue',
    executionNonce,
    effectDigest: 'sha256:scale-residue-effect',
    rejectionReason: null,
    attributionWindowComplete: true,
    confounderCount: 0,
  };
}

function model(meanDelta) {
  return { schemaVersion: 1, sampleCount: 1, meanDelta, uncertainty: 0 };
}

function capability(token) {
  return { schemaVersion: 1, token, cost: 1, allowed: true, safe: true };
}

function observation(vector, stateVersion) {
  return { schemaVersion: 1, vector, stateVersion, intervalId: `${stateVersion}:interval` };
}

function rng(state) {
  return { schemaVersion: 1, algorithm: 'xorshift32', state };
}
