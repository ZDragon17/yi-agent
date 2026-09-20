import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateCounterfactualPolicy } from '../../src/runtime/counterfactual-replay.mjs';
import { canonicalDigest } from '../../src/runtime/schema.mjs';

const TOKEN_A = 'tok_AAAAAAAA';
const TOKEN_B = 'tok_BBBBBBBB';
const CONTEXT_OBSERVATION = canonicalDigest({ observation: 'context-1' });
const OTHER_OBSERVATION = canonicalDigest({ observation: 'context-2' });
const BEFORE_ONE = canonicalDigest({ state: 'before-1' });
const BEFORE_TWO = canonicalDigest({ state: 'before-2' });
const VECTOR_ONE = [20.5];
const VECTOR_TWO = [21.5];
const WORLD = {
  worldVersion: 'temperature-v1',
  tokenMapDigest: canonicalDigest({ tokenMap: 1 }),
  scenario: 'steady',
};

test('a policy that repeats every recorded choice scores full agreement', () => {
  const history = [
    entry({ kernelStep: 1, observationDigest: CONTEXT_OBSERVATION, beforeStateDigest: BEFORE_ONE, token: TOKEN_A, goalDistanceAfter: 0.8 }),
    entry({ kernelStep: 2, observationDigest: OTHER_OBSERVATION, beforeStateDigest: BEFORE_TWO, token: TOKEN_A, goalDistanceAfter: 0.6 }),
  ];
  const result = evaluateCounterfactualPolicy({ history, policy: policy(TOKEN_A) });
  assert.equal(result.type, 'counterfactual-policy-evaluation');
  assert.equal(result.mode, 'history-anchored-one-step-v2');
  assert.equal(result.basis.steps, 2);
  assert.equal(result.agreement.matched, 2);
  assert.equal(result.agreement.diverged, 0);
  assert.equal(result.agreement.agreementRate, 1);
  assert.equal(result.outcome.verdict, 'INSUFFICIENT_EVIDENCE');
  assert.deepEqual(result.samples, []);
});

test('a divergence with a same-state recorded outcome is strict evidence', () => {
  const history = [
    entry({ kernelStep: 1, observationDigest: CONTEXT_OBSERVATION, beforeStateDigest: BEFORE_ONE, beforeVector: VECTOR_ONE, token: TOKEN_A, goalDistanceAfter: 0.8 }),
    entry({ kernelStep: 2, observationDigest: CONTEXT_OBSERVATION, beforeStateDigest: BEFORE_ONE, beforeVector: VECTOR_ONE, token: TOKEN_B, goalDistanceAfter: 0.5 }),
  ];
  const result = evaluateCounterfactualPolicy({ history, policy: policy(TOKEN_B) });
  assert.equal(result.basis.steps, 2);
  assert.equal(result.agreement.matched, 1);
  assert.equal(result.agreement.diverged, 1);
  assert.equal(result.divergence.strict, 1);
  assert.equal(result.divergence.vector, 0);
  assert.equal(result.divergence.unevaluable, 0);
  assert.equal(result.outcome.verdict, 'COUNTERFACTUAL_BETTER');
  assert.equal(result.outcome.bindingCount, 1);
  assert.equal(result.outcome.minDelta, 0.8 - 0.5);
  assert.equal(result.outcome.maxDelta, 0.8 - 0.5);
  assert.equal(result.samples.length, 1);
  assert.equal(result.samples[0].classification, 'STRICT');
  assert.equal(result.samples[0].sameBeforeState, true);
  assert.equal(result.samples[0].delta, 0.8 - 0.5);
});

test('a divergence anchored only by the observable vector still binds the verdict', () => {
  const history = [
    entry({ kernelStep: 1, observationDigest: CONTEXT_OBSERVATION, beforeStateDigest: BEFORE_ONE, beforeVector: VECTOR_ONE, token: TOKEN_A, goalDistanceAfter: 0.8 }),
    entry({ kernelStep: 2, observationDigest: CONTEXT_OBSERVATION, beforeStateDigest: BEFORE_TWO, beforeVector: VECTOR_ONE, token: TOKEN_B, goalDistanceAfter: 0.5 }),
  ];
  const result = evaluateCounterfactualPolicy({ history, policy: policy(TOKEN_B) });
  assert.equal(result.divergence.vector, 1);
  assert.equal(result.divergence.strict, 0);
  assert.equal(result.outcome.verdict, 'COUNTERFACTUAL_BETTER');
  assert.equal(result.outcome.bindingCount, 1);
  assert.equal(result.samples[0].classification, 'VECTOR');
  assert.equal(result.samples[0].sameBeforeState, false);
  assert.equal(result.samples[0].counterfactualGoalDistanceAfter, 0.5);
  assert.equal(result.samples[0].delta, 0.8 - 0.5);
});

