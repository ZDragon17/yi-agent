import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCertificateAuthority, makeCertificateSignedByAuthority } from '../fixtures/mutual-tls-certificate.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');
const ADAPTER = path.resolve('test/fixtures/idempotent-transition-world-adapter.mjs');
const SERVER = path.resolve('test/fixtures/tls-world-server.mjs');

test('TLS JSONL WorldPort runs across a remote process and Replay does not reconnect', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-remote-world-'));
  let server;
  try {
    const lab = path.join(root, 'lab');
    const effectFile = path.join(root, 'effect.json');
    const portFile = path.join(root, 'port.txt');
    const caKey = path.join(root, 'ca.key.pem');
    const caCert = path.join(root, 'ca.crt.pem');
    const serverKey = path.join(root, 'server.key.pem');
    const serverCert = path.join(root, 'server.crt.pem');
    const clientKey = path.join(root, 'client.key.pem');
    const clientCert = path.join(root, 'client.crt.pem');
    const untrustedCaKey = path.join(root, 'untrusted-ca.key.pem');
    const untrustedCaCert = path.join(root, 'untrusted-ca.crt.pem');
    const adapter = path.join(root, 'adapter.json');
    const authority = await createCertificateAuthority(caKey, caCert, 'yi-remote-world-ca');
    await createCertificateAuthority(untrustedCaKey, untrustedCaCert, 'yi-untrusted-world-ca');
    await makeCertificateSignedByAuthority(authority, serverKey, serverCert, 'localhost', 1);
    await makeCertificateSignedByAuthority(authority, clientKey, clientCert, 'yi-agent-cli', 2);
    server = spawn(process.execPath, [
      SERVER,
      '--adapter', ADAPTER,
      '--adapter-args-json', JSON.stringify(['--effect-file', effectFile]),
      '--port-file', portFile,
      '--tls-key-file', serverKey,
      '--tls-cert-file', serverCert,
      '--tls-client-ca-file', caCert,
    ], { windowsHide: true });
    await waitForFile(portFile);
    const port = Number(await readFile(portFile, 'utf8'));
    const adapterConfig = {
      transport: 'tls-jsonl',
      host: '127.0.0.1',
      port,
      tls: {
        certFile: clientCert,
        keyFile: clientKey,
        caFile: caCert,
        serverName: 'localhost',
      },
      adapterId: 'idempotent-transition-adapter-v1',
      worldId: 'idempotent-transition',
      timeoutMs: 5000,
    };
    await writeFile(adapter, JSON.stringify(adapterConfig));

    const init = await invoke(['init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'remote-world-seed', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    const run = await invoke(['run', '--lab', lab, '--run-id', 'remote-run', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);
    const untrustedAdapter = path.join(root, 'untrusted-adapter.json');
    await writeFile(untrustedAdapter, JSON.stringify({
      ...adapterConfig,
      tls: { ...adapterConfig.tls, caFile: untrustedCaCert },
    }));
    const rejected = await invoke(['init', '--lab', path.join(root, 'rejected-lab'), '--world', 'idempotent-transition', '--seed', 'untrusted-remote-world-seed', '--adapter', untrustedAdapter, '--json']);
    assert.notEqual(rejected.code, 0, JSON.stringify(rejected));
    assert.equal(rejected.json.error.code, 'WORLD_ADAPTER_PROTOCOL', JSON.stringify(rejected));
    server.kill();
    await waitForExit(server);
    const replay = await invoke(['replay', '--lab', lab, '--run', 'remote-run', '--adapter', adapter, '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.json.data.verdict, 'CONSISTENT');
  } finally {
    if (server !== undefined && server.exitCode === null) server.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test('TLS JSONL supports a remote reconciliation observer as a separate endpoint', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-remote-observer-'));
  const servers = [];
  try {
    const effectFile = path.join(root, 'effect.json');
    const caKey = path.join(root, 'ca.key.pem');
    const caCert = path.join(root, 'ca.crt.pem');
    const serverKey = path.join(root, 'server.key.pem');
    const serverCert = path.join(root, 'server.crt.pem');
    const clientKey = path.join(root, 'client.key.pem');
    const clientCert = path.join(root, 'client.crt.pem');
    const authority = await createCertificateAuthority(caKey, caCert, 'yi-remote-observer-ca');
    await makeCertificateSignedByAuthority(authority, serverKey, serverCert, 'localhost', 1);
    await makeCertificateSignedByAuthority(authority, clientKey, clientCert, 'yi-agent-cli', 2);
    const primary = await startRemoteServer(root, 'primary', [
      '--effect-file', effectFile, '--reconcilable',
    ], { serverKey, serverCert, caCert });
    const observer = await startRemoteServer(root, 'observer', [
      '--effect-file', effectFile, '--reconciliation-observer',
    ], { serverKey, serverCert, caCert });
    servers.push(primary.server, observer.server);
    const adapter = path.join(root, 'adapter.json');
    const connection = (port) => ({
      transport: 'tls-jsonl',
      host: '127.0.0.1',
      port,
      tls: { certFile: clientCert, keyFile: clientKey, caFile: caCert, serverName: 'localhost' },
    });
    await writeFile(adapter, JSON.stringify({
      ...connection(primary.port),
      adapterId: 'idempotent-transition-adapter-v1',
      worldId: 'idempotent-transition',
      timeoutMs: 5000,
      reconciliationObserver: {
        ...connection(observer.port),
        adapterId: 'idempotent-reconciliation-observer-v1',
        worldId: 'idempotent-transition',
        timeoutMs: 5000,
      },
    }));

    const init = await invoke(['init', '--lab', path.join(root, 'lab'), '--world', 'idempotent-transition', '--seed', 'remote-observer-seed', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    assert.equal(init.json.data.adapter.reconciliationObserver.transport, 'tls-jsonl');
  } finally {
    for (const server of servers) {
      if (server.exitCode === null) server.kill();
    }
    await Promise.all(servers.map(waitForExit));
    await rm(root, { recursive: true, force: true });
  }
});

async function invoke(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* assertion below includes raw output */ }
      resolve({ code, json, stdout, stderr });
    });
  });
}

async function waitForFile(filePath) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await readFile(filePath);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
}

async function startRemoteServer(root, name, adapterArgs, tlsFiles) {
  const portFile = path.join(root, `${name}-port.txt`);
  const server = spawn(process.execPath, [
    SERVER,
    '--adapter', ADAPTER,
    '--adapter-args-json', JSON.stringify(adapterArgs),
    '--port-file', portFile,
    '--tls-key-file', tlsFiles.serverKey,
    '--tls-cert-file', tlsFiles.serverCert,
    '--tls-client-ca-file', tlsFiles.caCert,
  ], { windowsHide: true });
  await waitForFile(portFile);
  return { server, port: Number(await readFile(portFile, 'utf8')) };
}
