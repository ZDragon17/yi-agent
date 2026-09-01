import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalDigest } from '../../src/runtime/schema.mjs';
import { step } from '../../src/kernel/index.mjs';

const TOKEN_A = 'tok_RECURSIVEA01';
const TOKEN_B = 'tok_RECURSIVEB01';
const TOKEN_C = 'tok_RECURSIVEC01';
const TOKEN_X = 'tok_RECURSIVEX01';
const TOKEN_D = 'tok_RECURSIVED01';
const TOKEN_E = 'tok_RECURSIVEE01';

test('recursive belief planning selects A without mutating input memory', () => {
  const input = scenario();
  const originalMemory = structuredClone(input.memory);

  const intent = step(input);

  assert.equal(intent.choice.token, TOKEN_A);
  assert.deepEqual(input.memory, originalMemory);
});

test('recursive planning evaluates a lower-immediate-value future action', () => {
  const input = treeScenario();

  const intent = step(input);

  assert.equal(intent.choice.token, TOKEN_A);
});

test('v17 recursive-v1 keeps its greedy future-policy semantics', () => {
  const input = treeScenario();
  input.planning.branchingMode = 'recursive-v1';

  const intent = step(input);

  assert.equal(intent.choice.token, TOKEN_X);
});

function scenario() {
  return {
    observation: {
      schemaVersion: 1,
      vector: [0],
      stateVersion: 'state:planning-recursive:0',
      intervalId: 'state:planning-recursive:0:interval',
    },
    memory: {
      schemaVersion: 1,
      recentHistory: [],
      actionModels: {
        [TOKEN_A]: model([0]),
        [TOKEN_B]: model([0]),
        [TOKEN_C]: model([0]),
        [TOKEN_X]: model([0.5]),
      },
      beliefModels: {
        [TOKEN_B]: {
          overall: {
            schemaVersion: 1,
            sampleCount: 2,
            samples: [[1], [3]],
          },
        },
      },
      contextModels: {
        [historyContext([{ token: TOKEN_A, actualDelta: [0] }])]: {
          [TOKEN_B]: model([2]),
        },
        [historyContext([
          { token: TOKEN_A, actualDelta: [0] },
          { token: TOKEN_B, actualDelta: [3] },
        ])]: {
          [TOKEN_C]: model([7]),
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
    capabilities: [TOKEN_A, TOKEN_B, TOKEN_C, TOKEN_X].map(capability),
    rngState: {
      schemaVersion: 1,
      algorithm: 'xorshift32',
      state: 7,
    },
    planning: {
      schemaVersion: 1,
      horizon: 3,
    },
  };
}

function treeScenario() {
  return {
    observation: {
      schemaVersion: 1,
      vector: [0],
      stateVersion: 'state:planning-tree:0',
      intervalId: 'state:planning-tree:0:interval',
    },
    memory: {
      schemaVersion: 1,
      recentHistory: [],
      actionModels: {
        [TOKEN_A]: model([0]),
        [TOKEN_B]: model([0]),
        [TOKEN_C]: model([0]),
        [TOKEN_X]: model([1.5]),
        [TOKEN_D]: model([0]),
        [TOKEN_E]: model([0]),
      },
      contextModels: {
        [historyContext([{ token: TOKEN_A, actualDelta: [0] }])]: {
          [TOKEN_D]: model([1.6]),
          [TOKEN_E]: model([1.5]),
        },
        [historyContext([
          { token: TOKEN_A, actualDelta: [0] },
          { token: TOKEN_E, actualDelta: [1.5] },
        ])]: {
          [TOKEN_C]: model([8]),
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
    capabilities: [TOKEN_A, TOKEN_B, TOKEN_C, TOKEN_X, TOKEN_D, TOKEN_E].map(capability),
    rngState: {
      schemaVersion: 1,
      algorithm: 'xorshift32',
      state: 7,
    },
    planning: {
      schemaVersion: 1,
      horizon: 3,
    },
  };
}

function historyContext(history) {
  return `h1:${canonicalDigest(history)}`;
}

function model(meanDelta) {
  return {
    schemaVersion: 1,
    sampleCount: 1,
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
