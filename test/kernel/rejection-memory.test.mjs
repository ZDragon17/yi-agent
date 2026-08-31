import assert from 'node:assert/strict';
import { test } from 'node:test';
import { learn, step, verify } from '../../src/kernel/index.mjs';

const TOKEN_REJECTED = 'tok_8MW7Q5V2FJ9C4RX6P1KD0ZAN3B';
const TOKEN_ALTERNATIVE = 'tok_2PZ6KV9RAQ4M1XN8D0FC7J5YHB';
const BASE_INPUT = {
  observation: { schemaVersion: 1, vector: [0], stateVersion: 'state:counter:0', intervalId: 'counter:0' },
  memory: {
    schemaVersion: 1,
    actionModels: {
      [TOKEN_ALTERNATIVE]: { schemaVersion: 1, sampleCount: 1, meanDelta: [0], uncertainty: 0 },
    },
  },
  valueSpec: { schemaVersion: 1, observationDimensions: 1, weights: [1], target: [1] },
  capabilities: [
    { schemaVersion: 1, token: TOKEN_REJECTED, cost: 1, allowed: true, safe: true },
    { schemaVersion: 1, token: TOKEN_ALTERNATIVE, cost: 1, allowed: true, safe: true },
  ],
  rngState: { schemaVersion: 1, algorithm: 'xorshift32', state: 1 },
};

test('rejected action feedback is retained and prevents a same-context repeat', () => {
  const first = step(BASE_INPUT);
  assert.equal(first.choice.token, TOKEN_REJECTED);
  const receipt = {
    schemaVersion: 1,
    status: 'REJECTED',
    token: TOKEN_REJECTED,
    basedOnVersion: first.expectation.predictedObservation.stateVersion,
    policyVersion: 'policy:counter:1',
    constraintsDigest: 'sha256:counter-constraints',
    executionNonce: 'execution:1',
    effectDigest: 'sha256:rejected-state',
    rejectionReason: 'TEMPORARY_CONSTRAINT',
    attributionWindowComplete: true,
    confounderCount: 0,
  };
  const verification = verify({
    intent: first,
    receipt,
    postObservation: BASE_INPUT.observation,
  });
  const update = learn({
    memory: BASE_INPUT.memory,
    intent: first,
    receipt,
    postObservation: BASE_INPUT.observation,
    verification,
  });
  assert.equal(update.status, 'REJECTION_RECORDED');
  assert.equal(update.nextMemory.rejectionModels[TOKEN_REJECTED].rejected, true);
  assert.equal(update.nextMemory.rejectionModels[TOKEN_REJECTED].sampleCount, 1);
  assert.equal(step({ ...BASE_INPUT, memory: update.nextMemory }).choice.token, TOKEN_ALTERNATIVE);
});

test('rejection feedback is contextual and does not permanently ban an action after the relation changes', () => {
  const input = {
    ...BASE_INPUT,
    memory: { ...BASE_INPUT.memory, relationModels: {} },
  };
  const first = step(input);
  const receipt = {
    schemaVersion: 1,
    status: 'REJECTED',
    token: first.choice.token,
    basedOnVersion: first.expectation.predictedObservation.stateVersion,
    policyVersion: 'policy:counter:1',
    constraintsDigest: 'sha256:counter-constraints',
    executionNonce: 'execution:contextual',
    effectDigest: 'sha256:rejected-state',
    rejectionReason: 'TEMPORARY_CONSTRAINT',
    attributionWindowComplete: true,
    confounderCount: 0,
  };
  const verification = verify({ intent: first, receipt, postObservation: input.observation });
  const update = learn({ memory: input.memory, intent: first, receipt, postObservation: input.observation, verification });
  const changedRelation = {
    ...input,
    observation: { ...input.observation, vector: [1], stateVersion: 'state:counter:1' },
    memory: update.nextMemory,
  };
  assert.equal(step(changedRelation).choice.token, TOKEN_REJECTED);
});
