import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
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
  let serverStderr = '';
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
    server.stderr.on('data', (chunk) => { serverStderr += chunk; });
    await waitForFile(readyPath, () => serverStderr);
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

test('remote execution authority signer supports mutually authenticated TLS', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-remote-signer-tls-'));
  let server;
  let serverStderr = '';
  try {
    const privateKeyPath = path.join(root, 'private-key.der');
    const authTokenPath = path.join(root, 'auth-token.txt');
    const readyPath = path.join(root, 'ready.txt');
    const serverKey = path.join(root, 'server.key.pem');
    const serverCert = path.join(root, 'server.crt.pem');
    const clientKey = path.join(root, 'client.key.pem');
    const clientCert = path.join(root, 'client.crt.pem');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    await writeFile(privateKeyPath, privateKey.export({ format: 'der', type: 'pkcs8' }));
    await writeFile(authTokenPath, 'remote-signer-test-token-2026');
    await makeCertificate(serverKey, serverCert, 'localhost');
    await makeCertificate(clientKey, clientCert, 'yi-authority');
    server = spawn(process.execPath, [
      path.resolve('bin/yi-agent-execution-signer-server.mjs'),
      '--private-key-der', privateKeyPath,
      '--auth-token-file', authTokenPath,
      '--host', '127.0.0.1',
      '--port', '0',
      '--ready-file', readyPath,
      '--tls-cert-file', serverCert,
      '--tls-key-file', serverKey,
      '--tls-client-ca-file', clientCert,
    ], { windowsHide: true });
    server.stderr.on('data', (chunk) => { serverStderr += chunk; });
    await waitForFile(readyPath, () => serverStderr);
    const executionPublicKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const signer = createRemoteExecutionAuthoritySigner({
      host: '127.0.0.1',
      port: Number(await readFile(readyPath, 'utf8')),
      authToken: 'remote-signer-test-token-2026',
      tls: {
        cert: await readFile(clientCert),
        key: await readFile(clientKey),
        ca: await readFile(serverCert),
        servername: 'localhost',
      },
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
    assert.equal(verifyExecutionAuthorityReceipt({ ...receipt, executionAttestation }, executionPublicKey), true);
  } finally {
    if (server !== undefined) server.kill();
    await rm(root, { recursive: true, force: true });
  }
});

async function makeCertificate(keyPath, certPath, commonName) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const algorithm = derSequence([derOid([1, 2, 840, 113549, 1, 1, 11]), der(0x05, Buffer.alloc(0))]);
  const name = derSequence([
    derSet(derSequence([derOid([2, 5, 4, 3]), derString(commonName)])),
  ]);
  const now = new Date();
  const later = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tbs = derSequence([
    der(0xa0, derInteger(2)),
    derInteger(1),
    algorithm,
    name,
    derSequence([derUtcTime(now), derUtcTime(later)]),
    name,
    publicKey.export({ format: 'der', type: 'spki' }),
  ]);
  const signer = createSign('sha256');
  signer.update(tbs);
  const certificate = derSequence([tbs, algorithm, derBitString(signer.sign(privateKey))]);
  await writeFile(certPath, `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').match(/.{1,64}/gu).join('\n')}\n-----END CERTIFICATE-----\n`);
}

function der(tag, value) {
  return Buffer.concat([Buffer.from([tag]), derLength(value.length), value]);
}

function derSequence(items) {
  return der(0x30, Buffer.concat(items));
}

function derSet(value) {
  return der(0x31, value);
}

function derInteger(value) {
  const bytes = Buffer.from([value]);
  return der(0x02, bytes);
}

function derString(value) {
  return der(0x0c, Buffer.from(value, 'utf8'));
}

function derUtcTime(value) {
  const text = `${String(value.getUTCFullYear()).slice(-2)}${String(value.getUTCMonth() + 1).padStart(2, '0')}${String(value.getUTCDate()).padStart(2, '0')}${String(value.getUTCHours()).padStart(2, '0')}${String(value.getUTCMinutes()).padStart(2, '0')}${String(value.getUTCSeconds()).padStart(2, '0')}Z`;
  return der(0x17, Buffer.from(text, 'ascii'));
}

function derBitString(value) {
  return der(0x03, Buffer.concat([Buffer.from([0]), value]));
}

function derOid(arcs) {
  const bytes = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const encoded = [arc & 0x7f];
    let rest = arc >>> 7;
    while (rest > 0) {
      encoded.unshift((rest & 0x7f) | 0x80);
      rest >>>= 7;
    }
    bytes.push(...encoded);
  }
  return der(0x06, Buffer.from(bytes));
}

function derLength(length) {
  if (length < 128) return Buffer.from([length]);
  const bytes = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

async function waitForFile(filePath, getError = () => '') {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`remote signer did not become ready: ${getError()}`);
}
