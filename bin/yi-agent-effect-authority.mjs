#!/usr/bin/env node

import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';
import { EffectJournal } from '../src/effects/effect-journal.mjs';
import { restoreEffectBroker } from '../src/effects/effect-broker.mjs';
import { createEffectBrokerAuthority } from '../src/effects/effect-broker-authority.mjs';
import { assertSandboxRoot, createSandboxFileExecutor } from '../src/effects/sandbox-file-executor.mjs';
import { canonicalDigest } from '../src/runtime/schema.mjs';

const options = parseArguments(process.argv.slice(2));
const descriptor = publishDescriptor(parseJsonOption(options, 'descriptor-json'));
const effectPlan = parseJsonOption(options, 'effect-plan-json');
const journalPath = required(options, 'journal');
const sandboxRoot = required(options, 'sandbox-root');
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
      if (request.op === 'executeExecution') result = await authority.executeExecution(request.payload ?? {});
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
    return createEffectBrokerAuthority({ broker, effectPlan, descriptor });
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

function respond(id, ok, result) {
  stdout.write(`${JSON.stringify({ protocol: 'yi-world-cli', version: 1, id, ok, ...(ok ? { result } : { error: result }) })}\n`);
}
