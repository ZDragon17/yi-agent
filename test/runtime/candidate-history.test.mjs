import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annotateCandidateHistory } from '../../src/runtime/candidate-history.mjs';

const CANDIDATE_DIGEST = `sha256:${'a'.repeat(64)}`;

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
