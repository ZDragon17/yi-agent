import { canonicalDigest, canonicalJson, SCHEMA_VERSION } from '../runtime/schema.mjs';

const MAX_EVIDENCE_ITEMS = 32;
const MAX_EVIDENCE_DEPTH = 8;
const MAX_EVIDENCE_KEYS = 64;
const MAX_EVIDENCE_ARRAY_ITEMS = 64;
const MAX_EVIDENCE_STRING_LENGTH = 2048;
const MAX_CONTEXT_BYTES = 32 * 1024;

export function projectModelObservation(observation, evidence = undefined, evidenceTruncated = false) {
  const source = observation === null || typeof observation !== 'object' || Array.isArray(observation)
    ? {}
    : observation;
  const rawEvidence = evidence ?? source.evidence ?? [];
  const state = { truncated: evidenceTruncated === true };
  const boundedEvidence = Array.isArray(rawEvidence)
    ? boundArray(rawEvidence, 0, state, MAX_EVIDENCE_ITEMS)
    : [];
  if (!Array.isArray(rawEvidence)) state.truncated = true;

  const context = {
    schemaVersion: SCHEMA_VERSION,
    observation: {
      schemaVersion: Number.isSafeInteger(source.schemaVersion) ? source.schemaVersion : null,
      vector: Array.isArray(source.vector)
        ? Array.from(source.vector, (value) => {
            if (Number.isFinite(value)) return value;
            state.truncated = true;
            return null;
          })
        : [],
      stateVersion: typeof source.stateVersion === 'string' ? source.stateVersion : null,
      intervalId: typeof source.intervalId === 'string' ? source.intervalId : null,
    },
    observationEvidence: boundedEvidence,
    observationEvidenceTruncated: state.truncated,
  };
  if (byteLength(context) > MAX_CONTEXT_BYTES) {
    context.observationEvidence = [];
    context.observationEvidenceTruncated = true;
  }
  return {
    ...context,
    digest: canonicalDigest(context),
  };
}

function boundValue(value, depth, state) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && value.length > MAX_EVIDENCE_STRING_LENGTH) {
      state.truncated = true;
      return `${value.slice(0, MAX_EVIDENCE_STRING_LENGTH)}…[truncated]`;
    }
    return value;
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    state.truncated = true;
    return null;
  }
  if (depth >= MAX_EVIDENCE_DEPTH || value === undefined || typeof value !== 'object') {
    state.truncated = true;
    return '[omitted:bounded-observation]';
  }
  if (Array.isArray(value)) {
    return boundArray(value, depth + 1, state, MAX_EVIDENCE_ARRAY_ITEMS);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    state.truncated = true;
    return '[omitted:non-data-observation]';
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort();
  const result = Object.create(null);
  if (keys.length > MAX_EVIDENCE_KEYS) state.truncated = true;
  for (const key of keys.slice(0, MAX_EVIDENCE_KEYS)) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      state.truncated = true;
      continue;
    }
    result[key] = boundValue(descriptor.value, depth + 1, state);
  }
  return result;
}

function boundArray(value, depth, state, limit) {
  const result = [];
  for (let index = 0; index < Math.min(value.length, limit); index += 1) {
    if (index in value) {
      result.push(boundValue(value[index], depth, state));
    } else {
      state.truncated = true;
      result.push(null);
    }
  }
  if (value.length > limit) state.truncated = true;
  return result;
}

function byteLength(value) {
  return Buffer.byteLength(canonicalJson(value), 'utf8');
}
