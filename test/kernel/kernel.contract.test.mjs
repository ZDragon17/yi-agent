import assert from 'node:assert/strict';
import test from 'node:test';

const KERNEL_ENTRY = new URL('../../src/kernel/index.mjs', import.meta.url);

const TOKEN_A = 'tok_8MW7Q5V2FJ9C4RX6P1KD0ZAN3B';
const TOKEN_B = 'tok_2PZ6KV9RAQ4M1XN8D0FC7J5YHB';
const TOKEN_C = 'tok_6RC1JA8VD0BM5QZ9FX2N7PK4WH';
const TOKEN_UNKNOWN = 'tok_9XD4HM2QZ7KCV8P1RB6N5WA0TY';

const STEP_INPUT_KEYS = [
  'observation',
  'memory',
  'valueSpec',
  'capabilities',
  'rngState',
];
const VERIFY_INPUT_KEYS = ['intent', 'receipt', 'postObservation'];
const OBSERVATION_KEYS = [
  'schemaVersion',
  'vector',
  'stateVersion',
  'intervalId',
];
const VALUE_SPEC_KEYS = [
  'schemaVersion',
  'observationDimensions',
  'weights',
  'target',
  'tolerance',
  'valueMode',
];
const CAPABILITY_KEYS = [
  'schemaVersion',
  'token',
  'cost',
  'allowed',
  'safe',
];
const MEMORY_KEYS = ['schemaVersion', 'actionModels'];
const ACTION_MODEL_KEYS = [
  'schemaVersion',
  'sampleCount',
  'meanDelta',
  'uncertainty',
];
const RNG_STATE_KEYS = ['schemaVersion', 'algorithm', 'state'];
const INTENT_KEYS = [
  'schemaVersion',
  'status',
  'expectation',
  'choice',
  'nextRngState',
];
const ACTION_REQUEST_KEYS = [
  'schemaVersion',
  'token',
  'basedOnVersion',
  'policyVersion',
  'constraintsDigest',
  'executionNonce',
];
const RECEIPT_KEYS = [
  'schemaVersion',
  'status',
  'token',
  'basedOnVersion',
  'policyVersion',
  'constraintsDigest',
  'executionNonce',
  'effectDigest',
  'rejectionReason',
  'attributionWindowComplete',
  'confounderCount',
];

test('kernel public entry exposes step and verify as the kernel contract seams', async () => {
  const kernel = await loadKernel();

  assert.equal(typeof kernel.step, 'function');
  assert.equal(typeof kernel.stepWithPreference, 'function');
  assert.equal(typeof kernel.verify, 'function');
  assert.equal(typeof kernel.learn, 'function');
});

test('model preference can select only a safe capability and cannot bypass the kernel boundary', async () => {
  const { stepWithPreference } = await loadKernel();
  const input = makeStepInput();
  const preferred = stepWithPreference(input, { schemaVersion: 1, token: TOKEN_B });
  assert.equal(preferred.status, 'READY');
  assert.equal(preferred.choice.token, TOKEN_B);
  assert.deepEqual(preferred.expectation.expectedDelta, [0.1, 0.1]);
  const unsafe = makeStepInput({ capabilities: [capability(TOKEN_A), capability(TOKEN_B, { safe: false })] });
  const rejected = stepWithPreference(unsafe, { schemaVersion: 1, token: TOKEN_B });
  assert.notEqual(rejected.choice.token, TOKEN_B);
  assert.equal(unsafe.capabilities[1].safe, false);
});

test('step makes a pure decision from only observation, memory, valueSpec, capabilities, and rngState', async () => {
  const { step } = await loadKernel();
  const input = makeStepInput({
    capabilities: [capability(TOKEN_A), capability(TOKEN_B)],
    memory: memoryWithModels([
      [TOKEN_A, { sampleCount: 4, meanDelta: [0.5, -0.25], uncertainty: 0.02 }],
      [TOKEN_B, { sampleCount: 4, meanDelta: [0.1, 0.1], uncertainty: 0.02 }],
    ]),
  });

  assertExactKeys(input, STEP_INPUT_KEYS, 'step input fixture');
  const result = step(clonePreservingDataHazards(input));

  assertStepIntent(result);
  assert.equal(result.choice.token, TOKEN_B);
  assert.equal(result.expectation.token, TOKEN_B);
  assert.equal(Object.hasOwn(result, 'receipt'), false);
  assert.equal(Object.hasOwn(result, 'postObservation'), false);
  assert.equal(Object.hasOwn(result, 'nextWorldState'), false);
  assert.equal(Object.hasOwn(result, 'verification'), false);
  assert.equal(Object.hasOwn(result, 'update'), false);
});

test('step ranks absolute distance to the target and does not reward overshoot', async () => {
  const { step } = await loadKernel();
  const result = step(makeStepInput({
    observation: observation([0], 'state-target'),
    valueSpec: { schemaVersion: 1, observationDimensions: 1, weights: [1], target: [1], tolerance: 0, valueMode: 'distance-v2' },
    capabilities: [capability(TOKEN_A), capability(TOKEN_B)],
    memory: memoryWithModels([
      [TOKEN_A, { sampleCount: 4, meanDelta: [10], uncertainty: 0 }],
      [TOKEN_B, { sampleCount: 4, meanDelta: [0.5], uncertainty: 0 }],
    ]),
  }));

  assert.equal(result.choice.token, TOKEN_B);
  assert.equal(result.choice.expectedValue, -0.5);
});

test('step treats the valueSpec tolerance as an acceptable target band', async () => {
  const { step } = await loadKernel();
  const result = step(makeStepInput({
    observation: observation([0], 'state-band'),
    valueSpec: { schemaVersion: 1, observationDimensions: 1, weights: [1], target: [10], tolerance: 1, valueMode: 'distance-v2' },
    capabilities: [capability(TOKEN_A), capability(TOKEN_B)],
    memory: memoryWithModels([
      [TOKEN_A, { sampleCount: 4, meanDelta: [9], uncertainty: 0 }],
      [TOKEN_B, { sampleCount: 4, meanDelta: [11], uncertainty: 0 }],
    ]),
  }));

  assert.equal(result.choice.expectedValue, 0);
  assert.equal(result.choice.score, 0);
});

test('bounded planning can choose a temporary detour from domain-neutral learned models', async () => {
  const { step } = await loadKernel();
  const input = makeStepInput({
    observation: observation([0, 1], 'state-detour'),
    valueSpec: { schemaVersion: 1, observationDimensions: 2, weights: [1, 1], target: [2, 0], tolerance: 0, valueMode: 'distance-v2' },
    capabilities: [capability(TOKEN_A), capability(TOKEN_B)],
    memory: memoryWithModels([
      [TOKEN_A, { sampleCount: 4, meanDelta: [0, 0], uncertainty: 0 }],
      [TOKEN_B, { sampleCount: 4, meanDelta: [0, 0], uncertainty: 0 }],
    ]),
  });
  input.memory.relationModels = {
    [TOKEN_A]: {
      'r1:+-': { schemaVersion: 1, sampleCount: 4, meanDelta: [-1, -1], uncertainty: 0 },
    },
    [TOKEN_B]: {
      'r1:+-': { schemaVersion: 1, sampleCount: 4, meanDelta: [0.5, 0], uncertainty: 0 },
      'r1:+0': { schemaVersion: 1, sampleCount: 4, meanDelta: [3, 0], uncertainty: 0 },
      'r1:++': { schemaVersion: 1, sampleCount: 4, meanDelta: [0.5, 0], uncertainty: 0 },
    },
  };

  const greedy = step(input);
  const planned = step({
    ...input,
    planning: { schemaVersion: 1, horizon: 2 },
  });

  assert.equal(greedy.choice.token, TOKEN_B);
  assert.equal(planned.choice.token, TOKEN_A);
  assert.deepEqual(planned.expectation.predictedObservation.vector, [-1, 0]);
  assert.deepEqual(planned.nextRngState, greedy.nextRngState);
});