test('strict binding refuses vector-only evidence from a different hidden state', () => {
  const history = [
    entry({ kernelStep: 1, observationDigest: CONTEXT_OBSERVATION, beforeStateDigest: BEFORE_ONE, beforeVector: VECTOR_ONE, token: TOKEN_A, goalDistanceAfter: 0.8 }),
    entry({ kernelStep: 2, observationDigest: CONTEXT_OBSERVATION, beforeStateDigest: BEFORE_TWO, beforeVector: VECTOR_ONE, token: TOKEN_B, goalDistanceAfter: 0.5 }),
  ];
  const result = evaluateCounterfactualPolicy({ history, policy: policy(TOKEN_B), binding: 'strict' });
  assert.equal(result.binding, 'strict');
  assert.equal(result.divergence.strict, 0);
  assert.equal(result.divergence.vector, 0);
  assert.equal(result.divergence.unevaluable, 1);
  assert.equal(result.outcome.verdict, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.samples[0].reason, 'NO_STRICT_OUTCOME');
});

test('vector binding refuses evidence from a different WorldPort implementation', () => {
  const history = [
    entry({
      ...WORLD,
      worldId: 'latent-choice',
      worldImplementationDigest: `sha256:${'a'.repeat(64)}`,
      kernelStep: 1,
      observationDigest: CONTEXT_OBSERVATION,
      beforeStateDigest: BEFORE_ONE,
      beforeVector: VECTOR_ONE,
      token: TOKEN_A,
      goalDistanceAfter: 0.8,
    }),
    entry({
      ...WORLD,
      worldId: 'latent-choice',
      worldImplementationDigest: `sha256:${'b'.repeat(64)}`,
      kernelStep: 2,
      observationDigest: CONTEXT_OBSERVATION,
      beforeStateDigest: BEFORE_TWO,
      beforeVector: VECTOR_ONE,
      token: TOKEN_B,
      goalDistanceAfter: 0.5,
    }),
  ];
  const result = evaluateCounterfactualPolicy({ history, policy: policy(TOKEN_B) });

  assert.equal(result.divergence.vector, 0);
  assert.equal(result.divergence.unevaluable, 1);
  assert.equal(result.outcome.verdict, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.samples[0].reason, 'NO_RECORDED_OUTCOME');
});

test('vector binding refuses evidence from a different WorldPort seed', () => {
  const history = [
    entry({
      ...WORLD,
      worldId: 'temperature',
      worldImplementationDigest: `sha256:${'a'.repeat(64)}`,
      seed: 'seed-a',
      kernelStep: 1,
      observationDigest: CONTEXT_OBSERVATION,
      beforeStateDigest: BEFORE_ONE,
      beforeVector: VECTOR_ONE,
      token: TOKEN_A,
      goalDistanceAfter: 0.8,
    }),
    entry({
      ...WORLD,
      worldId: 'temperature',
      worldImplementationDigest: `sha256:${'a'.repeat(64)}`,
      seed: 'seed-b',
      kernelStep: 2,
      observationDigest: CONTEXT_OBSERVATION,
      beforeStateDigest: BEFORE_TWO,
      beforeVector: VECTOR_ONE,
      token: TOKEN_B,
      goalDistanceAfter: 0.5,
    }),
  ];
  const result = evaluateCounterfactualPolicy({ history, policy: policy(TOKEN_B) });

  assert.equal(result.divergence.vector, 0);
  assert.equal(result.divergence.unevaluable, 1);
  assert.equal(result.outcome.verdict, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.samples[0].reason, 'NO_RECORDED_OUTCOME');
});

test('a counterfactual token recorded only at another observable vector stays unevaluable', () => {
  const history = [
    entry({ kernelStep: 1, observationDigest: CONTEXT_OBSERVATION, beforeStateDigest: BEFORE_ONE, beforeVector: VECTOR_ONE, token: TOKEN_A, goalDistanceAfter: 0.8 }),
    entry({ kernelStep: 2, observationDigest: OTHER_OBSERVATION, beforeStateDigest: BEFORE_TWO, beforeVector: VECTOR_TWO, token: TOKEN_B, goalDistanceAfter: 0.5 }),
  ];
  const result = evaluateCounterfactualPolicy({ history, policy: policy(TOKEN_B) });
  assert.equal(result.divergence.unevaluable, 1);
  assert.equal(result.divergence.evaluated, 0);
  assert.equal(result.outcome.verdict, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.samples[0].reason, 'NO_RECORDED_OUTCOME');
});

