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
