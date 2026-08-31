import { canonicalDigest } from '../runtime/schema.mjs';

const SCHEMA_VERSION = 1;
const MAX_PROMPT_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_GOAL_LENGTH = 4096;
const MAX_STAGES = 128;

export function createModelPlanner({ client, model } = {}) {
  if (client === null || typeof client?.chat !== 'function') {
    throw new Error('Model planner requires a chat client.');
  }

  return async function plan(input = {}) {
    const prompt = buildPlanningPrompt(input);
    const response = await client.chat(prompt);
    const modelName = response.model ?? model;
    const responseDigest = canonicalDigest({ model: modelName, content: response.content });
    const parsed = parsePlanProposal(response.content);
    return {
      schemaVersion: SCHEMA_VERSION,
      source: 'model',
      model: modelName,
      responseDigest,
      plan: parsed.plan,
      reason: parsed.reason,
    };
  };
}

export function buildPlanningPrompt({ goal = null, observation, valueSpec, memory, step = 0 } = {}) {
  const context = {
    goal: typeof goal === 'string' && goal.length > 0 ? goal : null,
    step,
    observation,
    valueSpec,
    memory: memorySummary(memory),
  };
  const prompt = [
    'You are a bounded goal planner inside yi-agent.',
    'Propose a short sequence of measurable intermediate objectives for the supplied goal.',
    'Do not propose actions, capabilities, tokens, code, or claims about the outside world.',
    'Use the same observation dimensions as valueSpec. Every objective must be finite and bounded.',
    'Return JSON only with exactly this shape: {"rootGoal":"...","stages":[{"id":"...","goal":"...","target":[...]}]}.',
    'The host validates the proposal and may reject it; a rejected proposal falls back to one bounded root stage.',
    JSON.stringify(context),
  ].join('\n');
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
    throw new Error('Model planning prompt exceeds the 128 KiB limit.');
  }
  return prompt;
}

export function parsePlanProposal(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_RESPONSE_BYTES) {
    return { plan: null, reason: 'INVALID_MODEL_OUTPUT' };
  }
  let source = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(source);
  if (fenced) source = fenced[1];
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return { plan: null, reason: 'INVALID_MODEL_OUTPUT' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      !Array.isArray(value.stages) || value.stages.length < 1 || value.stages.length > MAX_STAGES ||
      (value.rootGoal !== undefined && (typeof value.rootGoal !== 'string' || value.rootGoal.length === 0 || value.rootGoal.length > MAX_GOAL_LENGTH))) {
    return { plan: null, reason: 'INVALID_MODEL_OUTPUT' };
  }
  return {
    plan: {
      ...(value.schemaVersion === undefined ? {} : { schemaVersion: value.schemaVersion }),
      ...(value.rootGoal === undefined ? {} : { rootGoal: value.rootGoal }),
      stages: value.stages,
    },
    reason: null,
  };
}

function memorySummary(memory) {
  const models = memory?.actionModels;
  const actionModels = models === null || typeof models !== 'object' || Array.isArray(models)
    ? {}
    : Object.fromEntries(Object.entries(models).slice(0, 128).map(([token, model]) => [token, {
    sampleCount: model.sampleCount,
    meanDelta: model.meanDelta,
    uncertainty: model.uncertainty,
    }]));
  const relationModels = memory?.relationModels;
  const relationContexts = relationModels === null || typeof relationModels !== 'object' || Array.isArray(relationModels)
    ? {}
    : Object.fromEntries(Object.entries(relationModels).slice(0, 128).map(([token, relations]) => [token, relations]));
  return { actionModels, relationContexts };
}
