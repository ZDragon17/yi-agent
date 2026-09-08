#!/usr/bin/env node

import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { writeFileSync } from 'node:fs';
import { loadBoundedFile, loadBoundedSecret, loadPkcs8DerPrivateKey } from '../src/runtime/private-key-loader.mjs';
import { signExecutionAuthorityReceipt } from '../src/runtime/execution-authority-attestation.mjs';

const options = parseArguments(process.argv.slice(2));
const signingKey = loadPkcs8DerPrivateKey(required(options, 'private-key-der'));
const authToken = loadBoundedSecret(required(options, 'auth-token-file'), 'auth-token-file');
const host = options.host ?? '127.0.0.1';
const port = options.port === undefined ? 0 : Number(options.port);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('port must be between 0 and 65535');
if (host !== '127.0.0.1' && host !== '::1') throw new Error('signer server host must be loopback');

const serverOptions = createTlsOptions(options);
const server = (serverOptions === null ? createServer : createTlsServer)(...(serverOptions === null ? [] : [serverOptions]), (socket) => {
  let input = '';
  let handled = false;
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    if (handled) return;
    input += chunk;
    if (Buffer.byteLength(input, 'utf8') > 192 * 1024) {
      socket.destroy();
      return;
    }
    const newline = input.indexOf('\n');
    if (newline === -1) return;
    handled = true;
    const line = input.slice(0, newline).replace(/\r$/u, '');
    if (input.slice(newline + 1).trim().length > 0) {
      socket.destroy();
      return;
    }
    let request;
    try { request = JSON.parse(line); } catch { socket.destroy(); return; }
    if (request.protocol !== 'yi-execution-signer' || request.version !== 1 || request.op !== 'sign' || !sameSecret(request.authToken, authToken)) {
      respond(socket, request.id, false, 'unsupported protocol');
      return;
    }
    try {
      const signed = signExecutionAuthorityReceipt(request.payload, signingKey);
      respond(socket, request.id, true, signed.executionAttestation);
    } catch (error) {
      respond(socket, request.id, false, error instanceof Error ? error.message : String(error));
    }
  });
});

server.listen({ host, port }, () => {
  if (options['ready-file'] !== undefined) writeFileSync(options['ready-file'], String(server.address().port), 'utf8');
});

function parseArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith('--') || args[index + 1] === undefined) throw new Error('signer server arguments must be --name value pairs');
    result[key.slice(2)] = args[index + 1];
    index += 1;
  }
  return result;
}

function required(optionsValue, name) {
  const value = optionsValue[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing --${name}`);
  return value;
}

function respond(socket, id, ok, result) {
  socket.end(`${JSON.stringify({ protocol: 'yi-execution-signer', version: 1, id, ok, ...(ok ? { result } : { error: result }) })}\n`);
}

function createTlsOptions(optionsValue) {
  const hasTls = optionsValue['tls-cert-file'] !== undefined || optionsValue['tls-key-file'] !== undefined || optionsValue['tls-client-ca-file'] !== undefined;
  if (!hasTls) return null;
  if (optionsValue['tls-cert-file'] === undefined || optionsValue['tls-key-file'] === undefined || optionsValue['tls-client-ca-file'] === undefined) {
    throw new Error('tls-cert-file, tls-key-file, and tls-client-ca-file must be provided together');
  }
  return {
    cert: loadBoundedFile(optionsValue['tls-cert-file'], 'tls-cert-file'),
    key: loadBoundedFile(optionsValue['tls-key-file'], 'tls-key-file'),
    ca: loadBoundedFile(optionsValue['tls-client-ca-file'], 'tls-client-ca-file'),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  };
}

function sameSecret(value, expected) {
  if (typeof value !== 'string') return false;
  const actualBytes = Buffer.from(value, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
