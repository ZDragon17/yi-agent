import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createModelAdvisor } from '../../src/agent/model-advisor.mjs';

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
  assert.match(prompt, /保持稳定/u);
  assert.doesNotMatch(JSON.stringify(result), /temperature\.increase/u);
});

test('invalid model output becomes an explicit kernel fallback proposal', async () => {
  const advisor = createModelAdvisor({
    model: 'model-1',
    client: { async chat() { return { model: 'model-1', content: 'I choose something' }; } },
  });
  const result = await advisor({ capabilities: [], memory: {} });
  assert.deepEqual({ token: result.token, reason: result.reason }, { token: null, reason: 'INVALID_MODEL_OUTPUT' });
});
