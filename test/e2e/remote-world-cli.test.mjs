import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  createCertificateAuthority,
  makeCertificateRevocationList,
  makeCertificateSignedByAuthority,
} from '../fixtures/mutual-tls-certificate.mjs';

const CLI = path.resolve('bin/yi-agent.mjs');
const ADAPTER = path.resolve('test/fixtures/idempotent-transition-world-adapter.mjs');
const SERVER = path.resolve('test/fixtures/tls-world-server.mjs');
const exitedChildren = new WeakSet();

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

test('TLS JSONL rejects a delayed second response envelope', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-remote-protocol-'));
  const servers = [];
  try {
    const caKey = path.join(root, 'ca.key.pem');
    const caCert = path.join(root, 'ca.crt.pem');
    const serverKey = path.join(root, 'server.key.pem');
    const serverCert = path.join(root, 'server.crt.pem');
    const clientKey = path.join(root, 'client.key.pem');
    const clientCert = path.join(root, 'client.crt.pem');
    const effectFile = path.join(root, 'effect.json');
    const adapter = path.join(root, 'adapter.json');
    const authority = await createCertificateAuthority(caKey, caCert, 'yi-remote-protocol-ca');
    await makeCertificateSignedByAuthority(authority, serverKey, serverCert, 'localhost', 1);
    await makeCertificateSignedByAuthority(authority, clientKey, clientCert, 'yi-agent-cli', 2);
    const server = await startRemoteServer(root, 'extra-response', ['--effect-file', effectFile], {
      serverKey, serverCert, caCert,
    }, {
      extraResponseJson: JSON.stringify({ protocol: 'yi-world-cli', version: 1, id: 'extra', ok: true, result: {} }),
      extraResponseDelayMs: 25,
    });
    servers.push(server.server);
    await writeFile(adapter, JSON.stringify({
      transport: 'tls-jsonl',
      host: '127.0.0.1',
      port: server.port,
      tls: { certFile: clientCert, keyFile: clientKey, caFile: caCert, serverName: 'localhost' },
      adapterId: 'idempotent-transition-adapter-v1',
      worldId: 'idempotent-transition',
      timeoutMs: 5000,
    }));

    const init = await invoke(['init', '--lab', path.join(root, 'lab'), '--world', 'idempotent-transition', '--seed', 'remote-protocol-seed', '--adapter', adapter, '--json']);
    assert.notEqual(init.code, 0, JSON.stringify(init));
    assert.equal(init.json.error.code, 'WORLD_ADAPTER_PROTOCOL', JSON.stringify(init));
  } finally {
    await stopServers(servers);
    await rm(root, { recursive: true, force: true });
  }
});

test('TLS JSONL rejects a revoked remote server certificate before hello', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-remote-revocation-'));
  const servers = [];
  try {
    const caKey = path.join(root, 'ca.key.pem');
    const caCert = path.join(root, 'ca.crt.pem');
    const serverKey = path.join(root, 'server.key.pem');
    const serverCert = path.join(root, 'server.crt.pem');
    const clientKey = path.join(root, 'client.key.pem');
    const clientCert = path.join(root, 'client.crt.pem');
    const crlFile = path.join(root, 'server.crl.pem');
    const effectFile = path.join(root, 'effect.json');
    const adapter = path.join(root, 'adapter.json');
    const authority = await createCertificateAuthority(caKey, caCert, 'yi-remote-revocation-ca');
    await makeCertificateSignedByAuthority(authority, serverKey, serverCert, 'localhost', 1);
    await makeCertificateSignedByAuthority(authority, clientKey, clientCert, 'yi-agent-cli', 2);
    await makeCertificateRevocationList(authority, crlFile, [1]);
    const server = await startRemoteServer(root, 'revoked-server', ['--effect-file', effectFile], {
      serverKey, serverCert, caCert,
    });
    servers.push(server.server);
    await writeFile(adapter, JSON.stringify({
      transport: 'tls-jsonl',
      host: '127.0.0.1',
      port: server.port,
      tls: {
        certFile: clientCert,
        keyFile: clientKey,
        caFile: caCert,
        crlFile,
        serverName: 'localhost',
      },
      adapterId: 'idempotent-transition-adapter-v1',
      worldId: 'idempotent-transition',
      timeoutMs: 5000,
    }));

    const init = await invoke(['init', '--lab', path.join(root, 'lab'), '--world', 'idempotent-transition', '--seed', 'remote-revocation-seed', '--adapter', adapter, '--json']);
    assert.notEqual(init.code, 0, JSON.stringify(init));
    assert.equal(init.json.error.code, 'WORLD_ADAPTER_PROTOCOL', JSON.stringify(init));
  } finally {
    await stopServers(servers);
    await rm(root, { recursive: true, force: true });
  }
});

