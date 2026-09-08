#!/usr/bin/env node

import { existsSync, writeFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';
import { EffectJournal } from '../src/effects/effect-journal.mjs';
import { restoreEffectBroker } from '../src/effects/effect-broker.mjs';
import { createEffectBrokerAuthority } from '../src/effects/effect-broker-authority.mjs';
import { assertSandboxRoot, createSandboxFileExecutor } from '../src/effects/sandbox-file-executor.mjs';
import { createExecutionAuthoritySigner } from '../src/runtime/execution-authority-signer.mjs';
import { loadBoundedFile, loadBoundedSecret, loadPkcs8DerPrivateKey } from '../src/runtime/private-key-loader.mjs';
import { createRemoteExecutionAuthoritySigner } from '../src/runtime/remote-execution-authority-signer.mjs';
import { canonicalDigest } from '../src/runtime/schema.mjs';

const options = parseArguments(process.argv.slice(2));
const descriptor = publishDescriptor(parseJsonOption(options, 'descriptor-json'));
const effectPlan = parseJsonOption(options, 'effect-plan-json');
const journalPath = required(options, 'journal');
const sandboxRoot = required(options, 'sandbox-root');
const dropExecutionResponseOnceMarker = options['drop-execution-response-once-marker'] ?? null;
const signingKey = options['private-key-der'] === undefined
  ? null
  : loadPkcs8DerPrivateKey(options['private-key-der']);
const signer = createSigner(options, signingKey);
let authorityPromise = null;

const rl = createInterface({ input: stdin, crlfDelay: Infinity });
let tail = Promise.resolve();
rl.on('line', (line) => {
  tail = tail.then(() => handleLine(line), () => handleLine(line));
});

async function handleLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.protocol !== 'yi-world-cli' || request.version !== 1) {
    respond(request.id, false, 'unsupported protocol');
    return;
  }
  try {
    let result;
    if (request.op === 'hello') {
      result = descriptor;
    } else {
      const authority = await loadAuthority();
      if (request.op === 'executeExecution') {
        result = await authority.executeExecution(request.payload ?? {});
        if (dropExecutionResponseOnceMarker !== null && !existsSync(dropExecutionResponseOnceMarker)) {
          writeFileSync(dropExecutionResponseOnceMarker, 'dropped\n', 'utf8');
          process.exit(17);
        }
      }
      else if (request.op === 'reconcileExecution') result = await authority.reconcileExecution(request.payload ?? {});
      else throw new Error(`unsupported operation: ${request.op}`);
    }
    respond(request.id, true, result);
  } catch (error) {
    respond(request.id, false, error instanceof Error ? error.message : String(error));
  }
}

async function loadAuthority() {
  authorityPromise ??= (async () => {
    await assertSandboxRoot(sandboxRoot);
    const journal = await EffectJournal.open(journalPath);
    const executor = createSandboxFileExecutor({ sandboxRoot });
    const broker = await restoreEffectBroker({ journal, executor });
    return createEffectBrokerAuthority({ broker, effectPlan, descriptor, signingKey, signer });
  })();
  return authorityPromise;
}

function publishDescriptor(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('descriptor-json must contain an object');
  }
  const { descriptorDigest: _ignored, ...unsigned } = value;
  return { ...unsigned, descriptorDigest: canonicalDigest(unsigned) };
}

function parseArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith('--') || args[index + 1] === undefined) throw new Error('authority arguments must be --name value pairs');
    result[key.slice(2)] = args[index + 1];
    index += 1;
  }
  return result;
}

function parseJsonOption(optionsValue, name) {
  const raw = required(optionsValue, name);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

function required(optionsValue, name) {
  const value = optionsValue[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing --${name}`);
  return value;
}

function createSigner(optionsValue, signingKey) {
  const hasProcessSigner = optionsValue['signer-executable'] !== undefined;
  const hasRemoteSigner = optionsValue['signer-host'] !== undefined || optionsValue['signer-port'] !== undefined;
  if ((signingKey !== null && (hasProcessSigner || hasRemoteSigner)) || (hasProcessSigner && hasRemoteSigner)) {
    throw new Error('private-key-der, signer-executable, and remote signer options are mutually exclusive.');
  }
  if (hasRemoteSigner) {
    if (optionsValue['signer-host'] === undefined || optionsValue['signer-port'] === undefined) {
      throw new Error('signer-host and signer-port must be provided together.');
    }
    return createRemoteExecutionAuthoritySigner({
      host: optionsValue['signer-host'],
      port: Number(optionsValue['signer-port']),
      authToken: loadBoundedSecret(required(optionsValue, 'signer-auth-token-file'), 'signer-auth-token-file'),
      tls: createSignerTlsOptions(optionsValue),
      timeoutMs: optionsValue['signer-timeout-ms'] === undefined
        ? 5000
        : Number(optionsValue['signer-timeout-ms']),
    });
  }
  if (!hasProcessSigner) return null;
  const args = parseJsonOption(optionsValue, 'signer-args-json');
  return createExecutionAuthoritySigner({
    executable: optionsValue['signer-executable'],
    args,
    timeoutMs: optionsValue['signer-timeout-ms'] === undefined
      ? 5000
      : Number(optionsValue['signer-timeout-ms']),
  });
}

function createSignerTlsOptions(optionsValue) {
  const hasTls = optionsValue['signer-tls-cert-file'] !== undefined ||
    optionsValue['signer-tls-key-file'] !== undefined ||
    optionsValue['signer-tls-ca-file'] !== undefined ||
    optionsValue['signer-tls-server-name'] !== undefined ||
    optionsValue['signer-tls-crl-file'] !== undefined;
  if (!hasTls) return undefined;
  if (optionsValue['signer-tls-cert-file'] === undefined ||
      optionsValue['signer-tls-key-file'] === undefined ||
      optionsValue['signer-tls-ca-file'] === undefined ||
      optionsValue['signer-tls-server-name'] === undefined) {
    throw new Error('signer TLS options must include cert-file, key-file, ca-file, and server-name.');
  }
  return {
    cert: loadBoundedFile(optionsValue['signer-tls-cert-file'], 'signer-tls-cert-file'),
    key: loadBoundedFile(optionsValue['signer-tls-key-file'], 'signer-tls-key-file'),
    ca: loadBoundedFile(optionsValue['signer-tls-ca-file'], 'signer-tls-ca-file'),
    servername: optionsValue['signer-tls-server-name'],
    ...(optionsValue['signer-tls-crl-file'] === undefined ? {} : { crl: loadBoundedFile(optionsValue['signer-tls-crl-file'], 'signer-tls-crl-file') }),
  };
}

function respond(id, ok, result) {
  stdout.write(`${JSON.stringify({ protocol: 'yi-world-cli', version: 1, id, ok, ...(ok ? { result } : { error: result }) })}\n`);
}
