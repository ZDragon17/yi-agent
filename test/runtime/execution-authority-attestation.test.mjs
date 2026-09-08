import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import {
  signExecutionAuthorityReceipt,
  verifyExecutionAuthorityReceipt,
} from '../../src/runtime/execution-authority-attestation.mjs';

test('execution authority attestation binds the complete receipt to its signing key', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const { publicKey: otherPublicKey } = generateKeyPairSync('ed25519');
  const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const otherPublicKeyBase64 = otherPublicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const receipt = {
    schemaVersion: 1,
    status: 'EXECUTED',
    executionNonce: 'execution:step:1',
    token: 'tok_ABCDEFGH',
    basedOnVersion: 'state:idempotent-transition:0',
    beforeStateDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    afterStateDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  };

  const signed = signExecutionAuthorityReceipt(receipt, privateKey);
  assert.equal(verifyExecutionAuthorityReceipt(signed, publicKeyBase64), true);
  assert.equal(verifyExecutionAuthorityReceipt({ ...signed, token: 'tok_IJKLMNOP' }, publicKeyBase64), false);
  assert.equal(verifyExecutionAuthorityReceipt(signed, otherPublicKeyBase64), false);
});
