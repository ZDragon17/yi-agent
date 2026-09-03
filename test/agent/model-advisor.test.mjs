import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDecisionPrompt, createModelAdvisor } from '../../src/agent/model-advisor.mjs';
import { projectModelObservation } from '../../src/agent/observation-context.mjs';
import { MAX_MODEL_PROPOSAL_BYTES } from '../../src/runtime/schema.mjs';

const TOKEN_A = 'tok_8MW7Q5V2FJ9C4RX6P1KD0ZAN3B';

test('model advisor reduces a response to a bounded token proposal', async () => {
  let prompt;
  const advisor = createModelAdvisor({
    model: 'model-1',
    client: {
      async chat(value) {
        prompt = value;
        return { model: 'model-1', content: `{"token":"${TOKEN_A}"}` };
      },
    },
  });
  const result = await advisor({
    observation: { vector: [1], stateVersion: 'state-1', intervalId: 'interval-1' },
    valueSpec: { observationDimensions: 1, weights: [1], target: [0] },
    capabilities: [{ token: TOKEN_A, cost: 1, allowed: true, safe: true }],
    manifest: { tokenMap: { entries: [{ token: TOKEN_A, capabilityId: 'temperature.increase' }] } },
    memory: { actionModels: {} },
    step: 0,
    goal: '保持稳定',
  });
  assert.equal(result.token, TOKEN_A);
  assert.equal(result.source, 'model');
  assert.match(result.responseDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(result.observationDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(prompt, /保持稳定/u);
  assert.doesNotMatch(JSON.stringify(result), /temperature\.increase/u);
});

test('model advisor receives bounded WorldPort evidence without changing the token contract', async () => {
  let prompt;
  const advisor = createModelAdvisor({
    model: 'model-evidence',
    client: {
      async chat(value) {
        prompt = value;
        return { model: 'model-evidence', content: `{"token":"${TOKEN_A}"}` };
      },
    },
  });
  const result = await advisor({
    observation: { vector: [1], stateVersion: 'state-1', intervalId: 'interval-1' },
    observationEvidence: [{ kind: 'constraint', message: '当前边界只允许报告动作' }],
    capabilities: [{ token: TOKEN_A, cost: 1, allowed: true, safe: true }],
    memory: { actionModels: {} },
  });
  assert.match(prompt, /当前边界只允许报告动作/u);
  assert.equal(result.token, TOKEN_A);
  assert.match(result.observationDigest, /^sha256:[0-9a-f]{64}$/u);
});

test('model advisor receives only a bounded candidate history', async () => {
  let prompt;
  const advisor = createModelAdvisor({
    model: 'model-candidate-history',
    client: {
      async chat(value) {
        prompt = value;
        return { model: 'model-candidate-history', content: 'not json' };
      },
    },
  });
  const candidateHistory = Array.from({ length: 40 }, (_, index) => ({
    runId: `run-${index}`,
    sequence: index + 1,
    recordedAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
    candidateOutcome: {
      schemaVersion: 1,
      candidateDigest: `sha256:${String(index).padStart(64, '0')}`,
      token: TOKEN_A,
      status: 'APPLIED',
      receiptStatus: 'ACCEPTED',
      verification: { error: [index], attribution: 'ACTION', confidence: 1, learnable: true },
    },
  }));
  await advisor({
    observation: { vector: [1], stateVersion: 'state-1', intervalId: 'interval-1' },
    capabilities: [{ token: TOKEN_A, cost: 1, allowed: true, safe: true }],
    memory: {},
    candidateHistory,
  });
  const context = JSON.parse(prompt.split('\n').at(-1));
  assert.equal(context.candidateHistory.length, 32);
  assert.equal(context.candidateHistory[0].runId, 'run-8');
  assert.equal(context.candidateHistory.at(-1).runId, 'run-39');
});

test('model advisor receives small prior proposals and marks oversized ones as truncated', async () => {
  let prompt;
  const advisor = createModelAdvisor({
    model: 'model-candidate-proposal-history',
    client: {
      async chat(value) {
        prompt = value;
        return { model: 'model-candidate-proposal-history', content: 'not json' };
      },
    },
  });
  await advisor({
    capabilities: [{ token: TOKEN_A, cost: 1, allowed: true, safe: true }],
    memory: {},
    candidateHistory: [
      {
        runId: 'run-small',
        sequence: 2,
        proposal: { replacement: 'small fix' },
        candidateOutcome: { candidateDigest: 'sha256:small', token: TOKEN_A, status: 'APPLIED' },
      },
      {
        runId: 'run-large',
        sequence: 2,
        proposal: { replacement: 'x'.repeat(12_000) },
        proposalDigest: `sha256:${'a'.repeat(64)}`,
        candidateOutcome: { candidateDigest: 'sha256:large', token: TOKEN_A, status: 'APPLIED' },
      },
    ],
  });
  const context = JSON.parse(prompt.split('\n').at(-1));
  assert.deepEqual(context.candidateHistory[0].proposal, { replacement: 'small fix' });
  assert.equal(context.candidateHistory[1].proposal, undefined);
  assert.equal(context.candidateHistory[1].proposalDigest, `sha256:${'a'.repeat(64)}`);
  assert.equal(context.candidateHistory[1].proposalTruncated, true);
});

test('model advisor keeps many large candidate proposals below the prompt history budget', () => {
  const prompt = buildDecisionPrompt({
    capabilities: [{ token: TOKEN_A, cost: 1, allowed: true, safe: true }],
    memory: {},
    candidateHistory: Array.from({ length: 32 }, (_, index) => ({
      runId: `run-${index}`,
      sequence: 2,
      proposal: { replacement: 'x'.repeat(8_000) },
      candidateOutcome: { candidateDigest: `sha256:${'a'.repeat(64)}`, token: TOKEN_A, status: 'APPLIED' },
    })),
  });
  const context = JSON.parse(prompt.split('\n').at(-1));
  assert.equal(context.candidateHistoryTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(context.candidateHistory), 'utf8') <= 32 * 1024);
  assert.ok(Buffer.byteLength(prompt, 'utf8') < 128 * 1024);
});

test('model advisor preserves a bounded proposal as untrusted action data', async () => {
  const proposal = { schemaVersion: 1, targetPath: 'src/math.mjs', replacement: 'export const value = 2;\n' };
  const advisor = createModelAdvisor({
    model: 'model-proposal',
    client: {
      async chat() {
        return { model: 'model-proposal', content: JSON.stringify({ token: TOKEN_A, proposal }) };
      },
    },
  });
  const result = await advisor({
    observation: { vector: [1], stateVersion: 'state-1', intervalId: 'interval-1' },
    capabilities: [{ token: TOKEN_A, cost: 1, allowed: true, safe: true }],
    memory: {},
  });
  assert.deepEqual(result.proposal, proposal);
  assert.equal(result.token, TOKEN_A);
});

test('model advisor rejects an oversized action proposal before it reaches the kernel', async () => {
  const advisor = createModelAdvisor({
    model: 'model-oversized-proposal',
    client: {
      async chat() {
        return {
          model: 'model-oversized-proposal',
          content: JSON.stringify({ token: TOKEN_A, proposal: { replacement: 'x'.repeat(MAX_MODEL_PROPOSAL_BYTES) } }),
        };
      },
    },
  });
  const result = await advisor({
    observation: { vector: [1], stateVersion: 'state-1', intervalId: 'interval-1' },
    capabilities: [{ token: TOKEN_A, cost: 1, allowed: true, safe: true }],
    memory: {},
  });
  assert.equal(result.token, null);
  assert.equal(result.reason, 'INVALID_MODEL_OUTPUT');
  assert.equal(Object.hasOwn(result, 'proposal'), false);
});

test('model advisor bounds oversized observation evidence and marks the projection', async () => {
  let prompt;
  const advisor = createModelAdvisor({
    model: 'model-bounded-evidence',
    client: {
      async chat(value) {
        prompt = value;
        return { model: 'model-bounded-evidence', content: 'not json' };
      },
    },
  });
  await advisor({
    observation: { vector: [1], stateVersion: 'state-1', intervalId: 'interval-1' },
    observationEvidence: [{ kind: 'large', payload: 'x'.repeat(10_000) }],
    capabilities: [],
    memory: { actionModels: {} },
  });
  assert.match(prompt, /observationEvidenceTruncated":true/u);
  assert.ok(prompt.length < 32_000);
});

test('model advisor preserves an upstream truncation marker and ignores prototype keys', async () => {
  let prompt;
  const advisor = createModelAdvisor({
    model: 'model-boundary',
    client: {
      async chat(value) {
        prompt = value;
        return { model: 'model-boundary', content: 'not json' };
      },
    },
  });
  const evidence = JSON.parse('[{"kind":"signal","__proto__":{"polluted":true}}]');
  await advisor({
    observation: { vector: [1], stateVersion: 'state-1', intervalId: 'interval-1' },
    observationEvidence: evidence,
    observationEvidenceTruncated: true,
    capabilities: [],
    memory: {},
  });
  assert.match(prompt, /observationEvidenceTruncated":true/u);
  assert.equal(Object.prototype.polluted, undefined);
});

test('model advisor digest matches JSON context for sparse arrays', async () => {
  let prompt;
  const advisor = createModelAdvisor({
    model: 'model-sparse',
    client: {
      async chat(value) {
        prompt = value;
        return { model: 'model-sparse', content: 'not json' };
      },
    },
  });
  const sparse = new Array(2);
  sparse[1] = 'value';
  const result = await advisor({
    observation: { vector: [1], stateVersion: 'state-1', intervalId: 'interval-1' },
    observationEvidence: [{ kind: 'signal', sparse }],
    capabilities: [],
    memory: {},
  });
  assert.match(prompt, /"sparse":\[null,"value"\]/u);
  assert.equal(
    result.observationDigest,
    projectModelObservation(
      { vector: [1], stateVersion: 'state-1', intervalId: 'interval-1' },
      [{ kind: 'signal', sparse: [null, 'value'] }],
      true,
    ).digest,
  );
});

test('model advisor materializes sparse top-level evidence before hashing', async () => {
  let prompt;
  const advisor = createModelAdvisor({
    model: 'model-sparse-top-level',
    client: {
      async chat(value) {
        prompt = value;
        return { model: 'model-sparse-top-level', content: 'not json' };
      },
    },
  });
  const evidence = new Array(2);
  evidence[1] = { kind: 'signal' };
  const result = await advisor({
    observation: { vector: [1], stateVersion: 'state-1', intervalId: 'interval-1' },
    observationEvidence: evidence,
    capabilities: [],
    memory: {},
  });
  assert.match(prompt, /observationEvidence":\[null,\{"kind":"signal"\}\]/u);
  assert.equal(
    result.observationDigest,
    projectModelObservation(
      { vector: [1], stateVersion: 'state-1', intervalId: 'interval-1' },
      [null, { kind: 'signal' }],
      true,
    ).digest,
  );
});

test('decision prompt builder applies the same evidence boundary as the advisor', () => {
  const prompt = buildDecisionPrompt({
    observation: { vector: [1], stateVersion: 'state-1', intervalId: 'interval-1' },
    observationEvidence: [{ kind: 'large', payload: 'x'.repeat(10_000) }],
    capabilities: [],
    memory: {},
  });
  assert.match(prompt, /observationEvidenceTruncated":true/u);
  assert.ok(prompt.length < 32_000);
});

test('invalid model output becomes an explicit kernel fallback proposal', async () => {
  const advisor = createModelAdvisor({
    model: 'model-1',
    client: { async chat() { return { model: 'model-1', content: 'I choose something' }; } },
  });
  const result = await advisor({ capabilities: [], memory: {} });
  assert.deepEqual({ token: result.token, reason: result.reason }, { token: null, reason: 'INVALID_MODEL_OUTPUT' });
});