test('TLS JSONL rotates the remote CA with a pre-authorized trust bundle', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-remote-ca-rotation-'));
  const servers = [];
  try {
    const lab = path.join(root, 'lab');
    const effectFile = path.join(root, 'effect.json');
    const caKey = path.join(root, 'ca-1.key.pem');
    const caCert = path.join(root, 'ca-1.crt.pem');
    const nextCaKey = path.join(root, 'ca-2.key.pem');
    const nextCaCert = path.join(root, 'ca-2.crt.pem');
    const untrustedCaKey = path.join(root, 'ca-3.key.pem');
    const untrustedCaCert = path.join(root, 'ca-3.crt.pem');
    const trustBundle = path.join(root, 'trusted-ca-bundle.crt.pem');
    const serverKey = path.join(root, 'server.key.pem');
    const serverCert = path.join(root, 'server.crt.pem');
    const rotatedServerKey = path.join(root, 'server-rotated.key.pem');
    const rotatedServerCert = path.join(root, 'server-rotated.crt.pem');
    const untrustedServerKey = path.join(root, 'server-untrusted.key.pem');
    const untrustedServerCert = path.join(root, 'server-untrusted.crt.pem');
    const clientKey = path.join(root, 'client.key.pem');
    const clientCert = path.join(root, 'client.crt.pem');
    const adapter = path.join(root, 'adapter.json');
    const authority = await createCertificateAuthority(caKey, caCert, 'yi-remote-ca-1');
    const nextAuthority = await createCertificateAuthority(nextCaKey, nextCaCert, 'yi-remote-ca-2');
    const untrustedAuthority = await createCertificateAuthority(untrustedCaKey, untrustedCaCert, 'yi-remote-ca-3');
    await makeCertificateSignedByAuthority(authority, serverKey, serverCert, 'localhost', 1);
    await makeCertificateSignedByAuthority(nextAuthority, rotatedServerKey, rotatedServerCert, 'localhost', 2);
    await makeCertificateSignedByAuthority(untrustedAuthority, untrustedServerKey, untrustedServerCert, 'localhost', 3);
    await makeCertificateSignedByAuthority(authority, clientKey, clientCert, 'yi-agent-cli', 4);
    await writeFile(trustBundle, `${await readFile(caCert, 'utf8')}${await readFile(nextCaCert, 'utf8')}`);

    const serverArgs = ['--effect-file', effectFile, '--non-idempotent', '--reconcilable', '--both-safe'];
    const primary = await startRemoteServer(root, 'primary', serverArgs, {
      serverKey,
      serverCert,
      caCert,
    });
    servers.push(primary.server);
    const connection = (port) => ({
      transport: 'tls-jsonl',
      host: '127.0.0.1',
      port,
      tls: { certFile: clientCert, keyFile: clientKey, caFile: trustBundle, serverName: 'localhost' },
    });
    await writeFile(adapter, JSON.stringify({
      ...connection(primary.port),
      adapterId: 'idempotent-transition-adapter-v1',
      worldId: 'idempotent-transition',
      timeoutMs: 5000,
    }));

    const init = await invoke(['init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'remote-ca-rotation-seed', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    const first = await invoke(['run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
    assert.equal(first.code, 0, JSON.stringify(first));
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);

    const primaryExit = waitForExit(primary.server);
    primary.server.kill();
    await primaryExit;
    const rotated = await startRemoteServer(root, 'primary-rotated', serverArgs, {
      serverKey: rotatedServerKey,
      serverCert: rotatedServerCert,
      caCert,
    }, { port: primary.port });
    servers[0] = rotated.server;

    const second = await invoke(['run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
    assert.equal(second.code, 0, JSON.stringify(second));
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 2, 'the rotated CA must preserve a new remote transition');

    const rotatedExit = waitForExit(rotated.server);
    rotated.server.kill();
    await rotatedExit;
    const untrusted = await startRemoteServer(root, 'primary-untrusted', serverArgs, {
      serverKey: untrustedServerKey,
      serverCert: untrustedServerCert,
      caCert,
    }, { port: primary.port });
    servers[0] = untrusted.server;
    const rejected = await invoke(['run', '--lab', lab, '--run-id', 'run-3', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
    assert.notEqual(rejected.code, 0, 'a server certificate signed by an unlisted CA must be rejected');
    assert.equal(rejected.json.error.code, 'WORLD_ADAPTER_PROTOCOL', JSON.stringify(rejected));
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 2, 'TLS rejection must happen before a third transition');

    await stopServers(servers);
    const replay = await invoke(['replay', '--lab', lab, '--run', 'run-2', '--adapter', adapter, '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.json.data.verdict, 'CONSISTENT');
  } finally {
    await stopServers(servers);
    await rm(root, { recursive: true, force: true });
  }
});

test('TLS JSONL rejects a revoked client certificate before hello', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-remote-client-revocation-'));
  const servers = [];
  try {
    const caKey = path.join(root, 'ca.key.pem');
    const caCert = path.join(root, 'ca.crt.pem');
    const serverKey = path.join(root, 'server.key.pem');
    const serverCert = path.join(root, 'server.crt.pem');
    const clientKey = path.join(root, 'client.key.pem');
    const clientCert = path.join(root, 'client.crt.pem');
    const crlFile = path.join(root, 'client.crl.pem');
    const effectFile = path.join(root, 'effect.json');
    const adapter = path.join(root, 'adapter.json');
    const authority = await createCertificateAuthority(caKey, caCert, 'yi-remote-client-revocation-ca');
    await makeCertificateSignedByAuthority(authority, serverKey, serverCert, 'localhost', 1);
    await makeCertificateSignedByAuthority(authority, clientKey, clientCert, 'yi-agent-cli', 2);
    await makeCertificateRevocationList(authority, crlFile, [2]);
    const server = await startRemoteServer(root, 'revoked-client-server', ['--effect-file', effectFile], {
      serverKey,
      serverCert,
      caCert,
    }, { clientCrlFile: crlFile });
    servers.push(server.server);
    await writeFile(adapter, JSON.stringify({
      transport: 'tls-jsonl',
      host: '127.0.0.1',
      port: server.port,
      tls: { certFile: clientCert, keyFile: clientKey, caFile: caCert, serverName: 'localhost' },
      adapterId: 'idempotent-transition-adapter-v1',
      worldId: 'idempotent-transition',
      timeoutMs: 5000,
    }));

    const init = await invoke(['init', '--lab', path.join(root, 'lab'), '--world', 'idempotent-transition', '--seed', 'remote-client-revocation-seed', '--adapter', adapter, '--json']);
    assert.notEqual(init.code, 0, JSON.stringify(init));
    assert.equal(init.json.error.code, 'WORLD_ADAPTER_PROTOCOL', JSON.stringify(init));
  } finally {
    await stopServers(servers);
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
    await stopServers(servers);
    await rm(root, { recursive: true, force: true });
  }
});

test('TLS JSONL recovers a non-idempotent effect after the remote WorldPort restarts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-remote-recovery-'));
  const servers = [];
  try {
    const lab = path.join(root, 'lab');
    const effectFile = path.join(root, 'effect.json');
    const caKey = path.join(root, 'ca.key.pem');
    const caCert = path.join(root, 'ca.crt.pem');
    const serverKey = path.join(root, 'server.key.pem');
    const serverCert = path.join(root, 'server.crt.pem');
    const clientKey = path.join(root, 'client.key.pem');
    const clientCert = path.join(root, 'client.crt.pem');
    const rotatedServerKey = path.join(root, 'server-rotated.key.pem');
    const rotatedServerCert = path.join(root, 'server-rotated.crt.pem');
    const authority = await createCertificateAuthority(caKey, caCert, 'yi-remote-recovery-ca');
    await makeCertificateSignedByAuthority(authority, serverKey, serverCert, 'localhost', 1);
    await makeCertificateSignedByAuthority(authority, clientKey, clientCert, 'yi-agent-cli', 2);
    const primaryArgs = ['--effect-file', effectFile, '--non-idempotent', '--reconcilable', '--drop-response'];
    const observerArgs = ['--effect-file', effectFile, '--reconciliation-observer'];
    const tlsFiles = { serverKey, serverCert, caCert };
    await makeCertificateSignedByAuthority(authority, rotatedServerKey, rotatedServerCert, 'localhost', 3);
    const primary = await startRemoteServer(root, 'primary', primaryArgs, tlsFiles);
    const observer = await startRemoteServer(root, 'observer', observerArgs, tlsFiles);
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

    const init = await invoke(['init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'remote-recovery-seed', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    const lost = await invoke([
      'agent', 'run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--scenario', 'idempotent',
      '--adapter', adapter, '--kernel-only', '--goal', '完成一个可恢复远程目标', '--json',
    ]);
    assert.notEqual(lost.code, 0, 'the remote primary must lose the first transition response');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, JSON.stringify(lost));

    const primaryExit = waitForExit(primary.server);
    primary.server.kill();
    await primaryExit;
    const restartedPrimary = await startRemoteServer(root, 'primary-restarted', [
      '--effect-file', effectFile, '--non-idempotent', '--reconcilable',
    ], { ...tlsFiles, serverKey: rotatedServerKey, serverCert: rotatedServerCert }, { port: primary.port });
    servers[0] = restartedPrimary.server;

    const resumed = await invoke(['run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(resumed.json.data.status, 'COMPLETED');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, 'remote recovery must not execute the non-idempotent effect again');

    await stopServers(servers);
    const replay = await invoke(['replay', '--lab', lab, '--run', 'run-2', '--adapter', adapter, '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.json.data.verdict, 'CONSISTENT');
  } finally {
    await stopServers(servers);
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
  if (exitedChildren.has(child) || child.exitCode !== null || child.signalCode !== null) {
    exitedChildren.add(child);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => {
      exitedChildren.add(child);
      resolve();
    });
  });
}

async function stopServers(servers) {
  const exits = servers.map(waitForExit);
  for (const server of servers) {
    if (server.exitCode === null) server.kill();
  }
  await Promise.all(exits);
}

async function startRemoteServer(root, name, adapterArgs, tlsFiles, options = {}) {
  return startRemoteServerWithOptions(root, name, adapterArgs, tlsFiles, options);
}

async function startRemoteServerWithOptions(root, name, adapterArgs, tlsFiles, {
  port = 0,
  extraResponseJson,
  extraResponseDelayMs,
  clientCrlFile,
} = {}) {
  const portFile = path.join(root, `${name}-port.txt`);
  const server = spawn(process.execPath, [
    SERVER,
    '--adapter', ADAPTER,
    '--adapter-args-json', JSON.stringify(adapterArgs),
    '--port-file', portFile,
    '--tls-key-file', tlsFiles.serverKey,
    '--tls-cert-file', tlsFiles.serverCert,
    '--tls-client-ca-file', tlsFiles.caCert,
    '--port', String(port),
    ...(clientCrlFile === undefined ? [] : ['--tls-client-crl-file', clientCrlFile]),
    ...(extraResponseJson === undefined ? [] : ['--extra-response-json', extraResponseJson]),
    ...(extraResponseDelayMs === undefined ? [] : ['--extra-response-delay-ms', String(extraResponseDelayMs)]),
  ], { windowsHide: true });
  await waitForFile(portFile);
  return { server, port: Number(await readFile(portFile, 'utf8')) };
}
