#!/usr/bin/env node

// VPP 虚拟电厂场景 WorldPort：调度中心按步下发聚合出力指令，
// 两个站点（site-a 60kW / site-b 40kW 电池）各自以 ±30kW 步进调节出力。
// 观测 3 维：[聚合出力/100，跟踪偏差/50，指令/100]；
// ValueSpec：目标 [0, 0, 0]，权重 [0, 1.5, 0] —— 指令通道不可控仅作上下文，
// 跟踪偏差是核心价值几何：行动使 |偏差| 减小即被选择层奖励。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { vppCommandKw } from '../shared/energy-sim.mjs';

const PROTOCOL = 'yi-world-cli';
const VERSION = 1;
const ADAPTER_ID = 'vpp-adapter-v1';
const WORLD_ID = 'vpp';
const CAPABILITY_IDS = ['site-a.rise', 'site-a.drop', 'site-b.rise', 'site-b.drop'];
const SITE_LIMIT = { 'site-a': 60, 'site-b': 60 };
const STEP_KW = 30;
const EVIDENCE_PUBLIC_KEY = 'MCowBQYDK2VwAyEA2R0znN74/jSx8OPrwSEnDH8UKEKU4l0es4XeSwfuOEY=';

const input = readFileSync(0, 'utf8').split(/\r?\n/u).find((line) => line.length > 0);
if (input === undefined) process.exit(64);

let request;
try {
  request = JSON.parse(input);
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
  respond(request.id, false, error instanceof Error ? error.message : String(error));
}

function dispatch(op, payload) {
  if (op === 'hello') {
    const descriptor = {
      adapterId: ADAPTER_ID,
      worldId: WORLD_ID,
      worldVersion: 'vpp-1',
      capabilityIds: CAPABILITY_IDS,
      scenarioIds: ['steady'],
      valueSpec: {
        schemaVersion: VERSION,
        observationDimensions: 3,
        weights: [0, 1.5, 0],
        target: [0, 0, 0],
      },
      evidencePublicKey: EVIDENCE_PUBLIC_KEY,
      supportsStateDependentActions: true,
    };
    return { ...descriptor, descriptorDigest: canonicalDigest(descriptor) };
  }
  if (op === 'initialState') {
    return { state: { schemaVersion: VERSION, stateVersion: 'vpp:0', revision: 0, step: 0, siteA: 0, siteB: 0, usedExecutionNonces: [] } };
  }
  if (op === 'actions') {
    const entries = payload.manifest?.tokenMap?.entries;
    if (!Array.isArray(entries) || entries.length !== CAPABILITY_IDS.length) throw new Error('manifest token map is missing');
    return {
      actions: entries.map((entry) => ({
        schemaVersion: VERSION,
        token: entry.token,
        cost: 1,
        allowed: true,
        safe: capabilitySafe(entry.capabilityId, payload.state),
      })),
    };
  }
  if (op === 'observe') return { observation: observation(payload.state) };
  if (op === 'externalInputs') return { inputs: [] };
  if (op === 'transition') return transition(payload.state, payload.request, payload.manifest);
  throw new Error(`unsupported operation: ${op}`);
}

function capabilitySafe(capabilityId, state) {
  const { site, direction } = parseCapability(capabilityId);
  const current = site === 'site-a' ? state.siteA : state.siteB;
  const next = current + direction * STEP_KW;
  return Math.abs(next) <= SITE_LIMIT[site];
}

function parseCapability(capabilityId) {
  const [site, action] = capabilityId.split('.');
  return { site, direction: action === 'rise' ? 1 : -1 };
}

function observation(state) {
  const output = state.siteA + state.siteB;
  const command = vppCommandKw(state.step);
  const deviation = output - command;
  return {
    schemaVersion: VERSION,
    vector: [
      Math.round(output / 100 * 1000) / 1000,
      Math.round(deviation / 50 * 1000) / 1000,
      Math.round(command / 100 * 1000) / 1000,
    ],
    stateVersion: `vpp:${state.step}`,
    intervalId: `vpp:${state.step}`,
    evidence: [],
  };
}

function transition(state, request, manifest) {
  const entries = manifest?.tokenMap?.entries;
  const entry = entries?.find((candidate) => candidate.token === request.token);
  if (entry === undefined) throw new Error('unknown action token');
  const { site, direction } = parseCapability(entry.capabilityId);
  const current = site === 'site-a' ? state.siteA : state.siteB;
  const next = current + direction * STEP_KW;
  if (Math.abs(next) > SITE_LIMIT[site]) {
    return rejected(state, request, 'SITE_OUTPUT_LIMIT');
  }

  const nextState = {
    ...(site === 'site-a' ? { ...state, siteA: next } : { ...state, siteB: next }),
    schemaVersion: VERSION,
    stateVersion: `vpp:${state.step + 1}`,
    revision: state.revision + 1,
    step: state.step + 1,
    usedExecutionNonces: [...state.usedExecutionNonces.slice(-7), request.executionNonce],
  };
  const output = nextState.siteA + nextState.siteB;
  const command = vppCommandKw(nextState.step);
  const deviation = output - command;
  return {
    nextWorldState: nextState,
    receipt: {
      schemaVersion: VERSION,
      token: request.token,
      basedOnVersion: request.basedOnVersion,
      policyVersion: request.policyVersion,
      constraintsDigest: request.constraintsDigest,
      executionNonce: request.executionNonce,
      status: 'ACCEPTED',
      rejectionReason: null,
      effectDigest: canonicalDigest(nextState),
      attributionWindowComplete: true,
      confounderCount: 0,
    },
    postObservation: {
      schemaVersion: VERSION,
      vector: [
        Math.round(output / 100 * 1000) / 1000,
        Math.round(deviation / 50 * 1000) / 1000,
        Math.round(command / 100 * 1000) / 1000,
      ],
      stateVersion: `vpp:${nextState.step}`,
      intervalId: `vpp:${nextState.step}`,
      evidence: [{
        schemaVersion: VERSION,
        kind: 'tracking',
        step: state.step,
        commandKw: vppCommandKw(state.step),
        outputKw: output,
        deviationKw: Math.round((output - vppCommandKw(state.step)) * 1000) / 1000,
      }],
    },
  };
}

function rejected(state, request, reason) {
  return {
    nextWorldState: state,
    receipt: {
      schemaVersion: VERSION,
      token: request.token,
      basedOnVersion: request.basedOnVersion,
      policyVersion: request.policyVersion,
      constraintsDigest: request.constraintsDigest,
      executionNonce: request.executionNonce,
      status: 'REJECTED',
      rejectionReason: reason,
      effectDigest: canonicalDigest(state),
      attributionWindowComplete: true,
      confounderCount: 0,
    },
    postObservation: observation(state),
  };
}

function respond(id, ok, result) {
  process.stdout.write(`${JSON.stringify({ protocol: PROTOCOL, version: VERSION, id, ok, ...(ok ? { result } : { error: result }) })}\n`);
}

function canonicalDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
