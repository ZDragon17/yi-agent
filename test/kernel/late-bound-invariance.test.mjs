import assert from 'node:assert/strict';
import test from 'node:test';
import { learn, step, verify } from '../../src/kernel/index.mjs';

const CASES = 96;

test('late-bound random coordinate and opaque-token permutations preserve the kernel relation', () => {
  let seed = 0x9e3779b9;
  for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      return seed / 0x1_0000_0000;
    };
    const dimensions = 1 + Math.floor(random() * 6);
    const actionCount = 2 + Math.floor(random() * 4);
    const tokens = Array.from({ length: actionCount }, (_, index) => token(caseIndex, index));
    const tokenMap = new Map(tokens.map((value, index) => [value, tokens[(index + 1) % tokens.length]]));
    const dimensionPermutation = shuffle(Array.from({ length: dimensions }, (_, index) => index), random);
    const observation = Array.from({ length: dimensions }, () => finite(random));
    const target = Array.from({ length: dimensions }, () => finite(random));
    const weights = Array.from({ length: dimensions }, () => 0.25 + random() * 2);
    const relationKey = `r1:${target.map((value, index) => value === observation[index] ? '0' : value > observation[index] ? '+' : '-').join('')}`;
    const actionModels = Object.fromEntries(tokens.map((actionToken) => [actionToken, model(dimensions, random)]));
    const relationModels = Object.fromEntries(tokens.map((actionToken) => [actionToken, {
      [relationKey]: model(dimensions, random),
    }]));
    const input = {
      observation: observationFor(observation, `state:${caseIndex}:0`),
      memory: { schemaVersion: 1, actionModels, relationModels },
      valueSpec: { schemaVersion: 1, observationDimensions: dimensions, weights, target },
      capabilities: tokens.map((actionToken, index) => ({
        schemaVersion: 1,
        token: actionToken,
        cost: random(),
        allowed: true,
        safe: true,
      })),
      rngState: { schemaVersion: 1, algorithm: 'xorshift32', state: 0x1000 + caseIndex },
    };
    const permuted = permuteInput(input, tokenMap, dimensionPermutation);
    const originalIntent = step(input);
    const permutedIntent = step(permuted);
    assert.equal(permutedIntent.status, originalIntent.status, `case ${caseIndex} status`);
    if (originalIntent.status === 'HALTED') continue;

    assert.equal(permutedIntent.choice.token, tokenMap.get(originalIntent.choice.token), `case ${caseIndex} token`);
    assertClose(permutedIntent.choice.score, originalIntent.choice.score, `case ${caseIndex} score`);
    assertClose(permutedIntent.choice.expectedValue, originalIntent.choice.expectedValue, `case ${caseIndex} expectedValue`);
    assert.deepEqual(permutedIntent.expectation.expectedDelta, permuteVector(originalIntent.expectation.expectedDelta, dimensionPermutation), `case ${caseIndex} delta`);
    assert.deepEqual(permutedIntent.expectation.predictedObservation.vector, permuteVector(originalIntent.expectation.predictedObservation.vector, dimensionPermutation), `case ${caseIndex} prediction`);
    assert.equal(permutedIntent.expectation.relationKey, permuteRelationKey(originalIntent.expectation.relationKey, dimensionPermutation), `case ${caseIndex} relation`);
    assert.deepEqual(permutedIntent.nextRngState, originalIntent.nextRngState, `case ${caseIndex} rng`);

    const originalReceipt = receiptFor(originalIntent, `nonce:${caseIndex}`);
    const originalPostObservation = observationFor(originalIntent.expectation.predictedObservation.vector, `state:${caseIndex}:1`);
    const originalVerification = verify({ intent: originalIntent, receipt: originalReceipt, postObservation: originalPostObservation });
    const originalUpdate = learn({
      memory: input.memory,
      intent: originalIntent,
      receipt: originalReceipt,
      postObservation: originalPostObservation,
      verification: originalVerification,
    });
    const permutedReceipt = receiptFor(permutedIntent, `nonce:${caseIndex}`);
    const permutedPostObservation = observationFor(permutedIntent.expectation.predictedObservation.vector, `state:${caseIndex}:1`);
    const permutedVerification = verify({ intent: permutedIntent, receipt: permutedReceipt, postObservation: permutedPostObservation });
    const permutedUpdate = learn({
      memory: permuted.memory,
      intent: permutedIntent,
      receipt: permutedReceipt,
      postObservation: permutedPostObservation,
      verification: permutedVerification,
    });
    assert.deepEqual(permutedVerification.error, permuteVector(originalVerification.error, dimensionPermutation), `case ${caseIndex} verification`);
    assert.deepEqual(permutedUpdate.nextMemory, permuteMemory(originalUpdate.nextMemory, tokenMap, dimensionPermutation), `case ${caseIndex} learning`);
  }
});

function permuteInput(input, tokenMap, dimensions) {
  return {
    ...input,
    observation: {
      ...input.observation,
      vector: permuteVector(input.observation.vector, dimensions),
    },
    memory: permuteMemory(input.memory, tokenMap, dimensions),
    valueSpec: {
      ...input.valueSpec,
      weights: permuteVector(input.valueSpec.weights, dimensions),
      target: permuteVector(input.valueSpec.target, dimensions),
    },
    capabilities: input.capabilities.map((capability) => ({
      ...capability,
      token: tokenMap.get(capability.token),
    })),
  };
}

function permuteMemory(memory, tokenMap, dimensions) {
  return {
    schemaVersion: 1,
    actionModels: Object.fromEntries(Object.entries(memory.actionModels).map(([token, value]) => [tokenMap.get(token), {
      ...value,
      meanDelta: permuteVector(value.meanDelta, dimensions),
    }])),
    relationModels: Object.fromEntries(Object.entries(memory.relationModels).map(([token, relations]) => [tokenMap.get(token), Object.fromEntries(Object.entries(relations).map(([key, value]) => [permuteRelationKey(key, dimensions), {
      ...value,
      meanDelta: permuteVector(value.meanDelta, dimensions),
    }]))])),
  };
}

function model(dimensions, random) {
  return {
    schemaVersion: 1,
    sampleCount: 1 + Math.floor(random() * 20),
    meanDelta: Array.from({ length: dimensions }, () => finite(random)),
    uncertainty: random(),
  };
}

function observationFor(vector, stateVersion) {
  return {
    schemaVersion: 1,
    vector: [...vector],
    stateVersion,
    intervalId: `interval:${stateVersion}`,
  };
}

function receiptFor(intent, nonce) {
  return {
    schemaVersion: 1,
    status: 'ACCEPTED',
    token: intent.choice.token,
    basedOnVersion: intent.expectation.predictedObservation.stateVersion,
    policyVersion: 'policy:late-bound',
    constraintsDigest: 'sha256:late-bound',
    executionNonce: nonce,
    effectDigest: 'sha256:effect',
    rejectionReason: null,
    attributionWindowComplete: true,
    confounderCount: 0,
  };
}

function token(caseIndex, actionIndex) {
  return `tok_${String(caseIndex).padStart(3, '0')}${String(actionIndex).padStart(2, '0')}LATEBOUND`;
}

function finite(random) {
  return Math.round((random() * 10 - 5) * 1000) / 1000;
}

function shuffle(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function permuteVector(vector, permutation) {
  return permutation.map((index) => vector[index]);
}

function permuteRelationKey(key, permutation) {
  if (key === undefined) return undefined;
  const signs = key.slice(3);
  return `r1:${permutation.map((index) => signs[index]).join('')}`;
}

function assertClose(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${label}: expected ${expected}, got ${actual}`);
}
