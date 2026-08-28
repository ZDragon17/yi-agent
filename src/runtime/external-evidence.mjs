import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { canonicalDigest, canonicalJson } from './schema.mjs';

const MAX_PUBLIC_KEY_BYTES = 8192;
const MAX_SIGNATURE_BYTES = 8192;

export function externalInputUnsigned(value) {
  const { digest: _digest, attestation: _attestation, ...unsigned } = value;
  return unsigned;
}

export function externalInputSigningValue(value) {
  return { ...externalInputUnsigned(value), digest: value.digest };
}

export function verifyExternalInputDigest(value) {
  return value.digest === canonicalDigest(externalInputUnsigned(value));
}

export function isValidEvidencePublicKey(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PUBLIC_KEY_BYTES || !isBase64(value)) {
    return false;
  }
  try {
    const key = createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

export function verifyExternalInputAttestation(value, evidencePublicKey) {
  if (!isValidEvidencePublicKey(evidencePublicKey) ||
      typeof value?.attestation !== 'string' || value.attestation.length === 0 ||
      value.attestation.length > MAX_SIGNATURE_BYTES || !isBase64(value.attestation) ||
      !verifyExternalInputDigest(value)) {
    return false;
  }
  try {
    const key = createPublicKey({ key: Buffer.from(evidencePublicKey, 'base64'), format: 'der', type: 'spki' });
    return verifySignature(
      null,
      Buffer.from(canonicalJson(externalInputSigningValue(value)), 'utf8'),
      key,
      Buffer.from(value.attestation, 'base64'),
    );
  } catch {
    return false;
  }
}

function isBase64(value) {
  try {
    const bytes = Buffer.from(value, 'base64');
    return bytes.length > 0 && bytes.length <= MAX_PUBLIC_KEY_BYTES && bytes.toString('base64') === value;
  } catch {
    return false;
  }
}
