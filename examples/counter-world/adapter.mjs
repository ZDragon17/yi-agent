#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const PROTOCOL = 'yi-world-cli';
const VERSION = 1;
const ADAPTER_ID = 'counter-example-v1';
const WORLD_ID = 'counter';
const CAPABILITY_ID = 'counter.increment';
const SCENARIO_IDS = ['steady'];
const VALUE_SPEC = {
  schemaVersion: VERSION,
  observationDimensions: 1,
  weights: [1],
  target: [10],
};
const EVIDENCE_PUBLIC_KEY =
  'MCowBQYDK2VwAyEA2R0znN74/jSx8OPrwSEnDH8UKEKU4l0es4XeSwfuOEY=';

const line = readFileSync(0, 'utf8').split(/\r?\n/u).find((item) => item.length > 0);
if (line === undefined) process.exit(64);

let request;
try {
  request = JSON.parse(line);
} catch {
  respond(null, false, 'request is not JSON');
  process.exit(0);
}

if (request.protocol !== PROTOCOL || request.version !== VERSION || typeof request.id !== 'string') {
  respond(request.id ?? null, false, 'unsupported protocol');
  process.exit(0);
}

try {
  respond(request.id, true, dispatch(request.op, request.payload ?? {}));
} catch (error) {
  respond(request.id, false, error instanceof Error ? error.message : 'adapter error');
}

function dispatch(op, payload) {
  if (op === 'hello') {
    const descriptor = {
      adapterId: ADAPTER_ID,
      worldId: WORLD_ID,
      worldVersion: 'counter-1',
      capabilityIds: [CAPABILITY_ID],
      scenarioIds: SCENARIO_IDS,
      valueSpec: VALUE_SPEC,
      evidencePublicKey: EVIDENCE_PUBLIC_KEY,
    };
    return { ...descriptor, descriptorDigest: canonicalDigest(descriptor) };
  }
  if (op === 'initialState') return { state: state(0) };
  if (op === 'actions') {
    const token = payload.manifest?.tokenMap?.entries?.[0]?.token;
    if (typeof token !== 'string') throw new Error('manifest token is missing');
    return {
      actions: [{
        schemaVersion: VERSION,
        token,
        cost: 1,
        allowed: true,
        safe: true,
      }],
    };
  }
  if (op === 'observe') return { observation: observation(payload.state) };
  if (op === 'externalInputs') return { inputs: [] };
  if (op === 'transition') return transition(payload.state, payload.request);
  throw new Error(`unsupported operation: ${op}`);
}

function transition(previous, request) {
  const next = state(previous.value + 1, request.executionNonce, previous.usedExecutionNonces);
  return {
    nextWorldState: next,
    receipt: {
      schemaVersion: VERSION,
      status: 'ACCEPTED',
      token: request.token,
      basedOnVersion: request.basedOnVersion,
      policyVersion: request.policyVersion,
      constraintsDigest: request.constraintsDigest,
      executionNonce: request.executionNonce,
      effectDigest: canonicalDigest(next),
      rejectionReason: null,
      attributionWindowComplete: true,
      confounderCount: 0,
    },
    postObservation: observation(next),
  };
}

function state(value, executionNonce = null, previousNonces = []) {
  const usedExecutionNonces = executionNonce === null
    ? []
    : [...previousNonces, executionNonce].slice(-8);
  return {
    schemaVersion: VERSION,
    stateVersion: `state:${WORLD_ID}:${value}`,
    revision: value,
    value,
    usedExecutionNonces,
  };
}

function observation(current) {
  return {
    schemaVersion: VERSION,
    vector: [current.value],
    stateVersion: current.stateVersion,
    intervalId: `${WORLD_ID}:interval:${current.revision}`,
    evidence: [],
  };
}

function respond(id, ok, result) {
  const envelope = ok
    ? { protocol: PROTOCOL, version: VERSION, id, ok: true, result }
    : { protocol: PROTOCOL, version: VERSION, id, ok: false, error: result };
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function canonicalDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function canonicalJson(value, ancestors = new Set()) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON requires finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new TypeError('canonical JSON does not support this value');
  if (ancestors.has(value)) throw new TypeError('canonical JSON does not support cycles');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}
