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

test('persistent TLS JSONL WorldPort reuses one mTLS session per CLI operation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-persistent-remote-world-'));
  const servers = [];
  try {
    const lab = path.join(root, 'lab');
    const effectFile = path.join(root, 'effect.json');
    const connectionCountFile = path.join(root, 'connections.log');
    const caKey = path.join(root, 'ca.key.pem');
    const caCert = path.join(root, 'ca.crt.pem');
    const serverKey = path.join(root, 'server.key.pem');
    const serverCert = path.join(root, 'server.crt.pem');
    const clientKey = path.join(root, 'client.key.pem');
    const clientCert = path.join(root, 'client.crt.pem');
    const authority = await createCertificateAuthority(caKey, caCert, 'yi-persistent-remote-world-ca');
    await makeCertificateSignedByAuthority(authority, serverKey, serverCert, 'localhost', 1);
    await makeCertificateSignedByAuthority(authority, clientKey, clientCert, 'yi-agent-cli', 2);
    const server = await startRemoteServer(root, 'persistent', ['--effect-file', effectFile], {
      serverKey, serverCert, caCert,
    }, { keepAlive: true, connectionCountFile });
    servers.push(server.server);
    const adapter = path.join(root, 'adapter.json');
    await writeFile(adapter, JSON.stringify({
      transport: 'persistent-tls-jsonl',
      host: '127.0.0.1',
      port: server.port,
      tls: { certFile: clientCert, keyFile: clientKey, caFile: caCert, serverName: 'localhost' },
      adapterId: 'idempotent-transition-adapter-v1',
      worldId: 'idempotent-transition',
      timeoutMs: 5000,
    }));

    const init = await invoke(['init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'persistent-remote-seed', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    assert.equal((await readFile(connectionCountFile, 'utf8')).trim().split(/\r?\n/u).length, 1, 'init must reuse one TLS session for hello and initialState');
    const run = await invoke(['run', '--lab', lab, '--run-id', 'persistent-remote-run', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal((await readFile(connectionCountFile, 'utf8')).trim().split(/\r?\n/u).length, 2, 'run must reuse one TLS session for its requests');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);
    await stopServers(servers);
    servers.length = 0;
    const replay = await invoke(['replay', '--lab', lab, '--run', 'persistent-remote-run', '--adapter', adapter, '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.json.data.verdict, 'CONSISTENT');
  } finally {
    await stopServers(servers);
    await rm(root, { recursive: true, force: true });
  }
});

test('persistent TLS JSONL reconnects after the remote peer closes a response', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-persistent-remote-reconnect-'));
  const servers = [];
  try {
    const lab = path.join(root, 'lab');
    const effectFile = path.join(root, 'effect.json');
    const connectionCountFile = path.join(root, 'connections.log');
    const caKey = path.join(root, 'ca.key.pem');
    const caCert = path.join(root, 'ca.crt.pem');
    const serverKey = path.join(root, 'server.key.pem');
    const serverCert = path.join(root, 'server.crt.pem');
    const clientKey = path.join(root, 'client.key.pem');
    const clientCert = path.join(root, 'client.crt.pem');
    const authority = await createCertificateAuthority(caKey, caCert, 'yi-persistent-remote-reconnect-ca');
    await makeCertificateSignedByAuthority(authority, serverKey, serverCert, 'localhost', 1);
    await makeCertificateSignedByAuthority(authority, clientKey, clientCert, 'yi-agent-cli', 2);
    const server = await startRemoteServer(root, 'reconnect', ['--effect-file', effectFile], {
      serverKey, serverCert, caCert,
    }, { connectionCountFile });
    servers.push(server.server);
    const adapter = path.join(root, 'adapter.json');
    await writeFile(adapter, JSON.stringify({
      transport: 'persistent-tls-jsonl',
      host: '127.0.0.1',
      port: server.port,
      tls: { certFile: clientCert, keyFile: clientKey, caFile: caCert, serverName: 'localhost' },
      adapterId: 'idempotent-transition-adapter-v1',
      worldId: 'idempotent-transition',
      timeoutMs: 5000,
    }));

    const init = await invoke(['init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'persistent-reconnect-seed', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    const run = await invoke(['run', '--lab', lab, '--run-id', 'persistent-reconnect-run', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.ok((await readFile(connectionCountFile, 'utf8')).trim().split(/\r?\n/u).length > 2, 'peer-closed responses must cause later requests to reconnect');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1);
    await stopServers(servers);
    servers.length = 0;
    const replay = await invoke(['replay', '--lab', lab, '--run', 'persistent-reconnect-run', '--adapter', adapter, '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.json.data.verdict, 'CONSISTENT');
  } finally {
    await stopServers(servers);
    await rm(root, { recursive: true, force: true });
  }
});

test('persistent TLS JSONL preserves non-idempotent recovery across remote restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-persistent-remote-recovery-'));
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
    const authority = await createCertificateAuthority(caKey, caCert, 'yi-persistent-remote-recovery-ca');
    await makeCertificateSignedByAuthority(authority, serverKey, serverCert, 'localhost', 1);
    await makeCertificateSignedByAuthority(authority, clientKey, clientCert, 'yi-agent-cli', 2);
    const primary = await startRemoteServer(root, 'persistent-recovery-primary', [
      '--effect-file', effectFile, '--non-idempotent', '--reconcilable', '--drop-response',
    ], { serverKey, serverCert, caCert });
    const observer = await startRemoteServer(root, 'persistent-recovery-observer', [
      '--effect-file', effectFile, '--reconciliation-observer',
    ], { serverKey, serverCert, caCert });
    servers.push(primary.server, observer.server);
    const adapter = path.join(root, 'adapter.json');
    const connection = (port) => ({
      transport: 'persistent-tls-jsonl',
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

    const init = await invoke(['init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'persistent-remote-recovery-seed', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    const lost = await invoke([
      'agent', 'run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--scenario', 'idempotent',
      '--adapter', adapter, '--kernel-only', '--goal', '验证持久远程恢复', '--json',
    ]);
    assert.notEqual(lost.code, 0, 'the persistent remote primary must lose the first transition response');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, JSON.stringify(lost));

    const primaryExit = waitForExit(primary.server);
    primary.server.kill();
    await primaryExit;
    const restartedPrimary = await startRemoteServer(root, 'persistent-recovery-primary-restarted', [
      '--effect-file', effectFile, '--non-idempotent', '--reconcilable',
    ], { serverKey, serverCert, caCert }, { port: primary.port });
    servers[0] = restartedPrimary.server;

    const resumed = await invoke(['run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(resumed.json.data.status, 'COMPLETED');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, 'persistent remote recovery must not execute the effect again');

    await stopServers(servers);
    const replay = await invoke(['replay', '--lab', lab, '--run', 'run-2', '--adapter', adapter, '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.json.data.verdict, 'CONSISTENT');
  } finally {
    await stopServers(servers);
    await rm(root, { recursive: true, force: true });
  }
});

test('persistent TLS JSONL preserves recovery when remote role certificates rotate', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-persistent-remote-cert-rotation-'));
  const servers = [];
  try {
    const lab = path.join(root, 'lab');
    const effectFile = path.join(root, 'effect.json');
    const caKey = path.join(root, 'ca.key.pem');
    const caCert = path.join(root, 'ca.crt.pem');
    const primaryKey = path.join(root, 'primary.key.pem');
    const primaryCert = path.join(root, 'primary.crt.pem');
    const observerKey = path.join(root, 'observer.key.pem');
    const observerCert = path.join(root, 'observer.crt.pem');
    const rotatedPrimaryKey = path.join(root, 'primary-rotated.key.pem');
    const rotatedPrimaryCert = path.join(root, 'primary-rotated.crt.pem');
    const rotatedObserverKey = path.join(root, 'observer-rotated.key.pem');
    const rotatedObserverCert = path.join(root, 'observer-rotated.crt.pem');
    const clientKey = path.join(root, 'client.key.pem');
    const clientCert = path.join(root, 'client.crt.pem');
    const authority = await createCertificateAuthority(caKey, caCert, 'yi-persistent-remote-cert-rotation-ca');
    await makeCertificateSignedByAuthority(authority, primaryKey, primaryCert, 'localhost', 1);
    await makeCertificateSignedByAuthority(authority, observerKey, observerCert, 'localhost', 2);
    await makeCertificateSignedByAuthority(authority, rotatedPrimaryKey, rotatedPrimaryCert, 'localhost', 3);
    await makeCertificateSignedByAuthority(authority, rotatedObserverKey, rotatedObserverCert, 'localhost', 4);
    await makeCertificateSignedByAuthority(authority, clientKey, clientCert, 'yi-agent-cli', 5);

    const primary = await startRemoteServer(root, 'persistent-cert-primary', [
      '--effect-file', effectFile, '--non-idempotent', '--reconcilable', '--drop-response',
    ], { serverKey: primaryKey, serverCert: primaryCert, caCert });
    const observer = await startRemoteServer(root, 'persistent-cert-observer', [
      '--effect-file', effectFile, '--reconciliation-observer',
    ], { serverKey: observerKey, serverCert: observerCert, caCert });
    servers.push(primary.server, observer.server);

    const adapter = path.join(root, 'adapter.json');
    const connection = (port) => ({
      transport: 'persistent-tls-jsonl',
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

    const init = await invoke(['init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'persistent-remote-cert-rotation-seed', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    const lost = await invoke([
      'agent', 'run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--scenario', 'idempotent',
      '--adapter', adapter, '--kernel-only', '--goal', '验证持久远程证书轮换后的恢复', '--json',
    ]);
    assert.notEqual(lost.code, 0, 'the persistent remote primary must lose the first transition response');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, JSON.stringify(lost));

    const primaryExit = waitForExit(primary.server);
    const observerExit = waitForExit(observer.server);
    primary.server.kill();
    observer.server.kill();
    await Promise.all([primaryExit, observerExit]);
    const restartedPrimary = await startRemoteServer(root, 'persistent-cert-primary-restarted', [
      '--effect-file', effectFile, '--non-idempotent', '--reconcilable',
    ], { serverKey: rotatedPrimaryKey, serverCert: rotatedPrimaryCert, caCert }, { port: primary.port });
    const restartedObserver = await startRemoteServer(root, 'persistent-cert-observer-restarted', [
      '--effect-file', effectFile, '--reconciliation-observer',
    ], { serverKey: rotatedObserverKey, serverCert: rotatedObserverCert, caCert }, { port: observer.port });
    servers[0] = restartedPrimary.server;
    servers[1] = restartedObserver.server;

    const resumed = await invoke(['run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(resumed.json.data.status, 'COMPLETED');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, 'persistent certificate rotation must not execute the effect again');

    await stopServers(servers);
    const replay = await invoke(['replay', '--lab', lab, '--run', 'run-2', '--adapter', adapter, '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.json.data.verdict, 'CONSISTENT');
  } finally {
    await stopServers(servers);
    await rm(root, { recursive: true, force: true });
  }
});

test('persistent TLS JSONL recovers an effect after a response timeout without replay', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-persistent-remote-timeout-'));
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
    const authority = await createCertificateAuthority(caKey, caCert, 'yi-persistent-remote-timeout-ca');
    await makeCertificateSignedByAuthority(authority, serverKey, serverCert, 'localhost', 1);
    await makeCertificateSignedByAuthority(authority, clientKey, clientCert, 'yi-agent-cli', 2);
    const primary = await startRemoteServer(root, 'persistent-timeout-primary', [
      '--effect-file', effectFile, '--non-idempotent', '--reconcilable',
    ], { serverKey, serverCert, caCert }, {
      keepAlive: true,
      delayResponseOp: 'transition',
      delayResponseMs: 1500,
    });
    const observer = await startRemoteServer(root, 'persistent-timeout-observer', [
      '--effect-file', effectFile, '--reconciliation-observer',
    ], { serverKey, serverCert, caCert }, { keepAlive: true });
    servers.push(primary.server, observer.server);
    const adapter = path.join(root, 'adapter.json');
    const connection = (port) => ({
      transport: 'persistent-tls-jsonl',
      host: '127.0.0.1',
      port,
      tls: { certFile: clientCert, keyFile: clientKey, caFile: caCert, serverName: 'localhost' },
    });
    await writeFile(adapter, JSON.stringify({
      ...connection(primary.port),
      adapterId: 'idempotent-transition-adapter-v1',
      worldId: 'idempotent-transition',
      timeoutMs: 500,
      reconciliationObserver: {
        ...connection(observer.port),
        adapterId: 'idempotent-reconciliation-observer-v1',
        worldId: 'idempotent-transition',
        timeoutMs: 500,
      },
    }));

    const init = await invoke(['init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'persistent-remote-timeout-seed', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    const timedOut = await invoke([
      'agent', 'run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--scenario', 'idempotent',
      '--adapter', adapter, '--kernel-only', '--goal', '验证持久远程超时后的恢复', '--json',
    ]);
    assert.notEqual(timedOut.code, 0, 'the delayed response must cross the persistent TLS timeout');
    assert.equal(timedOut.json?.error?.code, 'WORLD_ADAPTER_PROTOCOL', JSON.stringify(timedOut));
    assert.match(timedOut.json?.error?.message ?? '', /timed out/iu, JSON.stringify(timedOut));
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, JSON.stringify(timedOut));

    const resumed = await invoke(['run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(resumed.json.data.status, 'COMPLETED');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, 'a timeout must not cause the non-idempotent effect to run again');

    await stopServers(servers);
    const replay = await invoke(['replay', '--lab', lab, '--run', 'run-2', '--adapter', adapter, '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.json.data.verdict, 'CONSISTENT');
  } finally {
    await stopServers(servers);
    await rm(root, { recursive: true, force: true });
  }
});

test('persistent TLS JSONL recovers after a blackholed response without endpoint restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-persistent-remote-blackhole-'));
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
    const authority = await createCertificateAuthority(caKey, caCert, 'yi-persistent-remote-blackhole-ca');
    await makeCertificateSignedByAuthority(authority, serverKey, serverCert, 'localhost', 1);
    await makeCertificateSignedByAuthority(authority, clientKey, clientCert, 'yi-agent-cli', 2);
    const primary = await startRemoteServer(root, 'persistent-blackhole-primary', [
      '--effect-file', effectFile, '--non-idempotent', '--reconcilable',
    ], { serverKey, serverCert, caCert }, {
      keepAlive: true,
      blackholeResponseOp: 'transition',
    });
    const observer = await startRemoteServer(root, 'persistent-blackhole-observer', [
      '--effect-file', effectFile, '--reconciliation-observer',
    ], { serverKey, serverCert, caCert }, { keepAlive: true });
    servers.push(primary.server, observer.server);
    const adapter = path.join(root, 'adapter.json');
    const connection = (port) => ({
      transport: 'persistent-tls-jsonl',
      host: '127.0.0.1',
      port,
      tls: { certFile: clientCert, keyFile: clientKey, caFile: caCert, serverName: 'localhost' },
    });
    await writeFile(adapter, JSON.stringify({
      ...connection(primary.port),
      adapterId: 'idempotent-transition-adapter-v1',
      worldId: 'idempotent-transition',
      timeoutMs: 500,
      reconciliationObserver: {
        ...connection(observer.port),
        adapterId: 'idempotent-reconciliation-observer-v1',
        worldId: 'idempotent-transition',
        timeoutMs: 500,
      },
    }));

    const init = await invoke(['init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'persistent-remote-blackhole-seed', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    const timedOut = await invoke([
      'agent', 'run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--scenario', 'idempotent',
      '--adapter', adapter, '--kernel-only', '--goal', '验证持久远程黑洞后的恢复', '--json',
    ]);
    assert.notEqual(timedOut.code, 0, 'the blackholed response must cross the persistent TLS timeout');
    assert.equal(timedOut.json?.error?.code, 'WORLD_ADAPTER_PROTOCOL', JSON.stringify(timedOut));
    assert.match(timedOut.json?.error?.message ?? '', /timed out/iu, JSON.stringify(timedOut));
    assert.equal(primary.server.exitCode, null, 'the remote endpoint must remain online after the blackholed response');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, JSON.stringify(timedOut));

    const resumed = await invoke(['run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(resumed.json.data.status, 'COMPLETED');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, 'a blackholed response must not cause the non-idempotent effect to run again');

    await stopServers(servers);
    const replay = await invoke(['replay', '--lab', lab, '--run', 'run-2', '--adapter', adapter, '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.json.data.verdict, 'CONSISTENT');
  } finally {
    await stopServers(servers);
    await rm(root, { recursive: true, force: true });
  }
});

test('persistent TLS JSONL recovers after a connection reset without endpoint restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-persistent-remote-reset-'));
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
    const authority = await createCertificateAuthority(caKey, caCert, 'yi-persistent-remote-reset-ca');
    await makeCertificateSignedByAuthority(authority, serverKey, serverCert, 'localhost', 1);
    await makeCertificateSignedByAuthority(authority, clientKey, clientCert, 'yi-agent-cli', 2);
    const primary = await startRemoteServer(root, 'persistent-reset-primary', [
      '--effect-file', effectFile, '--non-idempotent', '--reconcilable',
    ], { serverKey, serverCert, caCert }, {
      keepAlive: true,
      resetResponseOp: 'transition',
    });
    const observer = await startRemoteServer(root, 'persistent-reset-observer', [
      '--effect-file', effectFile, '--reconciliation-observer',
    ], { serverKey, serverCert, caCert }, { keepAlive: true });
    servers.push(primary.server, observer.server);
    const adapter = path.join(root, 'adapter.json');
    const connection = (port) => ({
      transport: 'persistent-tls-jsonl',
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

    const init = await invoke(['init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'persistent-remote-reset-seed', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    const reset = await invoke([
      'agent', 'run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--scenario', 'idempotent',
      '--adapter', adapter, '--kernel-only', '--goal', '验证持久远程连接重置后的恢复', '--json',
    ]);
    assert.notEqual(reset.code, 0, JSON.stringify(reset));
    assert.equal(reset.json?.error?.code, 'WORLD_ADAPTER_PROTOCOL', JSON.stringify(reset));
    assert.match(reset.json?.error?.message ?? '', /connection|responding|reset/iu, JSON.stringify(reset));
    assert.equal(primary.server.exitCode, null, 'the remote endpoint must remain online after resetting one connection');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, JSON.stringify(reset));

    const resumed = await invoke(['run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(resumed.json.data.status, 'COMPLETED');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, 'a reset connection must not cause the non-idempotent effect to run again');

    await stopServers(servers);
    const replay = await invoke(['replay', '--lab', lab, '--run', 'run-2', '--adapter', adapter, '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.json.data.verdict, 'CONSISTENT');
  } finally {
    await stopServers(servers);
    await rm(root, { recursive: true, force: true });
  }
});

test('persistent TLS JSONL serializes concurrent recovery of one unresolved Run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-persistent-remote-concurrent-'));
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
    const authority = await createCertificateAuthority(caKey, caCert, 'yi-persistent-remote-concurrent-ca');
    await makeCertificateSignedByAuthority(authority, serverKey, serverCert, 'localhost', 1);
    await makeCertificateSignedByAuthority(authority, clientKey, clientCert, 'yi-agent-cli', 2);
    const primary = await startRemoteServer(root, 'persistent-concurrent-primary', [
      '--effect-file', effectFile, '--non-idempotent', '--reconcilable',
    ], { serverKey, serverCert, caCert }, {
      keepAlive: true,
      blackholeResponseOp: 'transition',
    });
    const observer = await startRemoteServer(root, 'persistent-concurrent-observer', [
      '--effect-file', effectFile, '--reconciliation-observer',
    ], { serverKey, serverCert, caCert }, { keepAlive: true });
    servers.push(primary.server, observer.server);
    const adapter = path.join(root, 'adapter.json');
    const connection = (port) => ({
      transport: 'persistent-tls-jsonl',
      host: '127.0.0.1',
      port,
      tls: { certFile: clientCert, keyFile: clientKey, caFile: caCert, serverName: 'localhost' },
    });
    await writeFile(adapter, JSON.stringify({
      ...connection(primary.port),
      adapterId: 'idempotent-transition-adapter-v1',
      worldId: 'idempotent-transition',
      timeoutMs: 500,
      reconciliationObserver: {
        ...connection(observer.port),
        adapterId: 'idempotent-reconciliation-observer-v1',
        worldId: 'idempotent-transition',
        timeoutMs: 500,
      },
    }));

    const init = await invoke(['init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'persistent-remote-concurrent-seed', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    const lost = await invoke([
      'agent', 'run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--scenario', 'idempotent',
      '--adapter', adapter, '--kernel-only', '--goal', '建立一个并发恢复未决点', '--json',
    ]);
    assert.notEqual(lost.code, 0, JSON.stringify(lost));
    assert.match(lost.json?.error?.message ?? '', /timed out/iu, JSON.stringify(lost));
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, JSON.stringify(lost));

    const resumes = await Promise.all([
      invoke(['run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']),
      invoke(['run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']),
    ]);
    assert.equal(resumes.filter((result) => result.code === 0 && result.json?.data?.status === 'COMPLETED').length, 1, JSON.stringify(resumes));
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, 'concurrent recovery must not execute the effect twice');
    assert.equal(await countSteps(lab, 'run-2'), 1, JSON.stringify(resumes));

    await stopServers(servers);
    const replay = await invoke(['replay', '--lab', lab, '--run', 'run-2', '--adapter', adapter, '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.json.data.verdict, 'CONSISTENT');
  } finally {
    await stopServers(servers);
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

test('TLS JSONL recovers when primary and observer restart with rotated certificates', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-remote-multi-recovery-'));
  const servers = [];
  try {
    const lab = path.join(root, 'lab');
    const effectFile = path.join(root, 'effect.json');
    const caKey = path.join(root, 'ca.key.pem');
    const caCert = path.join(root, 'ca.crt.pem');
    const primaryKey = path.join(root, 'primary.key.pem');
    const primaryCert = path.join(root, 'primary.crt.pem');
    const observerKey = path.join(root, 'observer.key.pem');
    const observerCert = path.join(root, 'observer.crt.pem');
    const rotatedPrimaryKey = path.join(root, 'primary-rotated.key.pem');
    const rotatedPrimaryCert = path.join(root, 'primary-rotated.crt.pem');
    const rotatedObserverKey = path.join(root, 'observer-rotated.key.pem');
    const rotatedObserverCert = path.join(root, 'observer-rotated.crt.pem');
    const clientKey = path.join(root, 'client.key.pem');
    const clientCert = path.join(root, 'client.crt.pem');
    const authority = await createCertificateAuthority(caKey, caCert, 'yi-remote-multi-recovery-ca');
    await makeCertificateSignedByAuthority(authority, primaryKey, primaryCert, 'localhost', 1);
    await makeCertificateSignedByAuthority(authority, observerKey, observerCert, 'localhost', 2);
    await makeCertificateSignedByAuthority(authority, rotatedPrimaryKey, rotatedPrimaryCert, 'localhost', 3);
    await makeCertificateSignedByAuthority(authority, rotatedObserverKey, rotatedObserverCert, 'localhost', 4);
    await makeCertificateSignedByAuthority(authority, clientKey, clientCert, 'yi-agent-cli', 5);

    const primaryArgs = ['--effect-file', effectFile, '--non-idempotent', '--reconcilable', '--drop-response'];
    const observerArgs = ['--effect-file', effectFile, '--reconciliation-observer'];
    const primary = await startRemoteServer(root, 'primary', primaryArgs, {
      serverKey: primaryKey,
      serverCert: primaryCert,
      caCert,
    });
    const observer = await startRemoteServer(root, 'observer', observerArgs, {
      serverKey: observerKey,
      serverCert: observerCert,
      caCert,
    });
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

    const init = await invoke(['init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'remote-multi-recovery-seed', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    const lost = await invoke([
      'agent', 'run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--scenario', 'idempotent',
      '--adapter', adapter, '--kernel-only', '--goal', '完成两个远程 WorldPort 的恢复', '--json',
    ]);
    assert.notEqual(lost.code, 0, 'the remote primary must lose the first transition response');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, JSON.stringify(lost));

    const primaryExit = waitForExit(primary.server);
    const observerExit = waitForExit(observer.server);
    primary.server.kill();
    observer.server.kill();
    await Promise.all([primaryExit, observerExit]);
    const restartedPrimary = await startRemoteServer(root, 'primary-restarted', [
      '--effect-file', effectFile, '--non-idempotent', '--reconcilable',
    ], {
      serverKey: rotatedPrimaryKey,
      serverCert: rotatedPrimaryCert,
      caCert,
    }, { port: primary.port });
    const restartedObserver = await startRemoteServer(root, 'observer-restarted', observerArgs, {
      serverKey: rotatedObserverKey,
      serverCert: rotatedObserverCert,
      caCert,
    }, { port: observer.port });
    servers[0] = restartedPrimary.server;
    servers[1] = restartedObserver.server;

    const resumed = await invoke(['run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(resumed.json.data.status, 'COMPLETED');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, 'multi-WorldPort recovery must not execute the effect again');

    await stopServers(servers);
    const replay = await invoke(['replay', '--lab', lab, '--run', 'run-2', '--adapter', adapter, '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.json.data.verdict, 'CONSISTENT');
  } finally {
    await stopServers(servers);
    await rm(root, { recursive: true, force: true });
  }
});

test('TLS JSONL preserves recovery across independently trusted remote roles', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-remote-role-trust-'));
  const servers = [];
  try {
    const lab = path.join(root, 'lab');
    const effectFile = path.join(root, 'effect.json');
    const clientCaKey = path.join(root, 'client-ca.key.pem');
    const clientCaCert = path.join(root, 'client-ca.crt.pem');
    const primaryCaKey = path.join(root, 'primary-ca.key.pem');
    const primaryCaCert = path.join(root, 'primary-ca.crt.pem');
    const observerCaKey = path.join(root, 'observer-ca.key.pem');
    const observerCaCert = path.join(root, 'observer-ca.crt.pem');
    const rotatedObserverCaKey = path.join(root, 'observer-ca-rotated.key.pem');
    const rotatedObserverCaCert = path.join(root, 'observer-ca-rotated.crt.pem');
    const observerTrustBundle = path.join(root, 'observer-trust-bundle.crt.pem');
    const primaryKey = path.join(root, 'primary.key.pem');
    const primaryCert = path.join(root, 'primary.crt.pem');
    const rotatedPrimaryKey = path.join(root, 'primary-rotated.key.pem');
    const rotatedPrimaryCert = path.join(root, 'primary-rotated.crt.pem');
    const observerKey = path.join(root, 'observer.key.pem');
    const observerCert = path.join(root, 'observer.crt.pem');
    const rotatedObserverKey = path.join(root, 'observer-rotated.key.pem');
    const rotatedObserverCert = path.join(root, 'observer-rotated.crt.pem');
    const clientKey = path.join(root, 'client.key.pem');
    const clientCert = path.join(root, 'client.crt.pem');
    const authority = await createCertificateAuthority(clientCaKey, clientCaCert, 'yi-remote-role-client-ca');
    const primaryAuthority = await createCertificateAuthority(primaryCaKey, primaryCaCert, 'yi-remote-role-primary-ca');
    const observerAuthority = await createCertificateAuthority(observerCaKey, observerCaCert, 'yi-remote-role-observer-ca');
    const rotatedObserverAuthority = await createCertificateAuthority(rotatedObserverCaKey, rotatedObserverCaCert, 'yi-remote-role-observer-ca-rotated');
    await makeCertificateSignedByAuthority(primaryAuthority, primaryKey, primaryCert, 'localhost', 1);
    await makeCertificateSignedByAuthority(primaryAuthority, rotatedPrimaryKey, rotatedPrimaryCert, 'localhost', 2);
    await makeCertificateSignedByAuthority(observerAuthority, observerKey, observerCert, 'localhost', 3);
    await makeCertificateSignedByAuthority(rotatedObserverAuthority, rotatedObserverKey, rotatedObserverCert, 'localhost', 4);
    await makeCertificateSignedByAuthority(authority, clientKey, clientCert, 'yi-agent-cli', 5);
    await writeFile(observerTrustBundle, `${await readFile(observerCaCert, 'utf8')}${await readFile(rotatedObserverCaCert, 'utf8')}`);

    const primaryArgs = ['--effect-file', effectFile, '--non-idempotent', '--reconcilable', '--drop-response'];
    const observerArgs = ['--effect-file', effectFile, '--reconciliation-observer'];
    const primary = await startRemoteServer(root, 'primary', primaryArgs, {
      serverKey: primaryKey,
      serverCert: primaryCert,
      caCert: primaryCaCert,
      clientCaCert,
    });
    const observer = await startRemoteServer(root, 'observer', observerArgs, {
      serverKey: observerKey,
      serverCert: observerCert,
      caCert: observerCaCert,
      clientCaCert,
    });
    servers.push(primary.server, observer.server);

    const adapter = path.join(root, 'adapter.json');
    const connection = (port, caFile) => ({
      transport: 'tls-jsonl',
      host: '127.0.0.1',
      port,
      tls: { certFile: clientCert, keyFile: clientKey, caFile, serverName: 'localhost' },
    });
    await writeFile(adapter, JSON.stringify({
      ...connection(primary.port, primaryCaCert),
      adapterId: 'idempotent-transition-adapter-v1',
      worldId: 'idempotent-transition',
      timeoutMs: 5000,
      reconciliationObserver: {
        ...connection(observer.port, observerTrustBundle),
        adapterId: 'idempotent-reconciliation-observer-v1',
        worldId: 'idempotent-transition',
        timeoutMs: 5000,
      },
    }));

    const init = await invoke(['init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'remote-role-trust-seed', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    const lost = await invoke([
      'agent', 'run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--scenario', 'idempotent',
      '--adapter', adapter, '--kernel-only', '--goal', '验证独立远程身份下的恢复', '--json',
    ]);
    assert.notEqual(lost.code, 0, 'the remote primary must lose the first transition response');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, JSON.stringify(lost));

    const primaryExit = waitForExit(primary.server);
    const observerExit = waitForExit(observer.server);
    primary.server.kill();
    observer.server.kill();
    await Promise.all([primaryExit, observerExit]);
    const restartedPrimary = await startRemoteServer(root, 'primary-restarted', [
      '--effect-file', effectFile, '--non-idempotent', '--reconcilable',
    ], {
      serverKey: rotatedPrimaryKey,
      serverCert: rotatedPrimaryCert,
      caCert: primaryCaCert,
      clientCaCert,
    }, { port: primary.port });
    const restartedObserver = await startRemoteServer(root, 'observer-restarted', observerArgs, {
      serverKey: rotatedObserverKey,
      serverCert: rotatedObserverCert,
      caCert: rotatedObserverCaCert,
      clientCaCert,
    }, { port: observer.port });
    servers[0] = restartedPrimary.server;
    servers[1] = restartedObserver.server;

    const resumed = await invoke(['run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(resumed.json.data.status, 'COMPLETED');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, 'independent role recovery must not execute the effect again');

    await stopServers(servers);
    const replay = await invoke(['replay', '--lab', lab, '--run', 'run-2', '--adapter', adapter, '--json']);
    assert.equal(replay.code, 0, JSON.stringify(replay));
    assert.equal(replay.json.data.verdict, 'CONSISTENT');
  } finally {
    await stopServers(servers);
    await rm(root, { recursive: true, force: true });
  }
});

test('TLS JSONL keeps recovery pending when the observer is unavailable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yi-agent-remote-observer-outage-'));
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
    const authority = await createCertificateAuthority(caKey, caCert, 'yi-remote-observer-outage-ca');
    await makeCertificateSignedByAuthority(authority, serverKey, serverCert, 'localhost', 1);
    await makeCertificateSignedByAuthority(authority, clientKey, clientCert, 'yi-agent-cli', 2);

    const primary = await startRemoteServer(root, 'primary', [
      '--effect-file', effectFile, '--non-idempotent', '--reconcilable', '--drop-response',
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
      timeoutMs: 1000,
      reconciliationObserver: {
        ...connection(observer.port),
        adapterId: 'idempotent-reconciliation-observer-v1',
        worldId: 'idempotent-transition',
        timeoutMs: 1000,
      },
    }));

    const init = await invoke(['init', '--lab', lab, '--world', 'idempotent-transition', '--seed', 'remote-observer-outage-seed', '--adapter', adapter, '--json']);
    assert.equal(init.code, 0, JSON.stringify(init));
    const lost = await invoke([
      'agent', 'run', '--lab', lab, '--run-id', 'run-1', '--steps', '1', '--scenario', 'idempotent',
      '--adapter', adapter, '--kernel-only', '--goal', '在观察者失联后保持恢复未决', '--json',
    ]);
    assert.notEqual(lost.code, 0, 'the remote primary must lose the first transition response');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, JSON.stringify(lost));

    const observerExit = waitForExit(observer.server);
    observer.server.kill();
    await observerExit;
    const blocked = await invoke(['run', '--lab', lab, '--run-id', 'run-2', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
    assert.notEqual(blocked.code, 0, 'recovery must not complete while the observer is unavailable');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, JSON.stringify(blocked));
    assert.equal(await countSteps(lab, 'run-2'), 0, 'observer outage must not append a STEP');

    const restartedObserver = await startRemoteServer(root, 'observer-restarted', [
      '--effect-file', effectFile, '--reconciliation-observer',
    ], { serverKey, serverCert, caCert }, { port: observer.port });
    servers[1] = restartedObserver.server;
    const resumed = await invoke(['run', '--lab', lab, '--run-id', 'run-3', '--steps', '1', '--scenario', 'idempotent', '--adapter', adapter, '--json']);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(resumed.json.data.status, 'COMPLETED');
    assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).effectCount, 1, 'observer outage recovery must not execute the effect again');
    assert.equal(await countSteps(lab, 'run-3'), 1, 'observer recovery must append exactly one STEP');

    await stopServers(servers);
    const replay = await invoke(['replay', '--lab', lab, '--run', 'run-3', '--adapter', adapter, '--json']);
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

async function countSteps(lab, runId) {
  try {
    const ledger = await readFile(path.join(lab, 'runs', runId, 'events.jsonl'), 'utf8');
    return ledger.trim() === '' ? 0 : ledger.trim().split(/\r?\n/u).filter((line) => JSON.parse(line).kind === 'STEP').length;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
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
  delayResponseOp,
  delayResponseMs,
  blackholeResponseOp,
  resetResponseOp,
  clientCrlFile,
  keepAlive = false,
  connectionCountFile,
} = {}) {
  const portFile = path.join(root, `${name}-port.txt`);
  const server = spawn(process.execPath, [
    SERVER,
    '--adapter', ADAPTER,
    '--adapter-args-json', JSON.stringify(adapterArgs),
    '--port-file', portFile,
    '--tls-key-file', tlsFiles.serverKey,
    '--tls-cert-file', tlsFiles.serverCert,
    '--tls-client-ca-file', tlsFiles.clientCaCert ?? tlsFiles.caCert,
    '--port', String(port),
    ...(clientCrlFile === undefined ? [] : ['--tls-client-crl-file', clientCrlFile]),
    ...(keepAlive ? ['--keep-alive', 'true'] : []),
    ...(connectionCountFile === undefined ? [] : ['--connection-count-file', connectionCountFile]),
    ...(extraResponseJson === undefined ? [] : ['--extra-response-json', extraResponseJson]),
    ...(extraResponseDelayMs === undefined ? [] : ['--extra-response-delay-ms', String(extraResponseDelayMs)]),
    ...(delayResponseOp === undefined ? [] : ['--delay-response-op', delayResponseOp]),
    ...(delayResponseMs === undefined ? [] : ['--delay-response-ms', String(delayResponseMs)]),
    ...(blackholeResponseOp === undefined ? [] : ['--blackhole-response-op', blackholeResponseOp]),
    ...(resetResponseOp === undefined ? [] : ['--reset-response-op', resetResponseOp]),
  ], { windowsHide: true });
  await waitForFile(portFile);
  return { server, port: Number(await readFile(portFile, 'utf8')) };
}