test('entries without a usable observable vector cannot anchor counterfactuals', () => {
  const history = [
    entry({ kernelStep: 1, observationDigest: CONTEXT_OBSERVATION, beforeStateDigest: BEFORE_ONE, beforeVector: [Number.NaN], token: TOKEN_A, goalDistanceAfter: 0.8 }),
    entry({ kernelStep: 2, observationDigest: CONTEXT_OBSERVATION, beforeStateDigest: BEFORE_TWO, beforeVector: [], token: TOKEN_A, goalDistanceAfter: 0.6 }),
  ];
  const result = evaluateCounterfactualPolicy({ history, policy: policy(TOKEN_B) });
  assert.equal(result.basis.vectorStates, 0);
  assert.equal(result.divergence.unevaluable, 2);
  assert.equal(result.outcome.verdict, 'INSUFFICIENT_EVIDENCE');
});

test('a divergence the ledger never tried anywhere is honestly unevaluable', () => {
  const history = [
    entry({ kernelStep: 1, observationDigest: CONTEXT_OBSERVATION, beforeStateDigest: BEFORE_ONE, token: TOKEN_A, goalDistanceAfter: 0.8 }),
  ];
  const result = evaluateCounterfactualPolicy({ history, policy: policy(TOKEN_B) });
  assert.equal(result.divergence.unevaluable, 1);
  assert.equal(result.divergence.evaluated, 0);
  assert.equal(result.outcome.verdict, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.samples[0].classification, 'UNEVALUABLE');
  assert.equal(result.samples[0].reason, 'NO_RECORDED_OUTCOME');
});

test('an unverified recorded outcome cannot anchor a delta', () => {
  const history = [
    entry({ kernelStep: 1, observationDigest: CONTEXT_OBSERVATION, beforeStateDigest: BEFORE_ONE, token: TOKEN_A, verified: false, goalDistanceAfter: 0.8 }),
    entry({ kernelStep: 2, observationDigest: CONTEXT_OBSERVATION, beforeStateDigest: BEFORE_ONE, token: TOKEN_B, goalDistanceAfter: 0.5 }),
  ];
  const result = evaluateCounterfactualPolicy({ history, policy: policy(TOKEN_B) });
  assert.equal(result.divergence.unevaluable, 1);
  assert.equal(result.samples[0].reason, 'RECORDED_OUTCOME_UNVERIFIED');
  assert.equal(result.outcome.verdict, 'INSUFFICIENT_EVIDENCE');
});

test('unverified candidates are never indexed as counterfactual evidence', () => {
  const history = [
    entry({ kernelStep: 1, observationDigest: CONTEXT_OBSERVATION, beforeStateDigest: BEFORE_ONE, token: TOKEN_A, goalDistanceAfter: 0.8 }),
    entry({ kernelStep: 2, observationDigest: CONTEXT_OBSERVATION, beforeStateDigest: BEFORE_ONE, token: TOKEN_B, verified: false, goalDistanceAfter: 0.5 }),
  ];
  const result = evaluateCounterfactualPolicy({ history, policy: policy(TOKEN_B) });
  assert.equal(result.basis.recordedOutcomes, 1);
  assert.equal(result.divergence.unevaluable, 1);
  assert.equal(result.samples[0].reason, 'NO_RECORDED_OUTCOME');
});

test('a binding divergence with a worse counterfactual outcome is COUNTERFACTUAL_WORSE', () => {
  const history = [
    entry({ kernelStep: 1, observationDigest: CONTEXT_OBSERVATION, beforeStateDigest: BEFORE_ONE, beforeVector: VECTOR_ONE, token: TOKEN_A, goalDistanceAfter: 0.2 }),
    entry({ kernelStep: 2, observationDigest: CONTEXT_OBSERVATION, beforeStateDigest: BEFORE_TWO, beforeVector: VECTOR_ONE, token: TOKEN_B, goalDistanceAfter: 0.9 }),
  ];
  const result = evaluateCounterfactualPolicy({ history, policy: policy(TOKEN_B) });
  assert.equal(result.outcome.verdict, 'COUNTERFACTUAL_WORSE');
  assert.equal(result.outcome.minDelta, 0.2 - 0.9);
});

test('all-zero binding deltas tie without claiming improvement', () => {
  const history = [
    entry({ kernelStep: 1, observationDigest: CONTEXT_OBSERVATION, beforeStateDigest: BEFORE_ONE, beforeVector: VECTOR_ONE, token: TOKEN_A, goalDistanceAfter: 0.5 }),
    entry({ kernelStep: 2, observationDigest: CONTEXT_OBSERVATION, beforeStateDigest: BEFORE_TWO, beforeVector: VECTOR_ONE, token: TOKEN_B, goalDistanceAfter: 0.5 }),
  ];
  const result = evaluateCounterfactualPolicy({ history, policy: policy(TOKEN_B) });
  assert.equal(result.outcome.verdict, 'TIE');
  assert.equal(result.outcome.minDelta, 0);
  assert.equal(result.outcome.maxDelta, 0);
});

