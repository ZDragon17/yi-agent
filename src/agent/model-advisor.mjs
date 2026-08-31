import { canonicalDigest } from '../runtime/schema.mjs';

const SCHEMA_VERSION = 1;
const TOKEN_PATTERN = /^tok_[A-Z0-9]{8,128}$/u;
const MAX_PROMPT_BYTES = 128 * 1024;
const MAX_MEMORY_MODELS = 128;

export function createModelAdvisor({ client, model, goal = null } = {}) {
  if (client === null || typeof client?.chat !== 'function') {
    throw new Error('Model advisor requires a chat client.');
  }

  return async function advise(input) {
    const prompt = buildDecisionPrompt({ ...input, goal: goal ?? input.goal ?? null });
    const response = await client.chat(prompt);
    const responseDigest = canonicalDigest({ model: response.model ?? model, content: response.content });
    const parsed = parseProposal(response.content);
    if (parsed.token === null) {
      return {
        schemaVersion: SCHEMA_VERSION,
        source: 'model',
        model: response.model ?? model,
        token: null,
        responseDigest,
        reason: parsed.reason,
      };
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      source: 'model',
      model: response.model ?? model,
      token: parsed.token,
      responseDigest,
      reason: null,
    };
  };
}

export function buildDecisionPrompt({ observation, memory, valueSpec, capabilities, manifest, step = 0, goal = null } = {}) {
  const capabilityIds = new Map((manifest?.tokenMap?.entries ?? []).map((entry) => [entry.token, entry.capabilityId]));
  const context = {
    goal: typeof goal === 'string' && goal.length > 0 ? goal : null,
    step,
    observation,
    valueSpec,
    capabilities: Array.isArray(capabilities)
      ? capabilities.map((capability) => ({
          token: capability.token,
          capabilityId: capabilityIds.get(capability.token) ?? null,
          cost: capability.cost,
          allowed: capability.allowed,
          safe: capability.safe,
        }))
      : [],
    memory: memorySummary(memory),
  };
  const prompt = [
    'You are a bounded action proposer inside yi-agent.',
    'Choose one token only from capabilities. Never invent a token.',
    'The host kernel independently recomputes predictions and rejects unsafe or disallowed choices.',
    'Return JSON only with exactly this shape: {"token":"tok_..."}.',
    JSON.stringify(context),
  ].join('\n');
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
    throw new Error('Model decision prompt exceeds the 128 KiB limit.');
  }
  return prompt;
}

function memorySummary(memory) {
  const models = memory?.actionModels;
  const actionModels = models === null || typeof models !== 'object' || Array.isArray(models)
    ? {}
    : Object.fromEntries(Object.entries(models).slice(0, MAX_MEMORY_MODELS).map(([token, model]) => [token, {
    sampleCount: model.sampleCount,
    meanDelta: model.meanDelta,
    uncertainty: model.uncertainty,
    }]));
  const relationModels = memory?.relationModels;
  const relationContexts = relationModels === null || typeof relationModels !== 'object' || Array.isArray(relationModels)
    ? {}
    : Object.fromEntries(Object.entries(relationModels).slice(0, MAX_MEMORY_MODELS).map(([token, relations]) => [token, relations]));
  return { actionModels, relationContexts };
}

function parseProposal(content) {
  if (typeof content !== 'string') return { token: null, reason: 'INVALID_MODEL_OUTPUT' };
  let source = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(source);
  if (fenced) source = fenced[1];
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return { token: null, reason: 'INVALID_MODEL_OUTPUT' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.token !== 'string' || !TOKEN_PATTERN.test(value.token)) {
    return { token: null, reason: 'INVALID_MODEL_OUTPUT' };
  }
  return { token: value.token, reason: null };
}
