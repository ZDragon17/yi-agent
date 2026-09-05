import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KERNEL_LEARNING_VERSIONS, learn, step, verify } from '../../src/kernel/index.mjs';

const STALE = 'tok_BELIEFWEAKSTAL1';
const FRESH = 'tok_BELIEFWEAKFRE1';
const STRONG = 'tok_BELIEFSTRONG1';
const VALUE_SPEC = {
  schemaVersion: 1,
  observationDimensions: 1,
  weights: [1],
  target: [20],
  tolerance: 0,
  valueMode: 'distance-v2',
};

// 恢复期场景（F-117 步骤级证据）：全局证据已判劣的冷门候选（stale，信念 -1，
// 8+ 个已验证动作未复核）不得凭 freshness 打破由上下文证据支撑的轨道选择
// （fresh，信念 +3）；v26 及更早语义保持无条件强制重验。
const memoryAt = () => ({
  schemaVersion: 1,
  actionModels: {
    [STALE]: { schemaVersion: 1, sampleCount: 191, meanDelta: [-1], uncertainty: 0.18, modelAge: 400 },
    [FRESH]: { schemaVersion: 1, sampleCount: 30, meanDelta: [3], uncertainty: 0.05, modelAge: 400 },
  },
  relationModels: {},
  pendingCredits: [],
  settledFeedback: [],
  pendingCreditPolicy: { schemaVersion: 1, maxAge: 8 },
  beliefModels: {},
  contextModels: {},
  recentHistory: [],
  historyClock: 400,
  historyAccumulator: '0000000000000000000000000000000000000000000000000000000000000000',
  lastVerifiedSteps: { [STALE]: 1, [FRESH]: 400 },
  modelClock: 400,
  contextKeyScale: 9,
});

function stepAt(memory, learningVersion) {
  return step({
    observation: { schemaVersion: 1, vector: [12], stateVersion: 'state:belief:0', intervalId: 'state:belief:0:interval' },
    memory,
    valueSpec: VALUE_SPEC,
    capabilities: [STALE, FRESH].map((token) => ({ schemaVersion: 1, token, cost: 1, allowed: true, safe: true })),
    rngState: { schemaVersion: 1, algorithm: 'xorshift32', state: 71 },
    learningVersion,
  });
}

test('freshness cannot force re-verification of a candidate the global evidence already ranks inferior', () => {
  const intent = stepAt(memoryAt(), KERNEL_LEARNING_VERSIONS.current);
  assert.equal(intent.choice.token, FRESH);
  assert.equal(intent.expectation.verificationAge, 0);
});

test('v25 and earlier semantics keep unconditional freshness-driven re-verification', () => {
  const intent = stepAt(memoryAt(), 25);
  assert.equal(intent.choice.token, STALE);
  assert.equal(intent.expectation.verificationAge, 399);
});

test('a believed-strong stale candidate still earns forced re-verification under the belief gate', () => {
  const memory = memoryAt();
  memory.actionModels[STALE] = { schemaVersion: 1, sampleCount: 12, meanDelta: [4], uncertainty: 0.1, modelAge: 1 };
  memory.lastVerifiedSteps[STALE] = 1;
  const intent = stepAt(memory, KERNEL_LEARNING_VERSIONS.current);
  assert.equal(intent.choice.token, STALE);
  assert.equal(intent.expectation.verificationAge, 399);
});

test('the gate composes with verify and learn without corrupting freshness bookkeeping', () => {
  const memory = memoryAt();
  const before = { schemaVersion: 1, vector: [12], stateVersion: 'state:belief:0', intervalId: 'state:belief:0:interval' };
  const intent = stepAt(memory, KERNEL_LEARNING_VERSIONS.current);
  assert.equal(intent.choice.token, FRESH);
  const post = { schemaVersion: 1, vector: [15], stateVersion: 'state:belief:1', intervalId: 'state:belief:1:interval' };
  const receipt = {
    schemaVersion: 1,
    status: 'ACCEPTED',
    token: FRESH,
    basedOnVersion: before.stateVersion,
    policyVersion: 'policy:belief-gate',
    constraintsDigest: 'sha256:belief-gate',
    executionNonce: 'execution:belief:1',
    effectDigest: 'sha256:belief-effect',
    rejectionReason: null,
    attributionWindowComplete: true,
    confounderCount: 0,
  };
  const verification = verify({ intent, receipt, postObservation: post });
  const update = learn({
    memory,
    intent,
    receipt,
    postObservation: post,
    verification,
    learningVersion: KERNEL_LEARNING_VERSIONS.current,
  });
  assert.equal(update.status, 'UPDATED');
  assert.equal(update.nextMemory.lastVerifiedSteps[FRESH], 401);
  assert.equal(update.nextMemory.lastVerifiedSteps[STALE], 1);
});