test('bounded planning values a safe observation that reduces future uncertainty', async () => {
  const { step } = await loadKernel();
  const probe = 'tok_PROBE0001';
  const exploit = 'tok_EXPLOIT01';
  const goal = 'tok_GOAL0001';
  const model = (meanDelta, uncertainty = 0) => ({
    schemaVersion: 1,
    sampleCount: 8,
    meanDelta,
    uncertainty,
  });
  const input = makeStepInput({
    observation: observation([0, 0], 'state-information'),
    valueSpec: { schemaVersion: 1, observationDimensions: 2, weights: [1, 1], target: [1, 1], tolerance: 0, valueMode: 'distance-v2' },
    capabilities: [probe, exploit, goal].map((token) => capability(token, { cost: 0.05 })),
  });
  input.memory = {
    schemaVersion: 1,
    actionModels: {
      [probe]: model([0, 0]),
      [exploit]: model([0.5, 0.5]),
      [goal]: model([0, 0]),
    },
    relationModels: {
      [goal]: {
        'r1:0+': model([0, 2]),
        'r1:+0': model([2, 0]),
      },
    },
    beliefModels: {
      [probe]: {
        'r1:++': {
          schemaVersion: 1,
          sampleCount: 2,
          samples: [[1, -1], [-1, 1]],
        },
      },
    },
  };

  const greedy = step(input);
  const planned = step({
    ...input,
    planning: { schemaVersion: 1, horizon: 2 },
  });

  assert.equal(greedy.choice.token, exploit);
  assert.equal(planned.choice.token, probe);
  assert.deepEqual(planned.expectation.expectedDelta, [0, 0]);
});

test('active information planning ignores variance that does not change the next decision', async () => {
  const { step } = await loadKernel();
  const probe = 'tok_PROBE0001';
  const exploit = 'tok_EXPLOIT01';
  const goal = 'tok_GOAL0001';
  const model = (meanDelta, uncertainty = 0) => ({
    schemaVersion: 1,
    sampleCount: 8,
    meanDelta,
    uncertainty,
  });
  const input = makeStepInput({
    observation: observation([0, 0], 'state-noise'),
    valueSpec: { schemaVersion: 1, observationDimensions: 2, weights: [1, 0], target: [1, 1], tolerance: 0, valueMode: 'distance-v2' },
    capabilities: [probe, exploit, goal].map((token) => capability(token, { cost: 0.05 })),
  });
  input.memory = {
    schemaVersion: 1,
    actionModels: {
      [probe]: model([0, 0]),
      [exploit]: model([0.25, 0]),
      [goal]: model([0, 0]),
    },
    relationModels: {
      [goal]: {
        'r1:0+': model([0, 0]),
        'r1:0-': model([0, 0]),
      },
    },
    beliefModels: {
      [probe]: {
        'r1:++': {
          schemaVersion: 1,
          sampleCount: 2,
          samples: [[1, 1], [1, -1]],
        },
      },
    },
  };

  const planned = step({ ...input, planning: { schemaVersion: 1, horizon: 2 } });
  const historicalV12 = step({
    ...input,
    planning: { schemaVersion: 1, horizon: 2, informationMode: 'belief-v1' },
  });

  assert.equal(planned.choice.token, exploit);
  assert.equal(historicalV12.choice.token, probe);

  const branchNoiseInput = makeStepInput({
    observation: observation([0, 0], 'state-branch-noise'),
    valueSpec: { schemaVersion: 1, observationDimensions: 2, weights: [1, 0], target: [1, 2], tolerance: 0, valueMode: 'distance-v2' },
    capabilities: [probe, exploit, goal].map((token) => capability(token, { cost: 0.05 })),
  });
  branchNoiseInput.memory = {
    schemaVersion: 1,
    actionModels: {
      [probe]: model([-0.5, 0]),
      [exploit]: model([0.1, 0]),
      [goal]: model([0, 0]),
    },
    relationModels: {
      [goal]: {
        'r1:0-': model([0, 0]),
        'r1:0+': model([0, 0.5]),
      },
    },
    beliefModels: {
      [probe]: {
        'r1:++': {
          schemaVersion: 1,
          sampleCount: 2,
          samples: [[1, 3], [1, 1]],
        },
      },
    },
  };

  const valueRelevant = step({
    ...branchNoiseInput,
    planning: { schemaVersion: 1, horizon: 2 },
  });
  const historicalV13 = step({
    ...branchNoiseInput,
    planning: { schemaVersion: 1, horizon: 2, informationMode: 'belief-v2' },
  });

  assert.equal(valueRelevant.choice.token, exploit);
  assert.equal(historicalV13.choice.token, probe);
});

test('step is deterministic with an explicit rngState and does not require policy metadata', async () => {
  const { step } = await loadKernel();
  const input = makeStepInput({
    capabilities: [
      capability(TOKEN_A, { cost: 1 }),
      capability(TOKEN_B, { cost: 1 }),
    ],
    memory: memoryWithModels([
      [TOKEN_A, { sampleCount: 4, meanDelta: [0.25, -0.1], uncertainty: 0.02 }],
      [TOKEN_B, { sampleCount: 4, meanDelta: [0.25, -0.1], uncertainty: 0.02 }],
    ]),
  });

  const first = step(clonePreservingDataHazards(input));
  const second = step(clonePreservingDataHazards(input));

  assert.deepEqual(intentProjection(first), intentProjection(second));
  assertJsonSerializable(first.nextRngState);
  assert.notDeepEqual(first.nextRngState, input.rngState);
});

test('learn gives recent contradictory evidence bounded influence over stale history', async () => {
  const { step, verify, learn } = await loadKernel();
  const input = makeStepInput({
    capabilities: [capability(TOKEN_A)],
    memory: memoryWithModels([
      [TOKEN_A, { sampleCount: 64, meanDelta: [1, 0], uncertainty: 0 }],
    ]),
  });
  const intent = step(input);
  const request = actionRequest({ token: TOKEN_A });
  const receipt = receiptForRequest(request);
  const postObservation = observation([0, 1], 'state-2');
  const verification = verify({ intent, receipt, postObservation });
  const updated = learn({
    memory: input.memory,
    intent,
    receipt,
    postObservation,
    verification,
  });

  assert.equal(updated.nextMemory.actionModels[TOKEN_A].sampleCount, 65);
  assert.deepEqual(updated.nextMemory.actionModels[TOKEN_A].meanDelta, [0.75, 0]);
  assert.deepEqual(
    step({ ...input, memory: updated.nextMemory }).expectation.expectedDelta,
    [0.75, 0],
  );
});

test('step conditions an action prediction on a domain-neutral relation to the current target', async () => {
  const { step } = await loadKernel();
  const input = makeStepInput({ capabilities: [capability(TOKEN_A)] });
  input.memory.relationModels = {
    [TOKEN_A]: {
      'r1:--': {
        schemaVersion: 1,
        sampleCount: 4,
        meanDelta: [0.9, 0.8],
        uncertainty: 0.01,
      },
    },
  };
  const conditioned = step(input);
  assert.equal(conditioned.expectation.relationKey, 'r1:--');
  assert.deepEqual(conditioned.expectation.expectedDelta, [0.9, 0.8]);

  const otherContext = step({
    ...input,
    observation: observation([-1, -1], 'state-other'),
  });
  assert.equal(otherContext.expectation.relationKey, 'r1:++');
  assert.deepEqual(otherContext.expectation.expectedDelta, [0.5, -0.25]);
});

test('step halts fail-closed when every capability is unsafe or disallowed', async () => {
  const { step } = await loadKernel();
  const input = makeStepInput({
    capabilities: [
      capability(TOKEN_A, { safe: false }),
      capability(TOKEN_B, { allowed: false }),
    ],
  });

  const result = step(clonePreservingDataHazards(input));

  assert.equal(result.status, 'HALTED');
  assert.equal(result.stopReason, 'NO_SAFE_ACTION');
  assert.equal(result.choice, null);
  assert.equal(result.expectation, null);
  assert.equal(Object.hasOwn(result, 'receipt'), false);
  assert.equal(Object.hasOwn(result, 'postObservation'), false);
  assert.equal(Object.hasOwn(result, 'nextWorldState'), false);
});

test('step never selects memory-only unknown tokens even when their model is strongest', async () => {
  const { step } = await loadKernel();
  const input = makeStepInput({
    capabilities: [capability(TOKEN_A)],
    memory: memoryWithModels([
      [TOKEN_A, { sampleCount: 2, meanDelta: [0.01, 0], uncertainty: 0.5 }],
      [
        TOKEN_UNKNOWN,
        { sampleCount: 50, meanDelta: [100, 100], uncertainty: 0.001 },
      ],
    ]),
  });

  const result = step(clonePreservingDataHazards(input));

  assertStepIntent(result);
  assert.equal(result.choice.token, TOKEN_A);
  assert.notEqual(result.choice.token, TOKEN_UNKNOWN);
});

