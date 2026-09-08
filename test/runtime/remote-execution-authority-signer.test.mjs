import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRemoteExecutionAuthoritySigner } from '../../src/runtime/remote-execution-authority-signer.mjs';
import { verifyExecutionAuthorityReceipt } from '../../src/runtime/execution-authority-attestation.mjs';

test('remote execution authority signer serves a signed receipt over TCP', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-remote-signer-'));
  let server;
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyPath = path.join(root, 'private-key.der');
    const authTokenPath = path.join(root, 'auth-token.txt');
    const readyPath = path.join(root, 'ready.txt');
    await writeFile(privateKeyPath, privateKey.export({ format: 'der', type: 'pkcs8' }));
    await writeFile(authTokenPath, 'remote-signer-test-token-2026');
    const executionPublicKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    server = spawn(process.execPath, [
      path.resolve('bin/yi-agent-execution-signer-server.mjs'),
      '--private-key-der', privateKeyPath,
      '--auth-token-file', authTokenPath,
      '--host', '127.0.0.1',
      '--port', '0',
      '--ready-file', readyPath,
    ], { windowsHide: true });
    await waitForFile(readyPath);
    const port = Number(await readFile(readyPath, 'utf8'));
    const signer = createRemoteExecutionAuthoritySigner({ host: '127.0.0.1', port, authToken: 'remote-signer-test-token-2026', timeoutMs: 5000 });
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

    assert.equal(verifyExecutionAuthorityReceipt({ ...receipt, executionAttestation }, executionPublicKey), true);
  } finally {
    if (server !== undefined) server.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test('remote execution authority signer rejects an unauthenticated request', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-remote-signer-auth-'));
  let server;
  try {
    const { privateKey } = generateKeyPairSync('ed25519');
    const privateKeyPath = path.join(root, 'private-key.der');
    const authTokenPath = path.join(root, 'auth-token.txt');
    const readyPath = path.join(root, 'ready.txt');
    await writeFile(privateKeyPath, privateKey.export({ format: 'der', type: 'pkcs8' }));
    await writeFile(authTokenPath, 'remote-signer-test-token-2026');
    server = spawn(process.execPath, [
      path.resolve('bin/yi-agent-execution-signer-server.mjs'),
      '--private-key-der', privateKeyPath,
      '--auth-token-file', authTokenPath,
      '--host', '127.0.0.1',
      '--port', '0',
      '--ready-file', readyPath,
    ], { windowsHide: true });
    await waitForFile(readyPath);
    const signer = createRemoteExecutionAuthoritySigner({
      host: '127.0.0.1',
      port: Number(await readFile(readyPath, 'utf8')),
      authToken: 'wrong-token-2026-xxxxxxxx',
      timeoutMs: 5000,
    });

    await assert.rejects(signer.sign({ schemaVersion: 1 }), (error) => error.code === 'SIGNER_PROTOCOL');
  } finally {
    if (server !== undefined) server.kill();
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForFile(filePath) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error('remote signer did not become ready');
}
