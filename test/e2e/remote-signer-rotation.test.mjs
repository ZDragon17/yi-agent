import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { canonicalDigest } from '../../src/runtime/schema.mjs';
import { ED25519_PUBLIC_KEY } from '../fixtures/ed25519-proof.mjs';
import {
  createCertificateAuthority,
  makeCertificateSignedByAuthority,
} from '../fixtures/mutual-tls-certificate.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');
const AUTHORITY = path.resolve('bin/yi-agent-effect-authority.mjs');
const SIGNER_SERVER = path.resolve('bin/yi-agent-execution-signer-server.mjs');
const ADAPTER_FIXTURE = path.resolve('test/fixtures/idempotent-transition-world-adapter.mjs');

test('mTLS signer certificate rotation preserves chained authority and observer recovery', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-signer-rotation-'));
  let signer;
  try {
    const lab = path.join(root, 'lab');
    const effectFile = path.join(root, 'primary-effect.json');
    const sandboxRoot = path.join(root, 'sandbox');
    const journalPath = path.join(sandboxRoot, 'effects.jsonl');
    const privateKeyPath = path.join(root, 'execution-private-key.der');
    const authTokenPath = path.join(root, 'signer-auth-token.txt');
    const readyPath = path.join(root, 'signer-ready.txt');
    const signerDropMarker = path.join(root, 'signer-drop.marker');
    const observerDropMarker = path.join(root, 'observer-drop.marker');
    const serverKey1 = path.join(root, 'server-1.key.pem');
    const serverCert1 = path.join(root, 'server-1.crt.pem');
    const serverKey2 = path.join(root, 'server-2.key.pem');
    const serverCert2 = path.join(root, 'server-2.crt.pem');
    const clientKey = path.join(root, 'client.key.pem');
    const clientCert = path.join(root, 'client.crt.pem');
    const caKey = path.join(root, 'test-ca.key.pem');
    const caCert = path.join(root, 'test-ca.crt.pem');
    const markerName = `${canonicalDigest('execution:step:1').slice('sha256:'.length)}.marker`;
    await mkdir(path.join(sandboxRoot, 'pending'), { recursive: true });
    await mkdir(path.join(sandboxRoot, 'applied'), { recursive: true });
    await writeFile(path.join(sandboxRoot, '.yi-agent-sandbox'), 'yi-agent-sandbox-v1\n', 'utf8');
    await writeFile(path.join(sandboxRoot, 'pending', markerName), 'execution:step:1', 'utf8');

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    await writeFile(privateKeyPath, privateKey.export({ format: 'der', type: 'pkcs8' }));
    await writeFile(authTokenPath, 'remote-signer-rotation-token-2026');
    const authority = await createCertificateAuthority(caKey, caCert, 'yi-test-ca');
    await makeCertificateSignedByAuthority(authority, serverKey1, serverCert1, 'localhost', 1);
    await makeCertificateSignedByAuthority(authority, serverKey2, serverCert2, 'localhost', 2);
    await makeCertificateSignedByAuthority(authority, clientKey, clientCert, 'yi-authority', 3);
    const executionPublicKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

    signer = startSigner({
      privateKeyPath,
      authTokenPath,
      serverKeyPath: serverKey1,
      serverCertPath: serverCert1,
      clientCaPath: caCert,
      readyPath,
      port: 0,
      dropResponseMarker: signerDropMarker,
    });
    await waitForFile(readyPath);
    const signerPort = Number(await readFile(readyPath, 'utf8'));
    const descriptor = {
      adapterId: 'effect-broker-authority-v1',
      worldId: 'idempotent-transition',
      worldVersion: 'idempotent-transition-1',
      capabilityIds: ['idempotent-transition.advance'],
      scenarioIds: ['idempotent', 'alternate'],
      valueSpec: { schemaVersion: 1, observationDimensions: 1, weights: [1], target: [1] },
      evidencePublicKey: ED25519_PUBLIC_KEY,
      executionPublicKey,
      supportsStateDependentActions: true,
    };
    const effectPlan = {
      effectId: 'effect:os-marker:move',
      target: { operation: 'move', from: `pending/${markerName}`, to: `applied/${markerName}` },
      precondition: { sourceExists: true, destinationAbsent: true },
      risk: 'LOW',
      requiresConfirmation: false,
      reversible: true,
      compensation: { operation: 'move-back', from: `applied/${markerName}`, to: `pending/${markerName}` },
      afterStateDigest: canonicalDigest({
        schemaVersion: 1,
        stateVersion: 'state:idempotent-transition:1',
        revision: 1,
        value: 1,
        usedExecutionNonces: ['execution:step:1'],
      }),
    };
    const authorityArgs = [
      AUTHORITY,
      '--descriptor-json', JSON.stringify(descriptor),
      '--effect-plan-json', JSON.stringify(effectPlan),
      '--journal', journalPath,
      '--sandbox-root', sandboxRoot,
      '--signer-host', '127.0.0.1',
      '--signer-port', String(signerPort),
      '--signer-auth-token-file', authTokenPath,
      '--signer-tls-cert-file', clientCert,
      '--signer-tls-key-file', clientKey,
      '--signer-tls-ca-file', caCert,
      '--signer-tls-server-name', 'localhost',
    ];
    const adapter = path.join(root, 'adapter.json');
    await writeFile(adapter, JSON.stringify({
      executable: process.execPath,
      args: [ADAPTER_FIXTURE, '--effect-file', effectFile, '--skip-os-effect'],
      transport: 'persistent-jsonl',
      executionAuthority: {
        executable: process.execPath,
        args: authorityArgs,
        adapterId: descriptor.adapterId,
        worldId: descriptor.worldId,
        executionPublicKey,
        timeoutMs: 5000,
        transport: 'persistent-jsonl',
      },
      executionObserver: {
        executable: process.execPath,
        args: [ADAPTER_FIXTURE, '--effect-file', effectFile, '--execution-observer', '--observer-drop-marker', observerDropMarker],
        adapterId: 'idempotent-execution-observer-v1',
        worldId: descriptor.worldId,
        timeoutMs: 5000,
        transport: 'persistent-jsonl',
      },
      adapterId: 'idempotent-transition-adapter-v1',
      worldId: descriptor.worldId,
      timeoutMs: 5000,
    }));

    const init = await invoke(['init', '--lab', lab, '--world', descriptor.worldId, '--seed', 'signer-rotation-seed', '--lab-id', 'signer-rotation-lab', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));

    const authorityLost = await invoke(['run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
    assert.notEqual(authorityLost.code, 0, JSON.stringify(authorityLost));
    await waitForExit(signer);
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);
    assert.equal(await readFile(path.join(sandboxRoot, 'applied', markerName), 'utf8'), 'execution:step:1');

    await rm(readyPath, { force: true });
    signer = startSigner({
      privateKeyPath,
      authTokenPath,
      serverKeyPath: serverKey2,
      serverCertPath: serverCert2,
      clientCaPath: caCert,
      readyPath,
      port: signerPort,
    });
    await waitForFile(readyPath);

    const observerLost = await invoke(['run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
    assert.notEqual(observerLost.code, 0, JSON.stringify(observerLost));
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);
    assert.equal(await readFile(path.join(sandboxRoot, 'applied', markerName), 'utf8'), 'execution:step:1');

    const resumed = await invoke(['run', '--lab', lab, '--run-id', 'run-3', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);
    assert.equal(await readFile(path.join(sandboxRoot, 'applied', markerName), 'utf8'), 'execution:step:1');
    const replay = await invoke(['replay', '--lab', lab, '--run', 'run-3', '--adapter', adapter, '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.json.data.verdict, 'CONSISTENT');
  } finally {
    if (signer !== undefined) signer.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test('mTLS CA rotation changes both signer and client trust roots before nonce recovery', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-signer-ca-rotation-'));
  let signer;
  try {
    const lab = path.join(root, 'lab');
    const effectFile = path.join(root, 'primary-effect.json');
    const sandboxRoot = path.join(root, 'sandbox');
    const journalPath = path.join(sandboxRoot, 'effects.jsonl');
    const privateKeyPath = path.join(root, 'execution-private-key.der');
    const authTokenPath = path.join(root, 'signer-auth-token.txt');
    const readyPath = path.join(root, 'signer-ready.txt');
    const signerDropMarker = path.join(root, 'signer-drop.marker');
    const serverKey1 = path.join(root, 'server-1.key.pem');
    const serverCert1 = path.join(root, 'server-1.crt.pem');
    const serverKey2 = path.join(root, 'server-2.key.pem');
    const serverCert2 = path.join(root, 'server-2.crt.pem');
    const clientKey = path.join(root, 'client.key.pem');
    const clientCert = path.join(root, 'client.crt.pem');
    const caKey1 = path.join(root, 'ca-1.key.pem');
    const caCert1 = path.join(root, 'ca-1.crt.pem');
    const caKey2 = path.join(root, 'ca-2.key.pem');
    const caCert2 = path.join(root, 'ca-2.crt.pem');
    const caBundle = path.join(root, 'ca-bundle.pem');
    const markerName = `${canonicalDigest('execution:step:1').slice('sha256:'.length)}.marker`;
    await mkdir(path.join(sandboxRoot, 'pending'), { recursive: true });
    await mkdir(path.join(sandboxRoot, 'applied'), { recursive: true });
    await writeFile(path.join(sandboxRoot, '.yi-agent-sandbox'), 'yi-agent-sandbox-v1\n', 'utf8');
    await writeFile(path.join(sandboxRoot, 'pending', markerName), 'execution:step:1', 'utf8');

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    await writeFile(privateKeyPath, privateKey.export({ format: 'der', type: 'pkcs8' }));
    await writeFile(authTokenPath, 'remote-signer-ca-rotation-token-2026');
    const firstAuthority = await createCertificateAuthority(caKey1, caCert1, 'yi-test-ca-1');
    const secondAuthority = await createCertificateAuthority(caKey2, caCert2, 'yi-test-ca-2');
    await makeCertificateSignedByAuthority(firstAuthority, serverKey1, serverCert1, 'localhost', 1);
    await makeCertificateSignedByAuthority(firstAuthority, clientKey, clientCert, 'yi-authority', 2);
    await writeFile(caBundle, `${await readFile(caCert1, 'utf8')}${await readFile(caCert2, 'utf8')}`, 'utf8');
    const executionPublicKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    signer = startSigner({
      privateKeyPath,
      authTokenPath,
      serverKeyPath: serverKey1,
      serverCertPath: serverCert1,
      clientCaPath: caCert1,
      readyPath,
      port: 0,
      dropResponseMarker: signerDropMarker,
    });
    await waitForFile(readyPath);
    const signerPort = Number(await readFile(readyPath, 'utf8'));
    const descriptor = {
      adapterId: 'effect-broker-authority-ca-rotation-v1',
      worldId: 'idempotent-transition',
      worldVersion: 'idempotent-transition-1',
      capabilityIds: ['idempotent-transition.advance'],
      scenarioIds: ['idempotent', 'alternate'],
      valueSpec: { schemaVersion: 1, observationDimensions: 1, weights: [1], target: [1] },
      evidencePublicKey: ED25519_PUBLIC_KEY,
      executionPublicKey,
      supportsStateDependentActions: true,
    };
    const effectPlan = {
      effectId: 'effect:os-marker:move',
      target: { operation: 'move', from: `pending/${markerName}`, to: `applied/${markerName}` },
      precondition: { sourceExists: true, destinationAbsent: true },
      risk: 'LOW',
      requiresConfirmation: false,
      reversible: true,
      compensation: { operation: 'move-back', from: `applied/${markerName}`, to: `pending/${markerName}` },
      afterStateDigest: canonicalDigest({
        schemaVersion: 1,
        stateVersion: 'state:idempotent-transition:1',
        revision: 1,
        value: 1,
        usedExecutionNonces: ['execution:step:1'],
      }),
    };
    const authorityArgs = [
      AUTHORITY,
      '--descriptor-json', JSON.stringify(descriptor),
      '--effect-plan-json', JSON.stringify(effectPlan),
      '--journal', journalPath,
      '--sandbox-root', sandboxRoot,
      '--signer-host', '127.0.0.1',
      '--signer-port', String(signerPort),
      '--signer-auth-token-file', authTokenPath,
      '--signer-tls-cert-file', clientCert,
      '--signer-tls-key-file', clientKey,
      '--signer-tls-ca-file', caBundle,
      '--signer-tls-server-name', 'localhost',
    ];
    const adapter = path.join(root, 'adapter.json');
    await writeFile(adapter, JSON.stringify({
      executable: process.execPath,
      args: [ADAPTER_FIXTURE, '--effect-file', effectFile, '--skip-os-effect'],
      executionAuthority: {
        executable: process.execPath,
        args: authorityArgs,
        adapterId: descriptor.adapterId,
        worldId: descriptor.worldId,
        executionPublicKey,
        timeoutMs: 5000,
      },
      executionObserver: {
        executable: process.execPath,
        args: [ADAPTER_FIXTURE, '--effect-file', effectFile, '--execution-observer'],
        adapterId: 'idempotent-execution-observer-v1',
        worldId: descriptor.worldId,
        timeoutMs: 5000,
      },
      adapterId: 'idempotent-transition-adapter-v1',
      worldId: descriptor.worldId,
      timeoutMs: 5000,
    }));

    const init = await invoke(['init', '--lab', lab, '--world', descriptor.worldId, '--seed', 'signer-ca-rotation-seed', '--lab-id', 'signer-ca-rotation-lab', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    const lost = await invoke(['run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
    assert.notEqual(lost.code, 0, JSON.stringify(lost));
    await waitForExit(signer);
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);

    await makeCertificateSignedByAuthority(secondAuthority, serverKey2, serverCert2, 'localhost', 3);
    await makeCertificateSignedByAuthority(secondAuthority, clientKey, clientCert, 'yi-authority', 4);
    await rm(readyPath, { force: true });
    signer = startSigner({
      privateKeyPath,
      authTokenPath,
      serverKeyPath: serverKey2,
      serverCertPath: serverCert2,
      clientCaPath: caCert2,
      readyPath,
      port: signerPort,
    });
    await waitForFile(readyPath);

    const resumed = await invoke(['run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);
    const replay = await invoke(['replay', '--lab', lab, '--run', 'run-2', '--adapter', adapter, '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.json.data.verdict, 'CONSISTENT');
  } finally {
    if (signer !== undefined) signer.kill();
    await rm(root, { recursive: true, force: true });
  }
});

function startSigner({ privateKeyPath, authTokenPath, serverKeyPath, serverCertPath, clientCaPath, readyPath, port, dropResponseMarker }) {
  const args = [
    SIGNER_SERVER,
    '--private-key-der', privateKeyPath,
    '--auth-token-file', authTokenPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--ready-file', readyPath,
    '--tls-cert-file', serverCertPath,
    '--tls-key-file', serverKeyPath,
    '--tls-client-ca-file', clientCaPath,
  ];
  if (dropResponseMarker !== undefined) args.push('--drop-response-once-marker', dropResponseMarker);
  return spawn(process.execPath, args, { windowsHide: true });
}

function invoke(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      let json = null;
      if (stdout.trim() !== '') {
        try { json = JSON.parse(stdout.trim()); } catch (error) {
          reject(new Error(`CLI output was not JSON: ${stdout}\n${stderr}`, { cause: error }));
          return;
        }
      }
      resolve({ code, stdout, stderr, json });
    });
  });
}

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
  throw new Error(`file did not appear: ${filePath}`);
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
}