test('step explores an untried safe capability before exploiting learned actions', async () => {
  const { step } = await loadKernel();
  const input = makeStepInput({
    capabilities: [capability(TOKEN_A), capability(TOKEN_B)],
    memory: memoryWithModels([
      [TOKEN_A, { sampleCount: 50, meanDelta: [100, 0], uncertainty: 0.001 }],
    ]),
  });
  input.planning = { schemaVersion: 1, horizon: 2 };
  const result = step(input);

  assert.equal(result.choice.token, TOKEN_B);
  assert.equal(result.expectation.sampleCount, 0);
});

test('exploratory strategy changes the selected action using only opaque evidence', async () => {
  const { step } = await loadKernel();
  const input = makeStepInput({
    capabilities: [capability(TOKEN_A), capability(TOKEN_B)],
    memory: memoryWithModels([
      [TOKEN_A, { sampleCount: 10, meanDelta: [0.5, 0], uncertainty: 0.01 }],
      [TOKEN_B, { sampleCount: 1, meanDelta: [0, 0], uncertainty: 0.8 }],
    ]),
  });
  input.strategy = { schemaVersion: 1, mode: 'EXPLORATORY', revision: 1, reason: 'supervisor-stagnation' };
  const result = step(input);
  assert.equal(result.choice.token, TOKEN_B);
});

test('coverage exploration prevents a stale high-uncertainty action from monopolizing retries', async () => {
  const { step } = await loadKernel();
  const stale = 'tok_STALEA01';
  const alternate = 'tok_ALTERNATE01';
  const input = makeStepInput({
    observation: observation([0], 'state-exploration-coverage'),
    valueSpec: { schemaVersion: 1, observationDimensions: 1, weights: [1], target: [10], tolerance: 0, valueMode: 'distance-v2' },
    capabilities: [stale, alternate].map((token) => capability(token)),
  });
  input.strategy = {
    schemaVersion: 1,
    mode: 'EXPLORATORY',
    revision: 1,
    reason: 'supervisor-stagnation',
    explorationMode: 'coverage-v1',
  };
  input.memory = {
    schemaVersion: 1,
    actionModels: {
      [stale]: { schemaVersion: 1, sampleCount: 69, meanDelta: [0.75], uncertainty: 1.75 },
      [alternate]: { schemaVersion: 1, sampleCount: 64, meanDelta: [0.2], uncertainty: 0 },
    },
  };

  const covered = step(input);
  const historical = step({
    ...input,
    strategy: { ...input.strategy, explorationMode: 'uncertainty-v1' },
  });

  assert.equal(covered.choice.token, alternate);
  assert.equal(historical.choice.token, stale);
});

test('step converts model uncertainty into the ValueSpec scale before selection', async () => {
  const { step } = await loadKernel();
  const result = step(makeStepInput({
    valueSpec: valueSpec([1, 0]),
    capabilities: [capability(TOKEN_A), capability(TOKEN_B)],
    memory: memoryWithModels([
      [TOKEN_A, { sampleCount: 10, meanDelta: [0.1, 0], uncertainty: 1 }],
      [TOKEN_B, { sampleCount: 10, meanDelta: [0, 0], uncertainty: 0 }],
    ]),
  }));

  assert.equal(result.choice.token, TOKEN_B);
});

test('step behavior is equivalent under opaque token and observation-dimension permutations', async () => {
  const { step } = await loadKernel();
  const tokenMap = new Map([
    [TOKEN_A, 'tok_4RMY9D1XKQ6C8VZ0F2PN7WA3HB'],
    [TOKEN_B, 'tok_7KQ1ZC5AM9X2V0R8F6DPNY3WBH'],
    [TOKEN_C, 'tok_1BYX8P6WQ4VR0C9M2ZK7NAD5HF'],
  ]);
  const dimPermutation = [1, 0];
  const originalInput = makeStepInput({
    observation: observation([0.2, 0.8], 'state-1'),
    valueSpec: valueSpec([2, -1]),
    capabilities: [
      capability(TOKEN_A, { cost: 0.1 }),
      capability(TOKEN_B, { cost: 0.1 }),
      capability(TOKEN_C, { cost: 0.1 }),
    ],
    memory: memoryWithModels([
      [TOKEN_A, { sampleCount: 8, meanDelta: [0.3, -0.1], uncertainty: 0.02 }],
      [TOKEN_B, { sampleCount: 8, meanDelta: [-0.2, 0.2], uncertainty: 0.02 }],
      [TOKEN_C, { sampleCount: 1, meanDelta: [0.05, 0.05], uncertainty: 0.2 }],
    ]),
  });
  const permutedInput = permuteStepInput(
    originalInput,
    tokenMap,
    dimPermutation,
  );

  const original = step(clonePreservingDataHazards(originalInput));
  const permuted = step(clonePreservingDataHazards(permutedInput));

  assert.equal(invertToken(tokenMap, permuted.choice.token), original.choice.token);
  assertVectorClose(
    unpermuteVector(permuted.expectation.expectedDelta, dimPermutation),
    original.expectation.expectedDelta,
  );
  assertVectorClose(
    unpermuteVector(
      permuted.expectation.predictedObservation.vector,
      dimPermutation,
    ),
    original.expectation.predictedObservation.vector,
  );
  assert.deepEqual(permuted.nextRngState, original.nextRngState);
});

test('verify treats ACCEPTED as a receipt fact and needs no separate accepted boolean', async () => {
  const { verify } = await loadKernel();
  const input = makeVerifyInput();

  assertExactKeys(input, VERIFY_INPUT_KEYS, 'verify input fixture');
  const result = verify(clonePreservingDataHazards(input));

  assert.deepEqual(result.error, [0, 0]);
  assert.equal(result.attribution, 'ACTION');
  assert.equal(result.learnable, true);
  assert.ok(result.confidence > 0);
});

test('verify consumes the StepIntent returned by step without application-layer enrichment', async () => {
  const { step, verify } = await loadKernel();
  const intent = step(makeStepInput());
  const request = actionRequest({
    token: intent.choice.token,
    basedOnVersion: intent.expectation.predictedObservation.stateVersion,
  });

  const result = verify({
    intent,
    receipt: receiptForRequest(request),
    postObservation: observation(
      intent.expectation.predictedObservation.vector,
      'state-2',
    ),
  });

  assert.equal(result.attribution, 'ACTION');
  assert.equal(result.learnable, true);
});

test('verify rejected receipts fail closed and cannot update learned memory', async () => {
  const { verify } = await loadKernel();
  const request = actionRequest();
  const input = makeVerifyInput({
    intent: intentForRequest(request),
    receipt: receiptForRequest(request, {
      status: 'REJECTED',
      rejectionReason: 'POLICY_DENIED',
    }),
  });

  const result = verify(clonePreservingDataHazards(input));

  assert.equal(result.attribution, 'EXECUTION_REJECTED');
  assert.equal(result.learnable, false);
  assert.equal(result.confidence, 0);
});

test('verify uses only domain-neutral receipt evidence for confounding and incomplete windows', async () => {
  const { verify } = await loadKernel();
  const request = actionRequest();
  const input = makeVerifyInput({
    intent: intentForRequest(request),
    receipt: receiptForRequest(request, {
      attributionWindowComplete: false,
      confounderCount: 1,
    }),
    postObservation: observation([1.9, 0.55], 'state-2'),
  });

  const result = verify(clonePreservingDataHazards(input));

  assert.equal(result.attribution, 'AMBIGUOUS');
  assert.equal(result.learnable, false);
  assert.equal(result.confidence, 0);
});

test('verify fails closed when prediction, choice, and receipt action tokens do not match', async () => {
  const { verify } = await loadKernel();
  const baseRequest = actionRequest();
  const mismatches = [
    ['receipt.token', intentForRequest(baseRequest), receiptForRequest(baseRequest, { token: TOKEN_B })],
    ['choice.token', intentForRequest(baseRequest, { choiceToken: TOKEN_B }), receiptForRequest(baseRequest)],
    ['expectation.token', intentForRequest(baseRequest, { expectationToken: TOKEN_B }), receiptForRequest(baseRequest)],
    ['receipt.basedOnVersion', intentForRequest(baseRequest), receiptForRequest(baseRequest, { basedOnVersion: 'state-stale' })],
  ];

  for (const [field, intent, receipt] of mismatches) {
    const input = makeVerifyInput({
      intent,
      receipt,
    });
    const outcome = captureContractOutcome(() =>
      verify(clonePreservingDataHazards(input)),
    );

    if (outcome.threw) {
      assert.equal(outcome.error.code, 'KERNEL_CONTRACT_VIOLATION', field);
      continue;
    }

    assert.equal(
      outcome.value.learnable,
      false,
      `${field} mismatch must not be learnable`,
    );
    assert.notEqual(
      outcome.value.attribution,
      'ACTION',
      `${field} mismatch must not be attributed to the action`,
    );
  }
});

