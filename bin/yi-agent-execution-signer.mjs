#!/usr/bin/env node

import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';
import { loadPkcs8DerPrivateKey } from '../src/runtime/private-key-loader.mjs';
import { signExecutionAuthorityReceipt } from '../src/runtime/execution-authority-attestation.mjs';

const options = parseArguments(process.argv.slice(2));
const signingKey = loadPkcs8DerPrivateKey(required(options, 'private-key-der'));
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
  if (request.protocol !== 'yi-execution-signer' || request.version !== 1 || request.op !== 'sign') {
    respond(request.id, false, 'unsupported protocol');
    return;
  }
  try {
    const signed = signExecutionAuthorityReceipt(request.payload, signingKey);
    respond(request.id, true, signed.executionAttestation);
  } catch (error) {
    respond(request.id, false, error instanceof Error ? error.message : String(error));
  }
}

function parseArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith('--') || args[index + 1] === undefined) throw new Error('signer arguments must be --name value pairs');
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

function respond(id, ok, result) {
  stdout.write(`${JSON.stringify({ protocol: 'yi-execution-signer', version: 1, id, ok, ...(ok ? { result } : { error: result }) })}\n`);
}
