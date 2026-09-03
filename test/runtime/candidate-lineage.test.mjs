import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptedSupersessionDigest } from '../../src/runtime/candidate-lineage.mjs';

const TOKEN_MAP_DIGEST = `sha256:${'1'.repeat(64)}`;
const WORLD_VERSION = 'repo-v1';

function historyEntry(candidateDigest, overrides = {}) {
  return {
    worldVersion: WORLD_VERSION,
    tokenMapDigest: TOKEN_MAP_DIGEST,
    scenario: 'working-tree',
    candidateOutcome: { candidateDigest },
    ...overrides,
  };
}

test('accepts only an existing candidate from the same WorldPort scope', () => {
  const target = `sha256:${'a'.repeat(64)}`;
  const history = [
    historyEntry(target),
    historyEntry(`sha256:${'b'.repeat(64)}`, { scenario: 'other' }),
    historyEntry(`sha256:${'c'.repeat(64)}`, { worldVersion: 'repo-v2' }),
    historyEntry(`sha256:${'d'.repeat(64)}`, { tokenMapDigest: `sha256:${'2'.repeat(64)}` }),
  ];

  assert.equal(acceptedSupersessionDigest({
    requestedDigest: target,
    history,
    worldVersion: WORLD_VERSION,
    tokenMapDigest: TOKEN_MAP_DIGEST,
    scenario: 'working-tree',
  }), target);
  assert.equal(acceptedSupersessionDigest({
    requestedDigest: `sha256:${'b'.repeat(64)}`,
    history,
    worldVersion: WORLD_VERSION,
    tokenMapDigest: TOKEN_MAP_DIGEST,
    scenario: 'working-tree',
  }), null);
});

test('rejects malformed, missing, and self-absent candidate references', () => {
  const history = [historyEntry(`sha256:${'a'.repeat(64)}`)];
  const context = { history, worldVersion: WORLD_VERSION, tokenMapDigest: TOKEN_MAP_DIGEST, scenario: 'working-tree' };
  assert.equal(acceptedSupersessionDigest({ ...context, requestedDigest: 'not-a-digest' }), null);
  assert.equal(acceptedSupersessionDigest({ ...context, requestedDigest: `sha256:${'b'.repeat(64)}` }), null);
  assert.equal(acceptedSupersessionDigest({ ...context, requestedDigest: null }), null);
});