test('verify rejects internally contradictory decision evidence', async () => {
  const { verify } = await loadKernel();
  const request = actionRequest();
  const scoreMismatch = makeVerifyInput();
  scoreMismatch.intent.choice.score = 0.5;
  const optimisticZeroUncertainty = makeVerifyInput();
  optimisticZeroUncertainty.intent.expectation.uncertainty = 0;
  optimisticZeroUncertainty.intent.expectation.score = 1;
  optimisticZeroUncertainty.intent.choice.score = 1;

  assertContractViolation(
    () => verify(scoreMismatch),
    'intent expectation/choice score mismatch',
  );
  assertContractViolation(
    () => verify(optimisticZeroUncertainty),
    'zero-uncertainty score must equal expectedValue minus cost',
  );
});

test('finite inputs that overflow during step or verify fail closed', async () => {
  const { step, verify } = await loadKernel();
  const overflowStep = makeStepInput({
    observation: observation([Number.MAX_VALUE], 'state-1'),
    memory: memoryWithModels([
      [TOKEN_A, { sampleCount: 1, meanDelta: [Number.MAX_VALUE], uncertainty: 0 }],
    ]),
    valueSpec: valueSpec([1]),
    capabilities: [capability(TOKEN_A)],
  });
  assertContractViolation(() => step(overflowStep), 'step arithmetic overflow');

  const request = actionRequest();
  const overflowIntent = intentForRequest(request, {
    predictedVector: [-Number.MAX_VALUE, 0.75],
  });
  assertContractViolation(
    () => verify({
      intent: overflowIntent,
      receipt: receiptForRequest(request),
      postObservation: observation([Number.MAX_VALUE, 0.75], 'state-2'),
    }),
    'verify arithmetic overflow',
  );
  const summedOverflowIntent = intentForRequest(request, {
    predictedVector: [0, 0],
  });
  assertContractViolation(
    () => verify({
      intent: summedOverflowIntent,
      receipt: receiptForRequest(request),
      postObservation: observation(
        [Number.MAX_VALUE, Number.MAX_VALUE],
        'state-2',
      ),
    }),
    'verify confidence overflow',
  );
});

test('verify rejects stale post-observations and intents that were not safe to execute', async () => {
  const { verify } = await loadKernel();
  const request = actionRequest();

  assertContractViolation(
    () => verify(makeVerifyInput({
      postObservation: observation([1.5, 0.75], request.basedOnVersion),
    })),
    'stale postObservation',
  );
  assertContractViolation(
    () => verify(makeVerifyInput({
      intent: intentForRequest(request, { choiceSafe: false }),
    })),
    'unsafe intent',
  );
});

test('learn is the only memory transition and updates only verified learnable evidence', async () => {
  const { learn, verify } = await loadKernel();
  const request = actionRequest();
  const intent = intentForRequest(request);
  const verifyInput = makeVerifyInput({ intent });
  const verification = verify(verifyInput);
  const emptyMemory = memoryWithModels([]);

  const updated = learn({
    memory: emptyMemory,
    intent,
    receipt: verifyInput.receipt,
    postObservation: verifyInput.postObservation,
    verification,
  });
  assert.equal(updated.status, 'UPDATED');
  assert.equal(updated.token, request.token);
  assert.equal(updated.nextMemory.actionModels[request.token].sampleCount, 1);
  assertVectorClose(
    updated.nextMemory.actionModels[request.token].meanDelta,
    [0.5, -0.25],
  );

  const ambiguousInput = makeVerifyInput({
    intent,
    receipt: receiptForRequest(request, {
      attributionWindowComplete: false,
      confounderCount: 1,
    }),
  });
  const ambiguous = verify(ambiguousInput);
  const skipped = learn({
    memory: emptyMemory,
    intent,
    receipt: ambiguousInput.receipt,
    postObservation: ambiguousInput.postObservation,
    verification: ambiguous,
  });
  assert.equal(skipped.status, 'SKIPPED');
  assert.deepEqual(skipped.nextMemory, emptyMemory);

  assertContractViolation(
    () => learn({
      memory: emptyMemory,
      intent,
      receipt: verifyInput.receipt,
      postObservation: verifyInput.postObservation,
      verification: { ...verification, error: [10, 10] },
    }),
    'forged verification',
  );

  assertContractViolation(
    () => learn({
      memory: memoryWithModels([
        [request.token, {
          sampleCount: Number.MAX_SAFE_INTEGER,
          meanDelta: [0, 0],
          uncertainty: 0,
        }],
      ]),
      intent,
      receipt: verifyInput.receipt,
      postObservation: verifyInput.postObservation,
      verification,
    }),
    'sample-count overflow',
  );
});

test('accepted incomplete feedback is retained and later settled by its execution nonce', async () => {
  const { step, verify, learn } = await loadKernel();
  const input = makeStepInput({ capabilities: [capability(TOKEN_A)] });
  const firstIntent = step(input);
  const firstRequest = actionRequest({ token: TOKEN_A });
  const firstReceipt = receiptForRequest(firstRequest, {
    attributionWindowComplete: false,
    confounderCount: 0,
  });
  const firstPostObservation = observation([1.5, 0.75], 'state-2');
  const firstVerification = verify({
    intent: firstIntent,
    receipt: firstReceipt,
    postObservation: firstPostObservation,
  });
  const deferred = learn({
    memory: input.memory,
    intent: firstIntent,
    receipt: firstReceipt,
    postObservation: firstPostObservation,
    verification: firstVerification,
  });

  assert.equal(deferred.status, 'DEFERRED');
  assert.equal(deferred.nextMemory.pendingCredits.length, 1);
  assert.equal(deferred.nextMemory.pendingCredits[0].executionNonce, firstRequest.executionNonce);

  const secondInput = {
    ...input,
    observation: observation([2, 0.75], 'state-3'),
    memory: deferred.nextMemory,
    rngState: firstIntent.nextRngState,
  };
  const secondIntent = step(secondInput);
  const secondRequest = actionRequest({
    token: TOKEN_A,
    basedOnVersion: 'state-3',
    executionNonce: 'nonce:00000002',
  });
  const secondReceipt = receiptForRequest(secondRequest);
  const secondPostObservation = {
    ...observation([2, 0.75], 'state-4'),
    feedback: [{
      schemaVersion: 1,
      executionNonce: firstRequest.executionNonce,
      stateVersion: 'state-3',
      intervalId: 'interval:state-3',
      vector: [2, 0.75],
      confounderCount: 0,
    }],
  };
  const secondVerification = verify({
    intent: secondIntent,
    receipt: secondReceipt,
    postObservation: secondPostObservation,
  });
  const settled = learn({
    memory: deferred.nextMemory,
    intent: secondIntent,
    receipt: secondReceipt,
    postObservation: secondPostObservation,
    verification: secondVerification,
  });

  assert.equal(settled.status, 'SKIPPED');
  assert.deepEqual(settled.nextMemory.pendingCredits, []);
  assert.equal(settled.settled.length, 1);
  assert.equal(settled.settled[0].executionNonce, firstRequest.executionNonce);
  assert.equal(settled.settled[0].attribution, 'ACTION');
  assert.equal(settled.nextMemory.actionModels[TOKEN_A].sampleCount, 4);
});

