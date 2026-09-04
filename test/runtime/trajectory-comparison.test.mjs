import assert from 'node:assert/strict';
import { test } from 'node:test';
import { comparePairedTrajectories } from '../../src/runtime/trajectory-comparison.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;

test('trajectory comparison uses one common terminal goal metric', () => {
  const result = comparePairedTrajectories({
    worldVersion: 'temperature.v1',
    tokenMapDigest: DIGEST,
    scenario: 'steady',
    initialStateDigest: DIGEST,
    left: { trajectoryDigest: DIGEST, terminalDigest: DIGEST, quality: { verified: true, goalDistanceAfter: 0.5 } },
    right: { trajectoryDigest: OTHER_DIGEST, terminalDigest: OTHER_DIGEST, quality: { verified: true, goalDistanceAfter: 1.5 } },
  });

  assert.deepEqual(result, {
    pair: 'same-initial-state-trajectory-v1',
    initialStateDigest: DIGEST,
    metric: 'terminalGoalDistance',
    leftTrajectoryDigest: DIGEST,
    rightTrajectoryDigest: OTHER_DIGEST,
    leftTerminalDigest: DIGEST,
    rightTerminalDigest: OTHER_DIGEST,
    leftValue: 0.5,
    rightValue: 1.5,
    delta: -1,
    verdict: 'LEFT_BETTER',
  });
});

test('trajectory comparison refuses unverified or same trajectories', () => {
  assert.equal(comparePairedTrajectories({
    worldVersion: 'temperature.v1',
    tokenMapDigest: DIGEST,
    scenario: 'steady',
    initialStateDigest: DIGEST,
    left: { trajectoryDigest: DIGEST, terminalDigest: DIGEST, quality: { verified: false, goalDistanceAfter: 0.5 } },
    right: { trajectoryDigest: OTHER_DIGEST, terminalDigest: OTHER_DIGEST, quality: { verified: true, goalDistanceAfter: 1.5 } },
  }), null);
  assert.equal(comparePairedTrajectories({
    worldVersion: 'temperature.v1',
    tokenMapDigest: DIGEST,
    scenario: 'steady',
    initialStateDigest: DIGEST,
    left: { trajectoryDigest: DIGEST, terminalDigest: DIGEST, quality: { verified: true, goalDistanceAfter: 0.5 } },
    right: { trajectoryDigest: DIGEST, terminalDigest: OTHER_DIGEST, quality: { verified: true, goalDistanceAfter: 1.5 } },
  }), null);
});
