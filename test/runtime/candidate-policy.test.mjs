import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalDigest } from '../../src/runtime/schema.mjs';
import { createCandidatePolicyAdvisor, normalizeCandidatePolicy } from '../../src/runtime/candidate-policy.mjs';
import { comparePairedPolicies } from '../../src/runtime/policy-comparison.mjs';

const TOKENS = ['tok_AAAAAAAA', 'tok_BBBBBBBB'];

test('candidate policy selects by bounded observable digest and falls back to its default', async () => {
  const observation = { schemaVersion: 1, vector: [21], stateVersion: 'state:1', intervalId: 'interval:1' };
  const observationDigest = canonicalDigest({
    schemaVersion: 1,
    observation: { schemaVersion: 1, vector: [21], stateVersion: 'state:1', intervalId: 'interval:1' },
    observationEvidence: [],
    observationEvidenceTruncated: false,
  });
  const policy = normalizeCandidatePolicy({
    schemaVersion: 1,
    type: 'candidate-policy',
    version: 1,
    defaultToken: TOKENS[0],
    rules: [{ observationDigest, token: TOKENS[1] }],
  }, new Set(TOKENS));
  const advisor = createCandidatePolicyAdvisor(policy);
  const matched = await advisor({ observation });
  const fallback = await advisor({ observation: { ...observation, vector: [22], stateVersion: 'state:2' } });

  assert.equal(matched.token, TOKENS[1]);
  assert.equal(matched.observationDigest, observationDigest);
  assert.equal(fallback.token, TOKENS[0]);
  assert.equal(fallback.reason, null);
});

test('candidate policy rejects duplicate contexts and tokens outside the capability map', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  assert.throws(
    () => normalizeCandidatePolicy({
      schemaVersion: 1,
      type: 'candidate-policy',
      version: 1,
      defaultToken: TOKENS[0],
      rules: [{ observationDigest: digest, token: TOKENS[0] }, { observationDigest: digest, token: TOKENS[1] }],
    }, new Set(TOKENS)),
    (error) => error.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => normalizeCandidatePolicy({
      schemaVersion: 1,
      type: 'candidate-policy',
      version: 1,
      defaultToken: 'tok_CCCCCCCC',
      rules: [],
    }, new Set(TOKENS)),
    (error) => error.code === 'INVALID_INPUT',
  );
});

test('paired policy comparison keeps policy identity and trace evidence separate', () => {
  const digest = (letter) => `sha256:${letter.repeat(64)}`;
  assert.deepEqual(comparePairedPolicies({
    worldVersion: 'temperature.v1',
    tokenMapDigest: digest('a'),
    scenario: 'steady',
    initialStateDigest: digest('a'),
    left: { policyDigest: digest('b'), traceDigest: digest('c'), terminalDigest: digest('d'), quality: { verified: true, goalDistanceAfter: 1 } },
    right: { policyDigest: digest('e'), traceDigest: digest('f'), terminalDigest: digest('1'), quality: { verified: true, goalDistanceAfter: 2 } },
  }), {
    pair: 'same-initial-state-policy-v1',
    initialStateDigest: digest('a'),
    metric: 'terminalGoalDistance',
    leftPolicyDigest: digest('b'),
    rightPolicyDigest: digest('e'),
    leftTraceDigest: digest('c'),
    rightTraceDigest: digest('f'),
    leftTerminalDigest: digest('d'),
    rightTerminalDigest: digest('1'),
    leftValue: 1,
    rightValue: 2,
    delta: -1,
    verdict: 'LEFT_BETTER',
  });
});