test('feedback settlement is canonical across transport order when multiple pending actions are returned together', async () => {
  const { step, verify, learn } = await loadKernel();
  const input = makeStepInput({
    observation: observation([0, 0], 'state-0'),
    valueSpec: valueSpec([1, 1]),
    memory: { schemaVersion: 1, actionModels: {} },
  });
  input.memory.pendingCredits = [];
  input.memory.settledFeedback = [];
  input.memory.pendingCreditPolicy = { schemaVersion: 1, maxAge: 8 };
  input.memory.beliefModels = {};
  const firstIntent = step(input);
  const firstRequest = actionRequest({
    token: firstIntent.choice.token,
    basedOnVersion: 'state-0',
    executionNonce: 'nonce:00000001',
  });
  const firstReceipt = receiptForRequest(firstRequest, { attributionWindowComplete: false });
  const firstPostObservation = observation([0, 0], 'state-1');
  const firstVerification = verify({ intent: firstIntent, receipt: firstReceipt, postObservation: firstPostObservation });
  const firstDeferred = learn({
    memory: input.memory,
    intent: firstIntent,
    receipt: firstReceipt,
    postObservation: firstPostObservation,
    verification: firstVerification,
  });

  const secondInput = {
    ...input,
    observation: observation([0, 0], 'state-1'),
    memory: firstDeferred.nextMemory,
    rngState: firstIntent.nextRngState,
  };
  const secondIntent = step(secondInput);
  const secondRequest = actionRequest({
    token: secondIntent.choice.token,
    basedOnVersion: 'state-1',
    executionNonce: 'nonce:00000002',
  });
  const secondReceipt = receiptForRequest(secondRequest, { attributionWindowComplete: false });
  const secondPostObservation = observation([0, 0], 'state-2');
  const secondVerification = verify({ intent: secondIntent, receipt: secondReceipt, postObservation: secondPostObservation });
  const pending = learn({
    memory: firstDeferred.nextMemory,
    intent: secondIntent,
    receipt: secondReceipt,
    postObservation: secondPostObservation,
    verification: secondVerification,
  }).nextMemory;
  const completedReceipt = receiptForRequest(secondRequest);
  const feedback = (executionNonce, vector, stateVersion = 'state-2', intervalId = `interval:${stateVersion}`) => ({
    schemaVersion: 1,
    executionNonce,
    stateVersion,
    intervalId,
    vector,
    confounderCount: 0,
  });
  const settle = (items, feedbackOrder, feedbackCausality) => {
    const postObservation = { ...secondPostObservation, feedback: items };
    const verification = verify({ intent: secondIntent, receipt: completedReceipt, postObservation });
    return learn({
      memory: pending,
      intent: secondIntent,
      receipt: completedReceipt,
      postObservation,
      verification,
      ...(feedbackOrder === undefined ? {} : { feedbackOrder }),
      ...(feedbackCausality === undefined ? {} : { feedbackCausality }),
    });
  };

  const forward = settle([
    feedback(firstRequest.executionNonce, [1, 0], 'state-1', 'x\u0000interval:y'),
    feedback(secondRequest.executionNonce, [0, 2], 'state-1\u0000x', 'interval:y'),
  ]);
  const reverse = settle([
    feedback(secondRequest.executionNonce, [0, 2], 'state-1\u0000x', 'interval:y'),
    feedback(firstRequest.executionNonce, [1, 0], 'state-1', 'x\u0000interval:y'),
  ]);

  assert.deepEqual(forward.settled.map((item) => item.attribution), ['ACTION', 'ACTION']);
  assert.deepEqual(reverse.settled, forward.settled);
  assert.deepEqual(reverse.nextMemory, forward.nextMemory);
  const legacyReverse = settle([
    feedback(secondRequest.executionNonce, [0, 2]),
    feedback(firstRequest.executionNonce, [1, 0], 'state-1'),
  ], 'arrival-v1', 'legacy-v1');
  assert.notDeepEqual(legacyReverse.nextMemory, forward.nextMemory);

  const sharedBoundary = settle([
    feedback(firstRequest.executionNonce, [1, 2]),
    feedback(secondRequest.executionNonce, [1, 2]),
  ]);
  assert.deepEqual(sharedBoundary.settled.map((item) => item.attribution), ['AMBIGUOUS', 'AMBIGUOUS']);
  assert.deepEqual(sharedBoundary.nextMemory.actionModels, {});
});

test('missing feedback expires at a bounded window without learning and rejects late evidence', async () => {
  const { step, verify, learn } = await loadKernel();
  const input = makeStepInput({ capabilities: [capability(TOKEN_A)] });
  input.memory = {
    schemaVersion: 1,
    actionModels: {},
    pendingCredits: [],
    pendingCreditPolicy: { schemaVersion: 1, maxAge: 2 },
  };
  const firstIntent = step(input);
  const firstRequest = actionRequest({ token: TOKEN_A });
  const firstReceipt = receiptForRequest(firstRequest, {
    attributionWindowComplete: false,
    confounderCount: 0,
  });
  const firstPostObservation = observation([1.5, 0.75], 'state-2');
  const firstVerification = verify({ intent: firstIntent, receipt: firstReceipt, postObservation: firstPostObservation });
  const firstDeferred = learn({
    memory: input.memory,
    intent: firstIntent,
    receipt: firstReceipt,
    postObservation: firstPostObservation,
    verification: firstVerification,
  });
  assert.equal(firstDeferred.nextMemory.pendingCredits[0].age, 0);

  const secondRequest = actionRequest({ basedOnVersion: 'state-2', executionNonce: 'nonce:00000002' });
  const secondIntent = intentForRequest(secondRequest);
  const secondReceipt = receiptForRequest(secondRequest, { attributionWindowComplete: false });
  const secondPostObservation = observation([1.5, 0.75], 'state-3');
  const secondVerification = verify({ intent: secondIntent, receipt: secondReceipt, postObservation: secondPostObservation });
  const secondDeferred = learn({
    memory: firstDeferred.nextMemory,
    intent: secondIntent,
    receipt: secondReceipt,
    postObservation: secondPostObservation,
    verification: secondVerification,
  });
  assert.equal(secondDeferred.nextMemory.pendingCredits[0].executionNonce, firstRequest.executionNonce);
  assert.equal(secondDeferred.nextMemory.pendingCredits[0].age, 1);

  const thirdRequest = actionRequest({ basedOnVersion: 'state-3', executionNonce: 'nonce:00000003' });
  const thirdIntent = intentForRequest(thirdRequest);
  const thirdReceipt = receiptForRequest(thirdRequest);
  const thirdPostObservation = observation([1.5, 0.75], 'state-4');
  const thirdVerification = verify({ intent: thirdIntent, receipt: thirdReceipt, postObservation: thirdPostObservation });
  const expired = learn({
    memory: secondDeferred.nextMemory,
    intent: thirdIntent,
    receipt: thirdReceipt,
    postObservation: thirdPostObservation,
    verification: thirdVerification,
  });
  assert.equal(expired.status, 'UPDATED');
  assert.equal(expired.settled[0].executionNonce, firstRequest.executionNonce);
  assert.equal(expired.settled[0].attribution, 'UNRESOLVED');
  assert.equal(expired.settled[0].learnable, false);
  assert.equal(expired.settled[0].reason, 'FEEDBACK_TIMEOUT');
  assert.equal(expired.nextMemory.actionModels[TOKEN_A].sampleCount, 1);
  assert.equal(expired.nextMemory.pendingCredits.length, 1);
  assert.equal(expired.nextMemory.pendingCredits[0].executionNonce, secondRequest.executionNonce);
  assert.equal(expired.nextMemory.pendingCredits[0].age, 1);

  const lateRequest = actionRequest({ basedOnVersion: 'state-4', executionNonce: 'nonce:00000004' });
  const lateIntent = intentForRequest(lateRequest);
  const lateReceipt = receiptForRequest(lateRequest);
  const latePostObservation = {
    ...observation([1.5, 0.75], 'state-5'),
    feedback: [{
      schemaVersion: 1,
      executionNonce: firstRequest.executionNonce,
      stateVersion: 'state-4',
      intervalId: 'interval:state-4',
      vector: [1.5, 0.75],
      confounderCount: 0,
    }],
  };
  const lateVerification = verify({ intent: lateIntent, receipt: lateReceipt, postObservation: latePostObservation });
  assertContractViolation(
    () => learn({
      memory: expired.nextMemory,
      intent: lateIntent,
      receipt: lateReceipt,
      postObservation: latePostObservation,
      verification: lateVerification,
    }),
    'late feedback after timeout',
  );
});

