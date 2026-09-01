import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalDigest } from '../../src/runtime/schema.mjs';
import { step } from '../../src/kernel/index.mjs';

const TOKEN_A = 'tok_PLANNINGA01';
const TOKEN_B = 'tok_PLANNINGB01';

test('context-v1 planner 传播首步 h1 历史，legacy-v1 保持直接收益选择', () => {
  const input = scenario();
  const originalMemory = structuredClone(input.memory);

  const contextV1 = step(input);
  assert.equal(contextV1.choice.token, TOKEN_A);

  const legacyV1 = step({
    ...input,
    planning: { schemaVersion: 1, contextMode: 'legacy-v1', horizon: 2 },
  });
  assert.equal(legacyV1.choice.token, TOKEN_B);

  assert.deepEqual(input.memory, originalMemory);
});

function scenario() {
  const afterAContext = `h1:${canonicalDigest([{
    token: TOKEN_A,
    actualDelta: [1],
  }])}`;

  return {
    observation: {
      schemaVersion: 1,
      vector: [0],
      stateVersion: 'state:planning-context:0',
      intervalId: 'state:planning-context:0:interval',
    },
    memory: {
      schemaVersion: 1,
      recentHistory: [],
      actionModels: {
        [TOKEN_A]: model([1]),
        [TOKEN_B]: model([4]),
      },
      contextModels: {
        [afterAContext]: {
          [TOKEN_B]: model([9]),
        },
      },
    },
    valueSpec: {
      schemaVersion: 1,
      observationDimensions: 1,
      weights: [1],
      target: [10],
      tolerance: 0,
      valueMode: 'distance-v2',
    },
    capabilities: [capability(TOKEN_A), capability(TOKEN_B)],
    rngState: {
      schemaVersion: 1,
      algorithm: 'xorshift32',
      state: 7,
    },
    planning: { schemaVersion: 1, horizon: 2 },
  };
}

function model(meanDelta) {
  return {
    schemaVersion: 1,
    sampleCount: 4,
    meanDelta,
    uncertainty: 0,
  };
}

function capability(token) {
  return {
    schemaVersion: 1,
    token,
    cost: 0,
    allowed: true,
    safe: true,
  };
}
