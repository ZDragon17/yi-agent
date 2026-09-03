import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annotateCandidateHistory } from '../../src/runtime/candidate-history.mjs';

const CANDIDATE_DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_CANDIDATE_DIGEST = `sha256:${'b'.repeat(64)}`;

test('candidate history counts attempts only inside one WorldPort scope', () => {
  const history = annotateCandidateHistory([
    {
      worldVersion: 'world-v1',
      tokenMapDigest: `sha256:${'1'.repeat(64)}`,
      scenario: 'steady',
      candidateOutcome: { candidateDigest: CANDIDATE_DIGEST },
    },
    {
      worldVersion: 'world-v1',
      tokenMapDigest: `sha256:${'1'.repeat(64)}`,
      scenario: 'steady',
      candidateOutcome: { candidateDigest: CANDIDATE_DIGEST },
    },
    {
      worldVersion: 'world-v2',
      tokenMapDigest: `sha256:${'2'.repeat(64)}`,
      scenario: 'steady',
      candidateOutcome: { candidateDigest: CANDIDATE_DIGEST },
    },
  ]);

  assert.equal(history[0].attempt, 1);
  assert.equal(history[1].attempt, 2);
  assert.equal(history[2].attempt, 1);
  assert.match(history[0].candidateScopeDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(history[0].candidateScopeDigest, history[1].candidateScopeDigest);
  assert.notEqual(history[0].candidateScopeDigest, history[2].candidateScopeDigest);
});

test('candidate history derives prediction quality without calling it task success', () => {
  const history = annotateCandidateHistory([
    {
      worldVersion: 'world-v1',
      tokenMapDigest: `sha256:${'1'.repeat(64)}`,
      scenario: 'steady',
      candidateOutcome: {
        candidateDigest: CANDIDATE_DIGEST,
        status: 'APPLIED',
        receiptStatus: 'ACCEPTED',
        verification: {
          error: [1, -3],
          attribution: 'ACTION',
          learnable: true,
        },
      },
    },
  ]);

  assert.deepEqual(history[0].quality, { errorMagnitude: 2, verified: true });
});

test('candidate history compares target distance with the same bounded ValueSpec geometry', () => {
  const history = annotateCandidateHistory([
    {
      worldVersion: 'world-v1',
      tokenMapDigest: `sha256:${'1'.repeat(64)}`,
      scenario: 'steady',
      valueSpec: {
        schemaVersion: 1,
        observationDimensions: 2,
        weights: [1, 2],
        target: [0, 0],
        tolerance: 0,
        valueMode: 'distance-v2',
      },
      beforeVector: [3, 1],
      afterVector: [1, 0],
      candidateOutcome: {
        candidateDigest: CANDIDATE_DIGEST,
        status: 'APPLIED',
        verification: { error: [0, 0], attribution: 'ACTION', learnable: true },
      },
    },
  ]);

  assert.deepEqual(history[0].quality, {
    errorMagnitude: 0,
    verified: true,
    goalDistanceBefore: 5,
    goalDistanceAfter: 1,
    goalProgress: 4,
    goalReached: false,
  });
  assert.equal(history[0].beforeVector, undefined);
  assert.equal(history[0].valueSpec, undefined);
});

test('candidate history orders different candidates inside one observable decision context', () => {
  const history = annotateCandidateHistory([
    {
      worldVersion: 'world-v1',
      tokenMapDigest: `sha256:${'1'.repeat(64)}`,
      scenario: 'steady',
      observationDigest: `sha256:${'c'.repeat(64)}`,
      candidateOutcome: { candidateDigest: CANDIDATE_DIGEST },
    },
    {
      worldVersion: 'world-v1',
      tokenMapDigest: `sha256:${'1'.repeat(64)}`,
      scenario: 'steady',
      observationDigest: `sha256:${'c'.repeat(64)}`,
      candidateOutcome: { candidateDigest: OTHER_CANDIDATE_DIGEST },
    },
    {
      worldVersion: 'world-v1',
      tokenMapDigest: `sha256:${'1'.repeat(64)}`,
      scenario: 'steady',
      observationDigest: `sha256:${'d'.repeat(64)}`,
      candidateOutcome: { candidateDigest: OTHER_CANDIDATE_DIGEST },
    },
  ]);

  assert.match(history[0].decisionContextDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(history[0].decisionContextDigest, history[1].decisionContextDigest);
  assert.equal(history[0].contextAttempt, 1);
  assert.equal(history[1].contextAttempt, 2);
  assert.notEqual(history[1].decisionContextDigest, history[2].decisionContextDigest);
  assert.equal(history[2].contextAttempt, 1);
});

test('candidate history preserves continuous step distance without inferring repair lineage', () => {
  const history = annotateCandidateHistory([
    {
      worldVersion: 'world-v1',
      tokenMapDigest: `sha256:${'1'.repeat(64)}`,
      scenario: 'steady',
      observationDigest: `sha256:${'c'.repeat(64)}`,
      kernelStep: 3,
      candidateOutcome: { candidateDigest: CANDIDATE_DIGEST },
    },
    {
      worldVersion: 'world-v1',
      tokenMapDigest: `sha256:${'1'.repeat(64)}`,
      scenario: 'steady',
      observationDigest: `sha256:${'d'.repeat(64)}`,
      kernelStep: 7,
      candidateOutcome: { candidateDigest: OTHER_CANDIDATE_DIGEST },
    },
  ]);

  assert.equal(history[0].kernelStep, 3);
  assert.equal(history[0].stepsSincePreviousCandidate, undefined);
  assert.equal(history[1].kernelStep, 7);
  assert.equal(history[1].stepsSincePreviousCandidate, 4);
});

test('candidate history derives a bounded interval only for an accepted same-scope supersession', () => {
  const history = annotateCandidateHistory([
    {
      worldVersion: 'world-v1',
      tokenMapDigest: `sha256:${'1'.repeat(64)}`,
      scenario: 'steady',
      kernelStep: 3,
      candidateOutcome: { candidateDigest: CANDIDATE_DIGEST },
    },
    {
      worldVersion: 'world-v1',
      tokenMapDigest: `sha256:${'1'.repeat(64)}`,
      scenario: 'steady',
      kernelStep: 7,
      supersedesCandidateDigest: CANDIDATE_DIGEST,
      candidateOutcome: { candidateDigest: OTHER_CANDIDATE_DIGEST },
    },
    {
      worldVersion: 'world-v2',
      tokenMapDigest: `sha256:${'2'.repeat(64)}`,
      scenario: 'steady',
      kernelStep: 9,
      supersedesCandidateDigest: CANDIDATE_DIGEST,
      candidateOutcome: { candidateDigest: `sha256:${'d'.repeat(64)}` },
    },
  ]);

  assert.equal(history[1].stepsSinceSupersededCandidate, 4);
  assert.equal(history[2].stepsSinceSupersededCandidate, undefined);
});

test('candidate history compares superseded and current target distance with one geometry', () => {
  const valueSpec = {
    schemaVersion: 1,
    observationDimensions: 1,
    weights: [1],
    target: [0],
    tolerance: 0,
    valueMode: 'distance-v2',
  };
  const history = annotateCandidateHistory([
    {
      worldVersion: 'world-v1',
      tokenMapDigest: `sha256:${'1'.repeat(64)}`,
      scenario: 'steady',
      kernelStep: 3,
      valueSpec,
      beforeVector: [5],
      afterVector: [3],
      candidateOutcome: {
        candidateDigest: CANDIDATE_DIGEST,
        status: 'APPLIED',
        verification: { error: [2], attribution: 'ACTION', learnable: true },
      },
    },
    {
      worldVersion: 'world-v1',
      tokenMapDigest: `sha256:${'1'.repeat(64)}`,
      scenario: 'steady',
      kernelStep: 7,
      valueSpec,
      beforeVector: [3],
      afterVector: [1],
      supersedesCandidateDigest: CANDIDATE_DIGEST,
      candidateOutcome: {
        candidateDigest: OTHER_CANDIDATE_DIGEST,
        status: 'APPLIED',
        verification: { error: [2], attribution: 'ACTION', learnable: true },
      },
    },
  ]);

  assert.equal(history[1].goalDistanceDeltaFromSuperseded, 2);
  assert.equal(history[1].goalImprovedFromSuperseded, true);
});

test('candidate history compares the nearest candidates sharing one initial state', () => {
  const beforeStateDigest = `sha256:${'e'.repeat(64)}`;
  const history = annotateCandidateHistory([
    {
      worldVersion: 'world-v1',
      tokenMapDigest: `sha256:${'1'.repeat(64)}`,
      scenario: 'steady',
      beforeStateDigest,
      quality: { errorMagnitude: 3, verified: true },
      candidateOutcome: { candidateDigest: CANDIDATE_DIGEST },
    },
    {
      worldVersion: 'world-v1',
      tokenMapDigest: `sha256:${'1'.repeat(64)}`,
      scenario: 'steady',
      beforeStateDigest,
      quality: { errorMagnitude: 1, verified: true },
      candidateOutcome: { candidateDigest: OTHER_CANDIDATE_DIGEST },
    },
  ]);

  assert.deepEqual(history[1].pairedComparison, {
    pair: 'same-before-state-v1',
    beforeStateDigest,
    metric: 'errorMagnitude',
    leftCandidateDigest: CANDIDATE_DIGEST,
    rightCandidateDigest: OTHER_CANDIDATE_DIGEST,
    leftValue: 3,
    rightValue: 1,
    delta: 2,
    verdict: 'RIGHT_BETTER',
  });
});