test('delayed credit uses the action-before vector even when the first post-observation is partial', async () => {
  const { step, verify, learn } = await loadKernel();
  const input = makeStepInput({ capabilities: [capability(TOKEN_A)] });
  const firstIntent = step(input);
  const firstRequest = actionRequest({ token: TOKEN_A });
  const firstReceipt = receiptForRequest(firstRequest, {
    attributionWindowComplete: false,
    confounderCount: 0,
  });
  const firstPostObservation = observation([1.25, 0.875], 'state-2');
  const firstVerification = verify({ intent: firstIntent, receipt: firstReceipt, postObservation: firstPostObservation });
  const deferred = learn({
    memory: { schemaVersion: 1, actionModels: {}, pendingCredits: [] },
    intent: firstIntent,
    receipt: firstReceipt,
    postObservation: firstPostObservation,
    verification: firstVerification,
  });

  const secondRequest = actionRequest({ basedOnVersion: 'state-2', executionNonce: 'nonce:00000002' });
  const secondIntent = intentForRequest(secondRequest);
  const secondReceipt = receiptForRequest(secondRequest);
  const secondPostObservation = {
    ...observation([2, 0.75], 'state-3'),
    feedback: [{
      schemaVersion: 1,
      executionNonce: firstRequest.executionNonce,
      stateVersion: 'state-3',
      intervalId: 'interval:state-3',
      vector: [2, 0.75],
      confounderCount: 0,
    }],
  };
  const secondVerification = verify({ intent: secondIntent, receipt: secondReceipt, postObservation: secondPostObservation });
  const settled = learn({
    memory: deferred.nextMemory,
    intent: secondIntent,
    receipt: secondReceipt,
    postObservation: secondPostObservation,
    verification: secondVerification,
  });

  assert.equal(settled.settled[0].attribution, 'ACTION');
  assert.deepEqual(settled.nextMemory.actionModels[TOKEN_A].meanDelta, [1, -0.25]);
});

test('confounded delayed feedback is settled as ambiguous without contaminating its action model', async () => {
  const { step, verify, learn } = await loadKernel();
  const input = makeStepInput({ capabilities: [capability(TOKEN_A), capability(TOKEN_B)] });
  const firstIntent = step(input);
  const firstRequest = actionRequest({ token: TOKEN_A });
  const firstReceipt = receiptForRequest(firstRequest, {
    attributionWindowComplete: false,
    confounderCount: 0,
  });
  const firstPostObservation = observation([1.5, 0.75], 'state-2');
  const firstVerification = verify({ intent: firstIntent, receipt: firstReceipt, postObservation: firstPostObservation });
  const deferred = learn({
    memory: { schemaVersion: 1, actionModels: {}, pendingCredits: [] },
    intent: firstIntent,
    receipt: firstReceipt,
    postObservation: firstPostObservation,
    verification: firstVerification,
  });

  const secondRequest = actionRequest({
    token: TOKEN_B,
    basedOnVersion: 'state-2',
    executionNonce: 'nonce:00000002',
  });
  const secondIntent = intentForRequest(secondRequest);
  const secondReceipt = receiptForRequest(secondRequest);
  const secondPostObservation = {
    ...observation([1.5, 0.75], 'state-3'),
    feedback: [{
      schemaVersion: 1,
      executionNonce: firstRequest.executionNonce,
      stateVersion: 'state-3',
      intervalId: 'interval:state-3',
      vector: [2, 0.75],
      confounderCount: 1,
    }],
  };
  const secondVerification = verify({ intent: secondIntent, receipt: secondReceipt, postObservation: secondPostObservation });
  const settled = learn({
    memory: deferred.nextMemory,
    intent: secondIntent,
    receipt: secondReceipt,
    postObservation: secondPostObservation,
    verification: secondVerification,
  });

  assert.equal(settled.settled[0].attribution, 'AMBIGUOUS');
  assert.equal(settled.settled[0].learnable, false);
  assert.equal(settled.nextMemory.actionModels[TOKEN_A], undefined);
  assert.equal(settled.status, 'SKIPPED');
  assert.equal(settled.nextMemory.actionModels[TOKEN_B], undefined);
});

test('delayed feedback cannot settle an execution nonce that is absent from memory', async () => {
  const { learn, verify } = await loadKernel();
  const request = actionRequest();
  const intent = intentForRequest(request);
  const receipt = receiptForRequest(request);
  const postObservation = {
    ...observation([1.5, 0.75], 'state-2'),
    feedback: [{
      schemaVersion: 1,
      executionNonce: 'nonce:missing',
      stateVersion: 'state-1',
      intervalId: 'interval:state-1',
      vector: [1.5, 0.75],
      confounderCount: 0,
    }],
  };
  const verification = verify({ intent, receipt, postObservation });

  assertContractViolation(
    () => learn({
      memory: { schemaVersion: 1, actionModels: {}, pendingCredits: [] },
      intent,
      receipt,
      postObservation,
      verification,
    }),
    'unknown delayed feedback nonce',
  );
});

test('an identical delayed feedback delivery is idempotent after its original settlement', async () => {
  const { learn, verify } = await loadKernel();
  const request = actionRequest({ token: TOKEN_B, executionNonce: 'nonce:00000002' });
  const intent = intentForRequest(request);
  const receipt = receiptForRequest(request);
  const priorFeedback = {
    schemaVersion: 1,
    executionNonce: 'nonce:00000001',
    stateVersion: 'state-2',
    intervalId: 'interval:state-2',
    vector: [1.5, 0.75],
    confounderCount: 0,
  };
  const postObservation = {
    ...observation([1.5, 0.75], 'state-3'),
    feedback: [priorFeedback],
  };
  const settled = learn({
    memory: {
      schemaVersion: 1,
      actionModels: {},
      settledFeedback: [priorFeedback],
    },
    intent,
    receipt,
    postObservation,
    verification: verify({ intent, receipt, postObservation }),
  });

  assert.equal(settled.status, 'UPDATED');
  assert.equal(settled.settled, undefined);
  assert.equal(settled.nextMemory.settledFeedback.length, 1);
  assert.equal(settled.nextMemory.actionModels[TOKEN_B].sampleCount, 1);

  const contradictory = {
    ...postObservation,
    feedback: [{ ...priorFeedback, vector: [1.6, 0.75] }],
  };
  assertContractViolation(
    () => learn({
      memory: {
        schemaVersion: 1,
        actionModels: {},
        settledFeedback: [priorFeedback],
      },
      intent,
      receipt,
      postObservation: contradictory,
      verification: verify({ intent, receipt, postObservation: contradictory }),
    }),
    'contradictory settled feedback',
  );
});

test('delayed feedback rejects a snapshot from the pending action boundary', async () => {
  const { step, verify, learn } = await loadKernel();
  const input = makeStepInput({ capabilities: [capability(TOKEN_A)] });
  const firstIntent = step(input);
  const firstRequest = actionRequest();
  const firstReceipt = receiptForRequest(firstRequest, {
    attributionWindowComplete: false,
    confounderCount: 0,
  });
  const firstPostObservation = observation([1.5, 0.75], 'state-2');
  const firstVerification = verify({ intent: firstIntent, receipt: firstReceipt, postObservation: firstPostObservation });
  const deferred = learn({
    memory: { schemaVersion: 1, actionModels: {}, pendingCredits: [] },
    intent: firstIntent,
    receipt: firstReceipt,
    postObservation: firstPostObservation,
    verification: firstVerification,
  });
  const secondRequest = actionRequest({ basedOnVersion: 'state-2', executionNonce: 'nonce:00000002' });
  const secondIntent = intentForRequest(secondRequest);
  const secondReceipt = receiptForRequest(secondRequest);
  const stalePostObservation = {
    ...observation([1.5, 0.75], 'state-3'),
    feedback: [{
      schemaVersion: 1,
      executionNonce: firstRequest.executionNonce,
      stateVersion: 'state-1',
      intervalId: 'interval:state-1',
      vector: [1.5, 0.75],
      confounderCount: 0,
    }],
  };
  const secondVerification = verify({ intent: secondIntent, receipt: secondReceipt, postObservation: stalePostObservation });

  assertContractViolation(
    () => learn({
      memory: deferred.nextMemory,
      intent: secondIntent,
      receipt: secondReceipt,
      postObservation: stalePostObservation,
      verification: secondVerification,
    }),
    'stale delayed feedback snapshot',
  );
});

test('verified learning records the same change under its relation context', async () => {
  const { learn, verify } = await loadKernel();
  const request = actionRequest();
  const intent = intentForRequest(request);
  intent.expectation.relationKey = 'r1:++';
  const verifyInput = makeVerifyInput({ intent });
  const verification = verify(verifyInput);
  const updated = learn({
    memory: {
      schemaVersion: 1,
      actionModels: {},
      relationModels: {},
    },
    intent,
    receipt: verifyInput.receipt,
    postObservation: verifyInput.postObservation,
    verification,
  });
  assert.equal(updated.nextMemory.relationModels[request.token]['r1:++'].sampleCount, 1);
  assert.deepEqual(updated.nextMemory.relationModels[request.token]['r1:++'].meanDelta, [0.5, -0.25]);
});

