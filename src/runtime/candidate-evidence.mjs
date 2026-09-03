import { candidateDigest, SCHEMA_VERSION } from './schema.mjs';

export function candidateDigestForPolicy(policyEvidence) {
  return policyEvidence.candidateDigest ?? candidateDigest(policyEvidence);
}

export function buildCandidateOutcome(policyEvidence, receipt, verification) {
  const base = {
    schemaVersion: SCHEMA_VERSION,
    candidateDigest: candidateDigestForPolicy(policyEvidence),
    token: policyEvidence.token ?? null,
  };
  if (policyEvidence.applied !== true) {
    return {
      ...base,
      status: 'NOT_APPLIED',
      reason: policyEvidence.reason ?? 'NOT_APPLIED',
    };
  }
  return {
    ...base,
    status: 'APPLIED',
    receiptStatus: receipt.status,
    verification: {
      error: [...verification.error],
      attribution: verification.attribution,
      confidence: verification.confidence,
      learnable: verification.learnable,
    },
  };
}

export function isValidCandidateOutcome(value, policyEvidence) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      policyEvidence === null || typeof policyEvidence !== 'object' || Array.isArray(policyEvidence) ||
      value.schemaVersion !== SCHEMA_VERSION ||
      typeof value.candidateDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.candidateDigest) ||
      value.candidateDigest !== candidateDigestForPolicy(policyEvidence) ||
      value.token !== (policyEvidence.token ?? null) ||
      !['APPLIED', 'NOT_APPLIED'].includes(value.status)) return false;
  if (value.status === 'NOT_APPLIED') {
    return typeof value.reason === 'string' && value.reason.length > 0 && value.reason.length <= 256 &&
      value.reason === (policyEvidence.reason ?? 'NOT_APPLIED');
  }
  const verification = value.verification;
  return typeof value.receiptStatus === 'string' && value.receiptStatus.length > 0 && value.receiptStatus.length <= 256 &&
    verification !== null && typeof verification === 'object' && !Array.isArray(verification) &&
    Array.isArray(verification.error) && verification.error.every((item) => Number.isFinite(item)) &&
    ['ACTION', 'AMBIGUOUS', 'EXECUTION_REJECTED'].includes(verification.attribution) &&
    Number.isFinite(verification.confidence) && verification.confidence >= 0 && verification.confidence <= 1 &&
    typeof verification.learnable === 'boolean';
}
