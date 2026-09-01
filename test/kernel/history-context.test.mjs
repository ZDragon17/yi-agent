import assert from 'node:assert/strict';
import { test } from 'node:test';
import { learn, step, verify } from '../../src/kernel/index.mjs';
import { canonicalDigest } from '../../src/runtime/schema.mjs';

const PROBE = 'tok_HISTORYPROBE1';
const TARGET_A = 'tok_HISTORYTARGETA1';
const TARGET_B = 'tok_HISTORYTARGETB1';
const VALUE_SPEC = {
  schemaVersion: 1,
  observationDimensions: 1,
  weights: [1],
  target: [1],
  tolerance: 0,
  valueMode: 'distance-v2',
};
const CAPABILITIES = [TARGET_A, TARGET_B].map((token) => ({
  schemaVersion: 1,
  token,
  cost: 1,
  allowed: true,
  safe: true,
}));

test('verified recent changes condition later action models without domain fields', () => {
  const recentHistory = [
    { schemaVersion: 1, token: PROBE, actualDelta: [1] },
    { schemaVersion: 1, token: 'tok_HISTORYCLEAR1', actualDelta: [-1] },
  ];
  const contextKey = `h1:${canonicalDigest(recentHistory.map(({ token, actualDelta }) => ({ token, actualDelta })))}`;
  const memory = {
    schemaVersion: 1,
    actionModels: {},
    relationModels: {},
    contextModels: {
      [contextKey]: {
        [TARGET_A]: model([1]),
        [TARGET_B]: model([-1]),
      },
    },
    recentHistory,
  };
  const before = observation([0], 'state:history:0');
  const intent = step({
    observation: before,
    memory,
    valueSpec: VALUE_SPEC,
    capabilities: CAPABILITIES,
    rngState: rng(7),
  });
  assert.equal(intent.choice.token, TARGET_A);
  assert.equal(intent.expectation.expectedDelta[0], 1);

  const receipt = {
    schemaVersion: 1,
    status: 'ACCEPTED',
    token: TARGET_A,
    basedOnVersion: before.stateVersion,
    policyVersion: 'policy:history:1',
    constraintsDigest: 'sha256:history',
    executionNonce: 'execution:history:1',
    effectDigest: 'sha256:effect',
    rejectionReason: null,
    attributionWindowComplete: true,
    confounderCount: 0,
  };
  const postObservation = observation([1], 'state:history:1');
  const verification = verify({ intent, receipt, postObservation });
  const update = learn({ memory, intent, receipt, postObservation, verification });
  assert.equal(update.status, 'UPDATED');
  assert.equal(update.nextMemory.contextModels[contextKey][TARGET_A].sampleCount, 2);
  assert.equal(update.nextMemory.recentHistory.at(-1).token, TARGET_A);
});

test('history context keys stay bounded for the maximum observation dimension', () => {
  const dimensions = 1024;
  const recentHistory = [
    { schemaVersion: 1, token: PROBE, actualDelta: Array(dimensions).fill(1) },
    { schemaVersion: 1, token: 'tok_HISTORYCLEAR1', actualDelta: Array(dimensions).fill(-1) },
  ];
  const memory = {
    schemaVersion: 1,
    actionModels: {},
    relationModels: {},
    contextModels: {},
    recentHistory,
  };
  const vector = Array(dimensions).fill(0);
  const valueSpec = {
    schemaVersion: 1,
    observationDimensions: dimensions,
    weights: Array(dimensions).fill(1),
    target: Array(dimensions).fill(0),
    tolerance: 0,
    valueMode: 'distance-v2',
  };
  const intent = step({
    observation: observation(vector, 'state:history:wide:0'),
    memory,
    valueSpec,
    capabilities: [{ schemaVersion: 1, token: TARGET_A, cost: 1, allowed: true, safe: true }],
    rngState: rng(11),
  });
  const before = observation(vector, 'state:history:wide:0');
  const postObservation = observation(vector, 'state:history:wide:1');
  const receipt = {
    schemaVersion: 1,
    status: 'ACCEPTED',
    token: TARGET_A,
    basedOnVersion: before.stateVersion,
    policyVersion: 'policy:history:wide',
    constraintsDigest: 'sha256:history-wide',
    executionNonce: 'execution:history:wide:1',
    effectDigest: 'sha256:effect-wide',
    rejectionReason: null,
    attributionWindowComplete: true,
    confounderCount: 0,
  };
  const verification = verify({ intent, receipt, postObservation });
  const update = learn({ memory, intent, receipt, postObservation, verification });
  const contextKeys = Object.keys(update.nextMemory.contextModels);
  assert.equal(contextKeys.length, 1);
  assert.ok(contextKeys[0].length < 128);
  assert.doesNotThrow(() => step({
    observation: postObservation,
    memory: update.nextMemory,
    valueSpec,
    capabilities: [{ schemaVersion: 1, token: TARGET_A, cost: 1, allowed: true, safe: true }],
    rngState: rng(13),
  }));
});

function model(meanDelta) {
  return { schemaVersion: 1, sampleCount: 1, meanDelta, uncertainty: 0 };
}

function observation(vector, stateVersion) {
  return { schemaVersion: 1, vector, stateVersion, intervalId: `${stateVersion}:interval` };
}

function rng(state) {
  return { schemaVersion: 1, algorithm: 'xorshift32', state };
}