test('entries without a token or observation digest are opaque, not steps', () => {
  const history = [
    entry({ kernelStep: 1, observationDigest: undefined, beforeStateDigest: BEFORE_ONE, token: TOKEN_A, goalDistanceAfter: 0.8 }),
    entry({ kernelStep: 2, observationDigest: CONTEXT_OBSERVATION, beforeStateDigest: BEFORE_ONE, token: null, goalDistanceAfter: 0.8 }),
    entry({ kernelStep: 3, observationDigest: CONTEXT_OBSERVATION, beforeStateDigest: BEFORE_ONE, token: TOKEN_A, goalDistanceAfter: 0.8 }),
  ];
  const result = evaluateCounterfactualPolicy({ history, policy: policy(TOKEN_B) });
  assert.equal(result.basis.steps, 1);
  assert.equal(result.basis.opaque, 2);
  assert.equal(result.agreement.diverged, 1);
});

test('policy rules bind by observation digest before the default token', () => {
  const history = [
    entry({ kernelStep: 1, observationDigest: CONTEXT_OBSERVATION, beforeStateDigest: BEFORE_ONE, token: TOKEN_A, goalDistanceAfter: 0.8 }),
  ];
  const result = evaluateCounterfactualPolicy({
    history,
    policy: {
      ...policy(TOKEN_B),
      rules: [{ observationDigest: CONTEXT_OBSERVATION, token: TOKEN_A }],
    },
  });
  assert.equal(result.agreement.matched, 1);
  assert.equal(result.agreement.diverged, 0);
});

test('divergence samples are capped to keep reports bounded', () => {
  const history = [];
  for (let index = 0; index < 24; index += 1) {
    history.push(entry({
      kernelStep: index + 1,
      observationDigest: canonicalDigest({ observation: `context-${index}` }),
      beforeStateDigest: canonicalDigest({ state: `before-${index}` }),
      token: TOKEN_A,
      goalDistanceAfter: 0.8,
    }));
  }
  const result = evaluateCounterfactualPolicy({ history, policy: policy(TOKEN_B) });
  assert.equal(result.agreement.diverged, 24);
  assert.equal(result.divergence.unevaluable, 24);
  assert.equal(result.samples.length, 16);
});

test('invalid inputs fail closed', () => {
  assert.throws(() => evaluateCounterfactualPolicy({ history: [], policy: null }), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => evaluateCounterfactualPolicy({ history: [], policy: { schemaVersion: 2, type: 'candidate-policy', version: 1, defaultToken: TOKEN_A, rules: [] } }), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => evaluateCounterfactualPolicy({ history: [], policy: policy(TOKEN_A), binding: 'guess' }), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => evaluateCounterfactualPolicy({ history: [], policy: { schemaVersion: 1, type: 'candidate-policy', version: 1, defaultToken: 'nope', rules: [] } }), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => evaluateCounterfactualPolicy({ history: null, policy: policy(TOKEN_A) }), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => evaluateCounterfactualPolicy({ history: [], policy: { ...policy(TOKEN_A), rules: [{ observationDigest: 'sha256:not-a-digest', token: TOKEN_B }] } }), (error) => error.code === 'INVALID_INPUT');
});

function policy(defaultToken) {
  return { schemaVersion: 1, type: 'candidate-policy', version: 1, defaultToken, rules: [] };
}

function entry({
  kernelStep,
  observationDigest,
  beforeStateDigest,
  beforeVector = VECTOR_ONE,
  token,
  goalDistanceAfter,
  verified = true,
  worldId,
  worldImplementationDigest,
  seed,
}) {
  return {
    ...WORLD,
    ...(worldId === undefined ? {} : { worldId }),
    ...(worldImplementationDigest === undefined ? {} : { worldImplementationDigest }),
    ...(seed === undefined ? {} : { seed }),
    runId: `run-${Math.ceil(kernelStep / 2)}`,
    sequence: kernelStep,
    kernelStep,
    beforeStateDigest,
    beforeVector: [...beforeVector],
    ...(observationDigest === undefined ? {} : { observationDigest }),
    candidateOutcome: {
      candidateDigest: canonicalDigest({ token, proposal: null }),
      token,
      status: 'APPLIED',
    },
    quality: { verified, goalDistanceAfter },
  };
}
