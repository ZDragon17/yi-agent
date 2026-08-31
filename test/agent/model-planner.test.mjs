import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPlanningPrompt, createModelPlanner, parsePlanProposal } from '../../src/agent/model-planner.mjs';

test('model planner returns a bounded measurable proposal without action authority', async () => {
  let prompt;
  const planner = createModelPlanner({
    model: 'planner-1',
    client: {
      async chat(value) {
        prompt = value;
        return {
          model: 'planner-1',
          content: '```json\n{"rootGoal":"保持稳定","stages":[{"id":"approach","goal":"先接近","target":[1,2]}]}\n```',
        };
      },
    },
  });
  const result = await planner({
    goal: '保持稳定',
    observation: { vector: [0, 0], stateVersion: 'state-1', intervalId: 'interval-1' },
    valueSpec: { observationDimensions: 2, weights: [1, 1], target: [2, 2] },
    memory: { actionModels: {} },
  });
  assert.equal(result.plan.stages[0].target[0], 1);
  assert.match(result.responseDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(result.observationDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(prompt, /保持稳定/u);
  assert.doesNotMatch(JSON.stringify(result), /tok_/u);
});

test('model planner receives the same bounded observation evidence channel', async () => {
  let prompt;
  const planner = createModelPlanner({
    model: 'planner-evidence',
    client: {
      async chat(value) {
        prompt = value;
        return { model: 'planner-evidence', content: '{"stages":[{"id":"one","goal":"观察","target":[1]}]}' };
      },
    },
  });
  const result = await planner({
    goal: '保持稳定',
    observation: { vector: [0], stateVersion: 'state-1', intervalId: 'interval-1' },
    observationEvidence: [{ kind: 'signal', value: '变化边界已打开' }],
    valueSpec: { observationDimensions: 1, weights: [1], target: [2] },
    memory: { actionModels: {} },
  });
  assert.match(prompt, /变化边界已打开/u);
  assert.match(result.observationDigest, /^sha256:[0-9a-f]{64}$/u);
});

test('planning prompt builder applies the same evidence boundary as the planner', () => {
  const prompt = buildPlanningPrompt({
    goal: '保持稳定',
    observation: { vector: [0], stateVersion: 'state-1', intervalId: 'interval-1' },
    observationEvidence: [{ kind: 'large', payload: 'x'.repeat(10_000) }],
    valueSpec: { observationDimensions: 1, weights: [1], target: [2] },
    memory: {},
  });
  assert.match(prompt, /observationEvidenceTruncated":true/u);
  assert.ok(prompt.length < 32_000);
});

test('invalid planner output is rejected as a proposal rather than treated as a plan', () => {
  assert.deepEqual(parsePlanProposal('not json'), { plan: null, reason: 'INVALID_MODEL_OUTPUT' });
  assert.deepEqual(parsePlanProposal('{"stages":[]}'), { plan: null, reason: 'INVALID_MODEL_OUTPUT' });
});
