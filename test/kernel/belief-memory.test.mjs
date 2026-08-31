import assert from 'node:assert/strict';
import test from 'node:test';
import { learn, step, verify } from '../../src/kernel/index.mjs';

const TOKEN = 'tok_BELIEF0001';
const VALUE_SPEC = {
  schemaVersion: 1,
  observationDimensions: 1,
  weights: [1],
  target: [2],
  tolerance: 0,
  valueMode: 'distance-v2',
};
const CAPABILITIES = [{
  schemaVersion: 1,
  token: TOKEN,
  cost: 1,
  allowed: true,
  safe: true,
}];

test('belief memory preserves multiple verified outcomes under one observable condition', () => {
  const first = execute({
    memory: emptyMemory(),
    vector: [0],
    stateVersion: 'state:belief:0',
    nonce: 'execution:belief:1',
    actualVector: [1],
    rngState: 7,
  });
  const second = execute({
    memory: first.update.nextMemory,
    vector: [0],
    stateVersion: 'state:belief:1',
    nonce: 'execution:belief:2',
    actualVector: [-1],
    rngState: first.intent.nextRngState.state,
  });

  const context = 'r1:+';
  assert.deepEqual(
    second.update.nextMemory.beliefModels[TOKEN][context].samples,
    [[1], [-1]],
  );
  assert.equal(second.update.nextMemory.beliefModels[TOKEN][context].sampleCount, 2);

  const nextIntent = step({
    observation: observation([0], 'state:belief:2'),
    memory: second.update.nextMemory,
    valueSpec: VALUE_SPEC,
    capabilities: CAPABILITIES,
    rngState: second.intent.nextRngState,
  });
  assert.equal(nextIntent.expectation.uncertainty, 1.5);
  assert.deepEqual(nextIntent.expectation.expectedDelta, [0]);
});

test('belief memory remains bounded and is independent of WorldPort field names', () => {
  let memory = emptyMemory();
  let rngState = 11;
  for (let index = 0; index < 12; index += 1) {
    const result = execute({
      memory,
      vector: [0],
      stateVersion: `state:belief:${index}`,
      nonce: `execution:belief:bounded:${index}`,
      actualVector: [index],
      rngState,
    });
    memory = result.update.nextMemory;
    rngState = result.intent.nextRngState.state;
  }
  const model = memory.beliefModels[TOKEN]['r1:+'];
  assert.equal(model.samples.length, 8);
  assert.equal(model.sampleCount, 12);
  assert.deepEqual(model.samples.at(-1), [11]);
});

function execute({ memory, vector, stateVersion, nonce, actualVector, rngState }) {
  const before = observation(vector, stateVersion);
  const intent = step({
    observation: before,
    memory,
    valueSpec: VALUE_SPEC,
    capabilities: CAPABILITIES,
    rngState: rng(rngState),
  });
  const receipt = {
    schemaVersion: 1,
    status: 'ACCEPTED',
    token: intent.choice.token,
    basedOnVersion: before.stateVersion,
    policyVersion: 'policy:belief:1',
    constraintsDigest: 'sha256:belief',
    executionNonce: nonce,
    effectDigest: 'sha256:effect',
    rejectionReason: null,
    attributionWindowComplete: true,
    confounderCount: 0,
  };
  const postObservation = observation(actualVector, `${stateVersion}:next`);
  const verification = verify({ intent, receipt, postObservation });
  const update = learn({ memory, intent, receipt, postObservation, verification });
  return { intent, update };
}

function emptyMemory() {
  return { schemaVersion: 1, actionModels: {}, relationModels: {}, beliefModels: {} };
}

function observation(vector, stateVersion) {
  return { schemaVersion: 1, vector, stateVersion, intervalId: `${stateVersion}:interval` };
}

function rng(state) {
  return { schemaVersion: 1, algorithm: 'xorshift32', state };
}
