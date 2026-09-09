import { createPublicKey, sign, verify as verifySignature } from 'node:crypto';
import { SCHEMA_VERSION, canonicalDigest, canonicalJson } from './schema.mjs';
import { isValidEvidencePublicKey } from './external-evidence.mjs';

const ATTESTATION_TYPE = 'world-reconciliation-v1';
const ALGORITHM = 'ed25519-v1';
const MAX_SIGNATURE_LENGTH = 8192;

export function signReconciliationAttestation({ worldId, scenario, state, request, status, transition }, privateKey) {
  if (privateKey === null || privateKey === undefined) {
    throw new TypeError('Reconciliation signing key is required.');
  }
  const unsigned = reconciliationUnsigned({ worldId, scenario, state, request, status, transition });
  const digest = canonicalDigest(unsigned);
  const signature = sign(
    null,
    Buffer.from(canonicalJson({ ...unsigned, digest }), 'utf8'),
    privateKey,
  ).toString('base64');
  return {
    schemaVersion: SCHEMA_VERSION,
    type: ATTESTATION_TYPE,
    algorithm: ALGORITHM,
    requestDigest: unsigned.requestDigest,
    resultDigest: unsigned.resultDigest,
    digest,
    signature,
  };
}

export function verifyReconciliationAttestation({ attestation, publicKey, worldId, scenario, state, request, status, transition }) {
  if (!isValidEvidencePublicKey(publicKey) || !isPlainObject(attestation)) return false;
  if (Object.keys(attestation).some((key) => ![
    'schemaVersion', 'type', 'algorithm', 'requestDigest', 'resultDigest', 'digest', 'signature',
  ].includes(key)) ||
      attestation.schemaVersion !== SCHEMA_VERSION ||
      attestation.type !== ATTESTATION_TYPE ||
      attestation.algorithm !== ALGORITHM ||
      typeof attestation.digest !== 'string' ||
      typeof attestation.requestDigest !== 'string' ||
      typeof attestation.resultDigest !== 'string' ||
      typeof attestation.signature !== 'string' ||
      attestation.signature.length === 0 ||
      attestation.signature.length > MAX_SIGNATURE_LENGTH ||
      !isBase64(attestation.signature)) {
    return false;
  }
  try {
    const unsigned = reconciliationUnsigned({ worldId, scenario, state, request, status, transition });
    if (attestation.requestDigest !== unsigned.requestDigest ||
        attestation.resultDigest !== unsigned.resultDigest ||
        attestation.digest !== canonicalDigest(unsigned)) return false;
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return verifySignature(
      null,
      Buffer.from(canonicalJson({ ...unsigned, digest: attestation.digest }), 'utf8'),
      key,
      Buffer.from(attestation.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

export function reconciliationUnsigned({ worldId, scenario, state, request, status, transition }) {
  const result = {
    status,
    ...(transition === undefined ? {} : { transition: projectTransition(transition) }),
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    type: ATTESTATION_TYPE,
    algorithm: ALGORITHM,
    worldId,
    scenario,
    state,
    request,
    ...result,
    requestDigest: canonicalDigest({ worldId, scenario, state, request }),
    resultDigest: canonicalDigest(result),
  };
}

function projectTransition(transition) {
  if (!isPlainObject(transition) || !isPlainObject(transition.postObservation)) return transition;
  return { ...transition, postObservation: projectObservation(transition.postObservation) };
}

function projectObservation(observation) {
  const projected = {
    schemaVersion: observation.schemaVersion,
    vector: [...observation.vector],
    stateVersion: observation.stateVersion,
    intervalId: observation.intervalId,
  };
  if (observation.feedback !== undefined) {
    projected.feedback = observation.feedback.map((item) => ({
      schemaVersion: item.schemaVersion,
      executionNonce: item.executionNonce,
      stateVersion: item.stateVersion,
      intervalId: item.intervalId,
      vector: [...item.vector],
      confounderCount: item.confounderCount,
      ...(item.creditChain === undefined ? {} : {
        creditChain: {
          schemaVersion: item.creditChain.schemaVersion,
          ...(item.creditChain.basis === undefined ? {} : { basis: item.creditChain.basis }),
          ...(item.creditChain.attestation === undefined ? {} : {
            attestation: {
              schemaVersion: item.creditChain.attestation.schemaVersion,
              digest: item.creditChain.attestation.digest,
              attestation: item.creditChain.attestation.attestation,
            },
          }),
          ...(item.creditChain.independentAttestation === undefined ? {} : {
            independentAttestation: {
              schemaVersion: item.creditChain.independentAttestation.schemaVersion,
              digest: item.creditChain.independentAttestation.digest,
              attestation: item.creditChain.independentAttestation.attestation,
            },
          }),
          members: item.creditChain.members.map((member) => ({
            executionNonce: member.executionNonce,
            ...(item.creditChain.basis === undefined
              ? { share: member.share }
              : { delta: [...member.delta] }),
          })),
        },
      }),
    }));
  }
  return projected;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isBase64(value) {
  try {
    const bytes = Buffer.from(value, 'base64');
    return bytes.length > 0 && bytes.length <= MAX_SIGNATURE_LENGTH && bytes.toString('base64') === value;
  } catch {
    return false;
  }
}
