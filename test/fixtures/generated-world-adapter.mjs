import readline from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  canonicalDigest,
  MAX_BOUNDARY_IDENTIFIER_LENGTH,
  MAX_EXECUTION_NONCE_LENGTH,
} from '../../src/runtime/schema.mjs';
import { attestationFor, ED25519_PUBLIC_KEY } from './ed25519-proof.mjs';

const modeIndex = process.argv.indexOf('--mode');
const mode = modeIndex === -1 ? 'valid' : process.argv[modeIndex + 1] ?? 'valid';
const counterIndex = process.argv.indexOf('--counter-file');
const counterFile = counterIndex === -1 ? null : process.argv[counterIndex + 1] ?? null;
const adapterId = 'generated-adapter-v1';
const worldId = 'generated';
const capabilityId = 'generated.advance';
const scenarioIds = ['generated'];
const valueSpec = { schemaVersion: 1, observationDimensions: 1, weights: [1], target: [2] };

if (counterFile !== null) {
  let count = 0;
  try { count = Number.parseInt(readFileSync(counterFile, 'utf8'), 10) || 0; } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  writeFileSync(counterFile, String(count + 1));
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return respond(null, false, null); }
  if (request.op !== 'hello') {
    if (mode === 'timeout') return;
    if (mode === 'pollution') process.stdout.write('pollution\n');
    if (mode === 'nonzero') process.exit(17);
    if (mode === 'invalid-response') return process.stdout.write('{"invalid":true}\n');
  }
  if (request.protocol !== 'yi-world-cli' || request.version !== 1) return respond(request.id, false, null);
  const result = dispatch(request.op, request.payload ?? {});
  if (request.op !== 'hello' && mode === 'truncated-response') return process.stdout.write('{"protocol":"yi-world-cli"');
  if (request.op !== 'hello' && mode === 'wrong-response-id') return respond(`${request.id}-wrong`, true, result);
  if (request.op !== 'hello' && mode === 'wrong-response-version') return respond(request.id, true, result, { version: 2 });
  if (request.op !== 'hello' && mode === 'duplicate-response') return respond(request.id, true, result, { duplicate: true });
  if (request.op !== 'hello' && mode === 'stderr-noise') process.stderr.write('adapter diagnostic\n');
  if (request.op !== 'hello' && mode === 'crlf') return respond(request.id, true, result, { lineEnding: '\r\n' });
  respond(request.id, true, result);
});

function dispatch(op, payload) {
  if (op === 'hello') {
    const descriptor = { adapterId, worldId, worldVersion: 'generated-1', capabilityIds: [capabilityId], scenarioIds, valueSpec, evidencePublicKey: ED25519_PUBLIC_KEY };
    return { ...descriptor, descriptorDigest: canonicalDigest(descriptor) };
  }
  if (op === 'initialState') {
    const initial = state(0);
    if (mode === 'bad-revision') initial.revision = -1;
    return { state: initial };
  }
  if (op === 'actions') {
    if (Object.hasOwn(payload, 'state')) throw new Error('legacy adapter does not accept state-dependent actions');
    return { actions: [{ schemaVersion: 1, token: payload.manifest.tokenMap.entries[0].token, cost: 1, allowed: true, safe: true }] };
  }
  if (op === 'observe') {
    const result = observation(payload.state);
    if (mode === 'bad-observation-dimensions') result.vector = [payload.state.value, payload.state.value + 1];
    return { observation: result };
  }
  if (op === 'externalInputs') {
    const inputPayload = { generated: true, stepVersion: payload.stateVersion };
    const input = {
      schemaVersion: 1,
      source: 'scenario',
      kind: 'generated',
      payload: inputPayload,
      appliedBeforeVersion: payload.stateVersion,
    };
    const digest = canonicalDigest(input);
    return { inputs: [{ ...input, digest, attestation: attestationFor({ ...input, digest }) }] };
  }
  if (op === 'transition') {
    const priorNonces = Array.isArray(payload.state.usedExecutionNonces)
      ? payload.state.usedExecutionNonces.slice(-7)
      : [];
    const next = state(payload.state.value + 1, payload.request.executionNonce);
    next.usedExecutionNonces = [...priorNonces, payload.request.executionNonce];
    if (mode === 'oversized-domain-state') next.domainPayload = 'x'.repeat(1_045_000);
    return { nextWorldState: next, receipt: { ...payload.request, schemaVersion: 1, status: 'ACCEPTED', rejectionReason: null, effectDigest: canonicalDigest(next), attributionWindowComplete: true, confounderCount: 0 }, postObservation: observation(next) };
  }
  return null;
}

function state(value, executionNonce = null) {
  const usedExecutionNonces = executionNonce === null
    ? mode === 'oversized-execution-nonce'
      ? ['x'.repeat(MAX_EXECUTION_NONCE_LENGTH + 1)]
      : []
    : [executionNonce];
  return {
    schemaVersion: 1,
    stateVersion: stateVersionFor(value),
    revision: value,
    value,
    usedExecutionNonces,
  };
}

function stateVersionFor(value) {
  if (mode === 'oversized-boundary-id') return 'x'.repeat(MAX_BOUNDARY_IDENTIFIER_LENGTH + 1);
  return mode === 'opaque-state-version'
    ? `opaque-v7/${value.toString(36)}`
    : `state:${worldId}:${value}`;
}

function observation(value) {
  return {
    schemaVersion: 1,
    vector: [value.value],
    stateVersion: value.stateVersion,
    intervalId: mode === 'oversized-boundary-id'
      ? 'x'.repeat(MAX_BOUNDARY_IDENTIFIER_LENGTH + 1)
      : `boundary-v7/${value.revision.toString(36)}`,
    evidence: [],
  };
}

function respond(id, ok, result, { version = 1, duplicate = false, lineEnding = '\n' } = {}) {
  const line = `${JSON.stringify({ protocol: 'yi-world-cli', version, id, ok, result })}${lineEnding}`;
  process.stdout.write(line);
  if (duplicate) process.stdout.write(line);
}
