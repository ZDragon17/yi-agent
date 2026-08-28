import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { canonicalDigest, canonicalJson } from '../../src/runtime/schema.mjs';

const PRIVATE_SEED_HEX = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const PUBLIC_KEY_HEX = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const PRIVATE_KEY_PREFIX_HEX = '302e020100300506032b657004220420';
const PUBLIC_KEY_PREFIX_HEX = '302a300506032b6570032100';

export const ED25519_PUBLIC_KEY = Buffer.from(`${PUBLIC_KEY_PREFIX_HEX}${PUBLIC_KEY_HEX}`, 'hex').toString('base64');

const privateKey = createPrivateKey({
  key: Buffer.from(`${PRIVATE_KEY_PREFIX_HEX}${PRIVATE_SEED_HEX}`, 'hex'),
  format: 'der',
  type: 'pkcs8',
});
const publicKey = createPublicKey({
  key: Buffer.from(`${PUBLIC_KEY_PREFIX_HEX}${PUBLIC_KEY_HEX}`, 'hex'),
  format: 'der',
  type: 'spki',
});

export function attestationFor(value) {
  const { digest: _digest, attestation: _attestation, ...base } = value;
  const digest = canonicalDigest(base);
  return sign(null, Buffer.from(canonicalJson({ ...base, digest }), 'utf8'), privateKey).toString('base64');
}

export function verifyAttestation(value, attestation) {
  const { digest: _digest, attestation: _currentAttestation, ...base } = value;
  const digest = canonicalDigest(base);
  if (value.digest !== undefined && value.digest !== digest) return false;
  if (typeof attestation !== 'string') return false;
  return verify(
    null,
    Buffer.from(canonicalJson({ ...base, digest }), 'utf8'),
    publicKey,
    Buffer.from(attestation, 'base64'),
  );
}