test('kernel rejects oversized numeric and capability surfaces before prediction work', async () => {
  const { step } = await loadKernel();
  const dimensions = 1025;
  const vector = Array(dimensions).fill(0);
  const input = makeStepInput({
    observation: observation(vector, 'state-1'),
    valueSpec: valueSpec(Array(dimensions).fill(1)),
    memory: memoryWithModels([
      [TOKEN_A, { sampleCount: 1, meanDelta: vector, uncertainty: 0 }],
    ]),
    capabilities: [capability(TOKEN_A)],
  });

  assertContractViolation(() => step(input), 'oversized observation surface');
});

test('bounded planning remains finite on the maximum capability surface', async () => {
  const { step } = await loadKernel();
  const capabilities = Array.from({ length: 4096 }, (_, index) => capability(
    `tok_${index.toString(36).toUpperCase().padStart(8, '0')}`,
  ));
  const memory = memoryWithModels(capabilities.map((item) => [item.token, {
    sampleCount: 4,
    meanDelta: [0, 0],
    uncertainty: 0,
  }]));
  const input = makeStepInput({
    capabilities,
    memory,
  });
  input.planning = { schemaVersion: 1, horizon: 8 };
  const result = step(input);

  assert.equal(result.status, 'READY');
  assert.match(result.choice.token, /^tok_[A-Z0-9]{8,128}$/u);
});

test('verify rejects scenario externalInputs and domain payloads at the kernel boundary', async () => {
  const { verify } = await loadKernel();
  const scenarioExternalInput = {
    schemaVersion: 1,
    source: 'scenario',
    kind: 'external-during-step',
    payload: { vectorDelta: [0.4, -0.2] },
    fileName: 'temperature-scenario.json',
  };
  const cases = [
    [
      'verifyInput.externalInputs',
      {
        ...makeVerifyInput(),
        externalInputs: [scenarioExternalInput],
      },
    ],
    [
      'verifyInput.receipt.externalInputs',
      makeVerifyInput({
        receipt: {
          ...receiptForRequest(actionRequest()),
          externalInputs: [scenarioExternalInput],
        },
      }),
    ],
    [
      'verifyInput.receipt.payload',
      makeVerifyInput({
        receipt: {
          ...receiptForRequest(actionRequest()),
          source: 'scenario',
          kind: 'new-files',
          payload: { fileName: 'report.txt' },
        },
      }),
    ],
    [
      'verifyInput.postObservation.fileName',
      makeVerifyInput({
        postObservation: {
          ...observation([1.5, 0.75], 'state-2'),
          fileName: 'desktop.txt',
        },
      }),
    ],
  ];

  for (const [field, badInput] of cases) {
    assertContractViolation(
      () => verify(clonePreservingDataHazards(badInput)),
      field,
    );
  }
});

test('step rejects non-finite, undefined, and function-valued data fail-closed', async () => {
  const { step } = await loadKernel();
  const cases = [
    ['observation.vector[0]', ['observation', 'vector', 0], Number.NaN],
    ['observation.vector[1]', ['observation', 'vector', 1], Infinity],
    ['valueSpec.weights[0]', ['valueSpec', 'weights', 0], -Infinity],
    ['memory.actionModels token meanDelta', ['memory', 'actionModels', TOKEN_A, 'meanDelta', 0], undefined],
    ['capabilities[0].cost', ['capabilities', 0, 'cost'], () => 1],
    ['rngState.state', ['rngState', 'state'], undefined],
  ];

  for (const [field, path, value] of cases) {
    assertContractViolation(
      () => step(setPath(makeStepInput(), path, value)),
      field,
    );
  }
});

test('step rejects inherited properties, prototype pollution, and undeclared fields by allow-list', async () => {
  const { step } = await loadKernel();
  const inheritedRoot = Object.assign(
    Object.create({ fileName: 'scenario.json' }),
    makeStepInput(),
  );
  const ownProtoRoot = makeStepInput();
  Object.defineProperty(ownProtoRoot, '__proto__', {
    enumerable: true,
    value: { polluted: true },
  });
  const inheritedCapability = makeStepInput();
  inheritedCapability.capabilities[0] = Object.assign(
    Object.create({ payload: { kind: 'domain' } }),
    inheritedCapability.capabilities[0],
  );
  const cases = [
    [
      'stepInput.fileName',
      {
        ...makeStepInput(),
        fileName: 'temperature-scenario.json',
      },
    ],
    [
      'stepInput.unexpectedField',
      {
        ...makeStepInput(),
        unexpectedField: true,
      },
    ],
    [
      'stepInput.policyVersion',
      {
        ...makeStepInput(),
        policyVersion: 'policy-1',
      },
    ],
    [
      'stepInput.constraintsDigest',
      {
        ...makeStepInput(),
        constraintsDigest: 'sha256:constraints',
      },
    ],
    ['stepInput inherited fileName', inheritedRoot],
    ['stepInput.__proto__', ownProtoRoot],
    [
      'stepInput.capabilities[0].fileName',
      setPath(makeStepInput(), ['capabilities', 0, 'fileName'], 'button.txt'),
    ],
    ['stepInput.capabilities[0] inherited payload', inheritedCapability],
  ];

  for (const [field, badInput] of cases) {
    assertContractViolation(
      () => step(clonePreservingDataHazards(badInput)),
      field,
    );
  }
});

test('verify rejects non-data values and undeclared fields by allow-list', async () => {
  const { verify } = await loadKernel();
  const pollutedReceipt = makeVerifyInput();
  pollutedReceipt.receipt = Object.assign(
    Object.create({ fileName: 'scenario.json' }),
    pollutedReceipt.receipt,
  );
  const cases = [
    [
      'verifyInput.accepted',
      {
        ...makeVerifyInput(),
        accepted: true,
      },
    ],
    [
      'verifyInput.beforeObservation',
      {
        ...makeVerifyInput(),
        beforeObservation: observation([1, 1], 'state-1'),
      },
    ],
    [
      'verifyInput.receipt.fileName',
      makeVerifyInput({
        receipt: {
          ...receiptForRequest(actionRequest()),
          fileName: 'domain.txt',
        },
      }),
    ],
    [
      'verifyInput.receipt arbitraryField',
      makeVerifyInput({
        receipt: {
          ...receiptForRequest(actionRequest()),
          arbitraryField: 1,
        },
      }),
    ],
    [
      'verifyInput.receipt inherited fileName',
      pollutedReceipt,
    ],
    [
      'verifyInput.postObservation.vector[0]',
      makeVerifyInput({
        postObservation: observation([Number.NaN, 0.75], 'state-2'),
      }),
    ],
    [
      'verifyInput.intent.status',
      makeVerifyInput({ intent: intentForRequest(actionRequest(), { status: () => 'READY' }) }),
    ],
  ];

  for (const [field, badInput] of cases) {
    assertContractViolation(
      () => verify(clonePreservingDataHazards(badInput)),
      field,
    );
  }
});

test('kernel snapshots descriptor values instead of executing Proxy get traps', async () => {
  const { step } = await loadKernel();
  const input = makeStepInput();
  const proxied = new Proxy(input, {
    get() {
      throw new Error('untrusted Proxy get trap executed');
    },
  });

  assert.deepEqual(step(proxied), step(input));
});

test('runKernelStep, if present, must not expose WorldPort transition or nextWorldState orchestration', async () => {
  const kernel = await loadKernel();

  if (typeof kernel.runKernelStep !== 'function') {
    return;
  }

  const legacyOrchestrationInput = {
    ...makeStepInput(),
    schemaVersion: 1,
    policyVersion: 'policy-1',
    constraintsDigest: 'sha256:constraints',
    kernelStep: 0,
    externalInputs: [],
    transition: async () => ({
      accepted: true,
      nextWorldState: { schemaVersion: 1, stateVersion: 'state-2' },
      receipt: receiptForRequest(actionRequest()),
      postObservation: observation([1.5, 0.75], 'state-2'),
    }),
  };

  await assert.rejects(
    () => kernel.runKernelStep(clonePreservingDataHazards(legacyOrchestrationInput)),
    (error) => error?.code === 'KERNEL_CONTRACT_VIOLATION',
  );
});

async function loadKernel() {
  return import(KERNEL_ENTRY.href);
}

function makeStepInput(overrides = {}) {
  const input = {
    observation: observation([1, 1], 'state-1'),
    memory: memoryWithModels([
      [TOKEN_A, { sampleCount: 3, meanDelta: [0.5, -0.25], uncertainty: 0.05 }],
      [TOKEN_B, { sampleCount: 2, meanDelta: [0.1, 0.1], uncertainty: 0.25 }],
    ]),
    valueSpec: valueSpec([1, -1]),
    capabilities: [capability(TOKEN_A), capability(TOKEN_B)],
    rngState: rngState(0x1234abcd),
    ...overrides,
  };

  assertStepInputFixture(input);
  return input;
}

