import { createPublicKey, sign, verify } from 'node:crypto';
import { SCHEMA_VERSION, canonicalDigest, canonicalJson } from './schema.mjs';
import { isValidEvidencePublicKey } from './external-evidence.mjs';

const ATTESTATION_TYPE = 'execution-authority-v1';
const MAX_SIGNATURE_LENGTH = 8192;

export function signExecutionAuthorityReceipt(value, privateKey) {
  if (privateKey === null || privateKey === undefined) {
    throw new TypeError('Execution authority signing key is required.');
  }
  const unsigned = executionAuthorityUnsigned(value);
  const digest = canonicalDigest(unsigned);
  const attestation = {
    schemaVersion: SCHEMA_VERSION,
    type: ATTESTATION_TYPE,
    digest,
    signature: sign(null, Buffer.from(canonicalJson(signingValue(digest, unsigned)), 'utf8'), privateKey).toString('base64'),
  };
  return { ...unsigned, executionAttestation: attestation };
}

export function publicKeyForPrivateKey(privateKey) {
  return createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
}

export function verifyExecutionAuthorityReceipt(value, publicKey) {
  if (!isValidEvidencePublicKey(publicKey) || !isPlainObject(value)) return false;
  const attestation = value.executionAttestation;
  if (!isPlainObject(attestation) ||
      Object.keys(attestation).some((key) => !['schemaVersion', 'type', 'digest', 'signature'].includes(key)) ||
      attestation.schemaVersion !== SCHEMA_VERSION || attestation.type !== ATTESTATION_TYPE ||
      typeof attestation.digest !== 'string' || attestation.digest !== canonicalDigest(executionAuthorityUnsigned(value)) ||
      typeof attestation.signature !== 'string' || attestation.signature.length === 0 ||
      attestation.signature.length > MAX_SIGNATURE_LENGTH || !isBase64(attestation.signature)) {
    return false;
  }
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return verify(
      null,
      Buffer.from(canonicalJson(signingValue(attestation.digest, executionAuthorityUnsigned(value))), 'utf8'),
      key,
      Buffer.from(attestation.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

export function executionAuthorityUnsigned(value) {
  if (!isPlainObject(value)) return value;
  const { executionAttestation: _executionAttestation, ...unsigned } = value;
  return unsigned;
}

function signingValue(digest, payload) {
  return {
    schemaVersion: SCHEMA_VERSION,
    type: ATTESTATION_TYPE,
    digest,
    payload,
  };
}

function isBase64(value) {
  try {
    const bytes = Buffer.from(value, 'base64');
    return bytes.length > 0 && bytes.length <= MAX_SIGNATURE_LENGTH && bytes.toString('base64') === value;
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
