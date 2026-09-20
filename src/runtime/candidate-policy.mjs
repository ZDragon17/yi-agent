import { canonicalDigest, canonicalJson } from './schema.mjs';
import { projectModelObservation } from '../agent/observation-context.mjs';

const SCHEMA_VERSION = 1;
const POLICY_TYPE = 'candidate-policy';
const POLICY_VERSION = 1;
const MAX_POLICY_RULES = 8;
const TOKEN_PATTERN = /^tok_[A-Z0-9]{8,128}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export function normalizeCandidatePolicy(input, allowedTokens, worldPort = null) {
  if (!isRecord(input) || input.schemaVersion !== SCHEMA_VERSION || input.type !== POLICY_TYPE ||
      input.version !== POLICY_VERSION || !(allowedTokens instanceof Set)) {
    throw policyError('Candidate policy has an invalid envelope.');
  }
  assertToken(input.defaultToken, allowedTokens, 'defaultToken');
  if (!Array.isArray(input.rules) || input.rules.length > MAX_POLICY_RULES) {
    throw policyError(`Candidate policy rules must contain 0 to ${MAX_POLICY_RULES} entries.`);
  }
  const binding = normalizeWorldPortBinding(input, worldPort);
  const seen = new Set();
  const rules = input.rules.map((rule, index) => {
    if (!isRecord(rule) || !DIGEST_PATTERN.test(rule.observationDigest ?? '')) {
      throw policyError(`Candidate policy rule ${index + 1} has an invalid observation digest.`);
    }
    if (seen.has(rule.observationDigest)) {
      throw policyError('Candidate policy cannot contain duplicate observation contexts.');
    }
    seen.add(rule.observationDigest);
    assertToken(rule.token, allowedTokens, `rules[${index}].token`);
    return { observationDigest: rule.observationDigest, token: rule.token };
  });
  rules.sort((left, right) => left.observationDigest.localeCompare(right.observationDigest));
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    type: POLICY_TYPE,
    version: POLICY_VERSION,
    ...(binding === null ? {} : binding),
    defaultToken: input.defaultToken,
    rules,
  };
  canonicalJson(normalized);
  return normalized;
}

function normalizeWorldPortBinding(input, worldPort) {
  const fields = ['worldId', 'worldVersion', 'worldImplementationDigest', 'tokenMapDigest'];
  const hasBinding = fields.some((field) => Object.hasOwn(input, field));
  if (!hasBinding) return null;
  const target = worldPort === null ? null : {
    worldId: worldPort.worldId,
    worldVersion: worldPort.worldVersion,
    worldImplementationDigest: worldPort.worldImplementationDigest,
    tokenMapDigest: worldPort.tokenMapDigest ?? worldPort.tokenMap?.digest,
  };
  const binding = {
    worldId: input.worldId,
    worldVersion: input.worldVersion,
    worldImplementationDigest: input.worldImplementationDigest,
    tokenMapDigest: input.tokenMapDigest,
  };
  if (typeof binding.worldId !== 'string' || binding.worldId.length === 0 ||
      typeof binding.worldVersion !== 'string' || binding.worldVersion.length === 0 ||
      !DIGEST_PATTERN.test(binding.worldImplementationDigest ?? '') ||
      !DIGEST_PATTERN.test(binding.tokenMapDigest ?? '')) {
    throw policyError('Candidate policy WorldPort identity is invalid.');
  }
  if (target !== null && (
    target.worldId !== binding.worldId ||
    target.worldVersion !== binding.worldVersion ||
    target.worldImplementationDigest !== binding.worldImplementationDigest ||
    target.tokenMapDigest !== binding.tokenMapDigest
  )) {
    throw policyError('Candidate policy WorldPort identity differs from the target lab.');
  }
  return binding;
}

export function createCandidatePolicyAdvisor(policy) {
  const normalized = isRecord(policy) ? policy : null;
  if (normalized === null || normalized.schemaVersion !== SCHEMA_VERSION ||
      normalized.type !== POLICY_TYPE || normalized.version !== POLICY_VERSION) {
    throw policyError('Candidate policy must be normalized before creating an advisor.');
  }
  const rules = new Map(normalized.rules.map((rule) => [rule.observationDigest, rule.token]));
  const policyDigest = canonicalDigest(normalized);
  return async ({ observation, observationEvidence, observationEvidenceTruncated } = {}) => {
    const modelObservation = projectModelObservation(observation, observationEvidence, observationEvidenceTruncated);
    const token = rules.get(modelObservation.digest) ?? normalized.defaultToken;
    return {
      schemaVersion: SCHEMA_VERSION,
      source: 'candidate-policy',
      model: 'candidate-policy-v1',
      token,
      observationDigest: modelObservation.digest,
      responseDigest: canonicalDigest({ policyDigest, observationDigest: modelObservation.digest, token }),
      reason: null,
    };
  };
}

function assertToken(value, allowedTokens, field) {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value) || !allowedTokens.has(value)) {
    throw policyError(`Candidate policy ${field} must reference an allowed parent token.`);
  }
}

function policyError(message) {
  return Object.assign(new Error(message), { code: 'INVALID_INPUT', context: { field: 'policy' } });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