function makeVerifyInput(overrides = {}) {
  const request = actionRequest();
  const input = {
    intent: intentForRequest(request),
    receipt: receiptForRequest(request),
    postObservation: observation([1.5, 0.75], 'state-2'),
    ...overrides,
  };

  return input;
}

function observation(vector, stateVersion) {
  return {
    schemaVersion: 1,
    vector,
    stateVersion,
    intervalId: `interval:${stateVersion}`,
  };
}

function valueSpec(weights) {
  return {
    schemaVersion: 1,
    observationDimensions: weights.length,
    weights,
    target: weights.map(() => 0),
    tolerance: 0,
    valueMode: 'distance-v2',
  };
}

function capability(token, overrides = {}) {
  return {
    schemaVersion: 1,
    token,
    cost: 0,
    allowed: true,
    safe: true,
    ...overrides,
  };
}

function memoryWithModels(entries) {
  return {
    schemaVersion: 1,
    actionModels: Object.fromEntries(
      entries.map(([token, model]) => [
        token,
        {
          schemaVersion: 1,
          sampleCount: model.sampleCount,
          meanDelta: model.meanDelta,
          uncertainty: model.uncertainty,
        },
      ]),
    ),
  };
}

function rngState(state) {
  return {
    schemaVersion: 1,
    algorithm: 'xorshift32',
    state,
  };
}

function actionRequest(overrides = {}) {
  return {
    schemaVersion: 1,
    token: TOKEN_A,
    basedOnVersion: 'state-1',
    policyVersion: 'policy-1',
    constraintsDigest: 'sha256:constraints-base',
    executionNonce: 'nonce:00000001',
    ...overrides,
  };
}

function intentForRequest(request, overrides = {}) {
  const intent = {
    schemaVersion: 1,
    status: overrides.status ?? 'READY',
    expectation: {
      schemaVersion: 1,
      token: overrides.expectationToken ?? request.token,
      expectedDelta: [0.5, -0.25],
      predictedObservation: observation(
        overrides.predictedVector ?? [1.5, 0.75],
        request.basedOnVersion,
      ),
      score: 0.75,
      sampleCount: 3,
      uncertainty: 0.05,
    },
    choice: {
      schemaVersion: 1,
      token: overrides.choiceToken ?? request.token,
      score: 0.75,
      expectedValue: 0.75,
      cost: 0,
      allowed: overrides.choiceAllowed ?? true,
      safe: overrides.choiceSafe ?? true,
    },
    nextRngState: rngState(0x456789ab),
  };

  assertExactKeys(intent, INTENT_KEYS, 'intent fixture');
  return intent;
}

function receiptForRequest(request, overrides = {}) {
  const status = overrides.status ?? 'ACCEPTED';
  const receipt = {
    schemaVersion: 1,
    status,
    token: request.token,
    basedOnVersion: request.basedOnVersion,
    policyVersion: request.policyVersion,
    constraintsDigest: request.constraintsDigest,
    executionNonce: request.executionNonce,
    effectDigest: 'sha256:effect-base',
    rejectionReason: null,
    attributionWindowComplete: true,
    confounderCount: 0,
    ...overrides,
  };

  assertExactKeys(receipt, RECEIPT_KEYS, 'receipt fixture');
  return receipt;
}

function assertStepInputFixture(input) {
  assertExactKeys(input, STEP_INPUT_KEYS, 'step input fixture');
  assertExactKeys(input.observation, OBSERVATION_KEYS, 'observation fixture');
  assertExactKeys(input.valueSpec, VALUE_SPEC_KEYS, 'valueSpec fixture');
  assertExactKeys(input.memory, MEMORY_KEYS, 'memory fixture');
  assertExactKeys(input.rngState, RNG_STATE_KEYS, 'rngState fixture');

  for (const [token, model] of Object.entries(input.memory.actionModels)) {
    assert.match(token, /^tok_[A-Z0-9]{8,128}$/u);
    assertExactKeys(model, ACTION_MODEL_KEYS, `action model ${token} fixture`);
  }

  for (const item of input.capabilities) {
    assertExactKeys(item, CAPABILITY_KEYS, 'capability fixture');
  }
}

function assertStepIntent(result) {
  assert.equal(typeof result, 'object');
  assertExactKeys(
    result,
    ['schemaVersion', 'status', 'expectation', 'choice', 'nextRngState'],
    'StepIntent',
  );
  assert.equal(result.status, 'READY');
  assert.equal(typeof result.expectation, 'object');
  assert.equal(typeof result.choice, 'object');
  assert.equal(typeof result.choice.token, 'string');
  assert.equal(result.choice.token, result.expectation.token);
  assertFiniteVector(result.expectation.expectedDelta);
  assertFiniteVector(result.expectation.predictedObservation.vector);
  assertJsonSerializable(result.nextRngState);
}

function assertContractViolation(fn, field) {
  assert.throws(
    fn,
    (error) => {
      assert.equal(error?.code, 'KERNEL_CONTRACT_VIOLATION', field);
      return true;
    },
    `${field} must fail closed at the kernel boundary`,
  );
}

function captureContractOutcome(fn) {
  try {
    return { threw: false, value: fn() };
  } catch (error) {
    return { threw: true, error };
  }
}

function assertExactKeys(value, allowedKeys, label) {
  assert.equal(isPlainRecord(value), true, `${label} must be a plain object`);
  assert.deepEqual(
    Object.keys(value).sort(),
    [...allowedKeys].sort(),
    `${label} keys`,
  );
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clonePreservingDataHazards(value) {
  if (Array.isArray(value)) {
    return value.map((item) => clonePreservingDataHazards(item));
  }

  if (value && typeof value === 'object') {
    const clone = Object.create(Object.getPrototypeOf(value));

    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);

      if ('value' in descriptor) {
        descriptor.value = clonePreservingDataHazards(descriptor.value);
      }

      Object.defineProperty(clone, key, descriptor);
    }

    return clone;
  }

  return value;
}

function setPath(input, path, value) {
  const clone = clonePreservingDataHazards(input);
  let cursor = clone;

  for (const segment of path.slice(0, -1)) {
    cursor = cursor[segment];
  }

  cursor[path.at(-1)] = value;
  return clone;
}

function intentProjection(result) {
  return {
    status: result.status,
    expectation: result.expectation,
    choice: result.choice,
    nextRngState: result.nextRngState,
  };
}

function permuteStepInput(input, tokenMap, dimPermutation) {
  const actionModels = Object.fromEntries(
    Object.entries(input.memory.actionModels).map(([token, model]) => [
      tokenMap.get(token),
      {
        ...model,
        meanDelta: permuteVector(model.meanDelta, dimPermutation),
      },
    ]),
  );

  return makeStepInput({
    ...input,
    observation: {
      ...input.observation,
      vector: permuteVector(input.observation.vector, dimPermutation),
    },
    valueSpec: {
      ...input.valueSpec,
      weights: permuteVector(input.valueSpec.weights, dimPermutation),
      target: permuteVector(input.valueSpec.target, dimPermutation),
    },
    capabilities: input.capabilities.map((item) => ({
      ...item,
      token: tokenMap.get(item.token),
    })),
    memory: {
      ...input.memory,
      actionModels,
    },
  });
}

function assertJsonSerializable(value) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
}

function assertFiniteVector(value, length = undefined) {
  assert.equal(Array.isArray(value), true);

  if (length !== undefined) {
    assert.equal(value.length, length);
  }

  for (const item of value) {
    assert.equal(typeof item, 'number');
    assert.equal(Number.isFinite(item), true);
  }
}

function assertVectorClose(actual, expected, epsilon = 1e-12) {
  assertFiniteVector(actual, expected.length);

  for (let index = 0; index < expected.length; index += 1) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) <= epsilon,
      `vector[${index}] expected ${expected[index]} but got ${actual[index]}`,
    );
  }
}

function permuteVector(vector, permutation) {
  return permutation.map((sourceIndex) => vector[sourceIndex]);
}

function unpermuteVector(vector, permutation) {
  const result = Array(vector.length);

  permutation.forEach((sourceIndex, targetIndex) => {
    result[sourceIndex] = vector[targetIndex];
  });

  return result;
}

function invertToken(tokenMap, token) {
  for (const [source, target] of tokenMap.entries()) {
    if (target === token) {
      return source;
    }
  }

  return undefined;
}
