import test from 'node:test';
import assert from 'node:assert/strict';
import { comparePairedCandidates } from '../../src/runtime/candidate-comparison.mjs';

const TOKEN_MAP_DIGEST = `sha256:${'1'.repeat(64)}`;
const BEFORE_STATE_DIGEST = `sha256:${'2'.repeat(64)}`;
const LEFT_DIGEST = `sha256:${'3'.repeat(64)}`;
const RIGHT_DIGEST = `sha256:${'4'.repeat(64)}`;

function entry(candidateDigest, quality, overrides = {}) {
  return {
    worldVersion: 'world-v1',
    tokenMapDigest: TOKEN_MAP_DIGEST,
    scenario: 'steady',
    beforeStateDigest: BEFORE_STATE_DIGEST,
    candidateOutcome: { candidateDigest },
    quality,
    ...overrides,
  };
}

test('paired candidate comparison prefers the shared goal-distance metric', () => {
  assert.deepEqual(comparePairedCandidates(
    entry(LEFT_DIGEST, { verified: true, goalDistanceAfter: 1, errorMagnitude: 9 }),
    entry(RIGHT_DIGEST, { verified: true, goalDistanceAfter: 3, errorMagnitude: 1 }),
  ), {
    pair: 'same-before-state-v1',
    beforeStateDigest: BEFORE_STATE_DIGEST,
    metric: 'goalDistanceAfter',
    leftCandidateDigest: LEFT_DIGEST,
    rightCandidateDigest: RIGHT_DIGEST,
    leftValue: 1,
    rightValue: 3,
    delta: -2,
    verdict: 'LEFT_BETTER',
  });
});

test('paired candidate comparison falls back to verified error magnitude', () => {
  const result = comparePairedCandidates(
    entry(LEFT_DIGEST, { verified: true, errorMagnitude: 2 }),
    entry(RIGHT_DIGEST, { verified: true, errorMagnitude: 2 }),
  );
  assert.equal(result.metric, 'errorMagnitude');
  assert.equal(result.delta, 0);
  assert.equal(result.verdict, 'TIE');
});

test('paired candidate comparison rejects different initial states and invalid pairs', () => {
  assert.equal(comparePairedCandidates(
    entry(LEFT_DIGEST, { verified: true, goalDistanceAfter: 1 }),
    entry(RIGHT_DIGEST, { verified: true, goalDistanceAfter: 2 }, { beforeStateDigest: `sha256:${'5'.repeat(64)}` }),
  ), null);
  assert.equal(comparePairedCandidates(
    entry(LEFT_DIGEST, { verified: true, goalDistanceAfter: 1 }),
    entry(LEFT_DIGEST, { verified: true, goalDistanceAfter: 2 }),
  ), null);
  assert.equal(comparePairedCandidates(
    entry(LEFT_DIGEST, { verified: true, goalDistanceAfter: 1 }),
    entry(RIGHT_DIGEST, { verified: true, goalDistanceAfter: 2 }, { scenario: 'other' }),
  ), null);
  assert.equal(comparePairedCandidates(
    entry(LEFT_DIGEST, { verified: true, goalDistanceAfter: Number.POSITIVE_INFINITY }),
    entry(RIGHT_DIGEST, { verified: true, errorMagnitude: Number.NaN }),
  ), null);
});
