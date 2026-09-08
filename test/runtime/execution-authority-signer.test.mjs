import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createExecutionAuthoritySigner } from '../../src/runtime/execution-authority-signer.mjs';
import { verifyExecutionAuthorityReceipt } from '../../src/runtime/execution-authority-attestation.mjs';

test('execution authority signer delegates receipt signing to a separate process', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-signer-'));
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyPath = path.join(root, 'private-key.der');
    await writeFile(privateKeyPath, privateKey.export({ format: 'der', type: 'pkcs8' }));
    const executionPublicKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const signer = createExecutionAuthoritySigner({
      executable: process.execPath,
      args: [
        path.resolve('bin/yi-agent-execution-signer.mjs'),
        '--private-key-der', privateKeyPath,
      ],
      timeoutMs: 5000,
    });
    const receipt = {
      schemaVersion: 1,
      status: 'EXECUTED',
      executionNonce: 'execution:step:1',
      token: 'tok_IDEMPOTENT',
      basedOnVersion: 'state:idempotent-transition:0',
      beforeStateDigest: `sha256:${'1'.repeat(64)}`,
      afterStateDigest: `sha256:${'2'.repeat(64)}`,
    };

    const executionAttestation = await signer.sign(receipt);

    assert.deepEqual(Object.keys(executionAttestation).sort(), ['digest', 'schemaVersion', 'signature', 'type']);
    assert.equal(
      verifyExecutionAuthorityReceipt({ ...receipt, executionAttestation }, executionPublicKey),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
