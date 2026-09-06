#!/usr/bin/env node

// L4 对抗性世界：世界观察 Kernel 最近的选择，对「可预测性」做出反应——
// 当某个动作在最近 3 步内被选中 ≥ 2 次时，该动作在本步的动力学翻转
// （此前 +1 的奖励变为 -1 惩罚）。固定策略（确定性选择）必然被世界利用；
// 只有漂移检测 + 上下文条件策略的再组织能力才能维持正收益。
// 这检验的是 kernel 在「世界主动反学习」下的在线适应，比 regime-shift
// 的无条件切换难度高一级。
//
// 观测 1 维：[累计净收益]；ValueSpec：目标 [50]，权重 [1]。
// 世界状态含隐藏字段（recentChoices、flipped），只通过动力学间接可观测。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const PROTOCOL = 'yi-world-cli';
const VERSION = 1;
const ADAPTER_ID = 'adversarial-adapter-v1';
const WORLD_ID = 'adversarial';
const CAPABILITY_IDS = ['move.alpha', 'move.beta'];
const EVIDENCE_PUBLIC_KEY = 'MCowBQYDK2VwAyEA2R0znN74/jSx8OPrwSEnDH8UKEKU4l0es4XeSwfuOEY=';
const TARGET = 50;

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

function baseState() {
  return {
    schemaVersion: VERSION,
    stateVersion: 'adversarial:0',
    revision: 0,
    score: 0,
    recentChoices: [], // 最近 3 步被选动作的 capabilityId（隐藏）
    flipped: { 'move.alpha': false, 'move.beta': false }, // 隐藏：动力学翻转标记
    usedExecutionNonces: [],
  };
}

function dispatch(op, payload) {
  if (op === 'hello') {
    const descriptor = {
      adapterId: ADAPTER_ID,
      worldId: WORLD_ID,
      worldVersion: 'adversarial-1',
      capabilityIds: CAPABILITY_IDS,
      scenarioIds: ['steady'],
      valueSpec: {
        schemaVersion: VERSION,
        observationDimensions: 1,
        weights: [1],
        target: [TARGET],
      },
      evidencePublicKey: EVIDENCE_PUBLIC_KEY,
    };
    return { ...descriptor, descriptorDigest: canonicalDigest(descriptor) };
  }
  if (op === 'initialState') return { state: baseState() };
  if (op === 'actions') {
    const entries = payload.manifest?.tokenMap?.entries;
    if (!Array.isArray(entries) || entries.length !== CAPABILITY_IDS.length) throw new Error('manifest token map is missing');
    return {
      actions: entries.map((entry) => ({
        schemaVersion: VERSION,
        token: entry.token,
        cost: 1,
        allowed: true,
        safe: true,
      })),
    };
  }
  if (op === 'observe') return { observation: observation(payload.state) };
  if (op === 'externalInputs') return { inputs: [] };
  if (op === 'transition') return transition(payload.state, payload.request, payload.manifest);
  throw new Error(`unsupported operation: ${op}`);
}

function observation(state) {
  return {
    schemaVersion: VERSION,
    vector: [state.score],
    stateVersion: `adversarial:${state.revision}`,
    intervalId: `adversarial:${state.revision}`,
    evidence: [],
  };
}

function transition(state, request, manifest) {
  const entries = manifest?.tokenMap?.entries;
  const entry = entries?.find((candidate) => candidate.token === request.token);
  if (entry === undefined) throw new Error('unknown action token');
  const capabilityId = entry.capabilityId;

  // 世界规则（隐藏）：最近 3 步内同一动作被选 ≥ 2 次 → 该动作本步翻转
  const recentCount = state.recentChoices.filter((c) => c === capabilityId).length;
  const flipped = recentCount >= 2 ? !state.flipped[capabilityId] : state.flipped[capabilityId];
  const delta = (flipped ? -1 : 1) * (capabilityId === 'move.alpha' ? 1 : -1);
  const nextScore = state.score + delta;

  const next = {
    schemaVersion: VERSION,
    stateVersion: `adversarial:${state.revision + 1}`,
    revision: state.revision + 1,
    score: nextScore,
    recentChoices: [...state.recentChoices.slice(-2), capabilityId],
    flipped: { ...state.flipped, [capabilityId]: flipped },
    usedExecutionNonces: [...state.usedExecutionNonces.slice(-7), request.executionNonce],
  };
  return {
    nextWorldState: next,
    receipt: {
      schemaVersion: VERSION,
      token: request.token,
      basedOnVersion: request.basedOnVersion,
      policyVersion: request.policyVersion,
      constraintsDigest: request.constraintsDigest,
      executionNonce: request.executionNonce,
      status: 'ACCEPTED',
      rejectionReason: null,
      effectDigest: canonicalDigest(next),
      attributionWindowComplete: true,
      confounderCount: 0,
    },
    postObservation: {
      schemaVersion: VERSION,
      vector: [nextScore],
      stateVersion: next.stateVersion,
      intervalId: next.stateVersion,
      evidence: [],
    },
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
